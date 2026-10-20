import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import { NumberingService } from '../common/numbering.service';
import { SettingsService } from '../common/settings.service';
import { ReservationsService } from '../inventory/reservations.service';
import { AllocationService, type AllocationOutcome } from '../shipping/allocation.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { DB } from '../db/schema';
import type { Paged } from '../masters/partners.service';
import { itemNameExpr, skuItemNameExpr, skuNameExpr } from '../masters/products.service';
import { OVERSEAS_TAX_RATE, isOverseasPartner, orderTradeType } from './order-defaults';

/** 受注区分。社内移動・返品は 2026-10-13 受注処理編（O-02・O-44）で追加。通販は通販CSVの取込で作る */
export type OrderType = '卸' | '直送' | '通販' | '社内移動' | 'サンプル' | '返品';
export type LineType = '商品' | 'セット商品' | '内訳商品' | '販促品' | '送料' | '値引' | '非商品';
export type TradeType = '委託' | '買取';

export interface OrderLineInput {
  line_no: number;
  parent_line_no?: number | null;
  line_type: LineType;
  sku_id?: number | null;
  partner_product_id?: number | null;
  item_name: string;
  qty: string;
  unit_price: string;
  tax_rate?: string;
  /** 出荷依頼書適用（O-09） */
  shipping_note?: string | null;
  /** 納品書適用（O-09） */
  delivery_slip_note?: string | null;
}

export interface CreateOrderInput {
  order_type: OrderType;
  /** サンプル・社内移動だけ空にできる（O-14） */
  partner_id?: number | null;
  delivery_destination_id?: number | null;
  /** サンプル・社内移動だけ空にできる（O-14） */
  sales_category_id?: number | null;
  trade_type?: TradeType;
  /** 委託の入庫倉庫（取引条件が委託のときは必須。O-12） */
  consignment_warehouse_id?: number | null;
  /** 納品時間（区分値 DELIVERY_TIME。O-03） */
  delivery_time_code_id?: number | null;
  /** 納品書に送料を記載する（O-10） */
  print_shipping_fee?: boolean;
  /** 販売担当（販売担当マスタ）。省略時は取引先マスタの既定担当（9/15・9/17 ご要望）。 */
  sales_staff_id?: number | null;
  po_no?: string | null;
  po_line_no?: number | null;
  order_date: string;
  ship_date?: string | null;
  delivery_date?: string | null;
  requested_delivery_date?: string | null;
  ship_from_warehouse_id?: number | null;
  direct_name?: string | null;
  direct_kana?: string | null;
  direct_postal_code?: string | null;
  direct_address1?: string | null;
  direct_address2?: string | null;
  direct_tel?: string | null;
  shipping_remarks?: string | null;
  delivery_note_remarks?: string | null;
  shipping_fee_adjustment?: string | null;
  channel?: string | null;
  lines: OrderLineInput[];
}

export interface OrderListQuery {
  status?: string;
  order_type?: OrderType;
  partner_id?: number;
  from?: string;
  to?: string;
  include_cancelled?: boolean;
  limit: number;
  offset: number;
}

export interface OrderWriteResult {
  id: number;
  order_no: string;
  /** 未確定／引当済／引当待ち／出荷指示済 */
  status: string;
  shipment_id: number | null;
  shipment_no: string | null;
  /** 有効在庫が足りず引き当てられなかった分（引当待ちのとき） */
  shortages: string[];
}

/** 明細に SKU が要る種別。ここは 02-schema.sql の ck_sol_sku と同じ決まり。 */
const SKU_REQUIRED: LineType[] = ['商品', 'セット商品', '内訳商品'];
/** 数量が 0 より大きくないといけない行の種別。値引・販促品・送料はマイナスや0を許す。 */
const QTY_POSITIVE_REQUIRED = ['商品', 'セット商品', '内訳商品'];

/**
 * 取引先・販売カテゴリーを空にできる区分（2026-10-13 受注処理編 O-02・O-14。02-schema.sql の ck_so_partner と同じ決まり）。
 * 売上・請求にも計上しない（ck_so_sample。is_billable=false）。
 */
const NO_PARTNER_TYPES: OrderType[] = ['サンプル', '社内移動'];
/**
 * 取引条件を買取に決める区分。サンプルは取引先が無く委託にならない（O-14）。返品は請求で差し引く受注で、
 * 委託（単価なし・請求に載せない。O-12）にすると返品額が請求から消えるため、買取にそろえる（O-44）。
 */
const KAITORI_ONLY_TYPES: OrderType[] = ['サンプル', '返品'];

/** 受注の見出しのうち、区分ごとの決まりで見る項目（登録の値、または修正のあとの値）。 */
interface OrderHeaderRule {
  order_type: OrderType;
  partner_id: number | null;
  sales_category_id: number | null;
  delivery_destination_id: number | null;
  direct_name: string | null;
  trade_type: TradeType;
  consignment_warehouse_id: number | null;
  ship_from_warehouse_id: number | null;
  delivery_time_code_id: number | null;
}

/** 空白だけの文字は空（null）として持つ（適用の欄を消したときに '' が残らないように）。 */
const blankToNull = (v: string | null | undefined): string | null => (v && v.trim() !== '' ? v.trim() : null);

@Injectable()
export class OrdersService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly numbering: NumberingService,
    private readonly allocation: AllocationService,
    private readonly reservations: ReservationsService,
    private readonly settings: SettingsService,
  ) {}

  async create(input: CreateOrderInput, userId: number): Promise<OrderWriteResult> {
    return this.db.transaction().execute(async (trx) => {
      const partnerId = input.partner_id ?? null;
      // 取引条件の初期値は取引先マスタの既定値（確認事項③）。サンプル・返品は買取（KAITORI_ONLY_TYPES）
      const tradeType = this.tradeTypeOf(
        input.order_type,
        input.trade_type ?? (partnerId !== null ? await this.defaultTradeType(trx, partnerId) : '買取'),
      );
      const head: OrderHeaderRule = {
        order_type: input.order_type,
        partner_id: partnerId,
        sales_category_id: input.sales_category_id ?? null,
        delivery_destination_id: input.delivery_destination_id ?? null,
        direct_name: input.direct_name ?? null,
        trade_type: tradeType,
        consignment_warehouse_id: tradeType === '委託' ? (input.consignment_warehouse_id ?? null) : null,
        ship_from_warehouse_id: input.ship_from_warehouse_id ?? null,
        delivery_time_code_id: input.delivery_time_code_id ?? null,
      };
      await this.checkHeader(trx, head);
      this.validateLines(input.lines, input.order_type);

      const orderNo = await this.numbering.next(trx, 'sales_order');

      // 販売担当は取引先マスタの担当者を初期値にし、受注ごとに変えられる（9/15 ご要望）。
      const salesStaffId = input.sales_staff_id ?? (await this.defaultStaff(trx, partnerId));

      // サンプル出荷・社内移動は売上・請求に計上しない（確認事項④・2026-10-13 受注処理編 O-02）。
      // データベース側にも ck_so_sample があり、後から売上計上には変えられない。
      const isBillable = !NO_PARTNER_TYPES.includes(input.order_type);

      const order = await trx
        .insertInto('sales_orders')
        .values({
          order_no: orderNo,
          order_type: input.order_type,
          partner_id: partnerId,
          delivery_destination_id: head.delivery_destination_id,
          sales_category_id: head.sales_category_id,
          trade_type: tradeType,
          consignment_warehouse_id: head.consignment_warehouse_id,
          sales_staff_id: salesStaffId,
          po_no: input.po_no ?? null,
          po_line_no: input.po_line_no ?? null,
          order_date: input.order_date,
          ship_date: input.ship_date ?? null,
          delivery_date: input.delivery_date ?? null,
          requested_delivery_date: input.requested_delivery_date ?? null,
          delivery_time_code_id: head.delivery_time_code_id,
          ship_from_warehouse_id: head.ship_from_warehouse_id,
          direct_name: input.direct_name ?? null,
          direct_kana: input.direct_kana ?? null,
          direct_postal_code: input.direct_postal_code ?? null,
          direct_address1: input.direct_address1 ?? null,
          direct_address2: input.direct_address2 ?? null,
          direct_tel: input.direct_tel ?? null,
          shipping_remarks: input.shipping_remarks ?? null,
          delivery_note_remarks: input.delivery_note_remarks ?? null,
          shipping_fee_adjustment: input.shipping_fee_adjustment ?? null,
          print_shipping_fee: input.print_shipping_fee ?? false,
          is_billable: isBillable,
          channel: input.channel ?? null,
          status: '未確定',
          created_by: userId,
          updated_by: userId,
        })
        .returning(['id', 'order_no'])
        .executeTakeFirstOrThrow();

      await this.insertLines(trx, order.id, input.lines, userId, {
        overseas: await isOverseasPartner(trx, partnerId),
        returns: input.order_type === '返品',
        consignment: tradeType === '委託',
      });

      // 引当在庫（販売カテゴリーの枠）から減らす。枠を超えれば 400（9/17 ご確認②）。取引先が空の受注は減らさない
      await this.reservations.consume(trx, order.id, { strict: true });
      // 登録だけ（manual。既定）は在庫を引き当てず「引当待ち」（2026-10-13 受注処理編 O-06）。
      // 受注登録時に引き当てる設定（order_entry）なら、実在庫を確かめてそのまま引き当てる（9/15 ご確認①②）。
      const allocation = await this.allocation.afterOrderWrite(trx, order.id, userId);
      return this.writeResult(order, allocation);
    });
  }

  /** 取引条件。サンプル・返品は買取に決める（KAITORI_ONLY_TYPES）。 */
  private tradeTypeOf(orderType: OrderType, requested: TradeType): TradeType {
    return KAITORI_ONLY_TYPES.includes(orderType) ? '買取' : requested;
  }

  /**
   * 受注の見出しの決まり（登録と修正。修正は直したあとの値で見る）。2026-10-13 受注処理編で区分ごとに決めた。
   *   卸・直送・通販・返品 … 取引先・販売カテゴリーが必須（サンプル・社内移動は空でよい。O-14）
   *   卸 … 納品先が必須／直送・サンプル … お届け先のお名前が必須／社内移動 … 納品先かお届け先のお名前のどちらか
   *   委託 … 入庫倉庫が必須。使っている倉庫で、出荷倉庫と同じ倉庫は選べない（O-12）
   *   納品時間 … 区分値「納品時間」（DELIVERY_TIME）の値だけ（O-03）
   */
  private async checkHeader(trx: Transaction<DB>, h: OrderHeaderRule): Promise<void> {
    if (!NO_PARTNER_TYPES.includes(h.order_type)) {
      if (!h.partner_id) throw new BadRequestException('取引先を選んでください');
      if (!h.sales_category_id) throw new BadRequestException('販売カテゴリーを選んでください');
    }
    if (h.order_type === '卸' && !h.delivery_destination_id) {
      throw new BadRequestException('卸の受注では納品先を選んでください');
    }
    if ((h.order_type === '直送' || h.order_type === 'サンプル') && !h.direct_name) {
      throw new BadRequestException(`${h.order_type}の受注ではお届け先のお名前を入力してください`);
    }
    if (h.order_type === '社内移動' && !h.delivery_destination_id && !h.direct_name) {
      throw new BadRequestException('社内移動の受注では、納品先を選ぶか、お届け先のお名前を入力してください');
    }

    if (h.delivery_time_code_id) {
      const code = await trx
        .selectFrom('codes as c')
        .innerJoin('code_categories as cc', 'cc.id', 'c.code_category_id')
        .select('c.id')
        .where('c.id', '=', h.delivery_time_code_id)
        .where('cc.code', '=', 'DELIVERY_TIME')
        .executeTakeFirst();
      if (!code) throw new BadRequestException('納品時間は選択肢（区分値「納品時間」）から選んでください');
    }

    if (h.trade_type === '委託') {
      if (!h.consignment_warehouse_id) {
        throw new BadRequestException('取引条件が委託のときは入庫倉庫を選んでください');
      }
      const wh = await trx
        .selectFrom('warehouses')
        .select(['id', 'is_active'])
        .where('id', '=', h.consignment_warehouse_id)
        .executeTakeFirst();
      if (!wh || !wh.is_active) throw new BadRequestException('入庫倉庫は使っている倉庫から選んでください');
      // 出荷倉庫は、受注で指定が無ければ引当と同じ当て方（納品先の既定倉庫 → コニー倉庫）で決まる倉庫
      const shipFrom = await this.allocation.resolveWarehouse(trx, h.ship_from_warehouse_id, h.delivery_destination_id);
      if (Number(shipFrom) === Number(h.consignment_warehouse_id)) {
        const name = await trx.selectFrom('warehouses').select('short_name').where('id', '=', shipFrom).executeTakeFirst();
        throw new BadRequestException(`入庫倉庫に出荷倉庫（${name?.short_name ?? ''}）と同じ倉庫は選べません`);
      }
    }
  }

  /** 取引先マスタの担当者。未設定（取引先が空の受注も）なら null。 */
  private async defaultStaff(trx: Transaction<DB>, partnerId: number | null): Promise<number | null> {
    if (partnerId === null) return null;
    const p = await trx
      .selectFrom('partners')
      .select('sales_staff_id')
      .where('id', '=', partnerId)
      .executeTakeFirst();
    return p?.sales_staff_id ?? null;
  }

  /**
   * 取引条件の初期値は取引先マスタの既定値（確認事項③）。
   * 取引先の既定値には仕入先向けの「仕入」もあるが（1001 ご要望）、受注の取引条件は
   * 委託・買取の2つだけなので、それ以外のときは買取にする（取込と同じ orderTradeType を使う）。
   */
  private async defaultTradeType(trx: Transaction<DB>, partnerId: number): Promise<'委託' | '買取'> {
    const p = await trx
      .selectFrom('partners')
      .select('default_trade_type')
      .where('id', '=', partnerId)
      .executeTakeFirst();
    return orderTradeType(p?.default_trade_type);
  }

  private writeResult(
    order: { id: number; order_no: string },
    allocation: AllocationOutcome | null,
  ): OrderWriteResult {
    return {
      id: order.id,
      order_no: order.order_no,
      status: allocation?.status ?? '未確定',
      shipment_id: allocation?.shipment_id ?? null,
      shipment_no: allocation?.shipment_no ?? null,
      shortages: allocation?.shortages ?? [],
    };
  }

  /**
   * 明細の投入。
   * 金額は qty × unit_price を SQL 側で計算する。JavaScript の数値に通すと
   * 小数の誤差が出るため、金額の計算はデータベースから出さない。
   *
   * 海外の得意先は、画面で選んだ税率にかかわらず 0% で入れる。請求（締め）は海外を 0% で
   * 計算するので、受注・納品書を 10% のままにすると得意先に渡す書類どうしで金額が
   * 食い違う（2026-10-12 受入テスト M-02）。
   *
   * 2026-10-13 受注処理編:
   *   返品（O-44）… 数量は正の数で受け取り、すべての明細をマイナス（-abs）で持つ。金額も数量×単価でマイナスになる
   *   委託（O-12）… 単価なし。単価・金額 0 で持つ（請求に載せない）
   *   出荷依頼書適用・納品書適用（O-09）… 明細ごとに持つ
   */
  private async insertLines(
    trx: Transaction<DB>,
    orderId: number,
    lines: OrderLineInput[],
    userId: number,
    opts: { overseas: boolean; returns: boolean; consignment: boolean },
  ): Promise<void> {
    await this.assertPartnerProducts(trx, orderId, lines);
    await trx
      .insertInto('sales_order_lines')
      .values(
        lines.map((line) => {
          const qty = opts.returns ? sql<string>`-abs(${line.qty}::numeric)` : sql<string>`${line.qty}::numeric`;
          const unitPrice = opts.consignment ? '0' : line.unit_price;
          return {
            sales_order_id: orderId,
            line_no: line.line_no,
            parent_line_no: line.parent_line_no ?? null,
            line_type: line.line_type,
            sku_id: line.sku_id ?? null,
            partner_product_id: line.partner_product_id ?? null,
            item_name: line.item_name,
            qty,
            unit_price: unitPrice,
            tax_rate: opts.overseas ? OVERSEAS_TAX_RATE : (line.tax_rate ?? '10.00'),
            amount: sql<string>`${qty} * ${unitPrice}::numeric`,
            shipping_note: blankToNull(line.shipping_note),
            delivery_slip_note: blankToNull(line.delivery_slip_note),
            created_by: userId,
          };
        }),
      )
      .execute();
  }

  /**
   * 明細を送らずに区分・取引条件・得意先だけを直したとき、今の明細を決まり（insertLines と同じ）にそろえる。
   * 返品にしたらマイナスに、返品から外したらプラスに戻す。委託にしたら単価・金額を 0 に。海外の得意先は税率 0%。
   */
  private async conformLines(
    trx: Transaction<DB>,
    orderId: number,
    opts: { returns: boolean; wasReturns: boolean; consignment: boolean; overseas: boolean },
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    if (opts.returns) set.qty = sql<string>`-abs(qty)`;
    else if (opts.wasReturns) set.qty = sql<string>`abs(qty)`;
    if (opts.consignment) set.unit_price = '0';
    if (opts.overseas) set.tax_rate = OVERSEAS_TAX_RATE;
    if (Object.keys(set).length === 0) return;
    // 金額は直したあとの数量×単価（委託は 0）
    const qtyAfter = opts.returns ? sql`-abs(qty)` : opts.wasReturns ? sql`abs(qty)` : sql`qty`;
    set.amount = opts.consignment ? '0' : sql<string>`${qtyAfter} * unit_price`;
    await trx
      .updateTable('sales_order_lines')
      .set(set as never)
      .where('sales_order_id', '=', orderId)
      .execute();
  }

  /**
   * 明細が指す得意先別商品が、この受注の取引先・明細の SKU のものか。
   * 同じ SKU に先方コード・単価の違う行が複数あり（2026-10-16 マスター編_3 M3-26）、上代・出荷JAN は
   * 明細が指す行から印字するので、取引先を変えたあとに前の取引先の行を指したまま残らないようにする。
   */
  private async assertPartnerProducts(trx: Transaction<DB>, orderId: number, lines: OrderLineInput[]): Promise<void> {
    const ids = [...new Set(lines.map((l) => l.partner_product_id).filter((v): v is number => typeof v === 'number'))];
    if (ids.length === 0) return;
    const order = await trx.selectFrom('sales_orders').select('partner_id').where('id', '=', orderId).executeTakeFirstOrThrow();
    const rows = await trx.selectFrom('partner_products').select(['id', 'partner_id', 'sku_id']).where('id', 'in', ids).execute();
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    for (const l of lines) {
      if (typeof l.partner_product_id !== 'number') continue;
      const pp = byId.get(l.partner_product_id);
      if (!pp || Number(pp.partner_id) !== Number(order.partner_id) || Number(pp.sku_id) !== Number(l.sku_id ?? 0)) {
        throw new BadRequestException(
          `${l.line_no}行目：得意先別商品（先方コード・単価）がこの取引先・商品のものではありません。商品を選び直してください`,
        );
      }
    }
  }

  /** 明細の決まり。登録と修正の両方から使う。 */
  private validateLines(lines: OrderLineInput[], orderType: OrderType): void {
    if (lines.length === 0) {
      throw new BadRequestException('明細を1行以上入力してください');
    }

    const seen = new Set<number>();
    for (const line of lines) {
      if (seen.has(line.line_no)) {
        throw new BadRequestException(`行番号 ${line.line_no} が重複しています`);
      }
      seen.add(line.line_no);

      if (SKU_REQUIRED.includes(line.line_type) && !line.sku_id) {
        throw new BadRequestException(`${line.line_no}行目：「${line.line_type}」は商品を選んでください`);
      }
      if (line.line_type === '内訳商品' && !line.parent_line_no) {
        throw new BadRequestException(`${line.line_no}行目：内訳商品には親のセット商品の行番号が要ります`);
      }
      // 非商品は商品の欄が無く、品名がその行の中身（2026-10-13 受注処理編 O-11）
      if (!line.item_name?.trim()) {
        throw new BadRequestException(
          line.line_type === '非商品'
            ? `${line.line_no}行目：非商品の行は品名を入れてください`
            : `${line.line_no}行目：品名を入力してください`,
        );
      }

      // 品物の行は 0 や負数を受けない。
      // 0 や負数で登録すると引当が一切行われないまま「未確定」で残り、
      // 出荷一覧にも出ないため、受けた注文が誰にも気づかれず落ちる。
      // 値引・販促品のマイナスは仕様どおり（通販CSVのクーポンなど）なので、
      // 商品・セット商品・内訳商品の行だけを対象にする。
      // 返品は返品の数を正の数で入れ、マイナスで登録する（O-44）。0 だけを断る。
      if (QTY_POSITIVE_REQUIRED.includes(line.line_type)) {
        const qty = Number(line.qty);
        if (!Number.isFinite(qty) || (orderType === '返品' ? qty === 0 : qty <= 0)) {
          throw new BadRequestException(
            `${line.line_no}行目：数量は 0 より大きい数で入力してください（「${line.line_type}」の行）`,
          );
        }
      }
    }

    for (const line of lines) {
      if (line.parent_line_no && !seen.has(line.parent_line_no)) {
        throw new BadRequestException(`${line.line_no}行目：親の行 ${line.parent_line_no} がありません`);
      }
    }
  }

  async list(query: OrderListQuery): Promise<Paged<Record<string, unknown>>> {
    let base = this.db
      .selectFrom('sales_orders as o')
      // 取引先・販売カテゴリーはサンプル・社内移動では空のことがある（2026-10-13 受注処理編 O-14）。外部結合にして一覧から落とさない
      .leftJoin('partners as p', 'p.id', 'o.partner_id')
      .leftJoin('delivery_destinations as d', 'd.id', 'o.delivery_destination_id')
      .leftJoin('sales_categories as sc', 'sc.id', 'o.sales_category_id')
      .leftJoin('sales_staff as su', 'su.id', 'o.sales_staff_id')
      // 出荷確定・帳票の対象になる出荷（引当済みのとき1件）
      .leftJoin('shipments as sh', (join) =>
        join.onRef('sh.sales_order_id', '=', 'o.id').on('sh.status', '<>', '削除'),
      );

    if (!query.include_cancelled) base = base.where('o.is_cancelled', '=', false);
    if (query.status) base = base.where('o.status', '=', query.status);
    if (query.order_type) base = base.where('o.order_type', '=', query.order_type);
    if (query.partner_id !== undefined) base = base.where('o.partner_id', '=', query.partner_id);
    if (query.from) base = base.where('o.order_date', '>=', query.from);
    if (query.to) base = base.where('o.order_date', '<=', query.to);

    const [items, total] = await Promise.all([
      base
        .select([
          'o.id as id',
          'o.order_no as order_no',
          'o.order_type as order_type',
          'o.status as status',
          'o.order_date as order_date',
          'o.ship_date as ship_date',
          'o.delivery_date as delivery_date',
          'o.trade_type as trade_type',
          // 通貨（取引先の通貨で固定。2026-10-12 No.39）。一覧の金額に通貨を添えるため
          'o.currency as currency',
          'o.is_billable as is_billable',
          'o.is_cancelled as is_cancelled',
          'o.sales_staff_id as sales_staff_id',
          'su.name as staff_name',
          'sh.id as shipment_id',
          'sh.status as shipment_status',
          'p.partner_code as partner_code',
          'p.name1 as partner_name',
          'd.name as delivery_name',
          'sc.name as sales_category_name',
          (eb) =>
            eb
              .selectFrom('sales_order_lines as l')
              .select(sql<string>`coalesce(sum(l.amount), 0)`.as('a'))
              .whereRef('l.sales_order_id', '=', 'o.id')
              .as('total_amount'),
        ])
        .orderBy('o.order_date', 'desc')
        .orderBy('o.order_no', 'desc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  async findOne(id: number) {
    const order = await this.db
      .selectFrom('sales_orders as o')
      // 取引先・販売カテゴリーはサンプル・社内移動では空のことがある（2026-10-13 受注処理編 O-14）
      .leftJoin('partners as p', 'p.id', 'o.partner_id')
      .leftJoin('delivery_destinations as d', 'd.id', 'o.delivery_destination_id')
      // 納品先の作業指示（受注詳細にも出す。O-07・O-23）
      .leftJoin('work_instructions as wi', 'wi.id', 'd.work_instruction_id')
      .leftJoin('sales_categories as sc', 'sc.id', 'o.sales_category_id')
      .leftJoin('warehouses as w', 'w.id', 'o.ship_from_warehouse_id')
      // 委託の入庫倉庫（O-12）・納品時間（O-03）
      .leftJoin('warehouses as cw', 'cw.id', 'o.consignment_warehouse_id')
      .leftJoin('codes as dt', 'dt.id', 'o.delivery_time_code_id')
      .leftJoin('sales_staff as su', 'su.id', 'o.sales_staff_id')
      .leftJoin('shipments as sh', (join) =>
        join.onRef('sh.sales_order_id', '=', 'o.id').on('sh.status', '<>', '削除'),
      )
      .selectAll('o')
      .select([
        'su.name as staff_name',
        'sh.id as shipment_id',
        'sh.shipment_no as shipment_no',
        'sh.status as shipment_status',
        'p.partner_code as partner_code',
        'p.name1 as partner_name',
        'd.name as delivery_name',
        'd.delivery_code as delivery_code',
        'sc.name as sales_category_name',
        'w.short_name as warehouse_name',
        'dt.name as delivery_time_name',
        'cw.short_name as consignment_warehouse_name',
        'wi.name as work_instruction_name',
        'wi.instruction_body as work_instruction_body',
      ])
      .where('o.id', '=', id)
      .executeTakeFirst();

    if (!order) throw new NotFoundException(`受注が見つかりません（ID: ${id}）`);

    const lines = await this.db
      .selectFrom('sales_order_lines as l')
      .innerJoin('sales_orders as o', 'o.id', 'l.sales_order_id')
      .leftJoin('skus as s', 's.id', 'l.sku_id')
      // 明細が使った得意先別商品の行。修正画面で同じ行を選んだまま開くため（2026-10-16 マスター編_3 M3-26）
      .leftJoin('partner_products as pp', 'pp.id', 'l.partner_product_id')
      .leftJoin('products as sp', 'sp.id', 's.product_id')
      .leftJoin('colors as scl', 'scl.id', 's.color_id')
      .leftJoin('sizes as ssz', 'ssz.id', 's.size_id')
      .select([
        'l.id as id',
        'l.line_no as line_no',
        'l.parent_line_no as parent_line_no',
        'l.line_type as line_type',
        'l.sku_id as sku_id',
        's.sku_code as sku_code',
        // SKU の品名（SKU の商品名か商品名＋カラー・サイズ。「2枚組」はカラー・サイズのあと。2026-10-13 受注処理編 O-01）。
        // 修正画面の商品の欄は、受注入力と同じくこの名前で出す
        // （明細の品名＝販売名で出すと、得意先別商品の行を選び直しても古い販売名のまま残っていた。2026-10-19 受入 X2）
        sql<string | null>`case when s.id is null then null else ${skuItemNameExpr('s', 'sp', 'scl', 'ssz')} end`.as('sku_item_name'),
        // マスタの品名（O-34・O-35「品名をマスタから入れ直す」）。得意先別商品の販売名があれば販売名、無ければ SKU の名前。＋カラー＋サイズ
        // 明細が得意先別商品の行を指していない（取込のときに無かった）ときは、その取引先×SKU の使っている行が1つなら
        // その行の販売名を使う（取込の resolvePartnerProduct と同じ決まり）。取込のあとで得意先別商品を登録して
        // 入れ直しても販売名が入らなかった（2026-10-20 受入テスト T5）
        sql<string | null>`case when s.id is null then null else ${itemNameExpr(
          sql`coalesce(
            nullif(btrim(pp.sales_name), ''),
            (select nullif(btrim(min(pp3.sales_name)), '') from partner_products pp3
              where l.partner_product_id is null and pp3.sku_id = l.sku_id and pp3.is_active
                and pp3.partner_id = (select so3.partner_id from sales_orders so3 where so3.id = l.sales_order_id)
              having count(*) = 1),
            ${skuNameExpr('s', 'sp')})`,
          sql.ref('scl.name'),
          sql.ref('ssz.name'),
        )} end`.as('master_item_name'),
        'scl.name as color_name',
        'ssz.name as size_name',
        // JAN（O-24）。帳票と同じ：得意先別商品の出荷JAN、空ならコニーJAN（SKU の JAN）。明細が得意先別商品の行を
        // 指していればその行だけを、指していなければ取引先×SKU の行を見る（reports の出荷系帳票と同じ決まり。M-18・M3-26）
        sql<string | null>`coalesce(
          case when l.partner_product_id is not null
            then nullif(btrim(pp.shipping_jan), '')
            else (select nullif(btrim(pp2.shipping_jan), '') from partner_products pp2
                   where pp2.partner_id = o.partner_id and pp2.sku_id = l.sku_id
                     and nullif(btrim(pp2.shipping_jan), '') is not null
                   order by pp2.is_active desc, pp2.id limit 1) end,
          s.jan)`.as('jan'),
        'l.partner_product_id as partner_product_id',
        'pp.partner_product_code as partner_product_code',
        'pp.partner_jan as partner_jan',
        'pp.shipping_jan as shipping_jan',
        'l.item_name as item_name',
        // 返品の明細の数量・金額はマイナスのまま返す（画面が正の数にして出す。O-44）
        'l.qty as qty',
        'l.unit_price as unit_price',
        'l.tax_rate as tax_rate',
        'l.amount as amount',
        'l.allocated_qty as allocated_qty',
        'l.is_stock_target as is_stock_target',
        // 出荷依頼書適用・納品書適用（O-09）
        'l.shipping_note as shipping_note',
        'l.delivery_slip_note as delivery_slip_note',
      ])
      .where('l.sales_order_id', '=', id)
      .orderBy('l.line_no', 'asc')
      .execute();

    // 海外の得意先は消費税の欄に「免税（税抜扱い）」／「課税対象外」と出す（請求書・納品書と同じ表記）。
    // どちらかは取引先の消費税免税区分、無ければシステム設定（2026-10-16 マスター編_3 M3-07）
    const partner =
      order.partner_id === null
        ? undefined
        : await this.db
            .selectFrom('partners')
            .select(['is_overseas', 'overseas_tax_treatment'])
            .where('id', '=', order.partner_id)
            .executeTakeFirst();
    const overseas = partner?.is_overseas === true;
    return {
      ...order,
      partner_is_overseas: overseas,
      overseas_tax_label: overseas ? await this.settings.overseasTaxLabel(partner?.overseas_tax_treatment) : null,
      lines,
    };
  }

  /**
   * 受注入力の「絞り込んで選ぶ」の候補（2026-10-13 受注処理編 O-04・O-05）。画面がブランド → 商品分類 → カラー → サイズ → JAN の順に絞る。
   * 取引先を渡すと、その取引先の得意先別商品（使っている行）ごとに1件。同じ SKU に先方コード・単価の違う行があれば
   * 行ごとに出す（選んだ行の単価・先方コード・販売名がそのまま明細に入る。M3-26）。
   * 取引先が無い受注（サンプル・取引先を空にした社内移動）は、使っている SKU ごとに1件（得意先別商品の項目は空）。
   * セット商品も含む。並びはブランド・商品分類・商品コードの順。原価は返さない。
   */
  async skuPicker(partnerId: number | null) {
    let q = this.db
      .selectFrom('skus as s')
      .innerJoin('products as p', 'p.id', 's.product_id')
      // 取引先が無いときは結合先が無い（pp の列は空）。0 の取引先は無いので、どの行にも当たらない
      .leftJoin('partner_products as pp', (join) =>
        join.onRef('pp.sku_id', '=', 's.id').on('pp.partner_id', '=', partnerId ?? 0).on('pp.is_active', '=', true),
      )
      .leftJoin('brands as b', 'b.id', 'p.brand_id')
      .leftJoin('product_classes as pc', 'pc.id', 'p.product_class_id')
      .leftJoin('colors as cl', 'cl.id', 's.color_id')
      .leftJoin('sizes as sz', 'sz.id', 's.size_id')
      .where('s.is_active', '=', true)
      .where('p.is_active', '=', true);
    if (partnerId !== null) q = q.where('pp.id', 'is not', null);

    return q
      .select([
        's.id as sku_id',
        's.sku_code as sku_code',
        'p.product_name as product_name',
        's.sku_name as sku_name',
        // SKU の品名（商品名＋カラー＋サイズ。O-01）
        skuItemNameExpr('s', 'p', 'cl', 'sz').as('item_name'),
        'pp.sales_name as sales_name',
        'p.brand_id as brand_id',
        'b.name as brand_name',
        'p.product_class_id as product_class_id',
        'pc.name as product_class_name',
        's.color_id as color_id',
        'cl.name as color_name',
        's.size_id as size_id',
        'sz.name as size_name',
        's.jan as jan',
        'pp.partner_jan as partner_jan',
        'pp.shipping_jan as shipping_jan',
        'pp.id as partner_product_id',
        'pp.partner_product_code as partner_product_code',
        'pp.unit_price as unit_price',
        'pp.retail_price as retail_price',
        'p.is_set as is_set',
        'p.tax_rate as tax_rate',
      ])
      .orderBy(sql`b.sort_order asc nulls last`)
      .orderBy(sql`b.code asc nulls last`)
      .orderBy(sql`pc.sort_order asc nulls last`)
      .orderBy(sql`pc.code asc nulls last`)
      .orderBy('s.sku_code', 'asc')
      .orderBy(sql`pp.sort_order asc nulls last`)
      .orderBy('pp.id', 'asc')
      .execute();
  }

  /** 受注の得意先が海外か（修正のあとの得意先で見る）。 */
  private async isOverseasOrder(trx: Transaction<DB>, orderId: number): Promise<boolean> {
    const o = await trx.selectFrom('sales_orders').select('partner_id').where('id', '=', orderId).executeTakeFirstOrThrow();
    return isOverseasPartner(trx, o.partner_id);
  }

  /**
   * 受注の修正（ご要望⑨⑩「受注一覧のまま編集」）。
   *
   * 押さえている在庫をいったん戻してから直す。数量を変えても引当と受注が食い違わない。
   * 登録だけ（manual。2026-10-13 受注処理編 O-06）では、引き当てていた受注（引当済、または一部でも押さえていた受注）は
   * 直したあと引当（reallocate）と同じ動きで引き当て直し、まだ引き当てていない受注は引当待ちのまま残す。
   * 受注登録時に引き当てる設定（order_entry）では、直した内容で引き当て直す（今までどおり）。
   * 出荷済みは直せない。先に出荷確定を取り消していただく（9/15 ご確認③）。
   * 明細を渡した場合は入れ替えになる（渡さなければヘッダだけ直す）。送られなかった項目（納品希望日など）は変えない。
   */
  async update(
    id: number,
    input: Partial<CreateOrderInput>,
    userId: number,
  ): Promise<OrderWriteResult> {
    return this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('sales_orders')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!order) throw new NotFoundException(`受注が見つかりません（ID: ${id}）`);
      if (order.is_cancelled) throw new ConflictException('取り消された受注は修正できません');
      if (order.status === '出荷済') {
        throw new ConflictException('出荷済みの受注です。先に出荷確定を取り消してから修正してください');
      }
      if (order.status === '出荷指示済') {
        throw new ConflictException('出荷指示済みの受注です。先に出荷指示を取り消してから修正してください');
      }

      // 直したあとの見出しで、登録と同じ決まりを見る（送られなかった項目は今の値）
      const { lines, ...header } = input;
      const pick = <K extends keyof OrderHeaderRule>(k: K, cur: OrderHeaderRule[K]): OrderHeaderRule[K] =>
        (header as Partial<OrderHeaderRule>)[k] !== undefined ? ((header as Partial<OrderHeaderRule>)[k] ?? null) as OrderHeaderRule[K] : cur;
      const orderType = (header.order_type ?? order.order_type) as OrderType;
      const tradeType = this.tradeTypeOf(orderType, header.trade_type ?? (order.trade_type as TradeType));
      const next: OrderHeaderRule = {
        order_type: orderType,
        partner_id: pick('partner_id', order.partner_id),
        sales_category_id: pick('sales_category_id', order.sales_category_id),
        delivery_destination_id: pick('delivery_destination_id', order.delivery_destination_id),
        direct_name: pick('direct_name', order.direct_name),
        trade_type: tradeType,
        consignment_warehouse_id: tradeType === '委託' ? pick('consignment_warehouse_id', order.consignment_warehouse_id) : null,
        ship_from_warehouse_id: pick('ship_from_warehouse_id', order.ship_from_warehouse_id),
        delivery_time_code_id: pick('delivery_time_code_id', order.delivery_time_code_id),
      };
      await this.checkHeader(trx, next);
      if (lines) this.validateLines(lines, orderType);

      // 引き当てていた受注か（manual では、直したあと引き当て直すかどうかをこれで決める。O-06）
      const wasAllocated = await this.allocation.isAllocated(trx, id);
      // 引当済み・引当待ちなら、押さえている分をいったん戻す。引当在庫の枠も戻す
      if (order.status !== '未確定' || wasAllocated) await this.allocation.releaseInTrx(trx, id, userId);
      await this.reservations.restore(trx, id);

      const values = Object.fromEntries(
        Object.entries(header).filter(([, v]) => v !== undefined),
      ) as Record<string, unknown>;
      // 区分・取引条件から決まる項目は、送られなくても直したあとの値にそろえる
      // （以前は区分を直しても is_billable が変わらず、サンプル→卸にすると請求に載らなかった）
      values.trade_type = tradeType;
      values.consignment_warehouse_id = next.consignment_warehouse_id;
      values.is_billable = !NO_PARTNER_TYPES.includes(orderType);

      await trx
        .updateTable('sales_orders')
        .set({ ...values, updated_by: userId, updated_at: new Date() } as never)
        .where('id', '=', id)
        .execute();

      const overseas = await this.isOverseasOrder(trx, id);
      if (lines) {
        // 明細を入れ替える。解除済みの引当が明細を指しているので先に消す（在庫の履歴は stock_movements に残る）。
        await trx
          .deleteFrom('allocations')
          .where('sales_order_line_id', 'in', (qb) =>
            qb.selectFrom('sales_order_lines').select('id').where('sales_order_id', '=', id),
          )
          .execute();
        await trx.deleteFrom('sales_order_lines').where('sales_order_id', '=', id).execute();
        await this.insertLines(trx, id, lines, userId, {
          overseas,
          returns: orderType === '返品',
          consignment: tradeType === '委託',
        });
      } else {
        // 明細を渡さずに区分・取引条件・得意先だけ直したときも、明細を決まりにそろえる
        // （返品はマイナス、委託は単価 0、海外の取引先に替えたら税率 0%）
        await this.conformLines(trx, id, {
          returns: orderType === '返品',
          wasReturns: order.order_type === '返品' && orderType !== '返品',
          consignment: tradeType === '委託',
          overseas: input.partner_id !== undefined && overseas,
        });
      }

      await this.reservations.consume(trx, id, { strict: true });
      const allocation = await this.allocation.afterOrderWrite(trx, id, userId, { wasAllocated });
      return this.writeResult(order, allocation);
    });
  }

  /**
   * 取消。引当済み・引当待ちなら引当を戻してから取り消す（在庫が押さえられたまま消えない）。
   * 出荷指示済み・出荷済みは取り消せない。先に出荷指示の取消・出荷確定の取消をしていただく。
   */
  async cancel(id: number, userId: number): Promise<{ id: number; status: string }> {
    return this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('sales_orders')
        .select(['id', 'status', 'is_cancelled'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!order) throw new NotFoundException(`受注が見つかりません（ID: ${id}）`);
      if (order.is_cancelled) throw new ConflictException('すでに取り消されています');
      if (order.status === '出荷済' || order.status === '出荷指示済') {
        throw new ConflictException(
          `この受注は「${order.status}」です。先に出荷指示の取消（出荷済みなら出荷確定の取消）をしてください`,
        );
      }
      if (order.status !== '未確定') await this.allocation.releaseInTrx(trx, id, userId);
      await this.reservations.restore(trx, id);

      await trx
        .updateTable('sales_orders')
        .set({ is_cancelled: true, status: '取消', updated_by: userId, updated_at: new Date() })
        .where('id', '=', id)
        .execute();

      return { id, status: '取消' };
    });
  }
}
