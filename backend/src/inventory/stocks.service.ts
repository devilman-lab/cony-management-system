import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';

import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { Paged } from '../masters/partners.service';

export interface StockListQuery {
  q?: string;
  warehouse_id?: number;
  /** 有効在庫が残っているものだけ。受注時の引き当て可否を見るとき。 */
  available_only?: boolean;
  limit: number;
  offset: number;
}

/** 在庫表で何を返してよいか。権限から決める（stocks.controller.ts）。 */
export interface StockVisibility {
  /** 実在庫・引当済を返す。在庫を更新できる人（S-01:update）だけ。 */
  showQty: boolean;
  /** 原価を返す。機微項目の権限（SENSITIVE:view）がある人だけ。 */
  showCost: boolean;
}

export interface MovementListQuery {
  sku_id?: number;
  warehouse_id?: number;
  movement_type?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

@Injectable()
export class StocksService {
  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  /**
   * 在庫表。商品×倉庫×ロット×品質区分の単位で持つ。
   *
   * 有効在庫（qty_available）はデータベースの生成列で、
   * 実在庫−引当済 が常に成り立つ。ここで足し引きはしない。
   *
   * 2026-10-09 在庫編のご要望:
   *  - 閲覧だけの人には有効在庫だけを見せる（Z-02）。画面で隠すだけだと API を直接呼べば
   *    見えてしまうので、実在庫・引当済の項目そのものを返さない。
   *  - セット商品は在庫を持たないので出さない（Z-03）。「セット商品」にした商品の SKU と、
   *    セット登録（set_headers）にある SKU の両方を外す（片方だけ付いた古いデータもあるため）。
   */
  async list(query: StockListQuery, vis: StockVisibility): Promise<Paged<Record<string, unknown>>> {
    let base = this.db
      .selectFrom('stocks as s')
      .innerJoin('skus as sk', 'sk.id', 's.sku_id')
      .innerJoin('products as p', 'p.id', 'sk.product_id')
      .innerJoin('warehouses as w', 'w.id', 's.warehouse_id')
      .innerJoin('codes as q', 'q.id', 's.quality_code_id')
      .leftJoin('product_classes as pc', 'pc.id', 'p.product_class_id')
      .leftJoin('colors as c', 'c.id', 'sk.color_id')
      .leftJoin('sizes as z', 'z.id', 'sk.size_id')
      .where('p.is_set', '=', false)
      .where((eb) =>
        eb.not(eb.exists(eb.selectFrom('set_headers as sh').select('sh.id').whereRef('sh.sku_id', '=', 'sk.id'))),
      );

    if (query.warehouse_id !== undefined) {
      base = base.where('s.warehouse_id', '=', query.warehouse_id);
    }
    if (query.available_only) {
      base = base.where('s.qty_available', '>', sql<string>`0`);
    }
    if (query.q) {
      const like = `%${query.q}%`;
      base = base.where((eb) =>
        eb.or([
          eb('sk.sku_code', 'ilike', like),
          eb('sk.jan', 'ilike', like),
          eb('sk.sku_name', 'ilike', like),
          eb('p.product_code', 'ilike', like),
          eb('p.product_name', 'ilike', like),
          eb('pc.code', 'ilike', like),
          eb('pc.name', 'ilike', like),
        ]),
      );
    }

    const [rows, total] = await Promise.all([
      base
        .select([
          's.id as id',
          'sk.id as sku_id',
          'pc.code as product_class_code',
          'pc.name as product_class_name',
          'sk.sku_code as sku_code',
          'sk.jan as jan',
          'p.product_code as product_code',
          // SKU ごとの商品名があればそれ、無ければ商品の商品名（マスター編② M-10）
          sql<string>`coalesce(nullif(sk.sku_name, ''), p.product_name)`.as('product_name'),
          'c.name as color_name',
          'z.name as size_name',
          'w.id as warehouse_id',
          'w.warehouse_code as warehouse_code',
          'w.short_name as warehouse_name',
          'q.code as quality_code',
          'q.name as quality_name',
          's.expiry_date as expiry_date',
          's.note as note',
          's.qty_on_hand as qty_on_hand',
          's.qty_allocated as qty_allocated',
          's.qty_available as qty_available',
          // SKU だけの原価があればそれ、無ければ商品の原価（商品マスタと同じ決め方）
          sql<string>`coalesce(sk.cost_price, p.cost_price)`.as('cost_price'),
        ])
        .orderBy(sql`pc.code`, sql`asc nulls last`)
        .orderBy('sk.sku_code', 'asc')
        .orderBy('w.warehouse_code', 'asc')
        .orderBy('s.id', 'asc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    const items = rows.map(({ qty_on_hand, qty_allocated, cost_price, ...rest }) => ({
      ...rest,
      ...(vis.showQty ? { qty_on_hand, qty_allocated } : {}),
      ...(vis.showCost ? { cost_price } : {}),
    }));

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  /**
   * 在庫表の備考だけを直す（在庫編 Z-05）。
   * 数量はここでは触らない。数量を動かすのは入荷・出荷・在庫調整だけ（移動履歴を必ず残すため）。
   */
  async updateNote(id: number, note: string | null, userId: number) {
    const row = await this.db
      .updateTable('stocks')
      .set({ note: note && note.trim() !== '' ? note : null, updated_by: userId, updated_at: new Date() })
      .where('id', '=', id)
      .returning(['id', 'note'])
      .executeTakeFirst();
    if (!row) throw new NotFoundException(`在庫の行が見つかりません（ID: ${id}）`);
    return row;
  }

  /**
   * 入出荷履歴（機能ID S-05）。
   * 在庫移動履歴は追記専用で、あとから書き換えも削除もできない。
   * 「いつ・どの伝票で・いくつ動いたか」を必ず追える。
   */
  async movements(query: MovementListQuery): Promise<Paged<Record<string, unknown>>> {
    let base = this.db
      .selectFrom('stock_movements as m')
      .innerJoin('stocks as s', 's.id', 'm.stock_id')
      .innerJoin('skus as sk', 'sk.id', 's.sku_id')
      .innerJoin('products as p', 'p.id', 'sk.product_id')
      .innerJoin('warehouses as w', 'w.id', 's.warehouse_id')
      .leftJoin('users as u', 'u.id', 'm.created_by');

    if (query.sku_id !== undefined) base = base.where('s.sku_id', '=', query.sku_id);
    if (query.warehouse_id !== undefined) base = base.where('s.warehouse_id', '=', query.warehouse_id);
    if (query.movement_type) base = base.where('m.movement_type', '=', query.movement_type);
    if (query.from) base = base.where('m.moved_at', '>=', new Date(`${query.from}T00:00:00+09:00`));
    if (query.to) base = base.where('m.moved_at', '<=', new Date(`${query.to}T23:59:59+09:00`));

    const [items, total] = await Promise.all([
      base
        .select([
          'm.id as id',
          'm.moved_at as moved_at',
          'm.movement_type as movement_type',
          'm.ref_table as ref_table',
          'm.ref_id as ref_id',
          'm.qty as qty',
          'm.qty_before as qty_before',
          'm.qty_after as qty_after',
          'sk.sku_code as sku_code',
          // SKU ごとの商品名があればそれ、無ければ商品名（2026-10-09 マスター編②）
          sql<string>`coalesce(nullif(btrim(sk.sku_name), ''), p.product_name)`.as('product_name'),
          'w.short_name as warehouse_name',
          'u.name as user_name',
        ])
        .orderBy('m.moved_at', 'desc')
        .orderBy('m.id', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  /**
   * 1つの SKU の在庫を倉庫別に集計する。受注入力の横に出す想定。
   * 金額と同じく数量も文字列のまま返し、合計は SQL で計算する。
   * 閲覧だけの人には在庫表と同じく有効在庫だけを返す（Z-02。抜け道を作らないため）。
   */
  async summaryBySku(skuId: number, showQty = true) {
    const rows = await this.db
      .selectFrom('stocks as s')
      .innerJoin('warehouses as w', 'w.id', 's.warehouse_id')
      .innerJoin('codes as q', 'q.id', 's.quality_code_id')
      .select([
        'w.warehouse_code as warehouse_code',
        'w.short_name as warehouse_name',
        'q.name as quality_name',
        sql<string>`sum(s.qty_on_hand)`.as('qty_on_hand'),
        sql<string>`sum(s.qty_allocated)`.as('qty_allocated'),
        sql<string>`sum(s.qty_available)`.as('qty_available'),
      ])
      .where('s.sku_id', '=', skuId)
      .groupBy(['w.warehouse_code', 'w.short_name', 'q.name'])
      .orderBy('w.warehouse_code', 'asc')
      .execute();

    const totals = await this.db
      .selectFrom('stocks')
      .select([
        sql<string>`coalesce(sum(qty_on_hand), 0)`.as('qty_on_hand'),
        sql<string>`coalesce(sum(qty_allocated), 0)`.as('qty_allocated'),
        sql<string>`coalesce(sum(qty_available), 0)`.as('qty_available'),
      ])
      .where('sku_id', '=', skuId)
      .executeTakeFirstOrThrow();

    if (showQty) return { sku_id: skuId, total: totals, by_warehouse: rows };
    return {
      sku_id: skuId,
      total: { qty_available: totals.qty_available },
      by_warehouse: rows.map((r) => ({
        warehouse_code: r.warehouse_code,
        warehouse_name: r.warehouse_name,
        quality_name: r.quality_name,
        qty_available: r.qty_available,
      })),
    };
  }
}
