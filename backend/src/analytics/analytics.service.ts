import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

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
} as const;

export type Dimension = keyof typeof DIMENSIONS;

/**
 * 出荷明細1行あたりのロイヤリティ。支払先ごとに最も細かい規定（scope_priority）を当て、合算する。
 * 月次のロイヤリティ計算（royalty.service）と同じ当て方。
 */
const ROYALTY_PER_LINE = sql`(
  select coalesce(sum(case when rule.is_excluded then 0
                           when rule.rate is not null then sl.amount * rule.rate
                           else coalesce(rule.fixed_amount, 0) * sl.qty end), 0)
    from (select distinct rr0.payee_partner_id from royalty_rules rr0 where rr0.is_active) py
    join lateral (
      select rr.rate, rr.fixed_amount, rr.is_excluded
        from royalty_rules rr
       where rr.payee_partner_id = py.payee_partner_id
         and rr.is_active
         and rr.valid_from <= sh.ship_date
         and (rr.valid_to is null or rr.valid_to >= sh.ship_date)
         and (rr.brand_id is null or rr.brand_id = pr.brand_id)
         and (rr.product_id is null or rr.product_id = pr.id)
         and (rr.customer_partner_id is null or rr.customer_partner_id = o.partner_id)
       order by rr.scope_priority desc, rr.valid_from desc
       limit 1
    ) rule on true
)`;

/** 集計する数値。 */
export const MEASURES = {
  数量: sql`coalesce(sum(sl.qty), 0)`,
  金額: sql`coalesce(sum(sl.amount), 0)`,
  件数: sql`count(distinct o.id)`,
  明細数: sql`count(*)`,
  // ここから下は機微項目（SENSITIVE:view が要る）。9/15 ご要望「利益＝売上−（原価＋ロイヤリティ）」。
  // 原価は得意先別商品 → 商品マスタの順。ロイヤリティは規定を出荷明細ごとに当てて概算する
  // （確定値は月次のロイヤリティ計算表）。
  原価: sql`coalesce(sum(coalesce(pp.cost_price, pr.cost_price, 0) * sl.qty), 0)`,
  ロイヤリティ: sql`floor(coalesce(sum(${ROYALTY_PER_LINE}), 0))`,
  利益: sql`coalesce(sum(sl.amount), 0) - coalesce(sum(coalesce(pp.cost_price, pr.cost_price, 0) * sl.qty), 0) - floor(coalesce(sum(${ROYALTY_PER_LINE}), 0))`,
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
  ) {}

  /** Amazon決済レポートの集計。種類ごとの振り分けと、商品別の売上。 */
  amazonSummary(query: { from?: string; to?: string }) {
    return this.amazon.summary(query);
  }

  async sales(query: SalesQuery) {
    if (query.dimensions.length === 0) throw new BadRequestException('集計の軸を1つ以上選んでください');
    if (query.dimensions.length > 3) throw new BadRequestException('集計の軸は3つまでにしてください');
    if (query.measures.length === 0) throw new BadRequestException('集計する数値を1つ以上選んでください');

    const dims = query.dimensions.map((d, i) => DIMENSIONS[d].as(`dim${i + 1}`));
    const measures = query.measures.map((m) => MEASURES[m].as(m));
    const groupBy = query.dimensions.map((d) => DIMENSIONS[d]);

    let q = this.db
      .selectFrom('shipment_lines as sl')
      .innerJoin('shipments as sh', 'sh.id', 'sl.shipment_id')
      .innerJoin('sales_orders as o', 'o.id', 'sh.sales_order_id')
      .innerJoin('partners as p', 'p.id', 'o.partner_id')
      .innerJoin('sales_categories as sc', 'sc.id', 'o.sales_category_id')
      .innerJoin('warehouses as w', 'w.id', 'sh.warehouse_id')
      .leftJoin('skus as s', 's.id', 'sl.sku_id')
      .leftJoin('products as pr', 'pr.id', 's.product_id')
      .leftJoin('brands as b', 'b.id', 'pr.brand_id')
      .leftJoin('sales_staff as su', 'su.id', 'o.sales_staff_id')
      .leftJoin('sales_order_lines as sol', 'sol.id', 'sl.sales_order_line_id')
      .leftJoin('partner_products as pp', 'pp.id', 'sol.partner_product_id')
      .where('sh.status', '=', '出荷済')
      // サンプル出荷は実績に含めない
      .where('o.is_billable', '=', true)
      .where('sh.ship_date', '>=', query.from)
      .where('sh.ship_date', '<=', query.to);

    if (query.partner_id !== undefined) q = q.where('o.partner_id', '=', query.partner_id);
    if (query.brand_id !== undefined) q = q.where('pr.brand_id', '=', query.brand_id);
    if (query.order_type) q = q.where('o.order_type', '=', query.order_type);

    const rows = await q
      .select([...dims, ...measures])
      .groupBy(groupBy)
      .orderBy(groupBy)
      .limit(query.limit)
      .execute();

    return {
      period: { from: query.from, to: query.to },
      dimensions: query.dimensions,
      measures: query.measures,
      rows: rows.map((r) => {
        const record = r as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        query.dimensions.forEach((d, i) => (out[d] = record[`dim${i + 1}`]));
        query.measures.forEach((m) => (out[m] = record[m]));
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
