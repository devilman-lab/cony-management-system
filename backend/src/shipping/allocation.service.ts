import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import { NumberingService } from '../common/numbering.service';
import { SettingsService } from '../common/settings.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { DB } from '../db/schema';
import { RECEIPT_WAREHOUSE_NAME } from '../inventory/receipts.service';

/** 引き当てるべき SKU と数量。セット商品を展開したあとの形。 */
interface Requirement {
  sales_order_line_id: number;
  sku_id: number;
  sku_code: string;
  item_name: string;
  qty: string;
}

export interface AllocationOutcome {
  order_id: number;
  order_no: string;
  /** 受注の状態。引当済／引当待ち／出荷指示済 */
  status: string;
  warehouse_id: number;
  shipment_id: number | null;
  shipment_no: string | null;
  allocated: { sku_code: string; qty: string }[];
  /** 有効在庫が足りず引き当てられなかった分。空なら全量引当済み。 */
  shortages: string[];
}

/**
 * 引当。
 *
 * 2026-10-13 受注処理編（O-06・O-19）で、既定は「登録だけ」になった（設定 ALLOCATION_TIMING=manual）。
 *   1. 受注登録・取込 … 在庫は引き当てず、実在庫も確かめない。状態は「引当待ち」。
 *   2. 引当 … 受注一覧で選んで（まとめて／1件ずつ）「引当」。実在庫を超えていても止めず、取れた分だけ押さえる。
 *      全部取れたら「引当済」にして出荷の行を作る（出荷確定・印刷に出る）。足りなければ「引当待ち」のまま。
 *   3. 出荷確定 … 実在庫が減り、帳票を印刷する。
 * 9/15 にご確認の2段階（受注登録で引き当てる。実在庫を超える数量はエラー）は order_entry、
 * 従来の3段階（受注登録 → 出荷指示で引当 → 出荷確定）は shipping_instruction で、そのまま使える。
 * どの入口も同じ allocate() を通る。
 * 在庫の要らない受注（明細が非商品・送料・値引だけの受注、返品）は、引当で在庫を押さえずに引当済にする（どの設定でも）。
 */
@Injectable()
export class AllocationService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly numbering: NumberingService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * 出荷指示（ALLOCATION_TIMING=shipping_instruction のとき）。ここで初めて在庫を押さえる。
   * 受注登録時に引き当てる設定・登録だけの設定（manual）のときは、引当（引き当て直し）の入口として働く。
   */
  async instruct(orderId: number, userId: number): Promise<AllocationOutcome> {
    const timing = await this.settings.allocationTiming();
    if (timing !== 'shipping_instruction') return this.reallocate(orderId, userId);

    return this.db.transaction().execute(async (trx) => {
      const order = await this.lockOrder(trx, orderId);
      if (order.status !== '未確定') {
        throw new ConflictException(`この受注はすでに「${order.status}」です`);
      }
      // 足りなければ例外を投げ、トランザクションごと戻す。中途半端に押さえた状態は残らない。
      return this.allocate(trx, order, userId, { partial: false });
    });
  }

  /**
   * 引当（受注一覧・受注詳細の「引当」）。まとめて引当（受注一覧で選んだ受注。O-19）も1件ずつここを呼ぶ。
   * 押さえてある分をいったん戻してから全量を引き当て直すので、数の食い違いが起きない。
   * 1件ごとに自分のトランザクションで引き当てる（まとめて引当で1件が失敗しても、ほかの受注は戻らない）。
   *
   * manual（2026-10-13 受注処理編 O-06・O-19）では実在庫を超えていても止めず、取れた分だけ押さえる。
   * 全部取れたら「引当済」にして出荷の行を作り、足りなければ「引当待ち」のまま（9/15 ご確認と同じ）。
   * order_entry・shipping_instruction では今までどおり、実在庫を超える数量はエラーにする。
   */
  async reallocate(orderId: number, userId: number): Promise<AllocationOutcome> {
    return this.db.transaction().execute(async (trx) => {
      const order = await this.lockOrder(trx, orderId);
      if (!['未確定', '引当待ち', '引当済'].includes(order.status)) {
        throw new ConflictException(`この受注は「${order.status}」のため引き当て直せません`);
      }
      await this.releaseInTrx(trx, orderId, userId);
      if ((await this.settings.allocationTiming()) !== 'manual') await this.assertWithinOnHand(trx, order);
      return this.allocate(trx, order, userId, { partial: true });
    });
  }

  /**
   * 受注の登録・修正・取込の直後に呼ぶ（同じトランザクションの中で）。
   *
   * manual（既定。2026-10-13 受注処理編 O-06）: 在庫は引き当てず、実在庫も確かめない。状態は「引当待ち」。
   *   引き当てていた受注を直したとき（wasAllocated）だけ、引当（reallocate）と同じ動きで引き当て直す
   *   （実在庫で止めない・取れた分だけ押さえる）。まだ引き当てていない受注は引当待ちのまま。
   * order_entry: 実在庫を超えていればエラー（checkOnHand=false の CSV 取込では止めない）にし、引き当てる。
   * shipping_instruction: 実在庫を確かめるだけ（引当は出荷指示で）。null を返す。
   */
  async afterOrderWrite(
    trx: Transaction<DB>,
    orderId: number,
    userId: number,
    opts: { checkOnHand?: boolean; wasAllocated?: boolean } = {},
  ): Promise<AllocationOutcome | null> {
    const order = await this.lockOrder(trx, orderId);
    const timing = await this.settings.allocationTiming();

    if (timing === 'manual') {
      if (opts.wasAllocated) return this.allocate(trx, order, userId, { partial: true });
      await this.setStatus(trx, order.id, '引当待ち', userId);
      return {
        order_id: order.id,
        order_no: order.order_no,
        status: '引当待ち',
        warehouse_id: await this.resolveWarehouse(trx, order.ship_from_warehouse_id, order.delivery_destination_id),
        shipment_id: null,
        shipment_no: null,
        allocated: [],
        shortages: [],
      };
    }

    // CSV取込では実在庫を超えていても止めない（受注は引当待ちで残り、あとで対処できる）
    if (opts.checkOnHand ?? true) await this.assertWithinOnHand(trx, order);
    if (timing !== 'order_entry') return null;
    return this.allocate(trx, order, userId, { partial: true });
  }

  /**
   * 在庫を引き当てる明細がある受注か。明細が非商品・送料・値引だけの受注と返品は false。
   * 出荷確定（shipments.service）が、引当の無い出荷を確定してよいかを決めるのに使う（2026-10-13 受注処理編 O-11・O-44）。
   */
  async needsStock(trx: Transaction<DB>, orderId: number): Promise<boolean> {
    const order = await trx
      .selectFrom('sales_orders')
      .select(['id', 'order_type'])
      .where('id', '=', orderId)
      .executeTakeFirstOrThrow();
    return (await this.expand(trx, order)).length > 0;
  }

  /**
   * 引き当てている受注か。引当済、または一部でも押さえている（引当中の引当がある・削除でない出荷の行が残っている）。
   * manual で受注を直したとき、直したあとに引き当て直すかどうかをこれで決める（2026-10-13 受注処理編 O-06）。
   */
  async isAllocated(trx: Transaction<DB>, orderId: number): Promise<boolean> {
    const row = await trx
      .selectFrom('sales_orders as o')
      .select([
        'o.status as status',
        sql<boolean>`exists (
          select 1 from allocations a join sales_order_lines l on l.id = a.sales_order_line_id
           where l.sales_order_id = o.id and a.status = '引当中')`.as('has_allocation'),
        sql<boolean>`exists (select 1 from shipments sh where sh.sales_order_id = o.id and sh.status <> '削除')`.as('has_shipment'),
      ])
      .where('o.id', '=', orderId)
      .executeTakeFirst();
    return !!row && (row.status === '引当済' || row.has_allocation === true || row.has_shipment === true);
  }

  /**
   * 受注入力時の在庫チェック（9/15 ご確認①）。
   * 有効在庫（実在庫−引当済）を超えても登録はできるが、**実在庫を超える数量は通さない。**
   * 実在庫は、出荷元倉庫の指定があればその倉庫、なければ納品先の既定倉庫（それも無ければ先頭の倉庫）で見る。
   * セットは構成品ごとに照らす。
   */
  private async assertWithinOnHand(trx: Transaction<DB>, order: LockedOrder): Promise<void> {
    const requirements = await this.expand(trx, order);
    if (requirements.length === 0) return;
    const warehouseId = await this.resolveWarehouse(trx, order.ship_from_warehouse_id, order.delivery_destination_id);

    // 同じ SKU が複数行にあれば合算して照らす
    const needBySku = new Map<number, { sku_code: string; item_name: string; qty: number }>();
    for (const r of requirements) {
      const cur = needBySku.get(r.sku_id) ?? { sku_code: r.sku_code, item_name: r.item_name, qty: 0 };
      cur.qty += Number(r.qty);
      needBySku.set(r.sku_id, cur);
    }

    const over: string[] = [];
    for (const [skuId, need] of needBySku) {
      const row = await trx
        .selectFrom('stocks as s')
        .innerJoin('codes as q', 'q.id', 's.quality_code_id')
        .innerJoin('code_categories as cc', 'cc.id', 'q.code_category_id')
        .select(sql<string>`coalesce(sum(s.qty_on_hand), 0)`.as('on_hand'))
        .where('s.sku_id', '=', skuId)
        .where('s.warehouse_id', '=', warehouseId)
        .where('cc.code', '=', 'QUALITY_DIVISION')
        .where('q.code', '=', 'GOOD')
        .executeTakeFirstOrThrow();
      const onHand = Number(row.on_hand);
      if (need.qty > onHand) {
        over.push(`${need.sku_code}（${need.item_name}）入力 ${need.qty} / 実在庫 ${onHand}`);
      }
    }
    if (over.length > 0) {
      throw new BadRequestException({
        message: '実在庫を超える数量は登録できません。入荷を登録してからお試しください',
        over,
      });
    }
  }

  /**
   * 引当の本体。partial=true なら、足りない分は引当待ちとして受注を残す。
   * 全量引き当てられたときだけ出荷の行を作る（出荷確定と帳票の対象になる）。
   */
  private async allocate(
    trx: Transaction<DB>,
    order: LockedOrder,
    userId: number,
    opts: { partial: boolean },
  ): Promise<AllocationOutcome> {
    const requirements = await this.expand(trx, order);
    const warehouseId = await this.resolveWarehouse(trx, order.ship_from_warehouse_id, order.delivery_destination_id);
    // 全部押さえたあとの状態。3段階（shipping_instruction）は出荷指示済、登録だけ（manual）・受注登録時（order_entry）は引当済
    const timing = await this.settings.allocationTiming();
    const doneStatus = timing === 'shipping_instruction' ? '出荷指示済' : '引当済';

    if (requirements.length === 0) {
      // 在庫の要らない受注（明細が非商品・送料・値引だけの受注、返品）。在庫は押さえずに引当済にし、出荷の行を作る
      // （出荷確定・印刷に出る。2026-10-13 受注処理編 O-11・O-44）。以前は状態を変えず、出荷確定・印刷にも出なかった。
      const shipment = await this.ensureShipment(trx, order, warehouseId, userId);
      await this.setStatus(trx, order.id, doneStatus, userId);
      return {
        order_id: order.id,
        order_no: order.order_no,
        status: doneStatus,
        warehouse_id: warehouseId,
        shipment_id: shipment.id,
        shipment_no: shipment.shipment_no,
        allocated: [],
        shortages: [],
      };
    }

    const shortages: string[] = [];
    const allocated: { sku_code: string; qty: string }[] = [];
    for (const req of requirements) {
      const result = await this.take(trx, req, warehouseId, userId, opts.partial);
      if (result.shortage) shortages.push(result.shortage);
      if (Number(result.taken) > 0) allocated.push({ sku_code: req.sku_code, qty: result.taken });
    }

    if (shortages.length > 0 && !opts.partial) {
      // 例外を投げればトランザクションごと戻る。中途半端に押さえた状態は残らない。
      throw new ConflictException({ message: '有効在庫が足りないため出荷指示を出せません', shortages });
    }

    const fully = shortages.length === 0;

    let shipment: { id: number; shipment_no: string } | null = null;
    if (fully) shipment = await this.ensureShipment(trx, order, warehouseId, userId);

    const status = fully ? doneStatus : '引当待ち';
    await this.setStatus(trx, order.id, status, userId);

    return {
      order_id: order.id,
      order_no: order.order_no,
      status,
      warehouse_id: warehouseId,
      shipment_id: shipment?.id ?? null,
      shipment_no: shipment?.shipment_no ?? null,
      allocated,
      shortages,
    };
  }

  /**
   * 出荷の行を用意する。出荷指示番号は受注番号をそのまま使う（確認事項⑪／設定 SHIPMENT_NO_SOURCE）。
   * 一度引当を解除して出し直す場合、同じ受注の出荷が「削除」で残っている。
   * 番号が重複するため、その行を作り直して使う。
   */
  private async ensureShipment(
    trx: Transaction<DB>,
    order: LockedOrder,
    warehouseId: number,
    userId: number,
  ): Promise<{ id: number; shipment_no: string }> {
    const existing = await trx
      .selectFrom('shipments')
      .select(['id', 'shipment_no'])
      .where('sales_order_id', '=', order.id)
      .where('status', '<>', '出荷済')
      .forUpdate()
      .executeTakeFirst();

    if (existing) {
      await trx
        .updateTable('shipments')
        .set({
          warehouse_id: warehouseId,
          planned_ship_date: order.ship_date,
          status: '確定済',
          confirmed_at: new Date(),
          updated_by: userId,
          updated_at: new Date(),
        })
        .where('id', '=', existing.id)
        .execute();
      return existing;
    }

    const source = await this.settings.shipmentNoSource();
    const shipmentNo = source === 'sales_order' ? order.order_no : await this.numbering.next(trx, 'shipment');
    return trx
      .insertInto('shipments')
      .values({
        shipment_no: shipmentNo,
        sales_order_id: order.id,
        warehouse_id: warehouseId,
        planned_ship_date: order.ship_date,
        status: '確定済',
        confirmed_at: new Date(),
        created_by: userId,
        updated_by: userId,
      })
      .returning(['id', 'shipment_no'])
      .executeTakeFirstOrThrow();
  }

  private async lockOrder(trx: Transaction<DB>, orderId: number): Promise<LockedOrder> {
    const order = await trx
      .selectFrom('sales_orders')
      .select(['id', 'order_no', 'order_type', 'status', 'is_cancelled', 'ship_date', 'ship_from_warehouse_id', 'delivery_destination_id'])
      .where('id', '=', orderId)
      .forUpdate()
      .executeTakeFirst();

    if (!order) throw new NotFoundException(`受注が見つかりません（ID: ${orderId}）`);
    if (order.is_cancelled) throw new ConflictException('取り消された受注です');
    return order;
  }

  private async setStatus(trx: Transaction<DB>, orderId: number, status: string, userId: number): Promise<void> {
    await trx
      .updateTable('sales_orders')
      .set({ status, updated_by: userId, updated_at: new Date() })
      .where('id', '=', orderId)
      .execute();
  }

  /**
   * 明細を「実際に在庫から引く単位」に展開する。
   *
   * セット商品は在庫を持たない。通販CSVのように内訳商品の行が付いている場合は
   * その行から引き、付いていない手入力の場合はセット構成を展開して引く。
   * 両方から引くと二重に引き落としてしまうため、どちらか一方だけを使う。
   *
   * 返品の受注（2026-10-13 受注処理編 O-44）は在庫を動かさないので、引く明細は無い
   * （良品として戻すときは在庫調整で理由「返品」を選んで入れる。O-45）。
   */
  private async expand(trx: Transaction<DB>, order: { id: number; order_type: string }): Promise<Requirement[]> {
    if (order.order_type === '返品') return [];
    const orderId = order.id;
    const lines = await trx
      .selectFrom('sales_order_lines as l')
      .leftJoin('skus as s', 's.id', 'l.sku_id')
      .select([
        'l.id as id',
        'l.line_no as line_no',
        'l.parent_line_no as parent_line_no',
        'l.line_type as line_type',
        'l.sku_id as sku_id',
        'l.item_name as item_name',
        'l.qty as qty',
        'l.is_stock_target as is_stock_target',
        's.sku_code as sku_code',
      ])
      .where('l.sales_order_id', '=', orderId)
      .orderBy('l.line_no', 'asc')
      .execute();

    const hasChild = new Set(lines.map((l) => l.parent_line_no).filter((n): n is number => n !== null));
    const out: Requirement[] = [];

    for (const line of lines) {
      // 送料・値引・非商品・販促品は在庫を動かさない（is_stock_target が false）
      if (line.line_type === 'セット商品') {
        if (hasChild.has(line.line_no)) continue; // 内訳商品の行から引く
        if (!line.sku_id) continue;
        if (Number(line.qty) <= 0) continue; // マイナスの行は在庫を押さえない（商品の行と同じ）

        const components = await trx
          .selectFrom('set_components as sc')
          .innerJoin('set_headers as h', 'h.id', 'sc.set_header_id')
          .innerJoin('skus as s', 's.id', 'sc.component_sku_id')
          .select(['sc.component_sku_id as sku_id', 'sc.qty as qty', 's.sku_code as sku_code', 's.id as sid'])
          .where('h.sku_id', '=', line.sku_id)
          .execute();

        if (components.length === 0) {
          throw new BadRequestException(
            `${line.line_no}行目：「${line.item_name}」のセット構成が登録されていません`,
          );
        }
        for (const c of components) {
          out.push({
            sales_order_line_id: line.id,
            sku_id: c.sku_id,
            sku_code: c.sku_code ?? '',
            item_name: line.item_name,
            // セット数 × 構成数。掛け算は数値ではなく文字列のまま SQL に渡す。
            qty: String(Number(line.qty) * Number(c.qty)),
          });
        }
        continue;
      }

      if (!line.is_stock_target || !line.sku_id) continue;
      if (Number(line.qty) <= 0) continue; // 販促品のマイナス行などは対象外

      out.push({
        sales_order_line_id: line.id,
        sku_id: line.sku_id,
        sku_code: line.sku_code ?? '',
        item_name: line.item_name,
        qty: line.qty,
      });
    }

    return out;
  }

  /**
   * 出荷元の倉庫。受注で指定がなければ納品先の既定倉庫、それも無ければ「コニー倉庫」（略称が一致する倉庫。
   * 入荷・在庫調整の既定と同じ）。コニー倉庫が無いときだけ、表示順の先頭の倉庫。
   * 以前は表示順の先頭の倉庫で、一覧の並びのための表示順を変えただけで、在庫を確かめ・引き当てる倉庫が
   * 変わっていた（2026-10-19 受入 X1-1）。
   * 受注の登録・修正（orders.service）も、委託の入庫倉庫が出荷倉庫と同じでないかをこの当て方で確かめる（O-12）。
   */
  async resolveWarehouse(
    trx: Transaction<DB>,
    orderWarehouseId: number | null,
    deliveryDestinationId: number | null,
  ): Promise<number> {
    if (orderWarehouseId) return orderWarehouseId;

    if (deliveryDestinationId) {
      const dest = await trx
        .selectFrom('delivery_destinations')
        .select('default_warehouse_id')
        .where('id', '=', deliveryDestinationId)
        .executeTakeFirst();
      if (dest?.default_warehouse_id) return dest.default_warehouse_id;
    }

    const cony = await trx
      .selectFrom('warehouses')
      .select('id')
      .where('short_name', '=', RECEIPT_WAREHOUSE_NAME)
      .where('is_active', '=', true)
      .orderBy('sort_order', sql`asc nulls last`)
      .orderBy('id', 'asc')
      .executeTakeFirst();
    if (cony) return cony.id;

    const first = await trx
      .selectFrom('warehouses')
      .select('id')
      .where('is_active', '=', true)
      .orderBy('sort_order', sql`asc nulls last`)
      .orderBy('warehouse_code', 'asc')
      .executeTakeFirst();

    if (!first) throw new BadRequestException('出荷元の倉庫が登録されていません');
    return first.id;
  }

  /**
   * 1つの SKU を引き当てる。
   * 良品だけを対象にし、期限の近いロットから順に取る。
   * partial=true なら取れる分だけ取り、足りない内容を文字列で返す（呼び手がまとめて扱う）。
   */
  private async take(
    trx: Transaction<DB>,
    req: Requirement,
    warehouseId: number,
    userId: number,
    partial: boolean,
  ): Promise<{ taken: string; shortage: string | null }> {
    const stocks = await trx
      .selectFrom('stocks as s')
      .innerJoin('codes as q', 'q.id', 's.quality_code_id')
      .innerJoin('code_categories as cc', 'cc.id', 'q.code_category_id')
      .select(['s.id as id', 's.qty_available as qty_available'])
      .where('s.sku_id', '=', req.sku_id)
      .where('s.warehouse_id', '=', warehouseId)
      .where('cc.code', '=', 'QUALITY_DIVISION')
      .where('q.code', '=', 'GOOD')
      .orderBy('s.expiry_date', sql`asc nulls last`)
      .orderBy('s.lot_no', 'asc')
      .forUpdate()
      .execute();

    const need = Number(req.qty);
    const available = stocks.reduce((sum, s) => sum + Number(s.qty_available ?? 0), 0);
    const shortage =
      // 数は「12.00」ではなく「12」の形で出す（2026-10-20 受入テスト。有効在庫の数と書き方をそろえる）
      available < need ? `${req.sku_code}（${req.item_name}）必要 ${need} / 有効在庫 ${available}` : null;
    if (shortage && !partial) return { taken: '0', shortage };

    let remaining = Math.min(need, available);
    let takenTotal = 0;

    for (const stock of stocks) {
      if (remaining <= 0) break;
      const canTake = Math.min(remaining, Number(stock.qty_available ?? 0));
      if (canTake <= 0) continue;
      const take = String(canTake);

      const before = await trx
        .selectFrom('stocks')
        .select('qty_available')
        .where('id', '=', stock.id)
        .executeTakeFirstOrThrow();

      await trx
        .updateTable('stocks')
        .set({ qty_allocated: sql<string>`qty_allocated + ${take}::numeric`, updated_by: userId, updated_at: new Date() })
        .where('id', '=', stock.id)
        .execute();

      await trx
        .insertInto('allocations')
        .values({
          sales_order_line_id: req.sales_order_line_id,
          stock_id: stock.id,
          sku_id: req.sku_id,
          qty: take,
          status: '引当中',
          created_by: userId,
          updated_by: userId,
        })
        .execute();

      await trx
        .insertInto('stock_movements')
        .values({
          stock_id: stock.id,
          movement_type: '引当',
          ref_table: 'sales_order_lines',
          ref_id: req.sales_order_line_id,
          qty: take,
          qty_before: before.qty_available ?? '0',
          qty_after: sql<string>`${before.qty_available ?? '0'}::numeric - ${take}::numeric`,
          created_by: userId,
        })
        .execute();

      remaining -= canTake;
      takenTotal += canTake;
    }

    if (takenTotal > 0) {
      await trx
        .updateTable('sales_order_lines')
        .set({ allocated_qty: sql<string>`allocated_qty + ${String(takenTotal)}::numeric` })
        .where('id', '=', req.sales_order_line_id)
        .execute();
    }

    return { taken: String(takenTotal), shortage };
  }

  /**
   * 引当の解除（出荷指示の取消）。
   * 有効在庫は戻るが実在庫は動かない。棚の数は初めから変わっていない。
   */
  async release(orderId: number, userId: number) {
    return this.db.transaction().execute(async (trx) => {
      const order = await this.lockOrder(trx, orderId);
      if (order.status === '出荷済') {
        throw new ConflictException('出荷済みの受注は引当を解除できません。先に出荷確定を取り消してください');
      }
      if (!['出荷指示済', '引当済', '引当待ち'].includes(order.status)) {
        throw new ConflictException(`この受注は「${order.status}」です。解除する引当がありません`);
      }
      const released = await this.releaseInTrx(trx, orderId, userId);
      return { order_id: orderId, order_no: order.order_no, released, status: await this.releasedStatus() };
    });
  }

  /**
   * 引当を戻したあとの受注の状態。manual（登録だけ）は登録したばかりの受注と同じ「引当待ち」
   * （受注一覧の既定の絞り込みに出て、引き当て直せる。2026-10-13 受注処理編 O-06）。ほかの設定は「未確定」。
   */
  private async releasedStatus(): Promise<'引当待ち' | '未確定'> {
    return (await this.settings.allocationTiming()) === 'manual' ? '引当待ち' : '未確定';
  }

  /** 引当をすべて戻し、受注を引当前の状態（releasedStatus）に戻す。受注の修正・取消・引当直しの前処理。 */
  async releaseInTrx(trx: Transaction<DB>, orderId: number, userId: number): Promise<number> {
    const allocations = await trx
      .selectFrom('allocations as a')
      .innerJoin('sales_order_lines as l', 'l.id', 'a.sales_order_line_id')
      .select(['a.id as id', 'a.stock_id as stock_id', 'a.qty as qty', 'a.sales_order_line_id as line_id'])
      .where('l.sales_order_id', '=', orderId)
      .where('a.status', '=', '引当中')
      .execute();

    for (const alloc of allocations) {
      const before = await trx
        .selectFrom('stocks')
        .select('qty_available')
        .where('id', '=', alloc.stock_id)
        .executeTakeFirstOrThrow();

      await trx
        .updateTable('stocks')
        .set({
          qty_allocated: sql<string>`qty_allocated - ${alloc.qty}::numeric`,
          updated_by: userId,
          updated_at: new Date(),
        })
        .where('id', '=', alloc.stock_id)
        .execute();

      await trx
        .updateTable('allocations')
        .set({ status: '解除', released_at: new Date(), updated_by: userId, updated_at: new Date() })
        .where('id', '=', alloc.id)
        .execute();

      await trx
        .insertInto('stock_movements')
        .values({
          stock_id: alloc.stock_id,
          movement_type: '引当解除',
          ref_table: 'sales_order_lines',
          ref_id: alloc.line_id,
          qty: sql<string>`-${alloc.qty}::numeric`,
          qty_before: before.qty_available ?? '0',
          qty_after: sql<string>`${before.qty_available ?? '0'}::numeric + ${alloc.qty}::numeric`,
          created_by: userId,
        })
        .execute();
    }

    await trx
      .updateTable('sales_order_lines')
      .set({ allocated_qty: '0' })
      .where('sales_order_id', '=', orderId)
      .execute();

    await trx
      .updateTable('shipments')
      .set({ status: '削除', updated_by: userId, updated_at: new Date() })
      .where('sales_order_id', '=', orderId)
      .where('status', '<>', '出荷済')
      .execute();

    await this.setStatus(trx, orderId, await this.releasedStatus(), userId);

    return allocations.length;
  }
}

interface LockedOrder {
  id: number;
  order_no: string;
  order_type: string;
  status: string;
  is_cancelled: boolean;
  ship_date: string | null;
  ship_from_warehouse_id: number | null;
  delivery_destination_id: number | null;
}
