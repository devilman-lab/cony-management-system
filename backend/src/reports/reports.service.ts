import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';

import { AttachmentsService } from '../attachments/attachments.service';
import { SettingsService } from '../common/settings.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import { ShipmentsService } from '../shipping/shipments.service';
import { CONTENT_WIDTH, ReportDoc, money, qty, ymd, type Column } from './pdf-builder';
import { mergeToPdf, type MergeInput } from './pdf-merge';

/** 納品書の様式。設定 DELIVERY_NOTE_DEFAULT_FORM の選択肢と一致させる。 */
export const DELIVERY_NOTE_FORMS = ['単価あり', '単価あり2', '上代あり', '単価なし'] as const;
export type DeliveryNoteForm = (typeof DELIVERY_NOTE_FORMS)[number];

export interface PrintResult {
  pdf: Buffer;
  filename: string;
  /** 一緒に印刷できなかった添付（Excel・Word など）。応答ヘッダで知らせる。 */
  skipped?: string[];
}

/** 出荷確定と同時に印刷する帳票の種類。 */
export const PRINT_DOCUMENTS = ['出荷指示書', 'ピッキングリスト', '納品書'] as const;
export type PrintDocument = (typeof PRINT_DOCUMENTS)[number];

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
      form?: DeliveryNoteForm;
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

    // 帳票は出荷ごとにまとめず、種類ごとに全件分を1本ずつ作って並べる（頂いた運用どおり）
    const parts: MergeInput[] = [];
    for (const kind of input.documents) {
      const r =
        kind === '出荷指示書'
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
  // 出荷指示書
  // ==========================================================================

  async shippingInstructions(shipmentIds: number[], userId: number): Promise<PrintResult> {
    const shipments = await this.shipmentHeaders(shipmentIds);
    const doc = new ReportDoc('出荷指示書');

    for (const [i, sh] of shipments.entries()) {
      if (i > 0) doc.newPage();
      const lines = await this.orderLines(sh.sales_order_id);

      doc.title('出 荷 指 示 書');
      doc.keyValues([
        ['出荷指示番号', sh.shipment_no],
        ['受注番号', sh.order_no ?? ''],
        ['出荷予定日', ymd(sh.planned_ship_date)],
        ['受注日', ymd(sh.order_date)],
        ['得意先', this.partnerLabel(sh)],
        ['納品先', sh.destination_name ?? '（直送）'],
        ['出荷倉庫', sh.warehouse_name],
        ['納品希望日', ymd(sh.requested_delivery_date)],
      ]);
      doc.line(`納品先住所　${this.addressOf(sh)}`);
      if (sh.work_instruction) doc.line(`作業指示　　${sh.work_instruction}`);
      if (sh.delivery_rule) doc.line(`納品ルール　${sh.delivery_rule}`);
      if (sh.shipping_remarks) doc.line(`出荷備考　　${sh.shipping_remarks}`);
      doc.y += 4;

      const columns: Column[] = [
        { label: '行', width: 26, align: 'right' },
        { label: '商品コード', width: 110 },
        { label: '品名', width: 225 },
        { label: '区分', width: 56, align: 'center' },
        { label: '数量', width: 60, align: 'right' },
      ];
      doc.table(
        columns,
        lines.map((l) => [l.line_no, l.sku_code ?? '', l.item_name, l.line_type, qty(l.qty)]),
      );
      doc.totals([['合計数量', qty(this.goodsQty(lines))]]);
    }

    await this.recordPrint(shipmentIds, '出荷指示書', userId);
    return { pdf: await doc.finish(), filename: this.filename('出荷指示書', shipments.length) };
  }

  // ==========================================================================
  // ピッキングリスト
  // ==========================================================================

  /**
   * ピッキングリスト。
   *
   * PICKING_EXPAND_SET が true のときは引当（allocations）を数える。引当は
   * セットを構成品に展開したあとの姿なので、頂いた帳票サンプルどおり
   * 「展開したうえで同一商品を合算した」一覧になる。
   */
  async pickingList(shipmentIds: number[], userId: number): Promise<PrintResult> {
    const shipments = await this.shipmentHeaders(shipmentIds);
    const expand = await this.settings.bool('PICKING_EXPAND_SET', true);
    const orderIds = shipments.map((s) => s.sales_order_id);

    const rows = expand
      ? await this.db
          .selectFrom('allocations as a')
          .innerJoin('sales_order_lines as l', 'l.id', 'a.sales_order_line_id')
          .innerJoin('stocks as st', 'st.id', 'a.stock_id')
          .innerJoin('warehouses as w', 'w.id', 'st.warehouse_id')
          .innerJoin('skus as s', 's.id', 'a.sku_id')
          .innerJoin('products as p', 'p.id', 's.product_id')
          .select([
            'w.short_name as warehouse_name',
            's.sku_code as sku_code',
            's.jan as jan',
            'p.product_name as product_name',
            'st.lot_no as lot_no',
            sql<string>`sum(a.qty)`.as('qty'),
          ])
          .where('l.sales_order_id', 'in', orderIds)
          // 出荷確定と同時に印刷すると、この時点では引当が「出荷済」に変わっている。
          // 「引当中」だけを見ると、出荷確定して印刷したときのピッキングリストが
          // 必ず白紙になる（確定後の刷り直しも同じ）。
          .where('a.status', 'in', ['引当中', '出荷済'])
          .groupBy(['w.short_name', 's.sku_code', 's.jan', 'p.product_name', 'st.lot_no'])
          .orderBy('w.short_name')
          .orderBy('s.sku_code')
          .execute()
      : await this.db
          .selectFrom('sales_order_lines as l')
          .innerJoin('skus as s', 's.id', 'l.sku_id')
          .innerJoin('products as p', 'p.id', 's.product_id')
          .select([
            sql<string>`''`.as('warehouse_name'),
            's.sku_code as sku_code',
            's.jan as jan',
            'p.product_name as product_name',
            sql<string>`''`.as('lot_no'),
            sql<string>`sum(l.qty)`.as('qty'),
          ])
          .where('l.sales_order_id', 'in', orderIds)
          .where('l.line_type', 'in', ['商品', '内訳商品'])
          .groupBy(['s.sku_code', 's.jan', 'p.product_name'])
          .orderBy('s.sku_code')
          .execute();

    const doc = new ReportDoc('ピッキングリスト');
    doc.title('ピッキングリスト');
    doc.keyValues(
      [
        ['出力日', ymd(new Date())],
        ['対象出荷', `${shipments.length} 件`],
        ['セット展開', expand ? 'する' : 'しない'],
        ['出荷指示番号', shipments.map((s) => s.shipment_no).join('、')],
      ],
      2,
    );

    const columns: Column[] = [
      { label: '倉庫', width: 80 },
      { label: '商品コード', width: 110 },
      { label: 'JAN', width: 95 },
      { label: '品名', width: 152 },
      { label: 'ロット', width: 50 },
      { label: '数量', width: 36, align: 'right' },
    ];
    doc.table(
      columns,
      rows.map((r) => [
        r.warehouse_name,
        r.sku_code,
        r.jan ?? '',
        r.product_name,
        r.lot_no ?? '',
        qty(r.qty),
      ]),
    );
    doc.totals([
      ['明細行数', `${rows.length} 行`],
      ['合計数量', qty(this.sum(rows.map((r) => r.qty)))],
    ]);

    await this.recordPrint(shipmentIds, 'ピッキングリスト', userId);
    return { pdf: await doc.finish(), filename: this.filename('ピッキングリスト', 1) };
  }

  // ==========================================================================
  // 納品書（4様式）
  // ==========================================================================

  async deliveryNotes(
    shipmentIds: number[],
    form: DeliveryNoteForm | undefined,
    userId: number,
  ): Promise<PrintResult> {
    const shipments = await this.shipmentHeaders(shipmentIds);
    const fallback = await this.deliveryNoteDefaultForm();
    const company = await this.company();
    const doc = new ReportDoc('納品書');

    for (const [i, sh] of shipments.entries()) {
      if (i > 0) doc.newPage();

      // 様式の決め方：指定 → 納品先マスタの伝票発行分類 → システム設定の既定。
      const chosen = form ?? this.formOf(sh.slip_issue_class) ?? fallback;
      const lines = await this.deliveryLines(sh);

      doc.title('納 品 書');
      doc.keyValues([
        ['伝票番号', sh.shipment_no],
        ['納品日', ymd(sh.ship_date ?? sh.delivery_date ?? sh.planned_ship_date)],
        ['得意先', `${this.partnerLabel(sh)} 御中`],
        ['納品先', sh.destination_name ?? '（直送）'],
        ['納品先No', sh.partner_delivery_no ?? ''],
      ]);
      doc.line(`納品先住所　${this.addressOf(sh)}`);
      doc.line(company.line);
      if (company.invoiceNo) doc.line(`登録番号　${company.invoiceNo}`);
      if (sh.delivery_note_print1) doc.line(sh.delivery_note_print1);
      if (sh.delivery_note_print2) doc.line(sh.delivery_note_print2);
      doc.y += 4;

      const columns = this.deliveryColumns(chosen);
      doc.table(
        columns,
        lines.map((l) => this.deliveryRow(chosen, l)),
      );

      // 合計数量は品物の行だけ数える（送料・値引の「1」を個数に混ぜない）。
      // 出荷指示書も同じ数え方にしてあるので、同じ束の中で数が食い違わない。
      const totalQty = qty(this.goodsQty(lines));
      if (chosen === '単価なし') {
        doc.totals([['合計数量', totalQty]]);
      } else {
        const subtotal = this.sum(lines.map((l) => l.amount));
        const tax = await this.taxOf(lines);
        doc.totals([
          ['合計数量', totalQty],
          ['小計（税抜）', money(subtotal)],
          ['消費税', money(tax)],
          ['合計（税込）', money(Number(subtotal) + Number(tax))],
        ]);
      }
      if (sh.delivery_note_remarks) {
        doc.y += 6;
        doc.line(`備考　${sh.delivery_note_remarks}`);
      }
      doc.line(`様式：${chosen}`, 7);
    }

    await this.recordPrint(shipmentIds, '納品書', userId);
    return { pdf: await doc.finish(), filename: this.filename('納品書', shipments.length) };
  }

  // ==========================================================================
  // 請求書
  // ==========================================================================

  async invoices(invoiceIds: number[], userId: number): Promise<PrintResult> {
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

      const [lines, taxes] = await Promise.all([
        this.db
          .selectFrom('invoice_lines')
          .select(['line_no', 'item_name', 'qty', 'unit_price', 'tax_rate', 'amount'])
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
        ['請求先', `${iv.partner_name1}${iv.partner_name2 ? ' ' + iv.partner_name2 : ''} 御中`],
        ['対象期間', `${ymd(iv.period_from)} 〜 ${ymd(iv.period_to)}`],
      ];
      // 発行日は貴社ご指示により既定で印刷しない（設定 INVOICE_PRINT_ISSUE_DATE）。
      if (printIssueDate && iv.issued_at) head.push(['発行日', ymd(iv.issued_at)]);
      if (iv.po_no) head.push(['発注番号', iv.po_no]);
      doc.keyValues(head);

      doc.line(
        `〒${iv.partner_postal_code ?? ''}　${iv.partner_address1 ?? ''}${iv.partner_address2 ?? ''}`,
      );
      doc.line(company.line);
      if (company.invoiceNo) doc.line(`登録番号　${company.invoiceNo}`);
      doc.y += 4;

      // 請求書上部の税率別内訳（頂いた様式に合わせて明細の前に置く）
      if (taxes.length > 0) {
        doc.table(
          [
            { label: '税率', width: 70, align: 'center' },
            { label: '対象金額（税抜）', width: 150, align: 'right' },
            { label: '消費税額', width: 150, align: 'right' },
          ],
          taxes.map((t) => [`${Number(t.tax_rate)}%`, money(t.taxable_base), money(t.tax_amount)]),
        );
        doc.y += 4;
      }

      doc.totals([
        ['前回請求残高', money(iv.prev_invoice_balance)],
        ['今回入金額', money(iv.current_receipt_amount)],
        ['繰越残高', money(iv.carryover_balance)],
        ['出荷', money(iv.shipment_amount)],
        ['返品額', money(iv.return_amount)],
        ['未計上10%', money(iv.unposted_10)],
        ['未計上8%', money(iv.unposted_8)],
        ['調整10%', money(iv.adjust_10)],
        ['調整8%', money(iv.adjust_8)],
        ['手数料', money(iv.fee_amount)],
        ['送料', money(iv.shipping_fee_amount)],
        ['当月請求額', money(iv.current_invoice_amount)],
        ['今回請求残高', money(iv.current_balance)],
      ]);

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
          lines.map((l) => [
            l.line_no,
            l.item_name,
            qty(l.qty),
            money(l.unit_price),
            `${Number(l.tax_rate)}%`,
            money(l.amount),
          ]),
        );
      }
      if (iv.invoice_note) doc.line(`備考　${iv.invoice_note}`);
    }

    await this.db
      .updateTable('invoices')
      .set({ status: '発行済', issued_at: new Date(), updated_by: userId, updated_at: new Date() })
      .where('id', 'in', invoiceIds)
      .where('status', '=', '未発行')
      .execute();

    return { pdf: await doc.finish(), filename: this.filename('請求書', headers.length) };
  }

  // ==========================================================================

  private async shipmentHeaders(ids: number[]) {
    if (ids.length === 0) throw new BadRequestException('出荷を選んでください');

    const rows = await this.db
      .selectFrom('shipments as sh')
      .innerJoin('sales_orders as o', 'o.id', 'sh.sales_order_id')
      .innerJoin('partners as p', 'p.id', 'o.partner_id')
      .innerJoin('warehouses as w', 'w.id', 'sh.warehouse_id')
      .leftJoin('delivery_destinations as d', 'd.id', 'o.delivery_destination_id')
      .leftJoin('work_instructions as wi', 'wi.id', 'd.work_instruction_id')
      .leftJoin('delivery_rules as dr', 'dr.id', 'd.delivery_rule_id')
      .leftJoin('codes as sc', 'sc.id', 'd.slip_issue_class_code_id')
      .select([
        'sh.id as id',
        'sh.shipment_no as shipment_no',
        'sh.planned_ship_date as planned_ship_date',
        'sh.ship_date as ship_date',
        'sh.status as status',
        'o.id as sales_order_id',
        'o.order_no as order_no',
        'o.order_date as order_date',
        'o.order_type as order_type',
        'o.delivery_date as delivery_date',
        'o.requested_delivery_date as requested_delivery_date',
        'o.shipping_remarks as shipping_remarks',
        'o.delivery_note_remarks as delivery_note_remarks',
        'o.direct_name as direct_name',
        'o.direct_postal_code as direct_postal_code',
        'o.direct_address1 as direct_address1',
        'o.direct_address2 as direct_address2',
        'o.direct_tel as direct_tel',
        'p.partner_code as partner_code',
        'p.name1 as partner_name1',
        'p.name2 as partner_name2',
        'w.short_name as warehouse_name',
        'd.name as destination_name',
        'd.partner_delivery_no as partner_delivery_no',
        'd.postal_code as dest_postal_code',
        'd.address1 as dest_address1',
        'd.address2 as dest_address2',
        'd.tel as dest_tel',
        'd.delivery_note_print1 as delivery_note_print1',
        'd.delivery_note_print2 as delivery_note_print2',
        'wi.name as work_instruction',
        'dr.name as delivery_rule',
        'sc.name as slip_issue_class',
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
   * 明細が得意先別商品を指していればそれを、指していなければ取引先×SKU で引く。
   */
  private retailPriceExpr(lineAlias: string, orderAlias: string) {
    return sql<string | null>`coalesce(
      (select pp.retail_price from partner_products pp where pp.id = ${sql.ref(`${lineAlias}.partner_product_id`)}),
      (select pp2.retail_price from partner_products pp2
        where pp2.partner_id = ${sql.ref(`${orderAlias}.partner_id`)} and pp2.sku_id = ${sql.ref(`${lineAlias}.sku_id`)}
        order by pp2.id limit 1))`;
  }

  private orderLines(orderId: number) {
    return this.db
      .selectFrom('sales_order_lines as l')
      .innerJoin('sales_orders as o', 'o.id', 'l.sales_order_id')
      .leftJoin('skus as s', 's.id', 'l.sku_id')
      .select([
        'l.line_no as line_no',
        'l.parent_line_no as parent_line_no',
        'l.line_type as line_type',
        'l.item_name as item_name',
        'l.qty as qty',
        'l.unit_price as unit_price',
        'l.tax_rate as tax_rate',
        'l.amount as amount',
        'l.is_stock_target as is_stock_target',
        's.sku_code as sku_code',
        's.jan as jan',
        this.retailPriceExpr('l', 'o').as('retail_price'),
      ])
      .where('l.sales_order_id', '=', orderId)
      .orderBy('l.line_no')
      .execute();
  }

  /**
   * 納品書に載せる明細。**常に受注明細を使う。**
   *
   * 出荷明細（shipment_lines）は倉庫から実際に出たものの記録で、
   * 在庫を持たない行（送料・値引・販促品・非商品）を持たず、セット商品は
   * 構成品ごとに並ぶ。これを納品書に使うと、出荷確定の前後で得意先に渡す
   * 書類の内容と金額が変わってしまう（送料と値引が消え、セットは構成品の数だけ
   * 金額が重複する）。出荷は全量引き当てできたときだけ作られるので、
   * 受注明細がそのまま「出荷した内容」になる。
   */
  private deliveryLines(sh: { id: number; sales_order_id: number }) {
    return this.orderLines(sh.sales_order_id);
  }

  private deliveryColumns(form: DeliveryNoteForm): Column[] {
    switch (form) {
      case '単価なし':
        return [
          { label: '行', width: 26, align: 'right' },
          { label: '商品コード', width: 115 },
          { label: '品名', width: 322 },
          { label: '数量', width: 60, align: 'right' },
        ];
      case '単価あり2':
        // 得意先の伝票に合わせ、JAN を並べる様式。
        return [
          { label: '行', width: 26, align: 'right' },
          { label: '商品コード', width: 100 },
          { label: 'JAN', width: 92 },
          { label: '品名', width: 125 },
          { label: '数量', width: 42, align: 'right' },
          { label: '単価', width: 60, align: 'right' },
          { label: '金額', width: 78, align: 'right' },
        ];
      case '上代あり':
        return [
          { label: '行', width: 26, align: 'right' },
          { label: '商品コード', width: 105 },
          { label: '品名', width: 190 },
          { label: '数量', width: 42, align: 'right' },
          { label: '上代', width: 68, align: 'right' },
          { label: '金額', width: 92, align: 'right' },
        ];
      default:
        return [
          { label: '行', width: 26, align: 'right' },
          { label: '商品コード', width: 105 },
          { label: '品名', width: 190 },
          { label: '数量', width: 42, align: 'right' },
          { label: '単価', width: 68, align: 'right' },
          { label: '金額', width: 92, align: 'right' },
        ];
    }
  }

  private deliveryRow(
    form: DeliveryNoteForm,
    l: {
      line_no: number;
      item_name: string;
      qty: string;
      unit_price: string;
      amount: string;
      sku_code: string | null;
      jan: string | null;
      retail_price: string | null;
    },
  ) {
    switch (form) {
      case '単価なし':
        return [l.line_no, l.sku_code ?? '', l.item_name, qty(l.qty)];
      case '単価あり2':
        return [
          l.line_no,
          l.sku_code ?? '',
          l.jan ?? '',
          l.item_name,
          qty(l.qty),
          money(l.unit_price),
          money(l.amount),
        ];
      case '上代あり':
        // 上代は得意先別商品マスタ。未登録なら空欄にし、金額欄も上代×数量で出す。
        return [
          l.line_no,
          l.sku_code ?? '',
          l.item_name,
          qty(l.qty),
          money(l.retail_price),
          l.retail_price === null ? '' : money(Number(l.retail_price) * Number(l.qty)),
        ];
      default:
        return [
          l.line_no,
          l.sku_code ?? '',
          l.item_name,
          qty(l.qty),
          money(l.unit_price),
          money(l.amount),
        ];
    }
  }

  /** 伝票発行分類の名称が4様式のどれかなら、それを使う。 */
  private formOf(name: string | null): DeliveryNoteForm | undefined {
    if (!name) return undefined;
    return DELIVERY_NOTE_FORMS.find((f) => f === name);
  }

  private async deliveryNoteDefaultForm(): Promise<DeliveryNoteForm> {
    const v = await this.settings.text('DELIVERY_NOTE_DEFAULT_FORM', '単価あり');
    return this.formOf(v) ?? '単価あり';
  }

  /** 税率別に計算して合算する。端数処理は設定（既定は切捨て）に従う。 */
  private async taxOf(lines: { tax_rate: string; amount: string }[]): Promise<number> {
    const mode = await this.settings.text('TAX_ROUNDING_MODE', 'floor');
    const byRate = new Map<number, number>();
    for (const l of lines) {
      const rate = Number(l.tax_rate);
      byRate.set(rate, (byRate.get(rate) ?? 0) + Number(l.amount));
    }
    let total = 0;
    for (const [rate, base] of byRate) {
      const raw = (base * rate) / 100;
      total += mode === 'ceil' ? Math.ceil(raw) : mode === 'round' ? Math.round(raw) : Math.floor(raw);
    }
    return total;
  }

  /** 差出人。9/15 ご回答では会社名のみ印刷。住所・電話が空なら「TEL」の見出しごと出さない。 */
  private async company(): Promise<{ name: string; line: string; invoiceNo: string }> {
    const name = await this.settings.text('COMPANY_NAME', '株式会社コニー');
    const address = (await this.settings.text('COMPANY_ADDRESS', '')).trim();
    const tel = (await this.settings.text('COMPANY_TEL', '')).trim();
    const parts = [name, address, tel ? `TEL ` : ''].filter((p) => p !== '');
    return {
      name,
      line: parts.join('　'),
      invoiceNo: (await this.settings.text('COMPANY_INVOICE_NO', '')).trim(),
    };
  }

  private partnerLabel(sh: {
    partner_code: string;
    partner_name1: string;
    partner_name2: string | null;
  }): string {
    return `${sh.partner_code} ${sh.partner_name1}${sh.partner_name2 ? ' ' + sh.partner_name2 : ''}`;
  }

  /** 直送は受注に入れた住所、それ以外は納品先マスタの住所。 */
  private addressOf(sh: {
    order_type: string;
    direct_name: string | null;
    direct_postal_code: string | null;
    direct_address1: string | null;
    direct_address2: string | null;
    direct_tel: string | null;
    dest_postal_code: string | null;
    dest_address1: string | null;
    dest_address2: string | null;
    dest_tel: string | null;
  }): string {
    const direct = sh.order_type === '直送' || sh.order_type === '通販';
    const zip = direct ? sh.direct_postal_code : sh.dest_postal_code;
    const a1 = direct ? sh.direct_address1 : sh.dest_address1;
    const a2 = direct ? sh.direct_address2 : sh.dest_address2;
    const tel = direct ? sh.direct_tel : sh.dest_tel;
    const name = direct && sh.direct_name ? `${sh.direct_name} 様　` : '';
    return `${name}〒${zip ?? ''}　${a1 ?? ''}${a2 ?? ''}${tel ? `　TEL ${tel}` : ''}`;
  }

  /**
   * 帳票の「合計数量」。品物の行だけ数える。
   * ・送料・値引・非商品は個数ではないので数えない
   * ・セット商品は1行＝そのセット数として数える
   * ・内訳商品は、親のセット行があるときは二重になるので数えない
   * 出荷指示書と納品書で同じ規則を使う（同じ束の中で数が食い違わないように）。
   */
  private goodsQty(lines: { line_type: string; qty: string | number; parent_line_no?: number | null }[]): number {
    return this.sum(
      lines
        .filter(
          (l) =>
            l.line_type === '商品' ||
            l.line_type === 'セット商品' ||
            (l.line_type === '内訳商品' && !l.parent_line_no),
        )
        .map((l) => l.qty),
    );
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

/** 表の幅の合計が用紙に収まっているかを、起動時ではなく作った時点で気づけるように。 */
export const MAX_TABLE_WIDTH = CONTENT_WIDTH;
