import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';

import { AttachmentsService } from '../attachments/attachments.service';
import { orderShippingFeeSql } from '../billing/shipping-fee';
import { amountIn, amountWithCode, currencyDigits, isYen } from '../common/currency';
import { SettingsService } from '../common/settings.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import { skuItemNameExpr } from '../masters/products.service';
import { ShipmentsService } from '../shipping/shipments.service';
import {
  drawDeliveryNotes,
  type DeliveryNoteRow,
  type DeliveryNoteSheet,
  type DeliverySender,
  type DeliveryTotalRow,
} from './form-delivery-note';
import { drawPickingLists, type PickingSheet } from './form-picking-list';
import { drawShippingRequests, type ShippingRequestSheet } from './form-shipping-request';
import { ReportDoc, qty, ymd } from './pdf-builder';
import { dateTime, shortDate, slashDate } from './pdf-form';
import { mergeToPdf, type MergeInput } from './pdf-merge';

/**
 * 納品書の様式（2026-10-13 受注処理編 O-31：「単価あり」を削除し、単価あり2・上代あり・単価なし の3つ）。
 * 設定 DELIVERY_NOTE_DEFAULT_FORM の選択肢と一致させる。
 */
export const DELIVERY_NOTE_FORMS = ['単価あり2', '上代あり', '単価なし'] as const;
export type DeliveryNoteForm = (typeof DELIVERY_NOTE_FORMS)[number];
/** 受け付ける様式の名前。「単価あり」を渡されたら「単価あり2」として扱う（古い画面・伝票発行分類・設定の値）。 */
export const DELIVERY_NOTE_FORM_INPUTS = [...DELIVERY_NOTE_FORMS, '単価あり'] as const;
export type DeliveryNoteFormInput = (typeof DELIVERY_NOTE_FORM_INPUTS)[number];

export interface PrintResult {
  pdf: Buffer;
  filename: string;
  /** 一緒に印刷できなかった添付（Excel・Word など）。応答ヘッダで知らせる。 */
  skipped?: string[];
}

/**
 * 出荷確定と同時に印刷する帳票の種類。「出荷指示書」は「出荷依頼書」に呼び名をそろえた（O-25）。
 * 古い呼び名で頼まれても出荷依頼書を出す。
 */
export const PRINT_DOCUMENTS = ['出荷依頼書', 'ピッキングリスト', '納品書'] as const;
export const PRINT_DOCUMENT_INPUTS = [...PRINT_DOCUMENTS, '出荷指示書'] as const;
export type PrintDocument = (typeof PRINT_DOCUMENT_INPUTS)[number];

/** お届け先（受注に入れた住所・お名前）を宛先にする受注の区分（直送・通販・サンプル・社内移動）。 */
const DIRECT_TYPES = new Set(['直送', '通販', 'サンプル', '社内移動']);

type ShipmentHeader = Awaited<ReturnType<ReportsService['shipmentHeaders']>>[number];
type OrderLine = Awaited<ReturnType<ReportsService['orderLines']>>[number];

/** 「単価あり」は「単価あり2」として扱う。知らない名前は undefined。 */
function normalizeForm(name: string | null | undefined): DeliveryNoteForm | undefined {
  const v = name?.trim();
  if (!v) return undefined;
  if (v === '単価あり') return '単価あり2';
  return DELIVERY_NOTE_FORMS.find((f) => f === v);
}

@Injectable()
export class ReportsService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly settings: SettingsService,
    private readonly shipments: ShipmentsService,
    private readonly attachments: AttachmentsService,
  ) {}

  // ==========================================================================
  // 出荷確定と印刷を同時に行う（9/15 ご確認②）
  // ==========================================================================

  /**
   * 物流PCの「出荷確定」ボタン。選んだ出荷をまとめて確定し（実在庫が減る）、
   * 帳票と添付ファイルを1つの PDF にして返す。確定は全件まとめて1つのトランザクションで
   * 行うので、途中で1件でも通らなければ何も確定しない。
   */
  async confirmAndPrint(
    input: {
      shipment_ids: number[];
      documents: PrintDocument[];
      form?: DeliveryNoteFormInput;
      ship_date?: string | null;
      include_attachments: boolean;
    },
    userId: number,
  ): Promise<PrintResult & { confirmed: { shipment_id: number; shipment_no: string }[] }> {
    if (input.shipment_ids.length === 0) throw new BadRequestException('出荷を選んでください');
    const ids = [...new Set(input.shipment_ids)];

    const confirmed = await this.db.transaction().execute(async (trx) => {
      const done: { shipment_id: number; shipment_no: string }[] = [];
      for (const id of ids) {
        const r = await this.shipments.confirmInTrx(trx, id, input.ship_date ?? null, userId);
        done.push({ shipment_id: r.shipment_id, shipment_no: r.shipment_no });
      }
      return done;
    });

    // 帳票は出荷ごとにまとめず、種類ごとに全件分を1本ずつ作って並べる（頂いた運用どおり）。
    // 古い呼び名「出荷指示書」と新しい「出荷依頼書」が両方来ても1回だけ出す
    const kinds = [...new Set(input.documents.map((k) => (k === '出荷指示書' ? '出荷依頼書' : k)))];
    const parts: MergeInput[] = [];
    for (const kind of kinds) {
      const r =
        kind === '出荷依頼書'
          ? await this.shippingInstructions(ids, userId)
          : kind === 'ピッキングリスト'
            ? await this.pickingList(ids, userId)
            : await this.deliveryNotes(ids, input.form, userId);
      parts.push({ name: r.filename, mime: 'application/pdf', content: r.pdf });
    }

    if (input.include_attachments) {
      for (const id of ids) {
        for (const att of await this.printableAttachments(id)) parts.push(att);
      }
    }

    const merged = await mergeToPdf(parts);
    return {
      pdf: merged.pdf,
      filename: this.filename('出荷確定', ids.length),
      skipped: merged.skipped,
      confirmed,
    };
  }

  /** 出荷指示のときに一緒に印刷する添付。出荷に付いたものと、その受注に付いたもの。 */
  private async printableAttachments(shipmentId: number): Promise<MergeInput[]> {
    const sh = await this.db
      .selectFrom('shipments')
      .select('sales_order_id')
      .where('id', '=', shipmentId)
      .executeTakeFirst();

    let q = this.db
      .selectFrom('attachments')
      .select(['id', 'file_name', 'mime_type'])
      .where('is_print_target', '=', true);
    q = sh?.sales_order_id
      ? q.where((eb) =>
          eb.or([
            eb.and([eb('ref_table', '=', 'shipments'), eb('ref_id', '=', shipmentId)]),
            eb.and([eb('ref_table', '=', 'sales_orders'), eb('ref_id', '=', sh.sales_order_id as number)]),
          ]),
        )
      : q.where('ref_table', '=', 'shipments').where('ref_id', '=', shipmentId);

    const rows = await q.orderBy('id').execute();
    const out: MergeInput[] = [];
    for (const row of rows) {
      try {
        const file = await this.attachments.read(row.id);
        out.push({ name: file.file_name, mime: file.mime_type, content: file.content });
      } catch {
        out.push({ name: `${row.file_name}（実体なし）`, mime: '', content: Buffer.alloc(0) });
      }
    }
    return out;
  }

  // ==========================================================================
  // 出荷依頼書（2026-10-13 受注処理編 O-26。経路は今までどおり /reports/shipping-instructions）
  // ==========================================================================

  /**
   * 貴社の様式「出荷依頼書」（A4 横）。1出荷1枚、明細は 11 行の枠で、12 行目からは次の紙に続ける。
   * 明細はセットをセットのまま1行で出す（内訳商品の行は出さない）。送料・値引の行は品物ではないので出さない。
   */
  async shippingInstructions(shipmentIds: number[], userId: number): Promise<PrintResult> {
    const shipments = await this.shipmentHeaders(shipmentIds);
    const requestDate = shortDate();
    const sheets: ShippingRequestSheet[] = [];

    for (const sh of shipments) {
      const lines = await this.orderLines(sh.sales_order_id);
      const place = this.placeOf(sh);
      sheets.push({
        shipmentNo: sh.shipment_no,
        requestDate,
        warehouseName: sh.warehouse_name,
        isReturn: sh.order_type === '返品',
        lines: this.goodsRows(lines).map((l) => ({
          productCode: l.sku_code ?? '',
          itemName: l.item_name,
          color: l.color_name ?? '',
          size: l.size_name ?? '',
          qty: qty(l.qty),
          // 出荷依頼書適用（明細ごと。O-09）
          note: l.shipping_note ?? '',
          // JAN は得意先別商品の出荷JAN、空ならコニーJAN（2026-10-09 マスター編② M-18）
          jan: l.jan ?? '',
        })),
        // 出庫日は出荷日（確定済みなら確定した日）、無ければ出荷予定日
        shipDate: slashDate(sh.ship_date ?? sh.planned_ship_date ?? sh.order_ship_date),
        deliveryDate: slashDate(sh.delivery_date),
        // 納品時間（O-03）
        deliveryTime: sh.delivery_time_name ?? '',
        destinationCode: sh.delivery_code ?? '',
        partnerName: this.partnerName(sh),
        postalCode: place.postalCode,
        address: place.address,
        recipientName: place.name,
        tel: place.tel,
        instructions: this.instructionsOf(sh),
        remarks: sh.shipping_remarks ?? '',
      });
    }

    const doc = new ReportDoc('出荷依頼書', { landscape: true });
    drawShippingRequests(doc, sheets);
    // 帳票発行履歴の種類は「出荷指示書」のまま記録する（表の決まり ck_shipdoc_type。画面の呼び名だけ変えた）
    await this.recordPrint(shipmentIds, '出荷指示書', userId);
    return { pdf: await doc.finish(), filename: this.filename('出荷依頼書', shipments.length) };
  }

  // ==========================================================================
  // ピッキングリスト（O-27）
  // ==========================================================================

  /**
   * 貴社の様式「ピッキングリスト」（A4 横）。1出荷1枚（以前は選んだ出荷をまとめて1枚）。
   *
   * PICKING_EXPAND_SET が true のときは引当（allocations）を数える。引当は
   * セットを構成品に展開したあとの姿なので、頂いた帳票サンプルどおり
   * 「展開したうえで同一商品を合算した」一覧になる。false のときはセットをセットのまま数える。
   */
  async pickingList(shipmentIds: number[], userId: number): Promise<PrintResult> {
    const shipments = await this.shipmentHeaders(shipmentIds);
    const expand = await this.settings.bool('PICKING_EXPAND_SET', true);
    const requestedAt = dateTime();
    const sheets: PickingSheet[] = [];

    for (const sh of shipments) {
      const rows = expand ? await this.pickedSkus(sh.sales_order_id) : await this.orderedSkus(sh.sales_order_id);
      const place = this.placeOf(sh);
      sheets.push({
        shipmentNo: sh.shipment_no,
        warehouseName: sh.warehouse_name,
        deliveryDate: slashDate(sh.delivery_date),
        deliveryTime: sh.delivery_time_name ?? '',
        partnerCode: sh.partner_code ?? '',
        partnerName: this.partnerName(sh),
        partnerTel: sh.partner_tel ?? '',
        destinationCode: sh.delivery_code ?? '',
        destinationName: place.name,
        address: [place.postalCode ? `〒${place.postalCode}` : '', place.address].filter(Boolean).join(' '),
        requestedAt,
        isReturn: sh.order_type === '返品',
        rows: rows.map((r) => ({
          itemName: r.item_name,
          color: r.color_name ?? '',
          size: r.size_name ?? '',
          productCode: r.sku_code,
          qty: qty(r.qty),
        })),
        // 別途連絡事項＝出荷依頼書の備考欄と同じ内容
        remarks: sh.shipping_remarks ?? '',
      });
    }

    const doc = new ReportDoc('ピッキングリスト', { landscape: true });
    drawPickingLists(doc, sheets);
    await this.recordPrint(shipmentIds, 'ピッキングリスト', userId);
    return { pdf: await doc.finish(), filename: this.filename('ピッキングリスト', shipments.length) };
  }

  /** 引き当てた構成品を SKU ごとに合算する。品名は品名の決まり（SKU の名前＋カラー＋サイズ。O-01）。 */
  private pickedSkus(orderId: number) {
    return this.db
      .selectFrom('allocations as a')
      .innerJoin('sales_order_lines as l', 'l.id', 'a.sales_order_line_id')
      .innerJoin('skus as s', 's.id', 'a.sku_id')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .leftJoin('colors as cl', 'cl.id', 's.color_id')
      .leftJoin('sizes as sz', 'sz.id', 's.size_id')
      .select([
        's.sku_code as sku_code',
        skuItemNameExpr('s', 'p', 'cl', 'sz').as('item_name'),
        'cl.name as color_name',
        'sz.name as size_name',
        sql<string>`sum(a.qty)`.as('qty'),
      ])
      .where('l.sales_order_id', '=', orderId)
      // 出荷確定と同時に印刷すると、この時点では引当が「出荷済」に変わっている。
      // 「引当中」だけを見ると、出荷確定して印刷したときのピッキングリストが
      // 必ず白紙になる（確定後の刷り直しも同じ）。
      .where('a.status', 'in', ['引当中', '出荷済'])
      .groupBy(['s.id', 'p.id', 'cl.id', 'sz.id'])
      .orderBy('s.sku_code')
      .execute();
  }

  /** セットを展開しないとき。受注明細の商品・セット商品を SKU ごとに合算する（セットの内訳商品の行は数えない）。 */
  private orderedSkus(orderId: number) {
    return this.db
      .selectFrom('sales_order_lines as l')
      .innerJoin('skus as s', 's.id', 'l.sku_id')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .leftJoin('colors as cl', 'cl.id', 's.color_id')
      .leftJoin('sizes as sz', 'sz.id', 's.size_id')
      .select([
        's.sku_code as sku_code',
        skuItemNameExpr('s', 'p', 'cl', 'sz').as('item_name'),
        'cl.name as color_name',
        'sz.name as size_name',
        sql<string>`sum(l.qty)`.as('qty'),
      ])
      .where('l.sales_order_id', '=', orderId)
      .where((eb) =>
        eb.or([
          eb('l.line_type', 'in', ['商品', 'セット商品']),
          eb.and([eb('l.line_type', '=', '内訳商品'), eb('l.parent_line_no', 'is', null)]),
        ]),
      )
      .groupBy(['s.id', 'p.id', 'cl.id', 'sz.id'])
      .orderBy('s.sku_code')
      .execute();
  }

  // ==========================================================================
  // 納品書（3様式。O-28〜O-32）
  // ==========================================================================

  async deliveryNotes(
    shipmentIds: number[],
    form: DeliveryNoteFormInput | undefined,
    userId: number,
  ): Promise<PrintResult> {
    const shipments = await this.shipmentHeaders(shipmentIds);
    const requested = normalizeForm(form);
    const fallback = await this.deliveryNoteDefaultForm();
    const sender = await this.sender();
    const createdDate = shortDate();
    const sheets: DeliveryNoteSheet[] = [];

    for (const sh of shipments) {
      // 様式の決め方：指定 → 委託の受注は単価なし（O-12。委託は単価を持たない）→ 納品先マスタの伝票発行分類 → システム設定の既定
      const chosen =
        requested ?? (sh.trade_type === '委託' ? '単価なし' : undefined) ?? normalizeForm(sh.slip_issue_class) ?? fallback;
      const lines = await this.orderLines(sh.sales_order_id);
      sheets.push(await this.deliverySheet(sh, chosen, lines, sender, createdDate));
    }

    const doc = new ReportDoc('納品書', { landscape: true });
    drawDeliveryNotes(doc, sheets);
    await this.recordPrint(shipmentIds, '納品書', userId);
    return { pdf: await doc.finish(), filename: this.filename('納品書', shipments.length) };
  }

  private async deliverySheet(
    sh: ShipmentHeader,
    form: DeliveryNoteForm,
    lines: OrderLine[],
    sender: DeliverySender,
    createdDate: string,
  ): Promise<DeliveryNoteSheet> {
    // 外貨の受注（取引先の通貨が円以外。2026-10-12 No.39）は金額を小数2桁で出し、合計には通貨を添える
    const cur = sh.currency;
    const fmt = (v: string | number | null) => amountIn(v, cur);
    const direct = this.usesDirect(sh);
    const blank = { poNo: '', jan: '', productCode: '', note: '', unitPrice: '', amount: '', size: '', color: '' };

    let rows: DeliveryNoteRow[];
    let totals: DeliveryTotalRow[] = [];
    let inclLabel = '合計金額(税込)';
    const taxNotes: string[] = [];

    if (form === '単価あり2') {
      rows = this.pricedRows(lines).map((l) => ({
        ...blank,
        // 先方発注番号は受注の先方発注番号
        poNo: sh.po_no ?? '',
        jan: l.jan ?? '',
        productCode: l.sku_code ?? '',
        itemName: l.item_name,
        note: l.delivery_slip_note ?? '',
        qty: qty(l.qty),
        unitPrice: fmt(l.unit_price),
        amount: fmt(l.amount),
      }));

      // 海外の得意先は消費税 0。請求書（締め）と同じく、明細の税率にかかわらず 0 にし、
      // 扱い（免税（税抜扱い）／課税対象外）を請求書と同じ言い方で書く（2026-10-12 受入テスト M-02）。
      // どちらで書くかは取引先の消費税免税区分、空ならシステム設定（2026-10-16 マスター編_3 M3-07）
      const overseas = sh.partner_is_overseas === true;
      const taxed = lines.map((l) => ({ tax_rate: overseas ? '0' : l.tax_rate, amount: l.amount }));

      // 受注の「納品書に送料を記載する」（O-10）。金額は請求と同じ決まり（送料調整、空なら自動計算。shipping-fee.ts）。
      // 金額の入った送料の行が明細にあれば、その行がそのまま載るので足さない（請求と同じ）。
      // 送料は請求と同じく消費税をかけずに合計へ足す（請求書の当月請求額は送料を税の計算に入れていない。billing.service.ts）。
      // 税をかけると、同じ受注の納品書と請求書で税込の額が食い違うため
      let fee = 0;
      if (sh.print_shipping_fee && !lines.some((l) => l.line_type === '送料' && Number(l.amount) !== 0)) {
        const feeText = sh.shipping_fee ?? '0';
        rows.push({ ...blank, itemName: '送料', qty: '1', unitPrice: fmt(feeText), amount: fmt(feeText) });
        fee = Number(feeText);
      }

      // 税率ごとに合計する。10% と 8% が混ざるときは 10%対象・8%対象・合計 の段に分ける（O-29）。
      // 金額 0 の行（セットの内訳・無償の非商品など）だけの税率は段にしない
      const byRate = new Map<number, { tax_rate: string; amount: string }[]>();
      for (const t of taxed.filter((x) => Number(x.amount) !== 0)) {
        const rate = Number(t.tax_rate);
        byRate.set(rate, [...(byRate.get(rate) ?? []), t]);
      }
      const digits = currencyDigits(cur);
      const groups: { rate: number; excl: number; incl: number }[] = [];
      for (const rate of [...byRate.keys()].sort((a, b) => b - a)) {
        const items = byRate.get(rate) ?? [];
        const excl = Number(this.sum(items.map((t) => t.amount)).toFixed(digits));
        const tax = overseas ? 0 : await this.taxOf(items, cur);
        groups.push({ rate, excl, incl: Number((excl + tax).toFixed(digits)) });
      }
      // 合計には送料（税なし）を税抜・税込の両方にそのまま足す。税率ごとの段には入れない
      const all = {
        excl: Number((this.sum(groups.map((g) => g.excl)) + fee).toFixed(digits)),
        incl: Number((this.sum(groups.map((g) => g.incl)) + fee).toFixed(digits)),
      };
      totals =
        groups.length > 1
          ? [
              ...groups.map((g) => ({
                label: `${g.rate}%対象`,
                excl: amountWithCode(g.excl, cur),
                incl: amountWithCode(g.incl, cur),
              })),
              { label: '合計', excl: amountWithCode(all.excl, cur), incl: amountWithCode(all.incl, cur) },
            ]
          : [{ label: null, excl: amountWithCode(all.excl, cur), incl: amountWithCode(all.incl, cur) }];

      if (overseas) {
        inclLabel = '合計金額';
        taxNotes.push(`消費税　${await this.settings.overseasTaxLabel(sh.partner_overseas_tax_treatment)}`);
      }
      if (!isYen(cur)) taxNotes.push(`通貨　${cur}`);
    } else if (form === '上代あり') {
      // 上代は得意先別商品マスタ。金額（税抜）は上代×数量。未登録なら空欄。合計は出さない（O-30）
      rows = this.goodsRows(lines).map((l) => ({
        ...blank,
        productCode: l.sku_code ?? '',
        itemName: l.item_name,
        note: l.delivery_slip_note ?? '',
        qty: qty(l.qty),
        unitPrice: fmt(l.retail_price),
        amount: l.retail_price === null ? '' : fmt(Number(l.retail_price) * Number(l.qty)),
        size: l.size_name ?? '',
        color: l.color_name ?? '',
      }));
    } else {
      // 単価なし。「備考」の列は明細の納品書適用、「コード」の列は JAN（O-28）
      rows = this.goodsRows(lines).map((l) => ({
        ...blank,
        jan: l.jan ?? '',
        productCode: l.sku_code ?? '',
        itemName: l.item_name,
        note: l.delivery_slip_note ?? '',
        qty: qty(l.qty),
        size: l.size_name ?? '',
        color: l.color_name ?? '',
      }));
    }

    return {
      form,
      noteNo: sh.shipment_no,
      createdDate,
      addressee: this.addresseeOf(sh, direct),
      sender,
      // 納品日は受注の納品日。無ければ出荷日（確定済みなら確定した日）
      deliveryDate: slashDate(sh.delivery_date ?? sh.ship_date ?? sh.planned_ship_date),
      // 納品場所は納品先マスタの「納品書 印字2」、空なら納品先名（O-32）。お届け先の受注はお届け先のお名前
      deliveryPlace: direct
        ? sh.direct_name?.trim() || sh.delivery_note_print2?.trim() || sh.destination_name || ''
        : sh.delivery_note_print2?.trim() || sh.destination_name || sh.direct_name?.trim() || '',
      isReturn: sh.order_type === '返品',
      rows,
      totals,
      inclLabel,
      taxNotes,
      remarks: sh.delivery_note_remarks ?? '',
    };
  }

  // ==========================================================================
  // 請求書
  // ==========================================================================

  async invoices(invoiceIds: number[], _userId: number): Promise<PrintResult> {
    if (invoiceIds.length === 0) throw new BadRequestException('請求書を選んでください');

    const headers = await this.db
      .selectFrom('invoices as iv')
      .innerJoin('partners as p', 'p.id', 'iv.partner_id')
      .selectAll('iv')
      .select([
        'p.partner_code as partner_code',
        'p.name1 as partner_name1',
        'p.name2 as partner_name2',
        'p.postal_code as partner_postal_code',
        'p.address1 as partner_address1',
        'p.address2 as partner_address2',
        'p.invoice_note as invoice_note',
        // 取引先マスタで宛名・担当者名を決めていればそちらを使う（1001 ご要望）
        'p.invoice_addressee as invoice_addressee',
        'p.invoice_contact_name as invoice_contact_name',
        // 海外の得意先は消費税 0 で締めてある。税の欄に免税／課税対象外と書くために使う（2026-10-09 マスター編②）
        'p.is_overseas as is_overseas',
        // 免税（税抜扱い）か課税対象外か。取引先ごと（空ならシステム設定。2026-10-16 マスター編_3 M3-07）
        'p.overseas_tax_treatment as overseas_tax_treatment',
        // 消費税免税区分のある取引先は、未計上・調整を税率で分けずに1行で出す（下の totals）
        sql<string>`(iv.unposted_10 + iv.unposted_8)::text`.as('unposted_total'),
        sql<string>`(iv.adjust_10 + iv.adjust_8)::text`.as('adjust_total'),
      ])
      .where('iv.id', 'in', invoiceIds)
      .orderBy('iv.invoice_no')
      .execute();

    if (headers.length === 0) throw new NotFoundException('請求書が見つかりません');

    const printIssueDate = await this.settings.bool('INVOICE_PRINT_ISSUE_DATE', false);
    const company = await this.company();
    const doc = new ReportDoc('請求書');

    for (const [i, iv] of headers.entries()) {
      if (i > 0) doc.newPage();
      // 海外の得意先の税の表記（税額はどちらも 0）。取引先の消費税免税区分、空ならシステム設定 OVERSEAS_TAX_TREATMENT
      const overseasTaxLabel = await this.settings.overseasTaxLabel(iv.overseas_tax_treatment);

      const [lines, taxes] = await Promise.all([
        this.db
          .selectFrom('invoice_lines')
          .select(['line_no', 'item_name', 'qty', 'unit_price', 'tax_rate', 'amount', 'shipment_id', 'return_id'])
          .where('invoice_id', '=', iv.id)
          .orderBy('line_no')
          .execute(),
        this.db
          .selectFrom('invoice_tax_summaries')
          .select(['tax_rate', 'taxable_base', 'tax_amount'])
          .where('invoice_id', '=', iv.id)
          .orderBy('tax_rate', 'desc')
          .execute(),
      ]);

      doc.title('請 求 書');
      const head: [string, string][] = [
        ['請求番号', iv.invoice_no],
        ['締め日', ymd(iv.closing_date)],
        // 宛名は取引先マスタの「請求書の宛名」を優先する。空欄なら取引先名（1001 ご要望）。
        [
          '請求先',
          iv.invoice_addressee?.trim()
            ? iv.invoice_addressee.trim()
            : `${iv.partner_name1}${iv.partner_name2 ? ' ' + iv.partner_name2 : ''} 御中`,
        ],
        ['対象期間', `${ymd(iv.period_from)} 〜 ${ymd(iv.period_to)}`],
      ];
      // 担当者名は入っているときだけ出す
      if (iv.invoice_contact_name?.trim()) head.push(['ご担当者', iv.invoice_contact_name.trim()]);
      // 発行日は貴社ご指示により既定で印刷しない（設定 INVOICE_PRINT_ISSUE_DATE）。
      if (printIssueDate && iv.issued_at) head.push(['発行日', ymd(iv.issued_at)]);
      // 外貨の請求（取引先の通貨が円以外。2026-10-12 No.39）は通貨を書き、金額を小数2桁で出す
      if (!isYen(iv.currency)) head.push(['通貨', iv.currency]);
      if (iv.po_no) head.push(['発注番号', iv.po_no]);
      doc.keyValues(head);

      // 住所が無いときに「〒」だけの行を出さない。
      const billTo = [
        iv.partner_postal_code ? `〒${iv.partner_postal_code}` : '',
        `${iv.partner_address1 ?? ''}${iv.partner_address2 ?? ''}`.trim(),
      ].filter(Boolean).join('　');
      if (billTo) doc.line(billTo);
      // 差出人は会社名だけ（9/15 ご回答。住所・電話などの設定は納品書の差出人欄だけで使う）。登録番号は設定があれば添える
      doc.line(company.name);
      if (company.invoiceNo) doc.line(`登録番号　${company.invoiceNo}`);
      doc.y += 4;

      // 請求書上部の税率別内訳（頂いた様式に合わせて明細の前に置く）
      if (taxes.length > 0) {
        doc.table(
          [
            { label: '税率', width: iv.is_overseas ? 120 : 70, align: 'center' },
            { label: '対象金額（税抜）', width: 150, align: 'right' },
            { label: '消費税額', width: 150, align: 'right' },
          ],
          // 海外の得意先は税率の欄に「免税（税抜扱い）」／「課税対象外」と書く（0% と出すと
          // 国内の 0% 税率と見分けがつかないため）
          taxes.map((t) => [
            iv.is_overseas ? overseasTaxLabel : `${Number(t.tax_rate)}%`,
            amountIn(t.taxable_base, iv.currency),
            amountIn(t.tax_amount, iv.currency),
          ]),
        );
        doc.y += 4;
      }
      // 税率別の内訳が無い（明細0件）ときも扱いが分かるよう、1行で書いておく
      if (iv.is_overseas) doc.line(`消費税　${overseasTaxLabel}`);

      doc.totals([
        ['前回請求残高', amountWithCode(iv.prev_invoice_balance, iv.currency)],
        ['今回入金額', amountWithCode(iv.current_receipt_amount, iv.currency)],
        ['繰越残高', amountWithCode(iv.carryover_balance, iv.currency)],
        ['出荷', amountWithCode(iv.shipment_amount, iv.currency)],
        ['返品額', amountWithCode(iv.return_amount, iv.currency)],
        // 消費税免税区分のある取引先（税率はすべて 0）は、10%・8% の行を出さず「未計上（免税（税抜扱い））」の形で1行にする
        // （2026-10-18 受入 W1 N7。上の税率別の内訳・「消費税　免税（税抜扱い）」と表記をそろえる）
        ...((iv.is_overseas
          ? [
              [`未計上（${overseasTaxLabel}）`, amountWithCode(iv.unposted_total, iv.currency)],
              [`調整（${overseasTaxLabel}）`, amountWithCode(iv.adjust_total, iv.currency)],
            ]
          : [
              ['未計上10%', amountWithCode(iv.unposted_10, iv.currency)],
              ['未計上8%', amountWithCode(iv.unposted_8, iv.currency)],
              ['調整10%', amountWithCode(iv.adjust_10, iv.currency)],
              ['調整8%', amountWithCode(iv.adjust_8, iv.currency)],
            ]) as [string, string][]),
        ['手数料', amountWithCode(iv.fee_amount, iv.currency)],
        ['送料', amountWithCode(iv.shipping_fee_amount, iv.currency)],
        ['当月請求額', amountWithCode(iv.current_invoice_amount, iv.currency)],
        ['今回請求残高', amountWithCode(iv.current_balance, iv.currency)],
        // 消費税免税区分のある取引先は「未計上（免税（税抜扱い））」が長いので、項目名の欄を広げて1行に収める
      ], iv.is_overseas ? 160 : 120);

      if (lines.length > 0) {
        doc.y += 6;
        doc.line('明細');
        doc.table(
          [
            { label: '行', width: 26, align: 'right' },
            { label: '内容', width: 255 },
            { label: '数量', width: 50, align: 'right' },
            { label: '単価', width: 70, align: 'right' },
            { label: '税率', width: 40, align: 'center' },
            { label: '金額', width: 82, align: 'right' },
          ],
          // 出荷・返品の明細は1出荷（×税率）の合計なので単価は持たない（締めで 0 を入れてある）。0 と印字すると
          // 単価 0 円で売ったように読めるため空欄にする（2026-10-18 受入 W1 N7。金額・請求額は正しい）。
          lines.map((l) => [
            l.line_no,
            l.item_name,
            qty(l.qty),
            (l.shipment_id !== null || l.return_id !== null) && Number(l.unit_price) === 0 ? '' : amountIn(l.unit_price, iv.currency),
            `${Number(l.tax_rate)}%`,
            amountIn(l.amount, iv.currency),
          ]),
        );
      }
      if (iv.invoice_note) doc.line(`備考　${iv.invoice_note}`);
    }

    // 印刷しただけでは「発行済」にしない。
    // 発行は画面の「発行」ボタン（POST /billing/invoices/:id/issue）だけで行う。
    // 印刷で状態が変わると、中身を確かめようと PDF を開いた時点で
    // 手入力の修正も締め直しもできなくなってしまう（GET に副作用を持たせない）。
    return { pdf: await doc.finish(), filename: this.filename('請求書', headers.length) };
  }

  // ==========================================================================

  /**
   * 帳票の見出しに使う出荷・受注・納品先の項目。
   * 取引先は左結合にする。サンプル・社内移動は取引先が空でよく（2026-10-13 受注処理編 O-14）、
   * 内部結合だと帳票が「出荷が見つかりません」になってしまうため。
   */
  private async shipmentHeaders(ids: number[]) {
    if (ids.length === 0) throw new BadRequestException('出荷を選んでください');

    const rows = await this.db
      .selectFrom('shipments as sh')
      .innerJoin('sales_orders as o', 'o.id', 'sh.sales_order_id')
      .leftJoin('partners as p', 'p.id', 'o.partner_id')
      .innerJoin('warehouses as w', 'w.id', 'sh.warehouse_id')
      .leftJoin('delivery_destinations as d', 'd.id', 'o.delivery_destination_id')
      .leftJoin('work_instructions as wi', 'wi.id', 'd.work_instruction_id')
      .leftJoin('delivery_rules as dr', 'dr.id', 'd.delivery_rule_id')
      .leftJoin('codes as sc', 'sc.id', 'd.slip_issue_class_code_id')
      .leftJoin('codes as dt', 'dt.id', 'o.delivery_time_code_id')
      .select([
        'sh.id as id',
        'sh.shipment_no as shipment_no',
        'sh.planned_ship_date as planned_ship_date',
        'sh.ship_date as ship_date',
        'o.id as sales_order_id',
        'o.order_type as order_type',
        'o.trade_type as trade_type',
        'o.po_no as po_no',
        'o.ship_date as order_ship_date',
        'o.delivery_date as delivery_date',
        'o.shipping_remarks as shipping_remarks',
        'o.delivery_note_remarks as delivery_note_remarks',
        'o.direct_name as direct_name',
        'o.direct_postal_code as direct_postal_code',
        'o.direct_address1 as direct_address1',
        'o.direct_address2 as direct_address2',
        'o.direct_tel as direct_tel',
        // 受注の通貨（取引先の通貨で固定。2026-10-12 No.39）。納品書の金額に添える
        'o.currency as currency',
        // 納品書に送料を記載するか（O-10）と、その額（請求と同じ決まり）
        'o.print_shipping_fee as print_shipping_fee',
        orderShippingFeeSql(sql.ref('o.id')).as('shipping_fee'),
        'p.partner_code as partner_code',
        'p.name1 as partner_name1',
        'p.name2 as partner_name2',
        'p.tel as partner_tel',
        // 海外の得意先は納品書の消費税を 0 にする（請求書と同じ扱い）
        'p.is_overseas as partner_is_overseas',
        'p.overseas_tax_treatment as partner_overseas_tax_treatment',
        'w.short_name as warehouse_name',
        'd.delivery_code as delivery_code',
        'd.name as destination_name',
        'd.postal_code as dest_postal_code',
        'd.address1 as dest_address1',
        'd.address2 as dest_address2',
        'd.tel as dest_tel',
        'd.delivery_note_print1 as delivery_note_print1',
        'd.delivery_note_print2 as delivery_note_print2',
        'wi.name as work_instruction',
        'wi.instruction_body as work_instruction_body',
        'dr.name as delivery_rule',
        'sc.name as slip_issue_class',
        // 納品時間（区分値 DELIVERY_TIME。O-03）
        'dt.name as delivery_time_name',
      ])
      .where('sh.id', 'in', ids)
      .where('sh.status', '<>', '削除')
      .orderBy('sh.shipment_no')
      .execute();

    if (rows.length === 0) throw new NotFoundException('出荷が見つかりません');
    return rows;
  }

  /**
   * 上代（9/15 ご回答：得意先別商品マスタに置く）。
   * 明細が得意先別商品を指していればその行だけを、指していなければ取引先×SKU で引く（表示の行を先に、いちばん古い行。非表示の行は表示の行が無いときだけ）。
   * 同じ SKU に行が複数あるとき（2026-10-16 マスター編_3 M3-26）、受注で選んだ行の上代が空でも
   * 別の行の上代を出さない。
   */
  private retailPriceExpr(lineAlias: string, orderAlias: string) {
    const ppId = sql.ref(`${lineAlias}.partner_product_id`);
    return sql<string | null>`case when ${ppId} is not null
      then (select pp.retail_price from partner_products pp where pp.id = ${ppId})
      else (select pp2.retail_price from partner_products pp2
        where pp2.partner_id = ${sql.ref(`${orderAlias}.partner_id`)} and pp2.sku_id = ${sql.ref(`${lineAlias}.sku_id`)}
        order by pp2.is_active desc, pp2.id limit 1) end`;
  }

  /**
   * 出荷系帳票に印字する JAN（2026-10-09 マスター編② M-18「出荷JANが空欄ならコニーJAN」）。
   * 得意先別商品の出荷JAN → SKU の JAN の順。得意先別商品は上代と同じく、明細が指していれば
   * その行だけを、指していなければ取引先×SKU で引く。空白だけの出荷JANは空とみなす。
   * 受注で選んだ行の出荷JANが空なら、同じ SKU の別の行ではなく SKU の JAN を出す（M3-26）。
   */
  private shippingJanExpr(lineAlias: string, orderAlias: string, skuAlias: string) {
    const ppId = sql.ref(`${lineAlias}.partner_product_id`);
    return sql<string | null>`coalesce(
      case when ${ppId} is not null
        then (select nullif(btrim(pp.shipping_jan), '') from partner_products pp where pp.id = ${ppId})
        else (select nullif(btrim(pp2.shipping_jan), '') from partner_products pp2
          where pp2.partner_id = ${sql.ref(`${orderAlias}.partner_id`)} and pp2.sku_id = ${sql.ref(`${lineAlias}.sku_id`)}
            and nullif(btrim(pp2.shipping_jan), '') is not null
          order by pp2.is_active desc, pp2.id limit 1) end,
      ${sql.ref(`${skuAlias}.jan`)})`;
  }

  /** 受注明細（帳票の明細の元）。カラー・サイズは SKU のもの。 */
  private orderLines(orderId: number) {
    return this.db
      .selectFrom('sales_order_lines as l')
      .innerJoin('sales_orders as o', 'o.id', 'l.sales_order_id')
      .leftJoin('skus as s', 's.id', 'l.sku_id')
      .leftJoin('colors as cl', 'cl.id', 's.color_id')
      .leftJoin('sizes as sz', 'sz.id', 's.size_id')
      .select([
        'l.line_no as line_no',
        'l.parent_line_no as parent_line_no',
        'l.line_type as line_type',
        'l.item_name as item_name',
        'l.qty as qty',
        'l.unit_price as unit_price',
        'l.tax_rate as tax_rate',
        'l.amount as amount',
        // 出荷依頼書適用・納品書適用（明細ごとに入力。O-09）
        'l.shipping_note as shipping_note',
        'l.delivery_slip_note as delivery_slip_note',
        's.sku_code as sku_code',
        'cl.name as color_name',
        'sz.name as size_name',
        // 出荷依頼書・納品書の JAN 欄は、得意先別商品の出荷JAN、空なら SKU の JAN（コニーJAN）
        // （2026-10-09 マスター編② M-18）
        this.shippingJanExpr('l', 'o', 's').as('jan'),
        this.retailPriceExpr('l', 'o').as('retail_price'),
      ])
      .where('l.sales_order_id', '=', orderId)
      .orderBy('l.line_no')
      .execute();
  }

  /**
   * 出荷依頼書・納品書（単価なし・上代あり）に載せる行。
   * 送料・値引は品物ではないので載せない。セットはセットのまま1行（親のセット商品の行がある内訳商品は出さない）。
   * 非商品は品名が自由入力で、同梱する販促物のこともあるので載せる。
   */
  private goodsRows(lines: OrderLine[]): OrderLine[] {
    const sets = new Set(lines.filter((l) => l.line_type === 'セット商品').map((l) => l.line_no));
    return lines.filter((l) => {
      if (l.line_type === '送料' || l.line_type === '値引') return false;
      return !(l.line_type === '内訳商品' && l.parent_line_no !== null && sets.has(l.parent_line_no));
    });
  }

  /**
   * 納品書「単価あり2」に載せる行。金額のある行はすべて載せる（送料・値引も）。
   * セットはセットのまま1行。ただし内訳商品の行に金額が入っていれば、合計と合うようにその行も載せる。
   */
  private pricedRows(lines: OrderLine[]): OrderLine[] {
    const sets = new Set(lines.filter((l) => l.line_type === 'セット商品').map((l) => l.line_no));
    return lines.filter(
      (l) =>
        !(l.line_type === '内訳商品' && l.parent_line_no !== null && sets.has(l.parent_line_no) && Number(l.amount) === 0),
    );
  }

  /** お届け先を宛先にする受注か（直送・通販・サンプル・社内移動で、お届け先のお名前か住所が入っている）。 */
  private usesDirect(sh: ShipmentHeader): boolean {
    if (!DIRECT_TYPES.has(sh.order_type)) return false;
    return [sh.direct_name, sh.direct_postal_code, sh.direct_address1, sh.direct_address2].some(
      (v) => (v ?? '').trim() !== '',
    );
  }

  /** 届け先の〒・住所・お名前・電話。お届け先の受注はお届け先、それ以外は納品先マスタ。 */
  private placeOf(sh: ShipmentHeader): { postalCode: string; address: string; name: string; tel: string } {
    const join = (a: string | null, b: string | null) => [a?.trim(), b?.trim()].filter(Boolean).join(' ');
    if (this.usesDirect(sh)) {
      return {
        postalCode: sh.direct_postal_code?.trim() ?? '',
        address: join(sh.direct_address1, sh.direct_address2),
        name: sh.direct_name?.trim() ?? '',
        tel: sh.direct_tel?.trim() ?? '',
      };
    }
    return {
      postalCode: sh.dest_postal_code?.trim() ?? '',
      address: join(sh.dest_address1, sh.dest_address2),
      name: sh.destination_name ?? '',
      tel: sh.dest_tel?.trim() ?? '',
    };
  }

  /**
   * 納品書の宛名（O-32）。お届け先の受注はお届け先のお名前＋「様」。
   * それ以外は納品先マスタの「納品書 印字1」、空なら取引先名に「御中」を付ける。
   */
  private addresseeOf(sh: ShipmentHeader, direct: boolean): string {
    if (direct && sh.direct_name?.trim()) return `${sh.direct_name.trim()}　様`;
    const base =
      sh.delivery_note_print1?.trim() || this.partnerName(sh) || sh.destination_name?.trim() || sh.direct_name?.trim() || '';
    if (!base) return '';
    // 印字1 に敬称まで入れてある納品先は、重ねて付けない
    return /(御中|様|殿)$/.test(base) ? base : `${base}　御中`;
  }

  /**
   * 出荷依頼書の「連絡事項」（各社納品ルール）。納品先マスタの作業指示の名称と本文（全文）。
   * 納品ルール（2026-10-01 に納品先の編集画面から外した項目）が入っている納品先は、それも添える。
   */
  private instructionsOf(sh: ShipmentHeader): string {
    const name = sh.work_instruction?.trim() ?? '';
    const body = sh.work_instruction_body?.trim() ?? '';
    const parts = [name && body ? `${name}\n${body}` : name || body];
    if (sh.delivery_rule?.trim()) parts.push(`納品ルール：${sh.delivery_rule.trim()}`);
    return parts.filter(Boolean).join('\n');
  }

  /** 取引先名（名称1＋名称2）。取引先の無い受注（サンプル・社内移動）は空。 */
  private partnerName(sh: { partner_name1: string | null; partner_name2: string | null }): string {
    return [sh.partner_name1?.trim(), sh.partner_name2?.trim()].filter(Boolean).join(' ');
  }

  private async deliveryNoteDefaultForm(): Promise<DeliveryNoteForm> {
    return normalizeForm(await this.settings.text('DELIVERY_NOTE_DEFAULT_FORM', '単価あり2')) ?? '単価あり2';
  }

  /**
   * 税率別に計算して合算する。端数処理は設定（既定は切捨て）に従う。
   * 端数は通貨の最小単位で処理する（円は1円、外貨は小数2桁。請求の締めと同じ。2026-10-13 再テスト N3）。
   */
  private async taxOf(lines: { tax_rate: string; amount: string }[], currency?: string | null): Promise<number> {
    const scale = 10 ** currencyDigits(currency);
    const mode = await this.settings.text('TAX_ROUNDING_MODE', 'floor');
    const byRate = new Map<number, number>();
    for (const l of lines) {
      const rate = Number(l.tax_rate);
      byRate.set(rate, (byRate.get(rate) ?? 0) + Number(l.amount));
    }
    let total = 0;
    for (const [rate, base] of byRate) {
      // 小数の誤差（552.4999… など）で1単位ずれないよう、桁を上げた値をいったん整えてから丸める
      const raw = Number((((base * rate) / 100) * scale).toFixed(6));
      // 端数は絶対値で処理して符号を戻す（請求の締めの fn_round_amount と同じ）。返品のマイナスの税で、
      // Math.floor のままだと -12.5 が -13 になり、請求書（-12）と1円ずれていた（2026-10-20 受入テスト T4）
      const abs = Math.abs(raw);
      const rounded = mode === 'ceil' ? Math.ceil(abs) : mode === 'round' ? Math.round(abs) : Math.floor(abs);
      total += (Math.sign(raw) * rounded) / scale;
    }
    return Number(total.toFixed(currencyDigits(currency)));
  }

  /** 請求書の差出人。9/15 ご回答で会社名だけを印刷する（登録番号は設定があれば）。 */
  private async company(): Promise<{ name: string; invoiceNo: string }> {
    return {
      name: (await this.settings.text('COMPANY_NAME', '株式会社コニー')).trim(),
      invoiceNo: (await this.settings.text('COMPANY_INVOICE_NO', '')).trim(),
    };
  }

  /** 納品書の差出人欄（貴社の様式どおり。システム設定の COMPANY_*）。空の項目は見出しだけ、または出さない。 */
  private async sender(): Promise<DeliverySender> {
    const text = async (key: string, fallback = '') => (await this.settings.text(key, fallback)).trim();
    return {
      name: await text('COMPANY_NAME', '株式会社コニー'),
      postalCode: await text('COMPANY_POSTAL_CODE'),
      address1: await text('COMPANY_ADDRESS'),
      address2: await text('COMPANY_ADDRESS2'),
      contact: await text('COMPANY_CONTACT'),
      tel: await text('COMPANY_TEL'),
      fax: await text('COMPANY_FAX'),
      invoiceNo: await text('COMPANY_INVOICE_NO'),
    };
  }

  private sum(values: (string | number)[]): number {
    return values.reduce<number>((acc, v) => acc + Number(v), 0);
  }

  /** 誰がいつ何を出したかを残す。再発行したかどうかを後から追えるようにする。 */
  private async recordPrint(
    shipmentIds: number[],
    documentType: string,
    userId: number,
  ): Promise<void> {
    await this.db
      .insertInto('shipment_documents')
      .values(
        shipmentIds.map((id) => ({
          shipment_id: id,
          document_type: documentType,
          printed_at: new Date(),
          printed_by: userId,
          output_format: 'PDF',
        })),
      )
      .execute();
  }

  private filename(kind: string, count: number): string {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `${kind}_${today}_${count}件.pdf`;
  }
}
