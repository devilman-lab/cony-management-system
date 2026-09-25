import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import { NumberingService } from '../common/numbering.service';
import { SettingsService } from '../common/settings.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { DB } from '../db/schema';
import { decode, decodeAuto, encodingLabel, parseCsv, type DetectedEncoding } from './csv';

export interface OmsImportInput {
  file_name: string;
  content_base64: string;
  /** 省略時は中身から見分ける（UTF-8／Shift-JIS）。明示するとその文字コードで読む。 */
  encoding?: string;
  dry_run?: boolean;
}

export interface OmsImportResult {
  file_name: string;
  dry_run: boolean;
  /** 実際に読み取った文字コード。ファイルの出どころを確かめるために返す。 */
  encoding: DetectedEncoding;
  total_lines: number;
  orders: number;
  /** 受注として登録できた件数。原本だけ残った分は含めない。 */
  created_orders: number;
  skipped_orders: number;
  /** 原本は残したが受注にできなかった件数（商品マスタ未登録）。 */
  pending_orders: number;
  unresolved_skus: number;
  line_types: Record<string, number>;
  channels: Record<string, number>;
  errors: Array<{ order_no: string; reason: string }>;
  warnings: string[];
}

/** 明細の種別。受領CSVに実在する5値と、自社入力で使う2値。 */
const LINE_TYPES = new Set(['商品', 'セット商品', '内訳商品', '販促品', '送料', '値引', '非商品']);

/** 在庫を引き当てる対象になる種別（セット商品は内訳商品から引くため除く）。 */
const STOCK_TYPES = new Set(['商品', '内訳商品']);

/** 自社商品コードそのものが空の明細。件数に出さないと「0件なのに受注にならない」になる。 */
const NO_CODE = '（自社商品コードなし）';

const need = (row: Record<string, string>, key: string): string => (row[key] ?? '').trim();

/**
 * 機能ID I-01 CSV取込（通販＝OMS受注CSV）
 *
 * 貴社ご回答により、このCSVは**出荷済みのデータ**として取り込む
 * （設定 OMS_IMPORT_MODE＝shipped_result）。受注として登録したうえで
 * 出荷済みの状態まで進め、在庫は二重に動かさない。
 *
 * 列は見出し名で対応させる。63列の並びが変わっても壊れないようにするため。
 */
@Injectable()
export class OmsImportService {
  private readonly logger = new Logger(OmsImportService.name);

  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly numbering: NumberingService,
    private readonly settings: SettingsService,
  ) {}

  async import(input: OmsImportInput, userId: number): Promise<OmsImportResult> {
    const bytes = Buffer.from(input.content_base64, 'base64');
    // 文字コードの指定がなければ中身から見分ける。助ネコの出力は Shift-JIS だが、
    // Excel などを通すと UTF-8 で届くことがあり、決め打ちだと読めない。
    const { text, encoding } = input.encoding
      ? { text: decode(bytes, input.encoding), encoding: encodingLabel(input.encoding) }
      : decodeAuto(bytes);
    const rows = parseCsv(text);
    if (rows.length < 2) throw new BadRequestException('見出し行と明細行が読み取れませんでした');

    const header = rows[0].map((h) => h.replace(/^"|"$/g, '').trim());
    const required = ['受注ルート', '受注番号', '商品種別', '個数', '単価'];
    const missing = required.filter((k) => !header.includes(k));
    if (missing.length > 0) {
      throw new BadRequestException(
        `通販CSVの見出しに ${missing.join('・')} がありません。` +
          `別の書式のファイルか、文字コードが違う可能性があります（${encoding} として読みました）。` +
          `通販システムから出したCSVを、そのまま選び直してください`,
      );
    }

    const records = rows.slice(1).map((cells) => {
      const rec: Record<string, string> = {};
      header.forEach((h, i) => (rec[h] = cells[i] ?? ''));
      return rec;
    });

    const lineTypes: Record<string, number> = {};
    const channels: Record<string, number> = {};
    const warnings: string[] = [];

    for (const r of records) {
      const t = need(r, '商品種別') || '（空）';
      lineTypes[t] = (lineTypes[t] ?? 0) + 1;
      const c = need(r, '受注ルート') || '（空）';
      channels[c] = (channels[c] ?? 0) + 1;
      if (!LINE_TYPES.has(t)) {
        warnings.push(`商品種別「${t}」は設計の許容値にありません（受注番号 ${need(r, '受注番号')}）`);
      }
    }

    // 受注番号ごとにまとめる。1受注に複数明細が並ぶ。
    const groups = new Map<string, Record<string, string>[]>();
    for (const r of records) {
      const no = need(r, '受注番号');
      if (!no) continue;
      const list = groups.get(no) ?? [];
      list.push(r);
      groups.set(no, list);
    }

    const result: OmsImportResult = {
      file_name: input.file_name,
      dry_run: input.dry_run ?? false,
      encoding,
      total_lines: records.length,
      orders: groups.size,
      created_orders: 0,
      skipped_orders: 0,
      pending_orders: 0,
      unresolved_skus: 0,
      line_types: lineTypes,
      channels,
      errors: [],
      warnings: [...new Set(warnings)],
    };

    if (input.dry_run) {
      // 自社商品コードが商品マスタにあるかだけ先に見る。
      // 受注にできるかを左右するのは在庫を動かす明細だけなので、そこに絞って数える。
      const stockLines = records.filter((r) => STOCK_TYPES.has(need(r, '商品種別')));
      const codes = [...new Set(stockLines.map((r) => need(r, '自社商品コード')).filter(Boolean))];
      const known = new Set<string>();
      if (codes.length > 0) {
        const found = await this.db
          .selectFrom('skus')
          .select('sku_code')
          .where('sku_code', 'in', codes)
          .execute();
        for (const f of found) known.add(f.sku_code);
      }
      const unresolved = new Set(codes.filter((c) => !known.has(c)));
      if (stockLines.some((r) => !need(r, '自社商品コード'))) unresolved.add(NO_CODE);
      result.unresolved_skus = unresolved.size;
      return result;
    }

    const mode = await this.settings.text('OMS_IMPORT_MODE', 'shipped_result');
    const duplicatePolicy = await this.settings.text('OMS_DUPLICATE_POLICY', 'skip');

    const batch = await this.db
      .insertInto('import_batches')
      .values({
        import_type: 'OMS_ORDER',
        file_name: input.file_name,
        total_count: records.length,
        success_count: 0,
        error_count: 0,
        imported_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // 商品マスタに無い自社商品コードは、同じものが何受注にも出る。
    // 何種類を登録すればよいかが分かるよう、重複を除いて数える（確認だけのときと同じ数え方）。
    const unresolvedCodes = new Set<string>();

    // 受注1件ごとに独立したトランザクションで処理する。
    // 1つのトランザクションにまとめると、1件でも失敗した時点で以降の命令が
    // すべて無効になり、残りの76件も入らなくなる。
    // 途中で止まっても、同じ受注番号は再取込で除外されるので安全に流し直せる。
    for (const [orderNo, lines] of groups) {
      try {
        const outcome = await this.db
          .transaction()
          .execute((trx) => this.createOne(trx, batch.id, orderNo, lines, mode, userId));
        // 受注にできなかったものを「作成」に混ぜない。混ぜると取り込めたつもりになり、
        // 商品マスタを直して取り込み直す必要があることに気づけない。
        if (outcome.result === 'skipped') result.skipped_orders += 1;
        else if (outcome.result === 'pending') result.pending_orders += 1;
        else result.created_orders += 1;
        for (const c of outcome.unresolved_codes) unresolvedCodes.add(c);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        this.logger.warn(`受注番号 ${orderNo} を取り込めませんでした: ${reason}`);
        if (duplicatePolicy === 'error') throw e;
        result.errors.push({ order_no: orderNo, reason });
      }
    }

    result.unresolved_skus = unresolvedCodes.size;

    await this.db
      .updateTable('import_batches')
      .set({ success_count: result.created_orders, error_count: result.errors.length })
      .where('id', '=', batch.id)
      .execute();

    return result;
  }

  private async createOne(
    trx: Transaction<DB>,
    batchId: number,
    orderNo: string,
    lines: Record<string, string>[],
    mode: string,
    userId: number,
  ): Promise<{ result: 'created' | 'skipped' | 'pending'; unresolved_codes: string[] }> {
    const head = lines[0];
    const channel = need(head, '受注ルート') || '自社サイト';

    // 同じ受注番号を再取込したときは除外する（設定 OMS_DUPLICATE_POLICY＝skip）
    const already = await trx
      .selectFrom('external_orders')
      .select('id')
      .where('channel', '=', channel)
      .where('external_order_no', '=', orderNo)
      .executeTakeFirst();
    if (already) return { result: 'skipped', unresolved_codes: [] };

    const partnerCode = await this.settings.text('AMAZON_PARTNER_CODE', 'AMZN');
    // 通販は個人宛の直送。取引先は受注ルートに対応する1件を使う。
    const partner = await trx
      .selectFrom('partners')
      .select(['id'])
      .where('is_customer', '=', true)
      .where('is_active', '=', true)
      .orderBy(sql`case when partner_code = ${partnerCode} then 1 else 0 end`, 'asc')
      .orderBy('partner_code', 'asc')
      .executeTakeFirstOrThrow();

    const warehouseName = need(head, '処理ルート');
    const warehouse = warehouseName
      ? await trx
          .selectFrom('warehouses')
          .select('id')
          .where('short_name', '=', warehouseName)
          .executeTakeFirst()
      : undefined;

    const external = await trx
      .insertInto('external_orders')
      .values({
        import_batch_id: batchId,
        channel,
        external_order_no: orderNo,
        partner_id: partner.id,
        ordered_at: this.toTimestamp(need(head, '注文日'), need(head, '注文時間')),
        payment_method: need(head, '決済方法') || null,
        payment_fee: this.num(need(head, '決済手数料')),
        total_amount: this.num(need(head, '合計請求金額')),
        consolidated_from: need(head, '同梱元') || null,
        consolidated_to: need(head, '同梱先') || null,
        slip_management_no: need(head, '伝票管理番号') || null,
        tracking_no: need(head, '伝票番号') || null,
        warehouse_name: warehouseName || null,
        ship_date: this.toDate(need(head, '処理済日')) ?? this.toDate(need(head, '出荷予定日')),
        raw_data: JSON.stringify(lines) as unknown as object,
        status: '取込済',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // 明細の原本。引き当てできなくても消えない。
    let n = 0;
    const resolved: Array<{
      line_no: number;
      parent_line_no: number | null;
      line_type: string;
      sku_id: number | null;
      sku_code: string;
      item_name: string;
      qty: string;
      unit_price: string;
    }> = [];
    let lastSetLineNo: number | null = null;

    for (const line of lines) {
      n += 1;
      const lineType = need(line, '商品種別') || '商品';
      const skuCode = need(line, '自社商品コード');
      const sku = skuCode
        ? await trx.selectFrom('skus').select('id').where('sku_code', '=', skuCode).executeTakeFirst()
        : undefined;

      // CSV は出現順で親子を表す。セット商品の直後に内訳商品が並ぶ。
      if (lineType === 'セット商品') lastSetLineNo = n;
      const parent = lineType === '内訳商品' ? lastSetLineNo : null;

      await trx
        .insertInto('external_order_lines')
        .values({
          external_order_id: external.id,
          line_no: n,
          line_type: lineType,
          item_name: need(line, '商品名') || null,
          qty: this.num(need(line, '個数')) ?? '0',
          unit_price: this.num(need(line, '単価')) ?? '0',
          external_sku_code: skuCode || null,
          partner_product_code: need(line, '商品コード（助ネコ）') || null,
          sku_id: sku?.id ?? null,
          raw_data: JSON.stringify(line) as unknown as object,
        })
        .execute();

      resolved.push({
        line_no: n,
        parent_line_no: parent,
        line_type: LINE_TYPES.has(lineType) ? lineType : '非商品',
        sku_id: sku?.id ?? null,
        sku_code: skuCode,
        item_name: need(line, '商品名') || '（品名なし）',
        qty: this.num(need(line, '個数')) ?? '0',
        unit_price: this.num(need(line, '単価')) ?? '0',
      });
    }

    // 在庫を動かす行に商品が付いていなければ、受注にはせず原本のまま残す
    const unresolved = resolved.filter((r) => STOCK_TYPES.has(r.line_type) && r.sku_id === null);
    if (unresolved.length > 0) {
      await trx
        .updateTable('external_orders')
        .set({
          error_message: `${unresolved.length} 行の商品が商品マスタにありません（${unresolved
            .slice(0, 3)
            .map((u) => u.item_name)
            .join('、')}）`,
        })
        .where('id', '=', external.id)
        .execute();
      // 受注は作っていない。原本だけが残った状態なので「作成した受注」には数えない。
      return {
        result: 'pending',
        unresolved_codes: [...new Set(unresolved.map((u) => u.sku_code || NO_CODE))],
      };
    }

    const orderDate = this.toDate(need(head, '注文日')) ?? sql<string>`current_date`;
    const shipDate = this.toDate(need(head, '処理済日')) ?? this.toDate(need(head, '出荷予定日'));

    const order = await trx
      .insertInto('sales_orders')
      .values({
        order_no: await this.numbering.next(trx, 'sales_order'),
        order_type: '通販',
        partner_id: partner.id,
        sales_category_id: sql<number>`(select id from sales_categories order by sort_order nulls last, code limit 1)`,
        order_date: orderDate,
        ship_date: shipDate,
        ship_from_warehouse_id: warehouse?.id ?? null,
        direct_name: `${need(head, 'お届け先名（姓）')} ${need(head, 'お届け先名（名）')}`.trim() || null,
        direct_kana: `${need(head, 'お届け先名（セイ）')} ${need(head, 'お届け先名（メイ）')}`.trim() || null,
        direct_postal_code: need(head, 'お届け先郵便番号').replace(/[^\d]/g, '') || null,
        direct_address1:
          `${need(head, 'お届け先住所（都道府県）')}${need(head, 'お届け先住所（市区町村）')}${need(head, 'お届け先住所（市区町村以降）')}`.trim() ||
          null,
        direct_address2: need(head, 'お届け先住所（建物名等）') || null,
        direct_tel: need(head, 'お届け先電話番号') || null,
        delivery_note_remarks: need(head, '備考（注文）') || null,
        channel,
        external_order_id: external.id,
        // 出荷済みデータとして取り込む。引当はしない（すでに棚から出ている）。
        status: mode === 'shipped_result' ? '出荷済' : '未確定',
        created_by: userId,
        updated_by: userId,
      })
      .returning(['id', 'order_no'])
      .executeTakeFirstOrThrow();

    for (const r of resolved) {
      await trx
        .insertInto('sales_order_lines')
        .values({
          sales_order_id: order.id,
          line_no: r.line_no,
          parent_line_no: r.parent_line_no,
          line_type: r.line_type,
          sku_id: r.sku_id,
          item_name: r.item_name,
          qty: r.qty,
          unit_price: r.unit_price,
          amount: sql<string>`${r.qty}::numeric * ${r.unit_price}::numeric`,
          created_by: userId,
        })
        .execute();
    }

    // 出荷済みとして取り込む場合は、出荷の伝票も作る。
    // 在庫はすでに動いたあとなので、引当も実在庫の増減も行わない。
    if (mode === 'shipped_result' && warehouse) {
      const shipment = await trx
        .insertInto('shipments')
        .values({
          shipment_no: need(head, '伝票管理番号') || order.order_no,
          sales_order_id: order.id,
          warehouse_id: warehouse.id,
          ship_date: shipDate,
          planned_ship_date: shipDate,
          carrier: need(head, '運送会社システム') || null,
          tracking_no: need(head, '伝票番号') || null,
          shipping_label_type: need(head, '送り状種別') || null,
          cod_amount: this.num(need(head, '代引請求金額')),
          delivery_date_specified: this.toDate(need(head, 'お届け指定日')),
          delivery_time_slot: need(head, 'お届け時間帯') || null,
          status: '出荷済',
          confirmed_at: new Date(),
          created_by: userId,
          updated_by: userId,
        })
        .onConflict((oc) => oc.column('shipment_no').doNothing())
        .returning('id')
        .executeTakeFirst();

      if (shipment) {
        let m = 0;
        for (const r of resolved.filter((x) => STOCK_TYPES.has(x.line_type))) {
          m += 1;
          await trx
            .insertInto('shipment_lines')
            .values({
              shipment_id: shipment.id,
              line_no: m,
              sku_id: r.sku_id,
              item_name: r.item_name,
              qty: r.qty,
              unit_price: r.unit_price,
              amount: sql<string>`${r.qty}::numeric * ${r.unit_price}::numeric`,
              created_by: userId,
            })
            .execute();
        }
      }
    }

    await trx
      .updateTable('external_orders')
      .set({ sales_order_id: order.id, status: '変換済' })
      .where('id', '=', external.id)
      .execute();

    return { result: 'created', unresolved_codes: [] };
  }

  /** 「2026/9/1」「2026-09-01」を YYYY-MM-DD にする。空なら null。 */
  private toDate(value: string): string | null {
    const v = value.trim().replace(/[.\-]/g, '/');
    if (v === '') return null;
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(v);
    if (!m) return null;
    const pad = (s: string) => (s.length === 1 ? `0${s}` : s);
    return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  }

  /**
   * 注文日と注文時間を1つの日時にする。時刻は「13:10:00」「9:05」の両方が来る。
   * 読めなかった場合は null を返す。日時として無効な値をそのまま渡すと、
   * データベース側で「invalid input syntax」になって受注1件が丸ごと落ちる。
   */
  private toTimestamp(date: string, time: string): Date | null {
    const d = this.toDate(date);
    if (!d) return null;

    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(time.trim());
    const hh = (m?.[1] ?? '0').padStart(2, '0');
    const mm = m?.[2] ?? '00';
    const ss = m?.[3] ?? '00';

    const dt = new Date(`${d}T${hh}:${mm}:${ss}+09:00`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  /** 「1,200」「¥1,200」を数値文字列にする。読めなければ null。 */
  private num(value: string): string | null {
    const v = value.replace(/[,\s¥￥]/g, '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    if (v === '' || !/^-?\d+(\.\d+)?$/.test(v)) return null;
    return v;
  }
}
