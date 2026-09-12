import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';

import { NumberingService } from '../common/numbering.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import type { Paged } from '../masters/partners.service';

export interface ReturnLineInput {
  line_no: number;
  sku_id: number;
  qty: string;
  unit_price?: string;
  tax_rate?: string;
}

export interface CreateReturnInput {
  return_type: '販社返品' | '顧客返品' | 'プラットフォーム返金';
  partner_id?: number | null;
  original_shipment_id?: number | null;
  warehouse_id: number;
  return_date: string;
  note?: string | null;
  lines: ReturnLineInput[];
}

/** 検品の結果。良品は在庫へ戻し、不良は不良在庫へ回す。 */
export interface InspectLineInput {
  return_line_id: number;
  good_qty: string;
  defective_qty: string;
  refurbish_cost?: string | null;
  note?: string | null;
}

export interface ReturnListQuery {
  status?: string;
  return_type?: string;
  partner_id?: number;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

/** 機能ID R-01 返品・再生 */
@Injectable()
export class ReturnsService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly numbering: NumberingService,
    private readonly ledger: StockLedgerService,
  ) {}

  async create(input: CreateReturnInput, userId: number) {
    if (input.lines.length === 0) throw new BadRequestException('返品明細を1行以上入力してください');

    return this.db.transaction().execute(async (trx) => {
      const returnNo = await this.numbering.next(trx, 'return');

      const header = await trx
        .insertInto('returns')
        .values({
          return_no: returnNo,
          return_type: input.return_type,
          partner_id: input.partner_id ?? null,
          original_shipment_id: input.original_shipment_id ?? null,
          warehouse_id: input.warehouse_id,
          return_date: input.return_date,
          status: '受付',
          note: input.note ?? null,
          created_by: userId,
          updated_by: userId,
        })
        .returning(['id', 'return_no'])
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('return_lines')
        .values(
          input.lines.map((l) => ({
            return_id: header.id,
            line_no: l.line_no,
            sku_id: l.sku_id,
            qty: l.qty,
            unit_price: l.unit_price ?? '0',
            tax_rate: l.tax_rate ?? '10.00',
            created_by: userId,
          })),
        )
        .execute();

      // 返品額は売掛残高一覧の「返品額」に集計される。金額の計算は SQL 側で行う。
      await trx
        .updateTable('returns')
        .set({
          return_amount: sql<string>`(select coalesce(sum(qty * unit_price), 0) from return_lines where return_id = ${header.id})`,
        })
        .where('id', '=', header.id)
        .execute();

      return header;
    });
  }

  /**
   * 検品（再生）。
   * 良品として戻す分は良品在庫へ、不良は不良在庫へ入れる。
   * 戻した数は返品数を超えられない。
   */
  async inspect(id: number, lines: InspectLineInput[], userId: number) {
    return this.db.transaction().execute(async (trx) => {
      const header = await trx
        .selectFrom('returns')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!header) throw new NotFoundException(`返品が見つかりません（ID: ${id}）`);
      if (header.status === '完了') throw new ConflictException('すでに検品が終わっています');
      if (header.status === '取消') throw new ConflictException('取り消された返品です');

      const returnLines = await trx
        .selectFrom('return_lines')
        .select(['id', 'line_no', 'sku_id', 'qty'])
        .where('return_id', '=', id)
        .execute();
      const byId = new Map(returnLines.map((l) => [l.id, l]));

      for (const input of lines) {
        const line = byId.get(input.return_line_id);
        if (!line) {
          throw new BadRequestException(`返品明細 ${input.return_line_id} はこの返品のものではありません`);
        }
        const good = Number(input.good_qty);
        const defective = Number(input.defective_qty);
        if (good < 0 || defective < 0) throw new BadRequestException('数量にマイナスは入れられません');
        if (good + defective > Number(line.qty)) {
          throw new BadRequestException(
            `${line.line_no}行目：良品 ${good} ＋ 不良 ${defective} が返品数 ${line.qty} を超えています`,
          );
        }

        if (good > 0) {
          const stockId = await this.ledger.findOrCreate(
            trx,
            { sku_id: line.sku_id, warehouse_id: header.warehouse_id, quality: 'GOOD' },
            userId,
          );
          await this.ledger.apply(trx, stockId, input.good_qty, '返品入庫', { table: 'returns', id }, userId);
        }
        if (defective > 0) {
          const stockId = await this.ledger.findOrCreate(
            trx,
            { sku_id: line.sku_id, warehouse_id: header.warehouse_id, quality: 'DEFECTIVE' },
            userId,
          );
          await this.ledger.apply(trx, stockId, input.defective_qty, '不良振替', { table: 'returns', id }, userId);
        }

        await trx
          .insertInto('refurbishments')
          .values({
            return_line_id: line.id,
            good_qty: input.good_qty,
            defective_qty: input.defective_qty,
            refurbish_cost: input.refurbish_cost ?? null,
            note: input.note ?? null,
            created_by: userId,
          })
          .execute();
      }

      await trx
        .updateTable('returns')
        .set({ status: '完了', updated_by: userId, updated_at: new Date() })
        .where('id', '=', id)
        .execute();

      return { id, return_no: header.return_no, status: '完了', inspected: lines.length };
    });
  }

  async list(query: ReturnListQuery): Promise<Paged<Record<string, unknown>>> {
    let base = this.db
      .selectFrom('returns as r')
      .innerJoin('warehouses as w', 'w.id', 'r.warehouse_id')
      .leftJoin('partners as p', 'p.id', 'r.partner_id');

    if (query.status) base = base.where('r.status', '=', query.status);
    if (query.return_type) base = base.where('r.return_type', '=', query.return_type);
    if (query.partner_id !== undefined) base = base.where('r.partner_id', '=', query.partner_id);
    if (query.from) base = base.where('r.return_date', '>=', query.from);
    if (query.to) base = base.where('r.return_date', '<=', query.to);

    const [items, total] = await Promise.all([
      base
        .select([
          'r.id as id',
          'r.return_no as return_no',
          'r.return_type as return_type',
          'r.status as status',
          'r.return_date as return_date',
          'r.return_amount as return_amount',
          'p.name1 as partner_name',
          'w.short_name as warehouse_name',
        ])
        .orderBy('r.return_date', 'desc')
        .orderBy('r.return_no', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  async findOne(id: number) {
    const header = await this.db
      .selectFrom('returns as r')
      .innerJoin('warehouses as w', 'w.id', 'r.warehouse_id')
      .leftJoin('partners as p', 'p.id', 'r.partner_id')
      .selectAll('r')
      .select(['w.short_name as warehouse_name', 'p.name1 as partner_name'])
      .where('r.id', '=', id)
      .executeTakeFirst();

    if (!header) throw new NotFoundException(`返品が見つかりません（ID: ${id}）`);

    const lines = await this.db
      .selectFrom('return_lines as l')
      .innerJoin('skus as s', 's.id', 'l.sku_id')
      .innerJoin('products as pr', 'pr.id', 's.product_id')
      .leftJoin('refurbishments as rf', 'rf.return_line_id', 'l.id')
      .select([
        'l.id as id',
        'l.line_no as line_no',
        's.sku_code as sku_code',
        'pr.product_name as product_name',
        'l.qty as qty',
        'l.unit_price as unit_price',
        'rf.good_qty as good_qty',
        'rf.defective_qty as defective_qty',
        'rf.refurbish_cost as refurbish_cost',
      ])
      .where('l.return_id', '=', id)
      .orderBy('l.line_no', 'asc')
      .execute();

    return { ...header, lines };
  }
}
