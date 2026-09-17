import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import { NumberingService } from '../common/numbering.service';
import { ReservationsService } from '../inventory/reservations.service';
import { AllocationService, type AllocationOutcome } from '../shipping/allocation.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { DB } from '../db/schema';
import type { Paged } from '../masters/partners.service';

export type OrderType = '卸' | '直送' | '通販' | 'サンプル';
export type LineType = '商品' | 'セット商品' | '内訳商品' | '販促品' | '送料' | '値引' | '非商品';

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
}

export interface CreateOrderInput {
  order_type: OrderType;
  partner_id: number;
  delivery_destination_id?: number | null;
  sales_category_id: number;
  trade_type?: '委託' | '買取';
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

@Injectable()
export class OrdersService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly numbering: NumberingService,
    private readonly allocation: AllocationService,
    private readonly reservations: ReservationsService,
  ) {}

  async create(input: CreateOrderInput, userId: number): Promise<OrderWriteResult> {
    this.validate(input);

    return this.db.transaction().execute(async (trx) => {
      const orderNo = await this.numbering.next(trx, 'sales_order');

      // 販売担当は取引先マスタの担当者を初期値にし、受注ごとに変えられる（9/15 ご要望）。
      const salesStaffId = input.sales_staff_id ?? (await this.defaultStaff(trx, input.partner_id));

      // サンプル出荷は売上・請求に計上しない（確認事項④）。
      // データベース側にも ck_so_sample があり、後から売上計上には変えられない。
      const isBillable = input.order_type !== 'サンプル';

      const order = await trx
        .insertInto('sales_orders')
        .values({
          order_no: orderNo,
          order_type: input.order_type,
          partner_id: input.partner_id,
          delivery_destination_id: input.delivery_destination_id ?? null,
          sales_category_id: input.sales_category_id,
          trade_type: input.trade_type ?? '買取',
          sales_staff_id: salesStaffId,
          po_no: input.po_no ?? null,
          po_line_no: input.po_line_no ?? null,
          order_date: input.order_date,
          ship_date: input.ship_date ?? null,
          delivery_date: input.delivery_date ?? null,
          requested_delivery_date: input.requested_delivery_date ?? null,
          ship_from_warehouse_id: input.ship_from_warehouse_id ?? null,
          direct_name: input.direct_name ?? null,
          direct_kana: input.direct_kana ?? null,
          direct_postal_code: input.direct_postal_code ?? null,
          direct_address1: input.direct_address1 ?? null,
          direct_address2: input.direct_address2 ?? null,
          direct_tel: input.direct_tel ?? null,
          shipping_remarks: input.shipping_remarks ?? null,
          delivery_note_remarks: input.delivery_note_remarks ?? null,
          shipping_fee_adjustment: input.shipping_fee_adjustment ?? null,
          is_billable: isBillable,
          channel: input.channel ?? null,
          status: '未確定',
          created_by: userId,
          updated_by: userId,
        })
        .returning(['id', 'order_no'])
        .executeTakeFirstOrThrow();

      await this.insertLines(trx, order.id, input.lines, userId);

      // 引当在庫（販売カテゴリーの枠）から減らす。枠を超えれば 400（9/17 ご確認②）。
      await this.reservations.consume(trx, order.id, { strict: true });
      // 実在庫を超えていればここで止まる。設定が受注登録時なら、そのまま引き当てる（9/15 ご確認①②）。
      const allocation = await this.allocation.afterOrderWrite(trx, order.id, userId);
      return this.writeResult(order, allocation);
    });
  }

  /** 取引先マスタの担当者。未設定なら null。 */
  private async defaultStaff(trx: Transaction<DB>, partnerId: number): Promise<number | null> {
    const p = await trx
      .selectFrom('partners')
      .select('sales_staff_id')
      .where('id', '=', partnerId)
      .executeTakeFirst();
    return p?.sales_staff_id ?? null;
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
   */
  private async insertLines(
    trx: Transaction<DB>,
    orderId: number,
    lines: OrderLineInput[],
    userId: number,
  ): Promise<void> {
    await trx
      .insertInto('sales_order_lines')
      .values(
        lines.map((line) => ({
          sales_order_id: orderId,
          line_no: line.line_no,
          parent_line_no: line.parent_line_no ?? null,
          line_type: line.line_type,
          sku_id: line.sku_id ?? null,
          partner_product_id: line.partner_product_id ?? null,
          item_name: line.item_name,
          qty: line.qty,
          unit_price: line.unit_price,
          tax_rate: line.tax_rate ?? '10.00',
          amount: sql<string>`${line.qty}::numeric * ${line.unit_price}::numeric`,
          created_by: userId,
        })),
      )
      .execute();
  }

  private validate(input: CreateOrderInput): void {
    if (input.order_type === '卸' && !input.delivery_destination_id) {
      throw new BadRequestException('卸の受注では納品先を選んでください');
    }
    if (input.order_type === '直送' && !input.direct_name) {
      throw new BadRequestException('直送の受注ではお届け先のお名前を入力してください');
    }
    this.validateLines(input.lines, input.order_type);
  }

  /** 明細の決まり。登録と修正の両方から使う。 */
  private validateLines(lines: OrderLineInput[], _orderType: OrderType): void {
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
      .innerJoin('partners as p', 'p.id', 'o.partner_id')
      .leftJoin('delivery_destinations as d', 'd.id', 'o.delivery_destination_id')
      .innerJoin('sales_categories as sc', 'sc.id', 'o.sales_category_id')
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
      .innerJoin('partners as p', 'p.id', 'o.partner_id')
      .leftJoin('delivery_destinations as d', 'd.id', 'o.delivery_destination_id')
      .innerJoin('sales_categories as sc', 'sc.id', 'o.sales_category_id')
      .leftJoin('warehouses as w', 'w.id', 'o.ship_from_warehouse_id')
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
      ])
      .where('o.id', '=', id)
      .executeTakeFirst();

    if (!order) throw new NotFoundException(`受注が見つかりません（ID: ${id}）`);

    const lines = await this.db
      .selectFrom('sales_order_lines as l')
      .leftJoin('skus as s', 's.id', 'l.sku_id')
      .select([
        'l.id as id',
        'l.line_no as line_no',
        'l.parent_line_no as parent_line_no',
        'l.line_type as line_type',
        'l.sku_id as sku_id',
        's.sku_code as sku_code',
        'l.item_name as item_name',
        'l.qty as qty',
        'l.unit_price as unit_price',
        'l.tax_rate as tax_rate',
        'l.amount as amount',
        'l.allocated_qty as allocated_qty',
        'l.is_stock_target as is_stock_target',
      ])
      .where('l.sales_order_id', '=', id)
      .orderBy('l.line_no', 'asc')
      .execute();

    return { ...order, lines };
  }

  /**
   * 受注の修正（ご要望⑨⑩「受注一覧のまま編集」）。
   *
   * 引当済み・引当待ちの受注は、押さえている在庫をいったん戻してから直し、直した内容で
   * 引き当て直す。数量を変えても引当と受注が食い違わない。
   * 出荷済みは直せない。先に出荷確定を取り消していただく（9/15 ご確認③）。
   * 明細を渡した場合は入れ替えになる（渡さなければヘッダだけ直す）。
   */
  async update(
    id: number,
    input: Partial<CreateOrderInput>,
    userId: number,
  ): Promise<OrderWriteResult> {
    return this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('sales_orders')
        .select(['id', 'order_no', 'status', 'is_cancelled', 'order_type'])
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
      // 引当済み・引当待ちなら、押さえている分をいったん戻す。引当在庫の枠も戻す
      if (order.status !== '未確定') await this.allocation.releaseInTrx(trx, id, userId);
      await this.reservations.restore(trx, id);

      const { lines, ...header } = input;
      const values = Object.fromEntries(
        Object.entries(header).filter(([, v]) => v !== undefined),
      ) as Record<string, unknown>;

      if (Object.keys(values).length > 0) {
        await trx
          .updateTable('sales_orders')
          .set({ ...values, updated_by: userId, updated_at: new Date() } as never)
          .where('id', '=', id)
          .execute();
      }

      if (lines) {
        this.validateLines(lines, (input.order_type ?? order.order_type) as OrderType);
        // 明細を入れ替える。解除済みの引当が明細を指しているので先に消す（在庫の履歴は stock_movements に残る）。
        await trx
          .deleteFrom('allocations')
          .where('sales_order_line_id', 'in', (qb) =>
            qb.selectFrom('sales_order_lines').select('id').where('sales_order_id', '=', id),
          )
          .execute();
        await trx.deleteFrom('sales_order_lines').where('sales_order_id', '=', id).execute();
        await this.insertLines(trx, id, lines, userId);
      }

      await this.reservations.consume(trx, id, { strict: true });
      const allocation = await this.allocation.afterOrderWrite(trx, id, userId);
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
