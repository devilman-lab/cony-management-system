import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';

import { KYSELY, type ConyDatabase } from '../db/database.module';

export interface PartnerListQuery {
  q?: string;
  role?: 'customer' | 'supplier';
  include_inactive?: boolean;
  limit: number;
  offset: number;
}

export interface PartnerListItem {
  id: number;
  partner_code: string;
  name1: string;
  short_name: string | null;
  is_customer: boolean;
  is_supplier: boolean;
  closing_day: number | null;
  default_trade_type: string | null;
  /** 既定の販売担当。受注入力で取引先を選んだときに引き継ぐ。 */
  sales_staff_id: number | null;
  is_active: boolean;
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

@Injectable()
export class PartnersService {
  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  async list(query: PartnerListQuery): Promise<Paged<PartnerListItem>> {
    let base = this.db.selectFrom('partners');

    if (!query.include_inactive) {
      base = base.where('is_active', '=', true);
    }
    if (query.role === 'customer') {
      base = base.where('is_customer', '=', true);
    } else if (query.role === 'supplier') {
      base = base.where('is_supplier', '=', true);
    }
    if (query.q) {
      // 取引先コード・正式名称・略称のいずれかで部分一致
      const like = `%${query.q}%`;
      base = base.where((eb) =>
        eb.or([
          eb('partner_code', 'ilike', like),
          eb('name1', 'ilike', like),
          eb('short_name', 'ilike', like),
        ]),
      );
    }

    const [rows, totalRow] = await Promise.all([
      base
        .select([
          'id',
          'partner_code',
          'name1',
          'short_name',
          'is_customer',
          'is_supplier',
          'closing_day',
          'default_trade_type',
          'sales_staff_id',
          'is_active',
        ])
        .orderBy('sort_order', sql`asc nulls last`)
        .orderBy('partner_code', 'asc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return {
      items: rows,
      total: Number(totalRow.n),
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * 1件の詳細。原価や仕入単価と違い取引先自体に機微な項目はないが、
   * 納品先は件数が多くなりうるので同時には返さない。
   */
  async findOne(id: number) {
    const partner = await this.db
      .selectFrom('partners')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!partner) {
      throw new NotFoundException(`取引先が見つかりません（ID: ${id}）`);
    }
    return partner;
  }

  /** その取引先にぶら下がる納品先。受注の入力で使う。 */
  async deliveryDestinations(partnerId: number) {
    return this.db
      .selectFrom('delivery_destinations')
      .select(['id', 'delivery_code', 'name', 'partner_delivery_no', 'default_warehouse_id', 'is_active'])
      .where('partner_id', '=', partnerId)
      .where('is_active', '=', true)
      .orderBy('sort_order', sql`asc nulls last`)
      .orderBy('delivery_code', 'asc')
      .execute();
  }
}
