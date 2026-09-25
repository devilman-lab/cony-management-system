import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import { SettingsService } from '../common/settings.service';
import { KYSELY, type ConyDatabase } from '../db/database.module';
import type { DB } from '../db/schema';
import type { Paged } from '../masters/partners.service';

export interface ShipmentListQuery {
  status?: string;
  warehouse_id?: number;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

@Injectable()
export class ShipmentsService {
  constructor(
    @Inject(KYSELY) private readonly db: ConyDatabase,
    private readonly settings: SettingsService,
  ) {}

  async list(query: ShipmentListQuery): Promise<Paged<Record<string, unknown>>> {
    let base = this.db
      .selectFrom('shipments as sh')
      .leftJoin('sales_orders as o', 'o.id', 'sh.sales_order_id')
      .leftJoin('partners as p', 'p.id', 'o.partner_id')
      .innerJoin('warehouses as w', 'w.id', 'sh.warehouse_id')
      .where('sh.status', '<>', '削除');

    if (query.status) base = base.where('sh.status', '=', query.status);
    if (query.warehouse_id !== undefined) base = base.where('sh.warehouse_id', '=', query.warehouse_id);
    if (query.from) base = base.where('sh.planned_ship_date', '>=', query.from);
    if (query.to) base = base.where('sh.planned_ship_date', '<=', query.to);

    const [items, total] = await Promise.all([
      base
        .select([
          'sh.id as id',
          'sh.shipment_no as shipment_no',
          'sh.status as status',
          'sh.planned_ship_date as planned_ship_date',
          'sh.ship_date as ship_date',
          'sh.consolidated_to_shipment_id as consolidated_to_shipment_id',
          'o.id as sales_order_id',
          'o.order_no as order_no',
          'o.order_type as order_type',
          'o.is_billable as is_billable',
          'p.name1 as partner_name',
          'w.short_name as warehouse_name',
        ])
        .orderBy('sh.planned_ship_date', sql`asc nulls last`)
        .orderBy('sh.shipment_no', 'asc')
        .limit(query.limit)
        .offset(query.offset)
        .execute(),
      base.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    ]);

    return { items, total: Number(total.n), limit: query.limit, offset: query.offset };
  }

  /**
   * 出荷確定。**ここで初めて実在庫が減る。**
   *
   * 引当済も同じ数だけ減らす。有効在庫（＝実在庫−引当済）は生成列なので、
   * 両方を同じ数だけ減らせば有効在庫は変わらない。押さえていた分が
   * そのまま棚から出ていく、という動きになる。
   */
  async confirm(shipmentId: number, shipDate: string | null, userId: number) {
    return this.db.transaction().execute((trx) => this.confirmInTrx(trx, shipmentId, shipDate, userId));
  }

  /** 出荷確定の本体。確定と印刷を同時に行う経路からも同じトランザクションで呼ぶ。 */
  async confirmInTrx(trx: Transaction<DB>, shipmentId: number, shipDate: string | null, userId: number) {
    {
      const shipment = await trx
        .selectFrom('shipments')
        .selectAll()
        .where('id', '=', shipmentId)
        .forUpdate()
        .executeTakeFirst();

      if (!shipment) throw new NotFoundException(`出荷が見つかりません（ID: ${shipmentId}）`);
      if (shipment.status === '出荷済') throw new ConflictException('すでに出荷済みです');
      if (shipment.status === '削除') throw new ConflictException('取り消された出荷です');
      if (!shipment.sales_order_id) throw new ConflictException('受注に紐づいていない出荷です');

      const allocations = await trx
        .selectFrom('allocations as a')
        .innerJoin('sales_order_lines as l', 'l.id', 'a.sales_order_line_id')
        .select([
          'a.id as id',
          'a.stock_id as stock_id',
          'a.qty as qty',
          'a.sku_id as sku_id',
          'l.id as line_id',
          'l.line_no as line_no',
          'l.item_name as item_name',
          'l.unit_price as unit_price',
          'l.tax_rate as tax_rate',
        ])
        .where('l.sales_order_id', '=', shipment.sales_order_id)
        .where('a.status', '=', '引当中')
        .execute();

      if (allocations.length === 0) {
        throw new ConflictException('引当がありません。先に出荷指示を出してください');
      }

      let lineNo = 0;
      for (const alloc of allocations) {
        const before = await trx
          .selectFrom('stocks')
          .select('qty_on_hand')
          .where('id', '=', alloc.stock_id)
          .executeTakeFirstOrThrow();

        // 実在庫と引当済を同じ数だけ減らす。有効在庫は動かない。
        await trx
          .updateTable('stocks')
          .set({
            qty_on_hand: sql<string>`qty_on_hand - ${alloc.qty}::numeric`,
            qty_allocated: sql<string>`qty_allocated - ${alloc.qty}::numeric`,
            updated_by: userId,
            updated_at: new Date(),
          })
          .where('id', '=', alloc.stock_id)
          .execute();

        await trx
          .updateTable('allocations')
          .set({ status: '出荷済', updated_by: userId, updated_at: new Date() })
          .where('id', '=', alloc.id)
          .execute();

        await trx
          .insertInto('stock_movements')
          .values({
            stock_id: alloc.stock_id,
            movement_type: '出荷',
            ref_table: 'shipments',
            ref_id: shipmentId,
            qty: sql<string>`-${alloc.qty}::numeric`,
            qty_before: before.qty_on_hand,
            qty_after: sql<string>`${before.qty_on_hand}::numeric - ${alloc.qty}::numeric`,
            created_by: userId,
          })
          .execute();

        // 出荷明細は「倉庫から実際に出たもの」の記録。セット商品は構成品の SKU で並ぶ。
        // 在庫・原価・ロイヤリティはこの記録を見る。
        // 一方、**得意先に出す納品書と請求は受注明細から作る**（reports/billing）。
        // ここには送料・値引のような在庫を持たない行は入らないので、
        // この表を売った内容として使ってはいけない。
        lineNo += 1;
        await trx
          .insertInto('shipment_lines')
          .values({
            shipment_id: shipmentId,
            line_no: lineNo,
            sales_order_line_id: alloc.line_id,
            sku_id: alloc.sku_id,
            item_name: alloc.item_name,
            qty: alloc.qty,
            unit_price: alloc.unit_price,
            tax_rate: alloc.tax_rate,
            amount: sql<string>`${alloc.qty}::numeric * ${alloc.unit_price}::numeric`,
            created_by: userId,
          })
          .execute();
      }

      await trx
        .updateTable('shipments')
        .set({
          status: '出荷済',
          ship_date: shipDate ?? sql<string>`current_date`,
          updated_by: userId,
          updated_at: new Date(),
        })
        .where('id', '=', shipmentId)
        .execute();

      await trx
        .updateTable('sales_orders')
        .set({ status: '出荷済', updated_by: userId, updated_at: new Date() })
        .where('id', '=', shipment.sales_order_id)
        .execute();

      return {
        shipment_id: shipmentId,
        shipment_no: shipment.shipment_no,
        status: '出荷済',
        lines: lineNo,
      };
    }
  }

  /**
   * 出荷確定の取消（9/15 ご確認③「出荷確定後でも内容を変更できること」）。
   *
   * 確定した内容をその場で書き換えるのではなく、いったん確定前に戻す。
   * 実在庫と引当済を同じ数だけ戻し（有効在庫は動かない）、出荷明細を消し、
   * 受注を修正できる状態にする。在庫移動履歴には「出荷取消」として残るので、
   * 取消と再確定の両方があとから追える。
   * 締め処理で請求に含めたあとは取り消せない（締めを取り直すか返品で扱う）。
   */
  async unconfirm(shipmentId: number, userId: number) {
    return this.db.transaction().execute(async (trx) => {
      const shipment = await trx
        .selectFrom('shipments')
        .select(['id', 'shipment_no', 'status', 'sales_order_id'])
        .where('id', '=', shipmentId)
        .forUpdate()
        .executeTakeFirst();

      if (!shipment) throw new NotFoundException(`出荷が見つかりません（ID: ${shipmentId}）`);
      if (shipment.status !== '出荷済') {
        throw new ConflictException(`この出荷は「${shipment.status}」です。取り消す出荷確定がありません`);
      }
      if (!shipment.sales_order_id) throw new ConflictException('受注に紐づいていない出荷です');

      // 取消にした請求は履歴として残るだけなので数えない。
      // 数えてしまうと、取り消した請求に載っている出荷をいつまでも取り消せなくなる。
      const invoiced = await trx
        .selectFrom('invoice_lines as il')
        .innerJoin('invoices as i', 'i.id', 'il.invoice_id')
        .select('il.id')
        .where('il.shipment_id', '=', shipmentId)
        .where('i.status', '<>', '取消')
        .executeTakeFirst();
      if (invoiced) {
        throw new ConflictException(
          'この出荷はすでに請求に含まれています。締めを取り直すか、返品として処理してください',
        );
      }

      const allocations = await trx
        .selectFrom('allocations as a')
        .innerJoin('sales_order_lines as l', 'l.id', 'a.sales_order_line_id')
        .select(['a.id as id', 'a.stock_id as stock_id', 'a.qty as qty'])
        .where('l.sales_order_id', '=', shipment.sales_order_id)
        .where('a.status', '=', '出荷済')
        .execute();

      for (const alloc of allocations) {
        const before = await trx
          .selectFrom('stocks')
          .select('qty_on_hand')
          .where('id', '=', alloc.stock_id)
          .executeTakeFirstOrThrow();

        // 実在庫と引当済を同じ数だけ戻す。押さえた状態（確定前）に戻る。
        await trx
          .updateTable('stocks')
          .set({
            qty_on_hand: sql<string>`qty_on_hand + ${alloc.qty}::numeric`,
            qty_allocated: sql<string>`qty_allocated + ${alloc.qty}::numeric`,
            updated_by: userId,
            updated_at: new Date(),
          })
          .where('id', '=', alloc.stock_id)
          .execute();

        await trx
          .updateTable('allocations')
          .set({ status: '引当中', updated_by: userId, updated_at: new Date() })
          .where('id', '=', alloc.id)
          .execute();

        await trx
          .insertInto('stock_movements')
          .values({
            stock_id: alloc.stock_id,
            movement_type: '出荷取消',
            ref_table: 'shipments',
            ref_id: shipmentId,
            qty: alloc.qty,
            qty_before: before.qty_on_hand,
            qty_after: sql<string>`${before.qty_on_hand}::numeric + ${alloc.qty}::numeric`,
            created_by: userId,
          })
          .execute();
      }

      await trx.deleteFrom('shipment_lines').where('shipment_id', '=', shipmentId).execute();

      await trx
        .updateTable('shipments')
        .set({ status: '確定済', ship_date: null, updated_by: userId, updated_at: new Date() })
        .where('id', '=', shipmentId)
        .execute();

      const timing = await this.settings.allocationTiming();
      const orderStatus = timing === 'order_entry' ? '引当済' : '出荷指示済';
      await trx
        .updateTable('sales_orders')
        .set({ status: orderStatus, updated_by: userId, updated_at: new Date() })
        .where('id', '=', shipment.sales_order_id)
        .execute();

      return {
        shipment_id: shipmentId,
        shipment_no: shipment.shipment_no,
        status: '確定済',
        order_status: orderStatus,
        restored: allocations.length,
      };
    });
  }

  /**
   * 同梱。複数の出荷を1つの箱にまとめる。
   *
   * 通販では同じ住所あての受注が別々に立つことがあり、現行でも1箱で送っている。
   * まとめ先の出荷はそのまま残し、まとめられた側から `consolidated_to_shipment_id` で
   * まとめ先を指す。**受注も出荷も消さない。**あとから内訳をたどれる必要があるため。
   * 出荷指示番号は受注番号と同じものを使う決まりなので、ここでは採り直さない。
   */
  async consolidate(shipmentIds: number[], intoShipmentId: number, userId: number) {
    const targets = shipmentIds.filter((id) => id !== intoShipmentId);
    if (targets.length === 0) {
      throw new BadRequestException('まとめ先とは別の出荷を1件以上選んでください');
    }

    const ids = [...targets, intoShipmentId];

    return this.db.transaction().execute(async (trx) => {
      // 先に出荷の行だけを押さえる。外部結合を含んだまま FOR UPDATE を付けると、
      // 結合の外側（受注がない出荷）を掴めず PostgreSQL が断るため、2段に分ける。
      await trx.selectFrom('shipments').select('id').where('id', 'in', ids).forUpdate().execute();

      const rows = await trx
        .selectFrom('shipments as sh')
        .leftJoin('sales_orders as o', 'o.id', 'sh.sales_order_id')
        .select([
          'sh.id as id',
          'sh.shipment_no as shipment_no',
          'sh.status as status',
          'sh.warehouse_id as warehouse_id',
          'sh.consolidated_to_shipment_id as consolidated_to_shipment_id',
          'o.partner_id as partner_id',
          'o.delivery_destination_id as delivery_destination_id',
        ])
        .where('sh.id', 'in', ids)
        .execute();

      const into = rows.find((r) => r.id === intoShipmentId);
      if (!into) throw new NotFoundException(`まとめ先の出荷が見つかりません（ID: ${intoShipmentId}）`);
      if (rows.length !== targets.length + 1) {
        throw new NotFoundException('選んだ出荷の中に見つからないものがあります');
      }

      for (const r of rows) {
        if (r.status === '出荷済') {
          throw new ConflictException(`${r.shipment_no} はすでに出荷済みです`);
        }
        if (r.status === '削除') {
          throw new ConflictException(`${r.shipment_no} は取り消された出荷です`);
        }
        if (r.warehouse_id !== into.warehouse_id) {
          throw new ConflictException(`${r.shipment_no} は出荷倉庫が違うため同梱できません`);
        }
        if (r.partner_id !== into.partner_id) {
          throw new ConflictException(`${r.shipment_no} は得意先が違うため同梱できません`);
        }
        if (r.delivery_destination_id !== into.delivery_destination_id) {
          throw new ConflictException(`${r.shipment_no} は納品先が違うため同梱できません`);
        }
      }
      if (into.consolidated_to_shipment_id !== null) {
        throw new ConflictException('まとめ先がすでに別の出荷に同梱されています');
      }

      await trx
        .updateTable('shipments')
        .set({
          consolidated_to_shipment_id: intoShipmentId,
          updated_by: userId,
          updated_at: new Date(),
        })
        .where('id', 'in', targets)
        .execute();

      return {
        into_shipment_id: intoShipmentId,
        into_shipment_no: into.shipment_no,
        consolidated: rows.filter((r) => r.id !== intoShipmentId).map((r) => ({
          shipment_id: r.id,
          shipment_no: r.shipment_no,
        })),
      };
    });
  }

  /** 同梱を解く。1件ずつ元に戻す。 */
  async unconsolidate(shipmentId: number, userId: number) {
    const row = await this.db
      .updateTable('shipments')
      .set({ consolidated_to_shipment_id: null, updated_by: userId, updated_at: new Date() })
      .where('id', '=', shipmentId)
      .where('status', '<>', '出荷済')
      .returning(['id', 'shipment_no'])
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException('出荷が見つからないか、すでに出荷済みのため解けません');
    }
    return { shipment_id: row.id, shipment_no: row.shipment_no, consolidated_to_shipment_id: null };
  }

  async findOne(id: number) {
    const shipment = await this.db
      .selectFrom('shipments as sh')
      .leftJoin('sales_orders as o', 'o.id', 'sh.sales_order_id')
      .leftJoin('partners as p', 'p.id', 'o.partner_id')
      .innerJoin('warehouses as w', 'w.id', 'sh.warehouse_id')
      .selectAll('sh')
      .select(['o.order_no as order_no', 'p.name1 as partner_name', 'w.short_name as warehouse_name'])
      .where('sh.id', '=', id)
      .executeTakeFirst();

    if (!shipment) throw new NotFoundException(`出荷が見つかりません（ID: ${id}）`);

    const lines = await this.db
      .selectFrom('shipment_lines as l')
      .leftJoin('skus as s', 's.id', 'l.sku_id')
      .select([
        'l.line_no as line_no',
        's.sku_code as sku_code',
        'l.item_name as item_name',
        'l.qty as qty',
        'l.unit_price as unit_price',
        'l.amount as amount',
      ])
      .where('l.shipment_id', '=', id)
      .orderBy('l.line_no', 'asc')
      .execute();

    return { ...shipment, lines };
  }
}
