import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { ROYALTY_GOODS_LINE, royaltyAmount, royaltyRuleFor } from '../billing/royalty-rule.sql';
import { SettingsService } from '../common/settings.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import { AmazonImportService } from '../imports/amazon-import.service';

/** 集計の軸。任意の SQL は受け取らず、この一覧から選ばせる。 */
export const DIMENSIONS = {
  月: sql`to_char(sh.ship_date, 'YYYY-MM')`,
  日: sql`to_char(sh.ship_date, 'YYYY-MM-DD')`,
  取引先: sql`p.name1`,
  販売カテゴリー: sql`sc.name`,
  受注区分: sql`o.order_type`,
  ブランド: sql`coalesce(b.name, '(未設定)')`,
  商品: sql`pr.product_name`,
  商品コード: sql`pr.product_code`,
  SKU: sql`s.sku_code`,
  倉庫: sql`w.short_name`,
  取引条件: sql`o.trade_type`,
  // 受注の販売担当（販売担当マスタ。取引先の既定担当を初期値に受注ごとに変更できる。9/15・9/17 ご要望）
  販売担当: sql`coalesce(su.name, '(未設定)')`,
  // 受注の通貨（取引先の通貨。2026-10-12 No.39）。選ばなくても必ず最後の軸に足し、外貨を円と足さない
  通貨: sql`o.currency`,
} as const;

export type Dimension = keyof typeof DIMENSIONS;

/**
 * 品物の行（数量として数えてよい行）。
 * 送料・値引・非商品は個数ではないので数えない。販促品は在庫が動かないので数えない。
 * 内訳商品は、親のセット行があると二重になるので数えない。
 * 請求（billing）・納品書（reports の goodsQty）と同じ数え方。
 */
const IS_GOODS = sql`(sl.line_type in ('商品', 'セット商品')
  or (sl.line_type = '内訳商品' and sl.parent_line_no is null))`;

/**
 * 受注明細1行あたりの原価。
 *
 * セット商品はそれ自体が在庫を持たないため（商品マスタの原価も 0 のまま）、
 * 実際に倉庫から出た構成品の原価を合計する。それ以外の行は
 * **得意先別商品 → SKU → 商品マスタ** の順に、細かいものを先に見る。
 * SKU の原価は「大きいサイズだけ原価が違う」ときに入れる（1001 ご要望）。
 * 送料・値引のような商品でない行は原価 0 になる。
 */
const COST_PER_LINE = sql`(
  case when sl.line_type = 'セット商品' then (
    select coalesce(sum(coalesce(cs.cost_price, cpr.cost_price, 0) * a.qty), 0)
      from allocations a
      join skus cs on cs.id = a.sku_id
      join products cpr on cpr.id = cs.product_id
     where a.sales_order_line_id = sl.id
       and a.status in ('引当中', '出荷済')
  )
  -- 在庫が動く行だけ原価を持つ。販促品・非商品は倉庫から出ないので 0。
  when sl.is_stock_target then coalesce(pp.cost_price, s.cost_price, pr.cost_price, 0) * sl.qty
  else 0 end
)`;

/** 集計する数値。 */
export const MEASURES = {
  数量: sql`coalesce(sum(sl.qty) filter (where ${IS_GOODS}), 0)`,
  金額: sql`coalesce(sum(sl.amount), 0)`,
  件数: sql`count(distinct o.id)`,
  明細数: sql`count(*)`,
  // ここから下は機微項目（SENSITIVE:view が要る）。9/15 ご要望「利益＝売上−（原価＋ロイヤリティ）」。
  // 原価は得意先別商品 → 商品マスタの順。
  // ロイヤリティは月次のロイヤリティ計算表と同じ当て方・同じ端数処理にするため、別の集計で出して
  // あとから足し合わせる（sales() の royaltyQuery）。ここに置くのは「ロイヤリティを引く前の値」。
  原価: sql`coalesce(sum(${COST_PER_LINE}), 0)`,
  ロイヤリティ: sql`0`,
  利益: sql`coalesce(sum(sl.amount), 0) - coalesce(sum(${COST_PER_LINE}), 0)`,
} as const;

/** 機微な指標。持っていない利用者には返さない。 */
export const SENSITIVE_MEASURES: readonly string[] = ['原価', 'ロイヤリティ', '利益'];

export type Measure = keyof typeof MEASURES;

export interface SalesQuery {
  from: string;
  to: string;
  /** 1〜3軸まで。多すぎると読めなくなるため上限を設ける。 */
  dimensions: Dimension[];
  measures: Measure[];
  partner_id?: number;
  brand_id?: number;
  order_type?: string;
  limit: number;
}

/**
 * 機能ID A-01 販売実績管理／A-03 汎用クエリ集計
 *
 * 任意の SQL は受け取らない。軸と指標をこちらが用意した一覧から選ばせ、
 * 期間で絞って集計する。保存しておけば次から選ぶだけで同じ集計が出る。
 * 出荷済みの実績を集計対象とし、サンプル出荷は含めない。
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly amazon: AmazonImportService,
    private readonly settings: SettingsService,
  ) {}

  /** Amazon決済レポートの集計。種類ごとの振り分けと、商品別の売上。 */
  amazonSummary(query: { from?: string; to?: string }) {
    return this.amazon.summary(query);
  }

  async sales(query: SalesQuery) {
    if (query.dimensions.length === 0) throw new BadRequestException('集計の軸を1つ以上選んでください');
    if (query.dimensions.length > 3) throw new BadRequestException('集計の軸は3つまでにしてください');
    if (query.measures.length === 0) throw new BadRequestException('集計する数値を1つ以上選んでください');
    // 金額は通貨ごとに分けて集計する（2026-10-12 No.39）。ドルの売上を円の売上と黙って足さないよう、
    // 通貨を選んでいなくても最後の軸に足す。円だけの期間でも「JPY」の列が付く。
    if (!query.dimensions.includes('通貨')) query = { ...query, dimensions: [...query.dimensions, '通貨'] };

    const dims = query.dimensions.map((d, i) => DIMENSIONS[d].as(`dim${i + 1}`));
    const measures = query.measures.map((m) => MEASURES[m].as(m));
    const groupBy = query.dimensions.map((d) => DIMENSIONS[d]);

    // 集計するのは「出荷した受注の明細」。出荷明細（shipment_lines）は倉庫から出た
    // ものの記録で、送料・値引を持たず、セット商品は構成品ごとに並ぶため、売上の
    // 集計に使うと請求額と合わない。請求・納品書と同じ土台（受注明細）を使う。
    let q = this.db
      .selectFrom('sales_order_lines as sl')
      // 出荷は受注ごとに1本だけ見る。単純な結合にすると、1つの受注に出荷済が
      // 2本ある状態（将来の分納や取込経路）で明細がそのまま倍に数えられる。
      .innerJoinLateral(
        (eb) =>
          eb
            .selectFrom('shipments as sh0')
            .select(['sh0.id as id', 'sh0.ship_date as ship_date', 'sh0.warehouse_id as warehouse_id', 'sh0.status as status'])
            .whereRef('sh0.sales_order_id', '=', 'sl.sales_order_id')
            .where('sh0.status', '=', '出荷済')
            .orderBy('sh0.ship_date')
            .orderBy('sh0.id')
            .limit(1)
            .as('sh'),
        (join) => join.onTrue(),
      )
      .innerJoin('sales_orders as o', 'o.id', 'sl.sales_order_id')
      .innerJoin('partners as p', 'p.id', 'o.partner_id')
      .innerJoin('sales_categories as sc', 'sc.id', 'o.sales_category_id')
      .innerJoin('warehouses as w', 'w.id', 'sh.warehouse_id')
      .leftJoin('skus as s', 's.id', 'sl.sku_id')
      .leftJoin('products as pr', 'pr.id', 's.product_id')
      .leftJoin('brands as b', 'b.id', 'pr.brand_id')
      .leftJoin('sales_staff as su', 'su.id', 'o.sales_staff_id')
      .leftJoin('partner_products as pp', 'pp.id', 'sl.partner_product_id')
      .where('sh.status', '=', '出荷済')
      // サンプル出荷は実績に含めない
      .where('o.is_billable', '=', true)
      .where('sh.ship_date', '>=', query.from)
      .where('sh.ship_date', '<=', query.to);

    if (query.partner_id !== undefined) q = q.where('o.partner_id', '=', query.partner_id);
    if (query.brand_id !== undefined) q = q.where('pr.brand_id', '=', query.brand_id);
    if (query.order_type) q = q.where('o.order_type', '=', query.order_type);

    const main = q.select([...dims, ...measures]).groupBy(groupBy).orderBy(groupBy).limit(query.limit);

    let rows: unknown[];
    if (!query.measures.some((m) => m === 'ロイヤリティ' || m === '利益')) {
      rows = await main.execute();
    } else {
      // ロイヤリティ。月次のロイヤリティ計算表と同じ規定の当て方（royalty-rule.sql.ts）で、
      // 支払先ごとに規定を当て、「月 × 支払先 × 販売先 × ブランド × SKU × 規定」のまとまりごとに
      // 端数を処理してから、集計の軸ごとに足す（計算表は同じまとまりで1行になり、行ごとに端数を落とすため）。
      // 以前は媒体を見ずに規定を当て、全体をまとめて切り捨てていたので、計算表と合わなかった（T3 No.35）。
      // 当てる日は出荷日。計算の基準が売上・入金の規定も、販売実績では出荷した月の見込みとして数える。
      // 返品は出荷の実績ではないので、ここには入らない（計算表では返品の月に差し引く）。
      const roundingMode = await this.settings.text('ROYALTY_ROUNDING_MODE', 'floor');
      const rule = royaltyRuleFor({
        payee: sql`py.payee_partner_id`,
        date: sql`sh.ship_date`,
        brandId: sql`pr.brand_id`,
        productId: sql`pr.id`,
        customerId: sql`o.partner_id`,
      });
      const perRuleGroup = q
        .innerJoin(
          sql<{ payee_partner_id: number }>`(select distinct rr0.payee_partner_id from royalty_rules rr0 where rr0.is_active)`.as('py'),
          (join) => join.onTrue(),
        )
        .innerJoinLateral(sql<{ id: number }>`${rule}`.as('rule'), (join) => join.onTrue())
        .where(ROYALTY_GOODS_LINE)
        .where(sql<boolean>`not rule.is_excluded`)
        .select([
          ...dims,
          royaltyAmount(sql`rule.rate`, sql`rule.fixed_amount`, sql`sum(sl.amount)`, sql`sum(sl.qty)`, roundingMode).as('amt'),
        ])
        .groupBy([
          ...groupBy,
          sql`py.payee_partner_id`,
          sql`date_trunc('month', sh.ship_date)`,
          sql`o.partner_id`,
          sql`pr.brand_id`,
          sql`sl.sku_id`,
          sql`rule.id`,
          sql`rule.rate`,
          sql`rule.fixed_amount`,
        ]);
      const dimNames = query.dimensions.map((_, i) => `dim${i + 1}`);
      const royaltyByDims = sql`(
        select ${sql.join(dimNames.map((d) => sql.ref(`x.${d}`)))}, sum(x.amt) as royalty
          from ${perRuleGroup} as x
         group by ${sql.join(dimNames.map((d) => sql.ref(`x.${d}`)))}
      )`;
      const select = [
        ...dimNames.map((d) => sql.ref(`m.${d}`)),
        ...query.measures.map((m) =>
          m === 'ロイヤリティ'
            ? sql`coalesce(r.royalty, 0) as ${sql.id(m)}`
            : m === '利益'
              ? sql`${sql.ref(`m.${m}`)} - coalesce(r.royalty, 0) as ${sql.id(m)}`
              : sql`${sql.ref(`m.${m}`)}`,
        ),
      ];
      const joinOn = sql.join(
        dimNames.map((d) => sql`${sql.ref(`m.${d}`)} is not distinct from ${sql.ref(`r.${d}`)}`),
        sql` and `,
      );
      const result = await sql`
        select ${sql.join(select)}
          from ${main} as m
          left join ${royaltyByDims} as r on ${joinOn}
         order by ${sql.join(dimNames.map((d) => sql.ref(`m.${d}`)))}
      `.execute(this.db);
      rows = result.rows;
    }

    return {
      period: { from: query.from, to: query.to },
      dimensions: query.dimensions,
      measures: query.measures,
      rows: rows.map((r) => {
        const record = r as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        query.dimensions.forEach((d, i) => (out[d] = record[`dim${i + 1}`]));
        query.measures.forEach((m) => (out[m] = record[m]));
        // 原価・ロイヤリティ・利益は円で持っているので、外貨の売上の行では出さない（円の原価と引き算できないため）
        if (out['通貨'] !== 'JPY') SENSITIVE_MEASURES.forEach((m) => m in out && (out[m] = null));
        return out;
      }),
    };
  }

  /** 選べる軸と指標の一覧。画面の選択肢として使う。 */
  options() {
    return { dimensions: Object.keys(DIMENSIONS), measures: Object.keys(MEASURES) };
  }

  /** 集計条件を保存する。次からは選ぶだけで同じ集計が出る。 */
  async saveQuery(input: { name: string; target: string; conditions?: unknown; share_scope: string }, userId: number) {
    return this.db
      .insertInto('saved_queries')
      .values({
        name: input.name,
        target: input.target,
        conditions: JSON.stringify(input.conditions ?? {}) as unknown as object,
        share_scope: input.share_scope,
        created_by: userId,
        updated_by: userId,
      })
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow();
  }

  async listSavedQueries(userId: number) {
    return this.db
      .selectFrom('saved_queries as q')
      .leftJoin('users as u', 'u.id', 'q.created_by')
      .select([
        'q.id as id',
        'q.name as name',
        'q.target as target',
        'q.conditions as conditions',
        'q.share_scope as share_scope',
        'u.name as created_by_name',
      ])
      // 全体共有（shared）のものと、自分が作ったものだけ
      .where((eb) => eb.or([eb('q.share_scope', '=', 'shared'), eb('q.created_by', '=', userId)]))
      .orderBy('q.name', 'asc')
      .execute();
  }
}
