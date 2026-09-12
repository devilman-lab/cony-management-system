import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';

import { NumberingService } from '../common/numbering.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { Paged } from '../masters/partners.service';
import { StockLedgerService } from './stock-ledger.service';

export interface ReceiptLineInput {
  line_no: number;
  sku_id: number;
  qty: string;
  lot_no?: string | null;
  expiry_date?: string | null;
  cost_price?: string | null;
}

export interface CreateReceiptInput {
  warehouse_id: number;
  supplier_partner_id?: number | null;
  planned_date?: string | null;
  note?: string | null;
  lines: ReceiptLineInput[];
}

export interface ReceiptListQuery {
  status?: string;
  warehouse_id?: number;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

/** 機能ID S-03 入荷登録 */
@Injectable()
export class ReceiptsService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly numbering: NumberingService,
    private readonly ledger: StockLedgerService,
  ) {}

  async create(input: CreateReceiptInput, userId: number) {
    return this.db.transaction().execute(async (trx) => {
      const receiptNo = await this.numbering.next(trx, 'receipt');

      const receipt = await trx
        .insertInto('receipts')
        .values({
          receipt_no: receiptNo,
          warehouse_id: input.warehouse_id,
          supplier_partner_id: input.supplier_partner_id ?? null,
          planned_date: input.planned_date ?? null,
          status: '指示',
          note: input.note ?? null,
          created_by: userId,
          updated_by: userId,
        })
        .returning(['id', 'receipt_no'])
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('receipt_lines')
        .values(
          input.lines.map((l) => ({
            receipt_id: receipt.id,
            line_no: l.line_no,
            sku_id: l.sku_id,
            qty: l.qty,
            lot_no: l.lot_no ?? null,
            expiry_date: l.expiry_date ?? null,
            cost_price: l.cost_price ?? null,
            created_by: userId,
          })),
        )
        .execute();

      return receipt;
    });
  }

  /**
   * 入荷確定。ここで実在庫が増える。
   * 在庫表にまだ無い商品は、この時点で行が作られる（現行と同じ動き）。
   */
  async receive(id: number, receivedDate: string | null, userId: number) {
    return this.db.transaction().execute(async (trx) => {
      const receipt = await trx
        .selectFrom('receipts')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!receipt) throw new NotFoundException(`入荷が見つかりません（ID: ${id}）`);
      if (receipt.status === '入荷済') throw new ConflictException('すでに入荷済みです');
      if (receipt.status === '取消') throw new ConflictException('取り消された入荷です');

      const lines = await trx
        .selectFrom('receipt_lines')
        .select(['id', 'sku_id', 'qty', 'lot_no'])
        .where('receipt_id', '=', id)
        .orderBy('line_no', 'asc')
        .execute();

      if (lines.length === 0) throw new ConflictException('入荷明細がありません');

      for (const line of lines) {
        const stockId = await this.ledger.findOrCreate(
          trx,
          { sku_id: line.sku_id, warehouse_id: receipt.warehouse_id, lot_no: line.lot_no, quality: 'GOOD' },
          userId,
        );
        await this.ledger.apply(trx, stockId, line.qty, '入荷', { table: 'receipts', id }, userId);
      }

      await trx
        .updateTable('receipts')
        .set({
          status: '入荷済',
          received_date: receivedDate ?? sql<string>`current_date`,
          updated_by: userId,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .execute();

      return { id, receipt_no: receipt.receipt_no, status: '入荷済', lines: lines.length };
    });
  }

  async list(query: ReceiptListQuery): Promise<Paged<Record<string, unknown>>> {
    let base = this.db
      .selectFrom('receipts as r')
      .innerJoin('warehouses as w', 'w.id', 'r.warehouse_id')
      .leftJoin('partners as p', 'p.id', 'r.supplier_partner_id');

    if (query.status) base = base.where('r.status', '=', query.status);
    if (query.warehouse_id !== undefined) base = base.where('r.warehouse_id', '=', query.warehouse_id);
    if (query.from) base = base.where('r.planned_date', '>=', query.from);
    if (query.to) base = base.where('r.planned_date', '<=', query.to);

    const [items, total] = await Promise.all([
      base
        .select([
          'r.id as id',
          'r.receipt_no as receipt_no',
          'r.status as status',
          'r.planned_date as planned_date',
          'r.received_date as received_date',
          'w.short_name as warehouse_name',
          'p.name1 as supplier_name',
          (eb) =>
            eb
              .selectFrom('receipt_lines as l')
              .select(sql<string>`coalesce(sum(l.qty), 0)`.as('q'))
              .whereRef('l.receipt_id', '=', 'r.id')
              .as('total_qty'),
        ])
        .orderBy('r.planned_date', sql`desc nulls last`)
        .orderBy('r.receipt_no', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  async findOne(id: number) {
    const receipt = await this.db
      .selectFrom('receipts as r')
      .innerJoin('warehouses as w', 'w.id', 'r.warehouse_id')
      .leftJoin('partners as p', 'p.id', 'r.supplier_partner_id')
      .selectAll('r')
      .select(['w.short_name as warehouse_name', 'p.name1 as supplier_name'])
      .where('r.id', '=', id)
      .executeTakeFirst();

    if (!receipt) throw new NotFoundException(`入荷が見つかりません（ID: ${id}）`);

    const lines = await this.db
      .selectFrom('receipt_lines as l')
      .innerJoin('skus as s', 's.id', 'l.sku_id')
      .innerJoin('products as pr', 'pr.id', 's.product_id')
      .select([
        'l.line_no as line_no',
        's.sku_code as sku_code',
        'pr.product_name as product_name',
        'l.qty as qty',
        'l.lot_no as lot_no',
        'l.expiry_date as expiry_date',
      ])
      .where('l.receipt_id', '=', id)
      .orderBy('l.line_no', 'asc')
      .execute();

    return { ...receipt, lines };
  }
}
