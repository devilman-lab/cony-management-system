import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';

import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { Paged } from '../masters/partners.service';

export interface SalesScheduleInput {
  partner_id?: number | null;
  sales_category_id?: number | null;
  sku_id?: number | null;
  planned_sales_month?: string | null;
  planned_arrival_month?: string | null;
  planned_qty?: string | null;
  note?: string | null;
}

export interface SalesScheduleQuery {
  partner_id?: number;
  sku_id?: number;
  /** YYYY-MM。その月の予定だけを返す。 */
  month?: string;
  limit: number;
  offset: number;
}

/**
 * 販売予定（販売スケジュール）。
 *
 * 「いつ・どの得意先に・どのSKUを・いくつ」出す見込みかを持つ。
 * 在庫（stocks.planned_sales_month／planned_arrival_month）と同じ考え方の
 * 予定表で、引当も在庫も動かさない。
 */
@Injectable()
export class SalesSchedulesService {
  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  async list(query: SalesScheduleQuery): Promise<Paged<Record<string, unknown>>> {
    let base = this.db
      .selectFrom('sales_schedules as ss')
      .leftJoin('partners as p', 'p.id', 'ss.partner_id')
      .leftJoin('skus as s', 's.id', 'ss.sku_id')
      .leftJoin('products as pr', 'pr.id', 's.product_id')
      .leftJoin('sales_categories as sc', 'sc.id', 'ss.sales_category_id');

    if (query.partner_id !== undefined) base = base.where('ss.partner_id', '=', query.partner_id);
    if (query.sku_id !== undefined) base = base.where('ss.sku_id', '=', query.sku_id);
    if (query.month) {
      // 月初に丸めて比べる。日にちは運用で入れないが、入っていても拾えるようにする。
      base = base.where(
        sql<boolean>`date_trunc('month', ss.planned_sales_month) = date_trunc('month', ${`${query.month}-01`}::date)`,
      );
    }

    const [items, total] = await Promise.all([
      base
        .select([
          'ss.id as id',
          'ss.partner_id as partner_id',
          'p.name1 as partner_name',
          'ss.sales_category_id as sales_category_id',
          'sc.name as sales_category_name',
          'ss.sku_id as sku_id',
          's.sku_code as sku_code',
          'pr.product_name as product_name',
          'ss.planned_sales_month as planned_sales_month',
          'ss.planned_arrival_month as planned_arrival_month',
          'ss.planned_qty as planned_qty',
          'ss.note as note',
        ])
        .orderBy('ss.planned_sales_month', sql`desc nulls last`)
        .orderBy('ss.id', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  async create(input: SalesScheduleInput, userId: number) {
    return this.db
      .insertInto('sales_schedules')
      .values({ ...this.normalize(input), created_by: userId, updated_by: userId })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(id: number, input: SalesScheduleInput, userId: number) {
    const clean = Object.fromEntries(
      Object.entries(this.normalize(input)).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(clean).length === 0) {
      throw new BadRequestException('更新する項目がありません');
    }

    const row = await this.db
      .updateTable('sales_schedules')
      .set({ ...clean, updated_by: userId, updated_at: new Date() } as never)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!row) throw new NotFoundException(`販売予定が見つかりません（ID: ${id}）`);
    return row;
  }

  /** 予定は伝票ではないので、消してよい。 */
  async remove(id: number) {
    const row = await this.db
      .deleteFrom('sales_schedules')
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();

    if (!row) throw new NotFoundException(`販売予定が見つかりません（ID: ${id}）`);
    return { id: row.id, deleted: true };
  }

  /** 月だけを入れていただく想定なので、YYYY-MM は月初として扱う。 */
  private normalize(input: SalesScheduleInput): SalesScheduleInput {
    const month = (v: string | null | undefined): string | null | undefined =>
      typeof v === 'string' && /^\d{4}-\d{2}$/.test(v) ? `${v}-01` : v;

    return {
      ...input,
      planned_sales_month: month(input.planned_sales_month),
      planned_arrival_month: month(input.planned_arrival_month),
    };
  }
}
