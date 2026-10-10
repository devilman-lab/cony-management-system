import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import { NumberingService } from '../common/numbering.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { DB } from '../db/schema';
import { decodeAuto, parseCsv } from '../imports/csv';
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

/** 在庫調整の編集。送られた項目だけを直す。明細を送ったときは明細をまるごと入れ替える。 */
export interface UpdateAdjustmentInput {
  warehouse_id?: number;
  adjustment_date?: string;
  reason_code?: string;
  note?: string | null;
  lines?: AdjustmentLineInput[];
}

export interface AdjustmentListQuery {
  warehouse_id?: number;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

/** CSV 取込の結果。下見（dry_run）でも確定でも同じ形で返す。 */
export interface AdjustmentImportResult {
  dry_run: boolean;
  encoding: string;
  /** CSV の中身の行数（見出しを除く） */
  rows: number;
  /** まとめた結果の在庫調整。確定したときは adjustment_no が入る */
  adjustments: {
    adjustment_no?: string;
    adjustment_date: string;
    warehouse_name: string;
    reason_name: string;
    note: string | null;
    lines: {
      /** CSV の何行目か（見出しを1行目として数える。Excel の行番号と同じ） */
      row: number;
      sku_code: string;
      product_name: string;
      qty: string;
      from_quality: string | null;
      to_quality: string | null;
      note: string | null;
    }[];
  }[];
  errors: { row: number; message: string }[];
}

/** 在庫を動かしたかどうかを状態と移動履歴の両方で見るための、移動履歴の参照名。 */
const REF_TABLE = 'stock_adjustments';

/** 1回の CSV で取り込める行数の上限。これを超えるものは分けてもらう。 */
const MAX_IMPORT_ROWS = 2000;

/**
 * 在庫調整（確認事項⑫）。棚卸差異・破損・紛失・品質振替を伝票として残す。
 *
 * 2026-10-09 在庫編 Z-20・Z-21 のご要望で、登録と在庫への反映を分けた。
 *   登録   … 伝票を作るだけ。在庫は動かない（状態「登録」）。編集・取消は自由。
 *   調整   … ここで在庫を動かす（状態「確定」）。
 *   取消   … 「登録」はそのまま取消。「確定」は在庫を元に戻してから取消。
 *
 * この変更より前に作った調整は、状態が「登録」のまま在庫が動いている。
 * そのため「在庫を動かしたか」は状態ではなく移動履歴で判定する（effectiveStatus）。
 * 状態だけで見ると、そうした古い調整にもう一度「調整」を押せてしまい、在庫が二重に動く。
 */
@Injectable()
export class AdjustmentsService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly numbering: NumberingService,
    private readonly ledger: StockLedgerService,
  ) {}

  /** 状態の SQL。「登録」でも在庫が動いていれば「確定」として扱う（上の説明のとおり）。 */
  private effectiveStatusSql() {
    return sql<string>`case when a.status = '登録' and exists (
      select 1 from stock_movements m where m.ref_table = ${REF_TABLE} and m.ref_id = a.id
    ) then '確定' else a.status end`;
  }

  private assertLines(lines: AdjustmentLineInput[]) {
    if (lines.length === 0) throw new BadRequestException('調整明細を1行以上入力してください');
    for (const line of lines) {
      if (!/^-?\d+(\.\d+)?$/.test(line.qty) || Number(line.qty) === 0) {
        throw new BadRequestException(`${line.line_no}行目：増減が 0 の明細は登録できません`);
      }
      if (line.from_quality && line.to_quality && line.from_quality === line.to_quality) {
        throw new BadRequestException(`${line.line_no}行目：品質（前）と品質（後）が同じです。振替でなければ片方を空にしてください`);
      }
    }
  }

  private async reasonId(trx: Transaction<DB>, reasonCode: string): Promise<number> {
    const reason = await trx
      .selectFrom('codes as c')
      .innerJoin('code_categories as cc', 'cc.id', 'c.code_category_id')
      .select('c.id as id')
      .where('cc.code', '=', 'ADJUSTMENT_REASON')
      .where('c.code', '=', reasonCode)
      .executeTakeFirst();
    if (!reason) throw new BadRequestException(`調整理由「${reasonCode}」が登録されていません`);
    return reason.id;
  }

  private async insertLines(trx: Transaction<DB>, adjustmentId: number, lines: AdjustmentLineInput[], userId: number) {
    for (const line of lines) {
      const fromId = line.from_quality ? await this.ledger.qualityCodeId(trx, line.from_quality) : null;
      const toId = line.to_quality ? await this.ledger.qualityCodeId(trx, line.to_quality) : null;
      await trx
        .insertInto('stock_adjustment_lines')
        .values({
          stock_adjustment_id: adjustmentId,
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
    }
  }

  private async insertAdjustment(
    trx: Transaction<DB>,
    header: { warehouse_id: number; adjustment_date: string; reason_code_id: number; note: string | null },
    lines: AdjustmentLineInput[],
    userId: number,
  ) {
    const adjustmentNo = await this.numbering.next(trx, 'stock_adjustment');
    const row = await trx
      .insertInto('stock_adjustments')
      .values({
        adjustment_no: adjustmentNo,
        warehouse_id: header.warehouse_id,
        adjustment_date: header.adjustment_date,
        reason_code_id: header.reason_code_id,
        // 登録しただけでは在庫を動かさない（Z-20）。在庫は一覧の「調整」で動かす。
        status: '登録',
        note: header.note,
        created_by: userId,
        updated_by: userId,
      })
      .returning(['id', 'adjustment_no', 'status'])
      .executeTakeFirstOrThrow();
    await this.insertLines(trx, row.id, lines, userId);
    return row;
  }

  /** 在庫調整の登録。伝票を作るだけで、在庫は動かさない（Z-20）。 */
  async create(input: CreateAdjustmentInput, userId: number) {
    this.assertLines(input.lines);

    return this.db.transaction().execute(async (trx) => {
      const reasonId = await this.reasonId(trx, input.reason_code);
      const header = await this.insertAdjustment(
        trx,
        {
          warehouse_id: input.warehouse_id,
          adjustment_date: input.adjustment_date,
          reason_code_id: reasonId,
          note: input.note ?? null,
        },
        input.lines,
        userId,
      );
      return { ...header, lines: input.lines.length };
    });
  }

  /** 見出しをロックして、今の状態（移動履歴も見たもの）を返す。 */
  private async lockHeader(trx: Transaction<DB>, id: number) {
    const header = await trx
      .selectFrom('stock_adjustments')
      .select(['id', 'adjustment_no', 'warehouse_id', 'status'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!header) throw new NotFoundException(`在庫調整が見つかりません（ID: ${id}）`);
    const moved = await trx
      .selectFrom('stock_movements')
      .select('id')
      .where('ref_table', '=', REF_TABLE)
      .where('ref_id', '=', id)
      .executeTakeFirst();
    const status = header.status === '登録' && moved ? '確定' : header.status;
    return { ...header, status };
  }

  /** 調整日・理由・備考・明細の編集（Z-21「編集」・Z-23 一覧で直接直す）。在庫を動かす前（「登録」）だけ。 */
  async update(id: number, input: UpdateAdjustmentInput, userId: number) {
    if (input.lines) this.assertLines(input.lines);

    return this.db.transaction().execute(async (trx) => {
      const header = await this.lockHeader(trx, id);
      if (header.status !== '登録') {
        throw new ConflictException(
          `${header.adjustment_no} は「${header.status}」です。編集できるのは在庫に反映する前（「登録」）のものだけです`,
        );
      }

      const reasonId = input.reason_code !== undefined ? await this.reasonId(trx, input.reason_code) : undefined;
      await trx
        .updateTable('stock_adjustments')
        .set({
          ...(input.warehouse_id !== undefined ? { warehouse_id: input.warehouse_id } : {}),
          ...(input.adjustment_date !== undefined ? { adjustment_date: input.adjustment_date } : {}),
          ...(reasonId !== undefined ? { reason_code_id: reasonId } : {}),
          ...(input.note !== undefined ? { note: input.note && input.note.trim() !== '' ? input.note : null } : {}),
          updated_by: userId,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .execute();

      if (input.lines) {
        await trx.deleteFrom('stock_adjustment_lines').where('stock_adjustment_id', '=', id).execute();
        await this.insertLines(trx, id, input.lines, userId);
      }

      return { id, adjustment_no: header.adjustment_no, status: '登録' };
    });
  }

  /** 明細を、在庫を動かすのに要る形（品質はコード）で読む。 */
  private async linesForStock(trx: Transaction<DB>, id: number) {
    const rows = await trx
      .selectFrom('stock_adjustment_lines as l')
      .leftJoin('codes as fq', 'fq.id', 'l.from_quality_code_id')
      .leftJoin('codes as tq', 'tq.id', 'l.to_quality_code_id')
      .select(['l.line_no as line_no', 'l.sku_id as sku_id', 'l.lot_no as lot_no', 'l.qty as qty', 'fq.code as from_quality', 'tq.code as to_quality'])
      .where('l.stock_adjustment_id', '=', id)
      .orderBy('l.line_no', 'asc')
      .execute();
    return rows.map((r) => ({
      ...r,
      from_quality: (r.from_quality ?? null) as QualityCode | null,
      to_quality: (r.to_quality ?? null) as QualityCode | null,
    }));
  }

  /**
   * 明細のとおりに在庫を動かす。sign=-1 なら逆向き（確定の取消で元に戻すとき）。
   * 調整・取消のどちらも、この1か所で動かす（向きを間違えた経路を作らないため）。
   */
  private async moveStock(
    trx: Transaction<DB>,
    id: number,
    warehouseId: number,
    sign: 1 | -1,
    userId: number,
  ) {
    const lines = await this.linesForStock(trx, id);
    if (lines.length === 0) throw new ConflictException('調整明細がありません');
    const ref = { table: REF_TABLE, id };
    const negate = (q: string) => (q.startsWith('-') ? q.slice(1) : `-${q}`);

    for (const line of lines) {
      if (line.from_quality && line.to_quality) {
        // 品質の振替。移す数は絶対値で扱う（前の品質から減らして後の品質へ足す）。
        const move = line.qty.startsWith('-') ? line.qty.slice(1) : line.qty;
        const fromStock = await this.ledger.findOrCreate(
          trx,
          { sku_id: line.sku_id, warehouse_id: warehouseId, lot_no: line.lot_no, quality: line.from_quality },
          userId,
        );
        const toStock = await this.ledger.findOrCreate(
          trx,
          { sku_id: line.sku_id, warehouse_id: warehouseId, lot_no: line.lot_no, quality: line.to_quality },
          userId,
        );
        if (sign === 1) {
          await this.ledger.apply(trx, fromStock, `-${move}`, '不良振替', ref, userId);
          await this.ledger.apply(trx, toStock, move, '不良振替', ref, userId);
        } else {
          await this.ledger.apply(trx, toStock, `-${move}`, '不良振替', ref, userId);
          await this.ledger.apply(trx, fromStock, move, '不良振替', ref, userId);
        }
      } else {
        const quality: QualityCode = line.to_quality ?? line.from_quality ?? 'GOOD';
        const stockId = await this.ledger.findOrCreate(
          trx,
          { sku_id: line.sku_id, warehouse_id: warehouseId, lot_no: line.lot_no, quality },
          userId,
        );
        await this.ledger.apply(trx, stockId, sign === 1 ? line.qty : negate(line.qty), '棚卸調整', ref, userId);
      }
    }
    return lines.length;
  }

  /** 「調整」。ここで在庫を動かし、状態を「確定」にする（Z-21）。 */
  async confirm(id: number, userId: number) {
    return this.db.transaction().execute(async (trx) => {
      const header = await this.lockHeader(trx, id);
      if (header.status === '確定') throw new ConflictException(`${header.adjustment_no} はすでに在庫に反映（確定）しています`);
      if (header.status === '取消') throw new ConflictException(`${header.adjustment_no} は取り消されています`);

      let lines: number;
      try {
        lines = await this.moveStock(trx, id, header.warehouse_id, 1, userId);
      } catch (e) {
        if (e instanceof BadRequestException) {
          throw new ConflictException(`${header.adjustment_no} を在庫に反映できません（${e.message}）`);
        }
        throw e;
      }

      await trx
        .updateTable('stock_adjustments')
        .set({ status: '確定', updated_by: userId, updated_at: new Date() })
        .where('id', '=', id)
        .execute();

      return { id, adjustment_no: header.adjustment_no, status: '確定', lines };
    });
  }

  /**
   * 取消（Z-21）。「登録」はそのまま取消。「確定」は在庫を元に戻してから取消にする。
   * 元に戻すと引当済を下回る（その後の受注で押さえた）ときなどは、戻せない理由を言葉にして断る。
   */
  async cancel(id: number, userId: number) {
    return this.db.transaction().execute(async (trx) => {
      const header = await this.lockHeader(trx, id);
      if (header.status === '取消') throw new ConflictException(`${header.adjustment_no} はすでに取り消されています`);

      if (header.status === '確定') {
        try {
          await this.moveStock(trx, id, header.warehouse_id, -1, userId);
        } catch (e) {
          if (e instanceof BadRequestException) {
            throw new ConflictException(
              `${header.adjustment_no} は在庫を元に戻せないため取り消せません（${e.message}）。必要なら新しい在庫調整で数量を直してください`,
            );
          }
          throw e;
        }
      }

      await trx
        .updateTable('stock_adjustments')
        .set({ status: '取消', updated_by: userId, updated_at: new Date() })
        .where('id', '=', id)
        .execute();

      return { id, adjustment_no: header.adjustment_no, status: '取消', reverted: header.status === '確定' };
    });
  }

  /** 明細を商品の名前・カラー・サイズ・品質の名前付きで引く。一覧と詳細で同じ形にする。 */
  private async linesOf(ids: number[]) {
    if (ids.length === 0) return [];
    return this.db
      .selectFrom('stock_adjustment_lines as l')
      .innerJoin('skus as s', 's.id', 'l.sku_id')
      .innerJoin('products as pr', 'pr.id', 's.product_id')
      .leftJoin('colors as c', 'c.id', 's.color_id')
      .leftJoin('sizes as z', 'z.id', 's.size_id')
      .leftJoin('codes as fq', 'fq.id', 'l.from_quality_code_id')
      .leftJoin('codes as tq', 'tq.id', 'l.to_quality_code_id')
      .select([
        'l.stock_adjustment_id as stock_adjustment_id',
        'l.line_no as line_no',
        'l.sku_id as sku_id',
        's.sku_code as sku_code',
        's.jan as jan',
        // SKU ごとの商品名があればそれ（マスター編② M-10）
        sql<string>`coalesce(nullif(s.sku_name, ''), pr.product_name)`.as('product_name'),
        'c.name as color_name',
        'z.name as size_name',
        'l.qty as qty',
        'fq.code as from_quality',
        'fq.name as from_quality_name',
        'tq.code as to_quality',
        'tq.name as to_quality_name',
        'l.note as note',
      ])
      .where('l.stock_adjustment_id', 'in', ids)
      .orderBy('l.stock_adjustment_id', 'asc')
      .orderBy('l.line_no', 'asc')
      .execute();
  }

  /**
   * 一覧。1件の調整に明細（lines）を付けて返す（Z-22「調整した商品の詳細を表示」）。
   * ページ送りは調整の単位で数える（明細で切ると1件が2ページに割れ、ボタンの行が分からなくなる）。
   */
  async list(query: AdjustmentListQuery): Promise<Paged<Record<string, unknown>>> {
    let base = this.db
      .selectFrom('stock_adjustments as a')
      .innerJoin('warehouses as w', 'w.id', 'a.warehouse_id')
      .leftJoin('codes as c', 'c.id', 'a.reason_code_id');

    if (query.warehouse_id !== undefined) base = base.where('a.warehouse_id', '=', query.warehouse_id);
    if (query.from) base = base.where('a.adjustment_date', '>=', query.from);
    if (query.to) base = base.where('a.adjustment_date', '<=', query.to);

    const [headers, total] = await Promise.all([
      base
        .select([
          'a.id as id',
          'a.adjustment_no as adjustment_no',
          'a.adjustment_date as adjustment_date',
          'a.warehouse_id as warehouse_id',
          'w.short_name as warehouse_name',
          'c.code as reason_code',
          'c.name as reason_name',
          'a.note as note',
          this.effectiveStatusSql().as('status'),
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

    const lines = await this.linesOf(headers.map((h) => h.id));
    const items = headers.map((h) => ({ ...h, lines: lines.filter((l) => l.stock_adjustment_id === h.id) }));
    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  async findOne(id: number) {
    const header = await this.db
      .selectFrom('stock_adjustments as a')
      .innerJoin('warehouses as w', 'w.id', 'a.warehouse_id')
      .leftJoin('codes as c', 'c.id', 'a.reason_code_id')
      .select([
        'a.id as id',
        'a.adjustment_no as adjustment_no',
        'a.adjustment_date as adjustment_date',
        'a.warehouse_id as warehouse_id',
        'w.short_name as warehouse_name',
        'c.code as reason_code',
        'c.name as reason_name',
        'a.note as note',
        this.effectiveStatusSql().as('status'),
      ])
      .where('a.id', '=', id)
      .executeTakeFirst();
    if (!header) throw new NotFoundException(`在庫調整が見つかりません（ID: ${id}）`);
    return { ...header, lines: await this.linesOf([id]) };
  }

  /**
   * CSV で在庫調整を「登録」する（Z-24。在庫への反映＝「調整」は画面で行う）。
   *
   * 列: 調整日・倉庫・理由・商品コード・増減・品質(前)・品質(後)・メモ・備考
   *   - 同じ調整日・倉庫・理由・備考の行を1件の在庫調整にまとめる（メモは明細ごと）。
   *   - 倉庫・理由・品質は名前でもコードでもよい（Excel で作る人がコードを覚えていなくても書けるように）。
   *   - 1行でも誤りがあれば何も登録しない。半端に登録されると、直して取り込み直したときに二重になるため。
   */
  async importCsv(contentBase64: string, dryRun: boolean, userId: number): Promise<AdjustmentImportResult> {
    const bytes = Buffer.from(contentBase64, 'base64');
    if (bytes.length === 0) throw new BadRequestException('ファイルが空です');
    const { text, encoding } = decodeAuto(bytes);
    const table = parseCsv(text);
    if (table.length === 0) throw new BadRequestException('中身がありません');

    // 見出しは全角かっこ・空白の違いを吸収する（「品質（前）」でも「品質(前)」でも通す）
    const norm = (h: string) => h.trim().replace(/（/g, '(').replace(/）/g, ')').replace(/[\s　]/g, '');
    const header = table[0].map(norm);
    const body = table.slice(1);
    if (body.length === 0) throw new BadRequestException('見出しだけで、中身の行がありません');
    if (body.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException(`一度に取り込めるのは${MAX_IMPORT_ROWS}行までです（${body.length}行ありました）`);
    }

    const ALIASES: Record<string, string[]> = {
      date: ['調整日'],
      warehouse: ['倉庫', '倉庫コード', '倉庫名'],
      reason: ['理由', '調整理由'],
      sku: ['商品コード', 'SKU', 'SKUコード'],
      qty: ['増減', '数量'],
      from: ['品質(前)'],
      to: ['品質(後)'],
      memo: ['メモ'],
      note: ['備考'],
    };
    const col: Record<string, number> = {};
    for (const [field, names] of Object.entries(ALIASES)) {
      col[field] = header.findIndex((h) => names.includes(h));
    }
    const required: [string, string][] = [
      ['date', '調整日'],
      ['warehouse', '倉庫'],
      ['reason', '理由'],
      ['sku', '商品コード'],
      ['qty', '増減'],
    ];
    const missing = required.filter(([f]) => col[f] < 0).map(([, l]) => l);
    if (missing.length > 0) {
      throw new BadRequestException(
        `見出しに「${missing.join('」「')}」がありません。1行目は 調整日,倉庫,理由,商品コード,増減,品質(前),品質(後),メモ,備考 にしてください`,
      );
    }
    const cell = (r: string[], field: string) => (col[field] >= 0 ? (r[col[field]] ?? '').trim() : '');

    // 名前・コードの引き当て表をまとめて作る（行ごとに問い合わせない）
    const warehouses = await this.db.selectFrom('warehouses').select(['id', 'warehouse_code', 'short_name']).where('is_active', '=', true).execute();
    const codesOf = (category: string) =>
      this.db
        .selectFrom('codes as c')
        .innerJoin('code_categories as cc', 'cc.id', 'c.code_category_id')
        .select(['c.id as id', 'c.code as code', 'c.name as name'])
        .where('cc.code', '=', category)
        .execute();
    const [reasons, qualities] = await Promise.all([codesOf('ADJUSTMENT_REASON'), codesOf('QUALITY_DIVISION')]);
    const skuCodes = [...new Set(body.map((r) => cell(r, 'sku')).filter((v) => v !== ''))];
    const skus =
      skuCodes.length === 0
        ? []
        : await this.db
            .selectFrom('skus as s')
            .innerJoin('products as p', 'p.id', 's.product_id')
            .select([
              's.id as id',
              's.sku_code as sku_code',
              sql<string>`coalesce(nullif(s.sku_name, ''), p.product_name)`.as('product_name'),
              sql<boolean>`p.is_set or exists (select 1 from set_headers sh where sh.sku_id = s.id)`.as('is_set'),
            ])
            .where('s.sku_code', 'in', skuCodes)
            .execute();

    const findWarehouse = (v: string) => warehouses.find((w) => w.warehouse_code === v) ?? warehouses.find((w) => w.short_name === v);
    const findCode = <T extends { code: string; name: string }>(list: T[], v: string) =>
      list.find((c) => c.code.toUpperCase() === v.toUpperCase()) ?? list.find((c) => c.name === v);

    type Group = AdjustmentImportResult['adjustments'][number] & {
      warehouse_id: number;
      reason_code_id: number;
      input: AdjustmentLineInput[];
    };
    const groups = new Map<string, Group>();
    const errors: AdjustmentImportResult['errors'] = [];

    body.forEach((r, i) => {
      const row = i + 2; // 見出しが1行目
      const problems: string[] = [];

      const date = parseDate(cell(r, 'date'));
      if (!date) problems.push(`調整日「${cell(r, 'date')}」を日付として読めません（例 2026/10/09）`);
      const wh = findWarehouse(cell(r, 'warehouse'));
      if (!wh) problems.push(`倉庫「${cell(r, 'warehouse')}」が倉庫マスタにありません（倉庫コードか略称で指定）`);
      const reason = findCode(reasons, cell(r, 'reason'));
      if (!reason) problems.push(`理由「${cell(r, 'reason')}」が在庫調整理由にありません（${reasons.map((x) => x.name).join('・')}）`);
      const sku = skus.find((s) => s.sku_code === cell(r, 'sku'));
      if (!sku) problems.push(`商品コード「${cell(r, 'sku')}」が商品マスタにありません`);
      else if (sku.is_set) problems.push(`商品コード「${sku.sku_code}」はセット商品です。セットは在庫を持たないため、構成品で調整してください`);
      const qty = parseQty(cell(r, 'qty'));
      if (!qty) problems.push(`増減「${cell(r, 'qty')}」は 0 以外の数で入れてください（減らすときは -3 のように負の数）`);

      const qualityOf = (field: 'from' | 'to', label: string) => {
        const v = cell(r, field);
        if (v === '') return null;
        const q = findCode(qualities, v);
        if (!q) problems.push(`${label}「${v}」が品質区分にありません（${qualities.map((x) => x.name).join('・')}）`);
        return (q?.code ?? null) as QualityCode | null;
      };
      const fromQ = qualityOf('from', '品質(前)');
      const toQ = qualityOf('to', '品質(後)');
      if (fromQ && toQ && fromQ === toQ) problems.push('品質(前)と品質(後)が同じです。振替でなければ片方を空にしてください');

      if (problems.length > 0 || !date || !wh || !reason || !sku || !qty) {
        errors.push({ row, message: problems.join('／') });
        return;
      }

      const note = cell(r, 'note') || null;
      const key = [date, wh.id, reason.id, note ?? ''].join('\u0001');
      let g = groups.get(key);
      if (!g) {
        g = {
          adjustment_date: date,
          warehouse_id: wh.id,
          warehouse_name: wh.short_name,
          reason_code_id: reason.id,
          reason_name: reason.name,
          note,
          lines: [],
          input: [],
        };
        groups.set(key, g);
      }
      const memo = cell(r, 'memo') || null;
      g.input.push({ line_no: g.input.length + 1, sku_id: sku.id, qty, from_quality: fromQ, to_quality: toQ, note: memo });
      g.lines.push({
        row,
        sku_code: sku.sku_code,
        product_name: sku.product_name,
        qty,
        from_quality: fromQ ? (qualities.find((q) => q.code === fromQ)?.name ?? fromQ) : null,
        to_quality: toQ ? (qualities.find((q) => q.code === toQ)?.name ?? toQ) : null,
        note: memo,
      });
    });

    const list = [...groups.values()];
    const result = (withNo: (g: Group) => string | undefined): AdjustmentImportResult => ({
      dry_run: dryRun,
      encoding,
      rows: body.length,
      adjustments: list.map((g) => ({
        adjustment_no: withNo(g),
        adjustment_date: g.adjustment_date,
        warehouse_name: g.warehouse_name,
        reason_name: g.reason_name,
        note: g.note,
        lines: g.lines,
      })),
      errors,
    });

    if (dryRun) return result(() => undefined);
    if (errors.length > 0) {
      throw new BadRequestException(
        `CSV に誤りが ${errors.length} 行あるため、登録しませんでした。${errors
          .slice(0, 3)
          .map((e) => `${e.row}行目：${e.message}`)
          .join(' ')}`,
      );
    }

    const numbers = new Map<Group, string>();
    await this.db.transaction().execute(async (trx) => {
      for (const g of list) {
        const row = await this.insertAdjustment(
          trx,
          { warehouse_id: g.warehouse_id, adjustment_date: g.adjustment_date, reason_code_id: g.reason_code_id, note: g.note },
          g.input,
          userId,
        );
        numbers.set(g, row.adjustment_no);
      }
    });
    return result((g) => numbers.get(g));
  }
}

/** 全角数字を半角にし、桁区切りと空白を落とす。マイナスの全角・数学記号も半角にする。 */
function normalizeNumber(v: string): string {
  return v
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－−ー]/g, '-')
    .replace(/＋/g, '+')
    .replace(/[,，\s　]/g, '');
}

/** 増減。0 と数でないものは null。先頭の + は落とす（Excel で +3 と書く人がいるため）。 */
function parseQty(raw: string): string | null {
  const v = normalizeNumber(raw).replace(/^\+/, '');
  if (!/^-?\d+(\.\d+)?$/.test(v) || Number(v) === 0) return null;
  return v;
}

/** 2026/10/9・2026-10-09・20261009 を YYYY-MM-DD に。実在しない日（2/30 など）は null。 */
function parseDate(raw: string): string | null {
  const v = normalizeNumber(raw).replace(/[.\-年月]/g, '/').replace(/日$/, '');
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(v) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
