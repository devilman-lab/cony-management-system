import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';

import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { Paged } from './partners.service';

/**
 * SKU の名前（SKU の商品名があればそれ、無ければ商品の商品名）。
 *
 * 同じ品番の中で (W)・Amazon用・キャップ付 などを SKU の末尾で分けて管理しているため、
 * SKU ごとに商品名を持てるようにした（2026-10-09 マスター編②）。SKU の名前を出すところは
 * すべてこの式を使い、空白だけの SKU の商品名は「無い」とみなす。
 */
export const skuNameExpr = (skuAlias = 's', productAlias = 'p') =>
  sql<string>`coalesce(nullif(btrim(${sql.ref(`${skuAlias}.sku_name`)}), ''), ${sql.ref(`${productAlias}.product_name`)})`;

/**
 * 参照元の表の呼び名。削除を断るときに「どこで使われているか」を出すのに使う
 * （2026-10-09 マスター編②「受注等で使用していないのに何故削除できないのか」）。
 * 載っていない表は表の名前のまま出す（新しい表が増えても数え漏れはしない）。
 */
const USAGE_LABELS: Record<string, string> = {
  set_headers: 'セット登録（セット SKU）',
  set_components: 'セット登録（構成品）',
  partner_products: '得意先別商品',
  stocks: '在庫表',
  reservations: '引当在庫',
  receipt_lines: '入荷',
  sales_order_lines: '受注',
  shipment_lines: '出荷',
  allocations: '引当（出荷）',
  return_lines: '返品',
  purchase_lines: '仕入',
  royalty_rules: 'ロイヤリティ規定',
  royalty_calculation_lines: 'ロイヤリティ計算',
  external_order_lines: '受注取込',
  platform_transactions: 'Amazon 取引取込',
  sales_schedules: '販売予定',
  stock_adjustment_lines: '在庫調整',
};

/** どこで何件使われているか。skus は使っている SKU のコード（商品そのものを指す参照では空）。 */
export interface Usage {
  table: string;
  label: string;
  count: number;
  skus: string[];
}

/** 「在庫表 2件（SKU A・B）、受注 1件（SKU A）」の形にする。 */
export function describeUsages(usages: Usage[]): string {
  return usages
    .map((u) => {
      const codes = u.skus.length === 0 ? '' : `（SKU ${u.skus.slice(0, 3).join('・')}${u.skus.length > 3 ? ` ほか${u.skus.length - 3}件` : ''}）`;
      return `${u.label} ${u.count}件${codes}`;
    })
    .join('、');
}

export interface ProductListQuery {
  q?: string;
  brand_id?: number;
  include_inactive?: boolean;
  limit: number;
  offset: number;
  /** 原価を返してよいか。SENSITIVE:view を持たない利用者には返さない。 */
  showCost: boolean;
}

/** 原価の欄を落とす。項目そのものを返さないので、画面側で消し忘れることがない。 */
function stripCost<T extends Record<string, unknown>>(row: T, showCost: boolean): T {
  if (showCost) return row;
  const { cost_price: _cost, old_cost_price: _old, is_cost_undecided: _undecided, ...rest } = row;
  return rest as unknown as T;
}

export interface SkuSearchQuery {
  q?: string;
  limit: number;
  /** 取引先を渡すと、その取引先の先方JAN・出荷JAN・専用コードでも引く */
  partner_id?: number;
  /**
   * セット商品（products.is_set）の SKU だけ／以外だけに絞る。
   * セット登録のセット SKU の欄に、セット商品にした商品の SKU だけを出すため（2026-10-09 マスター編②）。
   */
  is_set?: boolean;
}

@Injectable()
export class ProductsService {
  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  async list(query: ProductListQuery): Promise<Paged<Record<string, unknown>>> {
    let base = this.db
      .selectFrom('products as p')
      .leftJoin('brands as b', 'b.id', 'p.brand_id')
      .leftJoin('categories as c', 'c.id', 'p.category_id');

    if (!query.include_inactive) base = base.where('p.is_active', '=', true);
    if (query.brand_id !== undefined) base = base.where('p.brand_id', '=', query.brand_id);
    if (query.q) {
      const like = `%${query.q}%`;
      base = base.where((eb) =>
        eb.or([eb('p.product_code', 'ilike', like), eb('p.product_name', 'ilike', like)]),
      );
    }

    const [items, total] = await Promise.all([
      base
        .select([
          'p.id as id',
          'p.product_code as product_code',
          'p.product_name as product_name',
          'p.set_product_name as set_product_name',
          'b.name as brand_name',
          'c.name as category_name',
          'p.tax_rate as tax_rate',
          'p.carton_qty as carton_qty',
          'p.is_set as is_set',
          'p.cost_price as cost_price',
          'p.old_cost_price as old_cost_price',
          'p.is_cost_undecided as is_cost_undecided',
          'p.is_active as is_active',
          // SKU が何件ぶら下がっているか。一覧から展開するかの判断に使う。
          (eb) =>
            eb
              .selectFrom('skus as s')
              .select(sql<number>`count(*)::int`.as('n'))
              .whereRef('s.product_id', '=', 'p.id')
              .as('sku_count'),
        ])
        .orderBy('p.product_code', 'asc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return {
      items: items.map((r) => stripCost(r as Record<string, unknown>, query.showCost)),
      total: Number(total.n),
      limit: query.limit,
      offset: query.offset,
    };
  }

  /** 商品1件と、その配下の SKU（色・サイズ・入数まで特定した単位）。 */
  async findOne(id: number, showCost: boolean) {
    const product = await this.db
      .selectFrom('products as p')
      .leftJoin('brands as b', 'b.id', 'p.brand_id')
      .leftJoin('categories as c', 'c.id', 'p.category_id')
      .leftJoin('product_classes as pc', 'pc.id', 'p.product_class_id')
      .select([
        'p.id as id',
        'p.product_code as product_code',
        'p.product_name as product_name',
        'p.set_product_name as set_product_name',
        'p.brand_id as brand_id',
        'b.name as brand_name',
        'p.category_id as category_id',
        'c.name as category_name',
        'p.product_class_id as product_class_id',
        'pc.name as product_class_name',
        'p.sort_order as sort_order',
        'p.carton_qty as carton_qty',
        'p.cost_price as cost_price',
        'p.old_cost_price as old_cost_price',
        'p.is_cost_undecided as is_cost_undecided',
        'p.tax_rate as tax_rate',
        'p.is_set as is_set',
        'p.is_active as is_active',
        'p.note as note',
      ])
      .where('p.id', '=', id)
      .executeTakeFirst();

    if (!product) throw new NotFoundException(`商品が見つかりません（ID: ${id}）`);

    const skus = await this.db
      .selectFrom('skus as s')
      .leftJoin('colors as c', 'c.id', 's.color_id')
      .leftJoin('sizes as z', 'z.id', 's.size_id')
      .select([
        's.id as id',
        's.sku_code as sku_code',
        // SKU ごとの商品名。空なら商品の商品名を使う（2026-10-09 マスター編②）
        's.sku_name as sku_name',
        's.jan as jan',
        // 画面はこの詳細の値を起点に保存し直すため、編集できる欄はすべて返す。
        // 返していなかった2項目が、SKU を保存するたびに空で上書きされて消えていた。
        's.fba_jan as fba_jan',
        's.shop_product_code as shop_product_code',
        's.pack_division as pack_division',
        // このSKUだけの原価（サイズ別原価。1001 ご要望）。権限が無い人には下で落とす
        's.cost_price as cost_price',
        's.color_id as color_id',
        's.size_id as size_id',
        'c.code as color_code',
        'c.name as color_name',
        'z.code as size_code',
        'z.name as size_name',
        's.is_active as is_active',
      ])
      .where('s.product_id', '=', id)
      .orderBy('s.sku_code', 'asc')
      .execute();

    return {
      ...stripCost(product as Record<string, unknown>, showCost),
      // SKU の原価も同じ扱い。項目そのものを返さないので、画面側で消し忘れることがない
      skus: skus.map((r) => stripCost(r as Record<string, unknown>, showCost)),
    };
  }

  /**
   * 受注入力で商品を選ぶための検索。
   * SKUコード・JAN・商品名・商品コードのいずれでも引ける。
   * 現場は JAN を読み取ることも商品名で探すこともあるため、入口を分けない。
   */
  async searchSkus(query: SkuSearchQuery) {
    // 取引先が分かっているときは、その取引先の得意先別商品（先方JAN・出荷JAN・専用コード）も一緒に引く。
    // 受注入力で先方JANを打つと出荷JANが出るようにするため（1001 ご要望）。取引先×SKU は1件まで（一意）。
    const partnerId = query.partner_id ?? 0;
    let q = this.db
      .selectFrom('skus as s')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .leftJoin('colors as c', 'c.id', 's.color_id')
      .leftJoin('sizes as z', 'z.id', 's.size_id')
      .leftJoin('partner_products as pp', (j) =>
        j.onRef('pp.sku_id', '=', 's.id').on('pp.partner_id', '=', partnerId).on('pp.is_active', '=', true),
      )
      .where('s.is_active', '=', true)
      .where('p.is_active', '=', true);

    if (query.is_set !== undefined) q = q.where('p.is_set', '=', query.is_set);
    if (query.q) {
      const like = `%${query.q}%`;
      q = q.where((eb) =>
        eb.or([
          eb('s.sku_code', 'ilike', like),
          eb('s.jan', 'ilike', like),
          eb('p.product_code', 'ilike', like),
          eb('p.product_name', 'ilike', like),
          eb('s.sku_name', 'ilike', like),
          eb('pp.partner_jan', 'ilike', like),
          eb('pp.shipping_jan', 'ilike', like),
          eb('pp.partner_product_code', 'ilike', like),
        ]),
      );
    }

    return q
      .select([
        's.id as sku_id',
        's.sku_code as sku_code',
        's.jan as jan',
        'p.id as product_id',
        'p.product_code as product_code',
        'p.product_name as product_name',
        's.sku_name as sku_name',
        // 候補の表示・受注の品名に使う名前（SKU の商品名があればそれ、無ければ商品名）
        skuNameExpr('s', 'p').as('item_name'),
        'p.is_set as is_set',
        'p.tax_rate as tax_rate',
        'c.name as color_name',
        'z.name as size_name',
        'pp.partner_jan as partner_jan',
        'pp.shipping_jan as shipping_jan',
        'pp.partner_product_code as partner_product_code',
      ])
      .orderBy('s.sku_code', 'asc')
      .limit(query.limit)
      .execute();
  }

  /**
   * JANコードの一覧を CSV で出す。
   *
   * ラベル発行や販社への提出に使う。**先頭に BOM を付ける。**付けないと
   * Excel で開いたときに日本語が化け、JANの先頭の 0 も落ちるため、
   * JAN は `="..."` の形にして文字列として読ませる。
   */
  async janExportCsv(includeInactive: boolean): Promise<string> {
    let q = this.db
      .selectFrom('skus as s')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .leftJoin('brands as b', 'b.id', 'p.brand_id')
      .leftJoin('colors as c', 'c.id', 's.color_id')
      .leftJoin('sizes as z', 'z.id', 's.size_id');

    if (!includeInactive) q = q.where('s.is_active', '=', true).where('p.is_active', '=', true);

    const rows = await q
      .select([
        's.sku_code as sku_code',
        's.jan as jan',
        // FBA・ショップの出荷依頼で使うコード（1001 ご要望）
        's.fba_jan as fba_jan',
        's.shop_product_code as shop_product_code',
        'p.product_code as product_code',
        // SKU の商品名があればそれ（2026-10-09 マスター編②）
        skuNameExpr('s', 'p').as('product_name'),
        'b.name as brand_name',
        'c.name as color_name',
        'z.name as size_name',
        's.pack_division as pack_division',
        's.is_active as is_active',
      ])
      .orderBy('s.sku_code', 'asc')
      .execute();

    const header = [
      'SKUコード',
      'JANコード',
      'FBA用JANコード',
      'ショップ商品コード',
      '商品コード',
      '商品名',
      'ブランド',
      'カラー',
      'サイズ',
      '入数区分',
      '有効',
    ];
    const esc = (v: string | null): string => `"${(v ?? '').replace(/"/g, '""')}"`;

    const lines = [header.map((h) => esc(h)).join(',')];
    for (const r of rows) {
      lines.push(
        [
          esc(r.sku_code),
          r.jan ? `"=""${r.jan}"""` : '""',
          r.fba_jan ? `"=""${r.fba_jan}"""` : '""',
          esc(r.shop_product_code),
          esc(r.product_code),
          esc(r.product_name),
          esc(r.brand_name),
          esc(r.color_name),
          esc(r.size_name),
          esc(r.pack_division),
          esc(r.is_active ? '有効' : '無効'),
        ].join(','),
      );
    }

    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  // ==========================================================================
  // 削除（2026-10-09 マスター編②）
  // ==========================================================================

  /**
   * 商品・SKU がどこで使われているかを数える。
   *
   * 参照元は外部キーの定義（pg_constraint）から拾う。表を手で並べると、新しい表が
   * 増えたときに数え漏れて、使われているものを消そうとしてしまうため。
   * 消すと一緒に消える参照（ON DELETE CASCADE・SET NULL）は「使われている」に数えない。
   */
  private async usages(target: 'skus' | 'products', ids: number[], skip: string[] = []): Promise<Usage[]> {
    if (ids.length === 0) return [];
    const fks = await sql<{ table_name: string; column_name: string }>`
      select cl.relname as table_name, a.attname as column_name
        from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_class rf on rf.oid = c.confrelid
        join pg_namespace n on n.oid = rf.relnamespace
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f'
         and rf.relname = ${target}
         and n.nspname = current_schema()
         and array_length(c.conkey, 1) = 1
         and c.confdeltype not in ('c', 'n', 'd')
       order by cl.relname, a.attname`.execute(this.db);

    const codes =
      target === 'skus'
        ? new Map(
            (await this.db.selectFrom('skus').select(['id', 'sku_code']).where('id', 'in', ids).execute()).map((r) => [
              Number(r.id),
              r.sku_code,
            ]),
          )
        : new Map<number, string>();

    const out: Usage[] = [];
    for (const fk of fks.rows) {
      // 商品の SKU そのもの（skus.product_id）は、商品と一緒に消すので使用に数えない
      if (target === 'products' && fk.table_name === 'skus') continue;
      if (skip.includes(fk.table_name)) continue;
      // 表・列の名前はデータベースの定義から取ったもの。利用者の入力は値としてのみ渡る
      const rows = await sql<{ id: string; n: number }>`
        select ${sql.ref(fk.column_name)} as id, count(*)::int as n
          from ${sql.table(fk.table_name)}
         where ${sql.ref(fk.column_name)} in (${sql.join(ids)})
         group by 1
         order by 1`.execute(this.db);
      if (rows.rows.length === 0) continue;
      const prev = out.find((u) => u.table === fk.table_name);
      const count = rows.rows.reduce((a, r) => a + Number(r.n), 0);
      const skus = rows.rows.map((r) => codes.get(Number(r.id))).filter((c): c is string => !!c);
      if (prev) {
        prev.count += count;
        prev.skus = [...new Set([...prev.skus, ...skus])];
      } else {
        out.push({ table: fk.table_name, label: USAGE_LABELS[fk.table_name] ?? fk.table_name, count, skus });
      }
    }
    return out;
  }

  /**
   * 商品を消す。SKU がどこにも使われていなければ SKU ごと消す。
   *
   * 以前は SKU を残したまま商品だけを消そうとしていたため、SKU のある商品は
   * 外部キーで必ず断られ「受注等で使用していないのに何故？」となっていた。
   * 使われているときは、どこで使われているか（在庫表・受注 など）を文言に出して断る。
   */
  async removeProduct(id: number): Promise<{ id: number; deleted: true; skus: number }> {
    const product = await this.db.selectFrom('products').select(['id']).where('id', '=', id).executeTakeFirst();
    if (!product) throw new NotFoundException(`商品が見つかりません（ID: ${id}）`);
    const skuIds = (await this.db.selectFrom('skus').select('id').where('product_id', '=', id).execute()).map((r) =>
      Number(r.id),
    );

    const used = [...(await this.usages('products', [id])), ...(await this.usages('skus', skuIds))];
    if (used.length > 0) {
      throw new ConflictException(
        `この商品は次で使われているため削除できません：${describeUsages(used)}。` +
          `一覧から外したいときは「使わない」をお使いください`,
      );
    }

    try {
      await this.db.transaction().execute(async (trx) => {
        await trx.deleteFrom('skus').where('product_id', '=', id).execute();
        await trx.deleteFrom('products').where('id', '=', id).execute();
      });
    } catch (e) {
      // 数えたあとに別の人が使い始めた場合。外部キーが最後の砦になる
      if ((e as { code?: string }).code === '23503') {
        throw new ConflictException('この商品は使われ始めたため削除できません。画面を開き直してください');
      }
      throw e;
    }
    return { id, deleted: true, skus: skuIds.length };
  }

  /**
   * SKU を1行消す（商品の編集画面の SKU 表の「削除」。2026-10-09 マスター編②）。
   * 使われていれば、どこで使われているかを出して断る。
   */
  async removeSku(id: number): Promise<{ id: number; deleted: true }> {
    const sku = await this.db.selectFrom('skus').select(['id', 'sku_code']).where('id', '=', id).executeTakeFirst();
    if (!sku) throw new NotFoundException(`SKU が見つかりません（ID: ${id}）`);

    const used = await this.usages('skus', [id]);
    if (used.length > 0) {
      throw new ConflictException(
        `SKU ${sku.sku_code} は次で使われているため削除できません：${describeUsages(used)}。` +
          `使わなくなった SKU は「有効」の印を外してください`,
      );
    }
    try {
      await this.db.deleteFrom('skus').where('id', '=', id).execute();
    } catch (e) {
      if ((e as { code?: string }).code === '23503') {
        throw new ConflictException(`SKU ${sku.sku_code} は使われ始めたため削除できません。画面を開き直してください`);
      }
      throw e;
    }
    return { id, deleted: true };
  }

  /**
   * セット登録を構成ごと消す（2026-10-09 マスター編②）。
   *
   * セット SKU が受注・取込・引当在庫などで使われていれば断る。構成を消すと、
   * 未出荷の受注がセットを構成品に展開できなくなるため。
   * 得意先別商品・ほかのセットの構成品になっていることは、構成を消しても困らないので数えない。
   * セット SKU（商品マスタ）そのものは残す。
   */
  async removeSet(id: number): Promise<{ id: number; deleted: true }> {
    const header = await this.db
      .selectFrom('set_headers as h')
      .innerJoin('skus as s', 's.id', 'h.sku_id')
      .select(['h.id as id', 'h.sku_id as sku_id', 's.sku_code as sku_code'])
      .where('h.id', '=', id)
      .executeTakeFirst();
    if (!header) throw new NotFoundException(`セット登録が見つかりません（ID: ${id}）`);

    const used = await this.usages('skus', [Number(header.sku_id)], ['set_headers', 'set_components', 'partner_products']);
    if (used.length > 0) {
      throw new ConflictException(
        `セット ${header.sku_code} は次で使われているため削除できません：${describeUsages(used)}。` +
          `構成を変えるときは「編集」で登録し直してください`,
      );
    }
    // 構成品（set_components）は外部キーの ON DELETE CASCADE で一緒に消える
    await this.db.deleteFrom('set_headers').where('id', '=', id).execute();
    return { id, deleted: true };
  }
}
