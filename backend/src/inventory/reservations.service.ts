import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { DB } from '../db/schema';

/**
 * 確保数（貴社の呼び方では「引当在庫」）。
 *
 * 期間・販売カテゴリー・商品（SKU）ごとに月初に数量を登録し、受注登録のたびに
 * その枠から減っていく（9/17 ご確認②）。取引先を指定した枠はその取引先だけに、
 * 指定しない枠はその販売カテゴリー全体に効く。
 *
 * 枠は期間で持つので、月末を過ぎれば自動的に効かなくなり、翌月1日からは翌月の
 * 枠が使われる。夜間処理はない。
 *
 * 棚の在庫（有効在庫）とは別の枠。受注登録では両方を見る。
 */
@Injectable()
export class ReservationsService {
  constructor(@Inject(KYSELY) private readonly db: ConyDatabase) {}

  /**
   * 受注の明細を枠から減らす。受注の登録・修正の直後に同じトランザクションで呼ぶ。
   * strict=false（CSV取込）では、枠を超えても止めずに知らせるだけにする。
   * 枠が登録されていない商品はそのまま通す（枠は任意）。
   */
  async consume(
    trx: Transaction<DB>,
    orderId: number,
    opts: { strict: boolean },
  ): Promise<string[]> {
    const order = await trx
      .selectFrom('sales_orders')
      .select(['id', 'partner_id', 'sales_category_id', 'order_date'])
      .where('id', '=', orderId)
      .executeTakeFirstOrThrow();

    const lines = await trx
      .selectFrom('sales_order_lines as l')
      .leftJoin('skus as s', 's.id', 'l.sku_id')
      .select(['l.id as id', 'l.line_no as line_no', 'l.sku_id as sku_id', 'l.qty as qty', 'l.item_name as item_name', 's.sku_code as sku_code'])
      .where('l.sales_order_id', '=', orderId)
      .where('l.is_stock_target', '=', true)
      .where('l.reservation_id', 'is', null)
      .execute();

    const warnings: string[] = [];
    const over: string[] = [];

    for (const line of lines) {
      if (!line.sku_id || Number(line.qty) <= 0) continue;

      // 取引先を指定した枠を優先し、なければ販売カテゴリー全体の枠。
      const frame = await trx
        .selectFrom('reservations')
        .select(['id', 'reserved_qty', 'consumed_qty', 'partner_id'])
        .where('sales_category_id', '=', order.sales_category_id)
        .where('sku_id', '=', line.sku_id)
        .where('period_from', '<=', order.order_date)
        .where('period_to', '>=', order.order_date)
        .where((eb) => eb.or([eb('partner_id', '=', order.partner_id), eb('partner_id', 'is', null)]))
        .orderBy(sql`partner_id nulls last`)
        .forUpdate()
        .executeTakeFirst();

      if (!frame) continue;

      const remaining = Number(frame.reserved_qty) - Number(frame.consumed_qty);
      const need = Number(line.qty);
      if (need > remaining) {
        const msg = `${line.sku_code ?? ''}（${line.item_name}）必要 ${need} / 引当在庫の残り ${remaining}`;
        if (opts.strict) over.push(msg);
        else warnings.push(`${line.line_no}行目：引当在庫の枠を超えています（${msg}）`);
        continue;
      }

      await trx
        .updateTable('reservations')
        .set({ consumed_qty: sql<string>`consumed_qty + ${line.qty}::numeric`, updated_at: new Date() })
        .where('id', '=', frame.id)
        .execute();
      await trx
        .updateTable('sales_order_lines')
        .set({ reservation_id: frame.id })
        .where('id', '=', line.id)
        .execute();
    }

    if (over.length > 0) {
      throw new BadRequestException({
        message: '引当在庫（販売カテゴリーの枠）を超えています。枠を増やしてから登録してください',
        over,
      });
    }
    return warnings;
  }

  /** 受注の明細が減らした分を枠に戻す。受注の修正・取消の前に呼ぶ。 */
  async restore(trx: Transaction<DB>, orderId: number): Promise<number> {
    const lines = await trx
      .selectFrom('sales_order_lines')
      .select(['id', 'qty', 'reservation_id'])
      .where('sales_order_id', '=', orderId)
      .where('reservation_id', 'is not', null)
      .execute();

    for (const line of lines) {
      await trx
        .updateTable('reservations')
        .set({ consumed_qty: sql<string>`greatest(consumed_qty - ${line.qty}::numeric, 0)`, updated_at: new Date() })
        .where('id', '=', line.reservation_id as number)
        .execute();
      await trx.updateTable('sales_order_lines').set({ reservation_id: null }).where('id', '=', line.id).execute();
    }
    return lines.length;
  }

  async update(
    id: number,
    values: { reserved_qty?: string; period_to?: string; note?: string | null },
    userId: number,
  ) {
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    if (Object.keys(clean).length === 0) throw new BadRequestException('更新する項目がありません');

    const row = await this.db
      .updateTable('reservations')
      .set({ ...clean, updated_by: userId, updated_at: new Date() } as never)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!row) throw new NotFoundException(`確保数が見つかりません（ID: ${id}）`);
    if (Number(row.reserved_qty) < Number(row.consumed_qty)) {
      throw new BadRequestException(
        `すでに ${row.consumed_qty} 使われているため、${row.reserved_qty} には減らせません`,
      );
    }
    return row;
  }

  /** まだ受注に使われていない枠だけ消せる。 */
  async remove(id: number) {
    const row = await this.db
      .selectFrom('reservations')
      .select(['id', 'consumed_qty'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException(`確保数が見つかりません（ID: ${id}）`);
    if (Number(row.consumed_qty) > 0) {
      throw new BadRequestException('すでに受注で使われている枠は消せません。数量を直してください');
    }
    await this.db.deleteFrom('reservations').where('id', '=', id).execute();
    return { id, deleted: true };
  }

  /**
   * 前月（任意の月）の枠を翌月分として複写する。毎月の登録を数量の見直しだけで済ませるため。
   * 複写先の月に同じ枠がすでにあれば飛ばす。期間は複写先の 1日〜末日にする。
   */
  async copyMonth(input: { from_month: string; to_month: string }, userId: number) {
    const [fy, fm] = input.from_month.split('-').map(Number);
    const [ty, tm] = input.to_month.split('-').map(Number);
    const fromStart = `${input.from_month}-01`;
    const fromEnd = `${input.from_month}-${String(new Date(Date.UTC(fy, fm, 0)).getUTCDate()).padStart(2, '0')}`;
    const toStart = `${input.to_month}-01`;
    const toEnd = `${input.to_month}-${String(new Date(Date.UTC(ty, tm, 0)).getUTCDate()).padStart(2, '0')}`;

    return this.db.transaction().execute(async (trx) => {
      const sources = await trx
        .selectFrom('reservations')
        .select(['partner_id', 'sales_category_id', 'sku_id', 'reserved_qty', 'note'])
        .where('period_from', '>=', fromStart)
        .where('period_from', '<=', fromEnd)
        .execute();

      let copied = 0;
      let skipped = 0;
      for (const s of sources) {
        const exists = await trx
          .selectFrom('reservations')
          .select('id')
          .where(sql<boolean>`coalesce(partner_id, 0) = coalesce(${s.partner_id}::bigint, 0)`)
          .where('sales_category_id', '=', s.sales_category_id)
          .where('sku_id', '=', s.sku_id)
          .where('period_from', '=', toStart)
          .executeTakeFirst();
        if (exists) {
          skipped += 1;
          continue;
        }
        await trx
          .insertInto('reservations')
          .values({
            partner_id: s.partner_id,
            sales_category_id: s.sales_category_id,
            sku_id: s.sku_id,
            period_from: toStart,
            period_to: toEnd,
            reserved_qty: s.reserved_qty,
            consumed_qty: '0',
            note: s.note,
            created_by: userId,
            updated_by: userId,
          })
          .execute();
        copied += 1;
      }
      return { from_month: input.from_month, to_month: input.to_month, copied, skipped };
    });
  }
}
