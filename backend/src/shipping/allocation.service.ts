import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import { NumberingService } from '../common/numbering.service';
import { SettingsService } from '../common/settings.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { DB } from '../db/schema';

/** 引き当てるべき SKU と数量。セット商品を展開したあとの形。 */
interface Requirement {
  sales_order_line_id: number;
  sku_id: number;
  sku_code: string;
  item_name: string;
  qty: string;
}

@Injectable()
export class AllocationService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly numbering: NumberingService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * 出荷指示。ここで初めて在庫を押さえる（確認事項⑧／設定 ALLOCATION_TIMING）。
   *
   * 受注を登録しただけ、受注一覧で編集している間は在庫はまったく動かない。
   * 押さえるのは「引当済」であって「実在庫」ではない。棚の数は出荷を確定する
   * まで変わらない。
   */
  async instruct(orderId: number, userId: number) {
    const timing = await this.settings.allocationTiming();
    if (timing !== 'shipping_instruction') {
      throw new ConflictException(
        `引当のタイミングが「${timing}」に設定されています。出荷指示からは引き当てません`,
      );
    }

    return this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('sales_orders')
        .selectAll()
        .where('id', '=', orderId)
        .forUpdate()
        .executeTakeFirst();

      if (!order) throw new NotFoundException(`受注が見つかりません（ID: ${orderId}）`);
      if (order.is_cancelled) throw new ConflictException('取り消された受注です');
      if (order.status !== '未確定') {
        throw new ConflictException(`この受注はすでに「${order.status}」です`);
      }

      const requirements = await this.expand(trx, orderId);
      if (requirements.length === 0) {
        throw new BadRequestException('引当の対象になる明細がありません');
      }

      const warehouseId = await this.resolveWarehouse(trx, order.ship_from_warehouse_id, order.delivery_destination_id);

      const shortages: string[] = [];
      for (const req of requirements) {
        const taken = await this.take(trx, req, warehouseId, userId);
        if (taken !== null) shortages.push(taken);
      }
      if (shortages.length > 0) {
        // 例外を投げればトランザクションごと戻る。中途半端に押さえた状態は残らない。
        throw new ConflictException({
          message: '有効在庫が足りないため出荷指示を出せません',
          shortages,
        });
      }

      // 出荷指示番号は受注番号をそのまま使う（確認事項⑪／設定 SHIPMENT_NO_SOURCE）。
      const source = await this.settings.shipmentNoSource();

      // 一度出荷指示を取り消してから出し直す場合、同じ受注に対する出荷の行が
      // 「削除」の状態で残っている。出荷指示番号は受注番号と同じなので、
      // 新しく作ると番号が重複する。その行を作り直して使う。
      const existing = await trx
        .selectFrom('shipments')
        .select(['id', 'shipment_no'])
        .where('sales_order_id', '=', orderId)
        .where('status', '<>', '出荷済')
        .forUpdate()
        .executeTakeFirst();

      let shipment: { id: number; shipment_no: string };
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
        shipment = existing;
      } else {
        const shipmentNo =
          source === 'sales_order' ? order.order_no : await this.numbering.next(trx, 'shipment');
        shipment = await trx
          .insertInto('shipments')
          .values({
            shipment_no: shipmentNo,
            sales_order_id: orderId,
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

      await trx
        .updateTable('sales_orders')
        .set({ status: '出荷指示済', updated_by: userId, updated_at: new Date() })
        .where('id', '=', orderId)
        .execute();

      return {
        order_id: orderId,
        order_no: order.order_no,
        shipment_id: shipment.id,
        shipment_no: shipment.shipment_no,
        warehouse_id: warehouseId,
        allocated: requirements.map((r) => ({ sku_code: r.sku_code, qty: r.qty })),
      };
    });
  }

  /**
   * 明細を「実際に在庫から引く単位」に展開する。
   *
   * セット商品は在庫を持たない。通販CSVのように内訳商品の行が付いている場合は
   * その行から引き、付いていない手入力の場合はセット構成を展開して引く。
   * 両方から引くと二重に引き落としてしまうため、どちらか一方だけを使う。
   */
  private async expand(trx: Transaction<DB>, orderId: number): Promise<Requirement[]> {
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

  /** 出荷元の倉庫。受注で指定がなければ納品先の既定倉庫、それも無ければ先頭の倉庫。 */
  private async resolveWarehouse(
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
   * 1つの SKU を引き当てる。足りなければ不足内容を文字列で返す（呼び手がまとめて返す）。
   * 良品だけを対象にし、期限の近いロットから順に取る。
   */
  private async take(
    trx: Transaction<DB>,
    req: Requirement,
    warehouseId: number,
    userId: number,
  ): Promise<string | null> {
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

    let remaining = Number(req.qty);
    const available = stocks.reduce((sum, s) => sum + Number(s.qty_available ?? 0), 0);
    if (available < remaining) {
      return `${req.sku_code}（${req.item_name}）必要 ${req.qty} / 有効在庫 ${available}`;
    }

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
    }

    await trx
      .updateTable('sales_order_lines')
      .set({ allocated_qty: sql<string>`allocated_qty + ${req.qty}::numeric` })
      .where('id', '=', req.sales_order_line_id)
      .execute();

    return null;
  }

  /**
   * 出荷指示の取消（引当解除）。
   * 有効在庫は戻るが実在庫は動かない。棚の数は初めから変わっていない。
   */
  async release(orderId: number, userId: number) {
    return this.db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('sales_orders')
        .select(['id', 'order_no', 'status'])
        .where('id', '=', orderId)
        .forUpdate()
        .executeTakeFirst();

      if (!order) throw new NotFoundException(`受注が見つかりません（ID: ${orderId}）`);
      if (order.status === '出荷済') {
        throw new ConflictException('出荷済みの受注は引当を解除できません');
      }
      if (order.status !== '出荷指示済') {
        throw new ConflictException(`この受注は「${order.status}」です。解除する引当がありません`);
      }

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

      await trx
        .updateTable('sales_orders')
        .set({ status: '未確定', updated_by: userId, updated_at: new Date() })
        .where('id', '=', orderId)
        .execute();

      return { order_id: orderId, order_no: order.order_no, released: allocations.length, status: '未確定' };
    });
  }
}
