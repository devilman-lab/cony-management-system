import { Inject, Injectable } from '@nestjs/common';
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
   */
  async list(query: StockListQuery): Promise<Paged<Record<string, unknown>>> {
    let base = this.db
      .selectFrom('stocks as s')
      .innerJoin('skus as sk', 'sk.id', 's.sku_id')
      .innerJoin('products as p', 'p.id', 'sk.product_id')
      .innerJoin('warehouses as w', 'w.id', 's.warehouse_id')
      .innerJoin('codes as q', 'q.id', 's.quality_code_id')
      .leftJoin('colors as c', 'c.id', 'sk.color_id')
      .leftJoin('sizes as z', 'z.id', 'sk.size_id');

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
          eb('p.product_code', 'ilike', like),
          eb('p.product_name', 'ilike', like),
        ]),
      );
    }

    const [items, total] = await Promise.all([
      base
        .select([
          's.id as id',
          'sk.id as sku_id',
          'sk.sku_code as sku_code',
          'sk.jan as jan',
          'p.product_code as product_code',
          'p.product_name as product_name',
          'c.name as color_name',
          'z.name as size_name',
          'w.id as warehouse_id',
          'w.warehouse_code as warehouse_code',
          'w.short_name as warehouse_name',
          'q.name as quality_name',
          's.lot_no as lot_no',
          's.expiry_date as expiry_date',
          's.qty_on_hand as qty_on_hand',
          's.qty_allocated as qty_allocated',
          's.qty_available as qty_available',
        ])
        .orderBy('p.product_code', 'asc')
        .orderBy('sk.sku_code', 'asc')
        .orderBy('w.warehouse_code', 'asc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
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
          'p.product_name as product_name',
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
   */
  async summaryBySku(skuId: number) {
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

    return { sku_id: skuId, total: totals, by_warehouse: rows };
  }
}
