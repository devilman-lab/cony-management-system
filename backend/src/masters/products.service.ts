import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';

import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { Paged } from './partners.service';

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
  const { cost_price: _cost, is_cost_undecided: _undecided, ...rest } = row;
  return rest as unknown as T;
}

export interface SkuSearchQuery {
  q?: string;
  limit: number;
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
        'b.name as brand_name',
        'c.name as category_name',
        'pc.name as product_class_name',
        'p.carton_qty as carton_qty',
        'p.cost_price as cost_price',
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
        's.jan as jan',
        's.pack_division as pack_division',
        'c.code as color_code',
        'c.name as color_name',
        'z.code as size_code',
        'z.name as size_name',
        's.is_active as is_active',
      ])
      .where('s.product_id', '=', id)
      .orderBy('s.sku_code', 'asc')
      .execute();

    return { ...stripCost(product as Record<string, unknown>, showCost), skus };
  }

  /**
   * 受注入力で商品を選ぶための検索。
   * SKUコード・JAN・商品名・商品コードのいずれでも引ける。
   * 現場は JAN を読み取ることも商品名で探すこともあるため、入口を分けない。
   */
  async searchSkus(query: SkuSearchQuery) {
    let q = this.db
      .selectFrom('skus as s')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .leftJoin('colors as c', 'c.id', 's.color_id')
      .leftJoin('sizes as z', 'z.id', 's.size_id')
      .where('s.is_active', '=', true)
      .where('p.is_active', '=', true);

    if (query.q) {
      const like = `%${query.q}%`;
      q = q.where((eb) =>
        eb.or([
          eb('s.sku_code', 'ilike', like),
          eb('s.jan', 'ilike', like),
          eb('p.product_code', 'ilike', like),
          eb('p.product_name', 'ilike', like),
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
        'p.is_set as is_set',
        'p.tax_rate as tax_rate',
        'c.name as color_name',
        'z.name as size_name',
      ])
      .orderBy('s.sku_code', 'asc')
      .limit(query.limit)
      .execute();
  }
}
