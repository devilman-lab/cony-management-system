import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import { NumberingService } from '../common/numbering.service';
import { ReservationsService } from '../inventory/reservations.service';
import { AllocationService } from '../shipping/allocation.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { DB } from '../db/schema';
import { applyTransform, decode, parseCsv } from './csv';

export interface ImportInput {
  template_code: string;
  file_name: string;
  /** CSV の中身。Shift-JIS をそのまま渡せるよう base64 で受け取る。 */
  content_base64: string;
  /** true のとき、読めるかどうかだけを見て登録しない。 */
  dry_run?: boolean;
}

interface MappedRow {
  row_no: number;
  values: Record<string, string | null>;
  raw: Record<string, string>;
  error?: string;
  /** 必須でない列が読めなかった場合。行は通すが、読めなかったことは残す。 */
  warnings: string[];
}

export interface ImportResult {
  template_code: string;
  file_name: string;
  dry_run: boolean;
  total_rows: number;
  success_rows: number;
  error_rows: number;
  /** 受注として登録できた件数。原本だけ残った分は含めない。 */
  created_orders: number;
  skipped_orders: number;
  /** 原本は残したが受注にできなかった件数（マスタ未登録）。取込一覧の「要確認」に出る。 */
  pending_orders: number;
  errors: Array<{ row_no: number; reason: string }>;
  /** 行は通したが読めなかった項目。JANが指数表記に壊れている等。 */
  warnings: string[];
  orders: Array<{ order_no: string; external_order_no: string; lines: number; status: string }>;
}

/**
 * 機能ID I-01 CSV取込（販社の発注CSV）
 *
 * 販社ごとに列の並びも項目名も違うが、書式そのものを import_templates と
 * import_template_columns に登録してある。**この処理は販社名を一切知らない。**
 * 5社目・6社目が増えてもマスタに登録するだけで取り込める。
 */
@Injectable()
export class PartnerOrderImportService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly numbering: NumberingService,
    private readonly allocation: AllocationService,
    private readonly reservations: ReservationsService,
  ) {}

  async import(input: ImportInput, userId: number): Promise<ImportResult> {
    const template = await this.db
      .selectFrom('import_templates')
      .selectAll()
      .where('template_code', '=', input.template_code)
      .where('is_active', '=', true)
      .executeTakeFirst();

    if (!template) {
      throw new NotFoundException(`取込テンプレート「${input.template_code}」が登録されていません`);
    }
    if (template.import_type !== 'PARTNER_ORDER') {
      throw new BadRequestException(`「${input.template_code}」は販社発注CSVのテンプレートではありません`);
    }

    const columns = await this.db
      .selectFrom('import_template_columns')
      .select(['column_index', 'source_header', 'target_field', 'transform', 'is_required'])
      .where('import_template_id', '=', template.id)
      .orderBy('column_index', 'asc')
      .execute();

    if (columns.length === 0) {
      throw new BadRequestException(`「${input.template_code}」に列の定義がありません`);
    }

    const text = decode(Buffer.from(input.content_base64, 'base64'), template.file_encoding);
    let rows = parseCsv(text);

    if (template.skip_rows > 0) rows = rows.slice(template.skip_rows);
    const header = template.has_header ? rows.shift() : undefined;

    if (header && header.length !== columns.length) {
      throw new BadRequestException(
        `列数が合いません。ファイルは ${header.length} 列、登録されている書式は ${columns.length} 列です`,
      );
    }

    const mapped = rows.map((cells, i) => this.mapRow(cells, columns, i + 1));
    const ok = mapped.filter((r) => !r.error);
    const errors = mapped
      .filter((r) => r.error)
      .map((r) => ({ row_no: r.row_no, reason: r.error as string }));

    const result: ImportResult = {
      template_code: input.template_code,
      file_name: input.file_name,
      dry_run: input.dry_run ?? false,
      total_rows: mapped.length,
      success_rows: ok.length,
      error_rows: errors.length,
      created_orders: 0,
      skipped_orders: 0,
      pending_orders: 0,
      errors,
      warnings: mapped.flatMap((r) => r.warnings),
      orders: [],
    };

    if (input.dry_run) return result;

    // 受注番号ごとにまとめる。1つの発注番号に複数の明細が並ぶ。
    const groups = new Map<string, MappedRow[]>();
    for (const row of ok) {
      const key = String(row.values['order_no'] ?? `行${row.row_no}`);
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    await this.db.transaction().execute(async (trx) => {
      // 件数は受注を作り終えてから入れ直す。
      // 「読めた行数」を成功として先に入れてしまうと、マスタ未登録で受注にできなかった分まで
      // 取り込めたことになり、履歴の件数と実際に登録された受注の件数が食い違う。
      const batch = await trx
        .insertInto('import_batches')
        .values({
          import_type: 'PARTNER_ORDER',
          import_template_id: template.id,
          file_name: input.file_name,
          total_count: mapped.length,
          success_count: 0,
          error_count: errors.length,
          imported_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      for (const [externalOrderNo, rowsOfOrder] of groups) {
        const outcome = await this.createOrder(
          trx,
          batch.id,
          template,
          externalOrderNo,
          rowsOfOrder,
          userId,
        );
        // 「作成した受注」は本当に受注番号が付いたものだけ数える。
        // マスタ未登録で原本のまま残した分まで数えると、画面の件数が実態と合わず、
        // 取り込めたつもりで出荷一覧に出てこない受注に気づけなくなる。
        if (outcome.status === '取込済のため除外') result.skipped_orders += 1;
        else if (outcome.order_no) result.created_orders += 1;
        else result.pending_orders += 1;
        result.orders.push(outcome);
      }

      // 取込履歴の「登録できた件数」は、通販(OMS)・Amazon と同じく
      // 実際に登録できた件数（＝受注番号が付いた受注）に揃える。
      await trx
        .updateTable('import_batches')
        .set({ success_count: result.created_orders })
        .where('id', '=', batch.id)
        .execute();
    });

    return result;
  }

  private mapRow(
    cells: string[],
    columns: Array<{
      column_index: number;
      source_header: string | null;
      target_field: string;
      transform: string | null;
      is_required: boolean;
    }>,
    rowNo: number,
  ): MappedRow {
    const values: Record<string, string | null> = {};
    const raw: Record<string, string> = {};
    const warnings: string[] = [];

    for (const col of columns) {
      const cell = cells[col.column_index - 1] ?? '';
      raw[col.source_header ?? `col${col.column_index}`] = cell;
      if (col.target_field === 'ignore') continue;

      try {
        const v = applyTransform(cell, col.transform, col.source_header ?? col.target_field);
        if (v === null && col.is_required) {
          return {
            row_no: rowNo,
            values,
            raw,
            warnings,
            error: `${col.source_header ?? col.target_field} が空です`,
          };
        }
        values[col.target_field] = v;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        // 必須の列が読めなければ行ごと止める。そうでなければ空にして進める。
        // ビックカメラ・ラベルヴィは JAN が指数表記に壊れているが、
        // 商品コードの列があるので取り込みには差し支えない。
        if (col.is_required) {
          return { row_no: rowNo, values, raw, warnings, error: reason };
        }
        values[col.target_field] = null;
        warnings.push(`${rowNo}行目：${reason}`);
      }
    }

    // 数量が読めない・0以下の行は受注にしない。
    // そのまま通すと引当されない受注ができ、出荷一覧に出ないまま埋もれる。
    const qty = Number(values['qty']);
    if (values['qty'] === null || values['qty'] === undefined || !Number.isFinite(qty) || qty <= 0) {
      return {
        row_no: rowNo,
        values,
        raw,
        warnings,
        error: `数量が読めません（${values['qty'] ?? '空欄'}）。0 より大きい数量が要ります`,
      };
    }

    return { row_no: rowNo, values, raw, warnings };
  }

  private async createOrder(
    trx: Transaction<DB>,
    batchId: number,
    template: { id: number; default_order_type: string; sku_match_key: string; order_no_source: string; template_code: string },
    externalOrderNo: string,
    rows: MappedRow[],
    userId: number,
  ): Promise<{ order_no: string; external_order_no: string; lines: number; status: string; shortages?: string[] }> {
    const head = rows[0].values;

    // 同じ発注番号を2回取り込んでも二重計上しない（一意制約でも守っている）
    const already = await trx
      .selectFrom('external_orders')
      .select('id')
      .where('channel', '=', template.template_code)
      .where('external_order_no', '=', externalOrderNo)
      .executeTakeFirst();

    if (already) {
      return { order_no: '', external_order_no: externalOrderNo, lines: rows.length, status: '取込済のため除外' };
    }

    const partnerCode = head['partner_code'];
    const partner = partnerCode
      ? await trx
          .selectFrom('partners')
          .select(['id', 'default_trade_type'])
          .where('partner_code', '=', partnerCode)
          .executeTakeFirst()
      : undefined;

    const deliveryCode = head['delivery_code'];
    const destination = deliveryCode
      ? await trx
          .selectFrom('delivery_destinations')
          .select(['id', 'default_warehouse_id'])
          .where('delivery_code', '=', deliveryCode)
          .executeTakeFirst()
      : undefined;

    const external = await trx
      .insertInto('external_orders')
      .values({
        import_batch_id: batchId,
        channel: template.template_code,
        external_order_no: externalOrderNo,
        partner_id: partner?.id ?? null,
        delivery_code: deliveryCode ?? null,
        po_no: head['po_no'] ?? null,
        ship_date: head['ship_date'] ?? null,
        total_amount: null,
        raw_data: JSON.stringify(rows.map((r) => r.raw)) as unknown as object,
        // 取込済＝元データは入ったが、まだ受注に変換できていない状態。
        // マスタが登録されたら取り込み直す。理由は error_message に残す。
        status: partner && destination ? '変換済' : '取込済',
        error_message:
          partner && destination
            ? null
            : `${!partner ? `得意先ID ${partnerCode} が取引先マスタにありません。` : ''}${
                !destination ? `納品先CD ${deliveryCode} が納品先マスタにありません。` : ''
              }`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // 明細は元データとして必ず残す。商品が引き当てられなくても消えない。
    let lineNo = 0;
    const resolved: Array<{ sku_id: number | null; values: Record<string, string | null> }> = [];

    for (const row of rows) {
      lineNo += 1;
      const skuId = await this.resolveSku(trx, template.sku_match_key, row.values, partner?.id);
      resolved.push({ sku_id: skuId, values: row.values });

      await trx
        .insertInto('external_order_lines')
        .values({
          external_order_id: external.id,
          line_no: lineNo,
          external_sku_code: row.values['sku_code'] ?? null,
          external_jan: row.values['jan'] ?? null,
          partner_product_code: row.values['partner_product_code'] ?? null,
          item_name: row.values['item_name'] ?? null,
          qty: row.values['qty'] ?? '0',
          unit_price: row.values['unit_price'] ?? '0',
          retail_price: row.values['retail_price'] ?? null,
          sku_id: skuId,
          raw_data: JSON.stringify(row.raw) as unknown as object,
        })
        .execute();
    }

    if (!partner || !destination) {
      return {
        order_no: '',
        external_order_no: externalOrderNo,
        lines: rows.length,
        status: '要確認（マスタ未登録）',
      };
    }

    const unresolved = resolved.filter((r) => r.sku_id === null).length;
    if (unresolved > 0) {
      await trx
        .updateTable('external_orders')
        .set({
          status: '取込済',
          error_message: `${unresolved} 行の商品が商品マスタにありません`,
        })
        .where('id', '=', external.id)
        .execute();
      return {
        order_no: '',
        external_order_no: externalOrderNo,
        lines: rows.length,
        status: `要確認（商品未登録 ${unresolved} 行）`,
      };
    }

    // 受注番号は自社で採番する。先方の発注番号は po_no に残す。
    const orderNo =
      template.order_no_source === 'csv' && externalOrderNo
        ? await this.numbering.next(trx, 'sales_order')
        : await this.numbering.next(trx, 'sales_order');

    const order = await trx
      .insertInto('sales_orders')
      .values({
        order_no: orderNo,
        order_type: template.default_order_type,
        partner_id: partner.id,
        delivery_destination_id: destination.id,
        sales_category_id: sql<number>`(select id from sales_categories order by sort_order nulls last, code limit 1)`,
        trade_type: partner.default_trade_type ?? undefined,
        po_no: head['po_no'] ?? externalOrderNo,
        po_line_no: head['po_line_no'] ? Number(head['po_line_no']) : null,
        order_date: head['order_date'] ?? head['ship_date'] ?? sql<string>`current_date`,
        ship_date: head['ship_date'] ?? null,
        delivery_date: head['delivery_date'] ?? null,
        requested_delivery_date: head['requested_delivery_date'] ?? null,
        ship_from_warehouse_id: destination.default_warehouse_id,
        shipping_remarks: head['remarks'] ?? null,
        channel: template.template_code,
        external_order_id: external.id,
        status: '未確定',
        created_by: userId,
        updated_by: userId,
      })
      .returning(['id', 'order_no'])
      .executeTakeFirstOrThrow();

    let n = 0;
    for (const line of resolved) {
      n += 1;
      await trx
        .insertInto('sales_order_lines')
        .values({
          sales_order_id: order.id,
          line_no: n,
          line_type: '商品',
          sku_id: line.sku_id,
          item_name: line.values['item_name'] ?? '（品名なし）',
          qty: line.values['qty'] ?? '0',
          unit_price: line.values['unit_price'] ?? '0',
          amount: sql<string>`${line.values['qty'] ?? '0'}::numeric * ${line.values['unit_price'] ?? '0'}::numeric`,
          created_by: userId,
        })
        .execute();
    }

    await trx
      .updateTable('external_orders')
      .set({ sales_order_id: order.id, status: '変換済' })
      .where('id', '=', external.id)
      .execute();

    // 手入力の受注と同じく、登録した時点で引当在庫の枠から減らし、在庫を引き当てる。
    // 取込では止めずに進める（枠超え・実在庫超えは引当待ちで残し、あとで対処できる）。
    const frameWarnings = await this.reservations.consume(trx, order.id, { strict: false });
    const allocation = await this.allocation.afterOrderWrite(trx, order.id, userId, { checkOnHand: false });

    return {
      order_no: order.order_no,
      external_order_no: externalOrderNo,
      lines: n,
      status: allocation?.status ?? '未確定',
      shortages: [...frameWarnings, ...(allocation?.shortages ?? [])],
    };
  }

  /**
   * 商品の引き当て。テンプレートの sku_match_key に従う。
   * 白鳩は自社商品コードの列がないため JAN で引く。
   */
  private async resolveSku(
    trx: Transaction<DB>,
    matchKey: string,
    values: Record<string, string | null>,
    partnerId: number | undefined,
  ): Promise<number | null> {
    if (matchKey === 'jan') {
      const jan = values['jan'];
      if (!jan) return null;
      const row = await trx.selectFrom('skus').select('id').where('jan', '=', jan).executeTakeFirst();
      return row?.id ?? null;
    }

    if (matchKey === 'partner_code') {
      const code = values['partner_product_code'];
      if (!code || !partnerId) return null;
      const row = await trx
        .selectFrom('partner_products')
        .select('sku_id')
        .where('partner_id', '=', partnerId)
        .where('partner_product_code', '=', code)
        .executeTakeFirst();
      return row?.sku_id ?? null;
    }

    const code = values['sku_code'];
    if (!code) return null;
    const row = await trx.selectFrom('skus').select('id').where('sku_code', '=', code).executeTakeFirst();
    return row?.id ?? null;
  }

  /** 取込の履歴。何をいつ取り込んで、何件が要確認になったか。 */
  async listBatches(query: { import_type?: string; limit: number; offset: number }) {
    let base = this.db
      .selectFrom('import_batches as b')
      .leftJoin('import_templates as t', 't.id', 'b.import_template_id')
      .leftJoin('users as u', 'u.id', 'b.imported_by');

    if (query.import_type) base = base.where('b.import_type', '=', query.import_type);

    const [items, total] = await Promise.all([
      base
        .select([
          'b.id as id',
          'b.import_type as import_type',
          't.name as template_name',
          'b.file_name as file_name',
          'b.total_count as total_count',
          'b.success_count as success_count',
          'b.error_count as error_count',
          'b.imported_at as imported_at',
          'u.name as imported_by_name',
        ])
        .orderBy('b.imported_at', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  /**
   * 要確認のまま残っている取込。マスタ登録が済んだら取り込み直す。
   *
   * 件数は1ページ分ではなく全体の件数を返す。ここを表示件数にすると
   * 「50件」で頭打ちになり、あと何件残っているのかが画面から分からない。
   */
  async listPending(query: { limit: number; offset: number }) {
    const base = this.db
      .selectFrom('external_orders as e')
      .leftJoin('partners as p', 'p.id', 'e.partner_id')
      .where('e.status', '=', '取込済');

    const [items, total] = await Promise.all([
      base
        .select([
          'e.id as id',
          'e.channel as channel',
          'e.external_order_no as external_order_no',
          'e.delivery_code as delivery_code',
          'p.name1 as partner_name',
          'e.status as status',
          'e.error_message as error_message',
          'e.ordered_at as ordered_at',
        ])
        .orderBy('e.id', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }
}
