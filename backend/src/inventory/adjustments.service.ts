import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { NumberingService } from '../common/numbering.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { Paged } from '../masters/partners.service';
import { StockLedgerService, type QualityCode } from './stock-ledger.service';

export interface AdjustmentLineInput {
  line_no: number;
  sku_id: number;
  /** 増やすなら正、減らすなら負。0 は入れられない（データベース側の制約でも弾く）。 */
  qty: string;
  lot_no?: string | null;
  /** 良品→不良のような振替のとき、両方を指定する。 */
  from_quality?: QualityCode | null;
  to_quality?: QualityCode | null;
  note?: string | null;
}

export interface CreateAdjustmentInput {
  warehouse_id: number;
  adjustment_date: string;
  reason_code: string;
  note?: string | null;
  lines: AdjustmentLineInput[];
}

export interface AdjustmentListQuery {
  warehouse_id?: number;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

/** 在庫調整（確認事項⑫）。棚卸差異・破損・紛失・品質振替を伝票として残す。 */
@Injectable()
export class AdjustmentsService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly numbering: NumberingService,
    private readonly ledger: StockLedgerService,
  ) {}

  async create(input: CreateAdjustmentInput, userId: number) {
    if (input.lines.length === 0) throw new BadRequestException('調整明細を1行以上入力してください');

    return this.db.transaction().execute(async (trx) => {
      const reason = await trx
        .selectFrom('codes as c')
        .innerJoin('code_categories as cc', 'cc.id', 'c.code_category_id')
        .select('c.id as id')
        .where('cc.code', '=', 'ADJUSTMENT_REASON')
        .where('c.code', '=', input.reason_code)
        .executeTakeFirst();

      if (!reason) throw new BadRequestException(`調整理由「${input.reason_code}」が登録されていません`);

      const adjustmentNo = await this.numbering.next(trx, 'stock_adjustment');
      const header = await trx
        .insertInto('stock_adjustments')
        .values({
          adjustment_no: adjustmentNo,
          warehouse_id: input.warehouse_id,
          adjustment_date: input.adjustment_date,
          reason_code_id: reason.id,
          note: input.note ?? null,
          created_by: userId,
          updated_by: userId,
        })
        .returning(['id', 'adjustment_no'])
        .executeTakeFirstOrThrow();

      for (const line of input.lines) {
        if (Number(line.qty) === 0) {
          throw new BadRequestException(`${line.line_no}行目：増減が 0 の明細は登録できません`);
        }

        const fromId = line.from_quality ? await this.ledger.qualityCodeId(trx, line.from_quality) : null;
        const toId = line.to_quality ? await this.ledger.qualityCodeId(trx, line.to_quality) : null;

        await trx
          .insertInto('stock_adjustment_lines')
          .values({
            stock_adjustment_id: header.id,
            line_no: line.line_no,
            sku_id: line.sku_id,
            // lot_no は NOT NULL DEFAULT ''。未指定なら既定値に任せる。
            lot_no: line.lot_no ?? undefined,
            from_quality_code_id: fromId,
            to_quality_code_id: toId,
            qty: line.qty,
            note: line.note ?? null,
            created_by: userId,
          })
          .execute();

        if (line.from_quality && line.to_quality) {
          // 品質の振替。移す数は絶対値で扱う（良品から減らして不良へ足す）。
          const move = String(Math.abs(Number(line.qty)));
          const fromStock = await this.ledger.findOrCreate(
            trx,
            { sku_id: line.sku_id, warehouse_id: input.warehouse_id, lot_no: line.lot_no, quality: line.from_quality },
            userId,
          );
          const toStock = await this.ledger.findOrCreate(
            trx,
            { sku_id: line.sku_id, warehouse_id: input.warehouse_id, lot_no: line.lot_no, quality: line.to_quality },
            userId,
          );
          await this.ledger.apply(trx, fromStock, `-${move}`, '不良振替', { table: 'stock_adjustments', id: header.id }, userId);
          await this.ledger.apply(trx, toStock, move, '不良振替', { table: 'stock_adjustments', id: header.id }, userId);
        } else {
          const quality: QualityCode = line.to_quality ?? line.from_quality ?? 'GOOD';
          const stockId = await this.ledger.findOrCreate(
            trx,
            { sku_id: line.sku_id, warehouse_id: input.warehouse_id, lot_no: line.lot_no, quality },
            userId,
          );
          await this.ledger.apply(trx, stockId, line.qty, '棚卸調整', { table: 'stock_adjustments', id: header.id }, userId);
        }
      }

      return { ...header, lines: input.lines.length };
    });
  }

  async list(query: AdjustmentListQuery): Promise<Paged<Record<string, unknown>>> {
    let base = this.db
      .selectFrom('stock_adjustments as a')
      .innerJoin('warehouses as w', 'w.id', 'a.warehouse_id')
      .leftJoin('codes as c', 'c.id', 'a.reason_code_id');

    if (query.warehouse_id !== undefined) base = base.where('a.warehouse_id', '=', query.warehouse_id);
    if (query.from) base = base.where('a.adjustment_date', '>=', query.from);
    if (query.to) base = base.where('a.adjustment_date', '<=', query.to);

    const [items, total] = await Promise.all([
      base
        .select([
          'a.id as id',
          'a.adjustment_no as adjustment_no',
          'a.adjustment_date as adjustment_date',
          'w.short_name as warehouse_name',
          'c.name as reason_name',
          'a.note as note',
          (eb) =>
            eb
              .selectFrom('stock_adjustment_lines as l')
              .select(sql<number>`count(*)::int`.as('n'))
              .whereRef('l.stock_adjustment_id', '=', 'a.id')
              .as('line_count'),
        ])
        .orderBy('a.adjustment_date', 'desc')
        .orderBy('a.adjustment_no', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }
}
