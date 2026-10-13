import { BadRequestException, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { DB } from '../db/schema';

export type QualityCode = 'GOOD' | 'DEFECTIVE' | 'PENDING';
export type MovementType =
  | '入荷'
  | '出荷'
  | '出荷取消'
  | '引当'
  | '引当解除'
  | '返品入庫'
  | '再生'
  | '不良振替'
  | '倉庫間移動'
  | '棚卸調整'
  | '廃棄';

export interface StockKey {
  sku_id: number;
  warehouse_id: number;
  lot_no?: string | null;
  quality: QualityCode;
}

/**
 * 実在庫を動かす処理をここ1か所に集める。
 *
 * 在庫を増減する場所が散らばると、移動履歴を書き忘れた経路が必ず出る。
 * 入荷・返品入庫・在庫調整・廃棄は、すべてこのサービスを通す。
 * （引当と出荷確定は伝票の状態も同時に扱うため、それぞれの処理側に置いている）
 */
@Injectable()
export class StockLedgerService {
  async qualityCodeId(trx: Transaction<DB>, quality: QualityCode): Promise<number> {
    const row = await trx
      .selectFrom('codes as c')
      .innerJoin('code_categories as cc', 'cc.id', 'c.code_category_id')
      .select('c.id as id')
      .where('cc.code', '=', 'QUALITY_DIVISION')
      .where('c.code', '=', quality)
      .executeTakeFirst();

    if (!row) throw new BadRequestException(`品質区分「${quality}」が登録されていません`);
    return row.id;
  }

  /**
   * セット商品の SKU を入荷・在庫調整に入れさせない。
   *
   * セット商品は在庫を持たない（在庫表にも出さない）。入荷・調整でセット SKU の在庫を作ると、
   * 誰にも見えず引当にも使われない在庫ができる（2026-10-12 受入テスト）。
   * 「セット商品」にした商品の SKU と、セット登録（set_headers）にある SKU の両方を断る
   * （在庫表の除外・CSV 取込と同じ決め方）。文言は CSV 取込とそろえる。
   */
  async assertNoSetSkus(db: Kysely<DB>, lines: { line_no: number; sku_id: number }[]): Promise<void> {
    if (lines.length === 0) return;
    const sets = await db
      .selectFrom('skus as s')
      .innerJoin('products as p', 'p.id', 's.product_id')
      .select(['s.id as id', 's.sku_code as sku_code'])
      .where('s.id', 'in', [...new Set(lines.map((l) => l.sku_id))])
      // かっこで囲む（前の条件と and でつながるため。囲まないと or が全体に掛かる）
      .where(sql<boolean>`(p.is_set or exists (select 1 from set_headers sh where sh.sku_id = s.id))`)
      .execute();
    if (sets.length === 0) return;
    const messages = lines.flatMap((l) => {
      const hit = sets.find((s) => Number(s.id) === Number(l.sku_id));
      return hit ? [`${l.line_no}行目：商品コード「${hit.sku_code}」はセット商品です`] : [];
    });
    throw new BadRequestException(`${messages.join('／')}。セット商品は在庫を持たないため、構成品で入荷・調整してください`);
  }

  /**
   * 在庫の行を取り出す。無ければ 0 で作る。
   * 「在庫表にない新商品は入荷したら自動で表に現れる」という現行の動きに合わせる。
   */
  async findOrCreate(trx: Transaction<DB>, key: StockKey, userId: number): Promise<number> {
    const qualityId = await this.qualityCodeId(trx, key.quality);
    const lot = key.lot_no ?? '';

    const existing = await trx
      .selectFrom('stocks')
      .select('id')
      .where('sku_id', '=', key.sku_id)
      .where('warehouse_id', '=', key.warehouse_id)
      .where('lot_no', '=', lot)
      .where('quality_code_id', '=', qualityId)
      .forUpdate()
      .executeTakeFirst();

    if (existing) return existing.id;

    const created = await trx
      .insertInto('stocks')
      .values({
        sku_id: key.sku_id,
        warehouse_id: key.warehouse_id,
        lot_no: lot,
        quality_code_id: qualityId,
        qty_on_hand: '0',
        qty_allocated: '0',
        created_by: userId,
        updated_by: userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return created.id;
  }

  /**
   * 実在庫を増減し、移動履歴を残す。
   *
   * 減らす場合は引当済を下回らないことを確かめる。押さえてある分まで
   * 減らしてしまうと、有効在庫がマイナスになり CHECK 制約に弾かれる。
   * その前に、何が起きているか分かる言葉で止める。
   */
  async apply(
    trx: Transaction<DB>,
    stockId: number,
    delta: string,
    movementType: MovementType,
    ref: { table: string; id: number },
    userId: number,
    /**
     * 履歴の日付（YYYY-MM-DD）。入荷確定で、登録した入荷日を履歴の日付にするとき（在庫編 Z-14）。
     * 時刻は記録した時刻のままにする（同じ日の中の並びが記録の順になるように）。省略すると今。
     */
    movedOn?: string | null,
  ): Promise<void> {
    const before = await trx
      .selectFrom('stocks as s')
      .innerJoin('skus as sk', 'sk.id', 's.sku_id')
      .select(['s.qty_on_hand as qty_on_hand', 's.qty_allocated as qty_allocated', 'sk.sku_code as sku_code'])
      .where('s.id', '=', stockId)
      .executeTakeFirstOrThrow();

    const after = Number(before.qty_on_hand) + Number(delta);
    if (after < Number(before.qty_allocated)) {
      throw new BadRequestException(
        `${before.sku_code}：実在庫を ${after} にすると、押さえてある ${before.qty_allocated} を下回ります。先に引当を解除してください`,
      );
    }

    await trx
      .updateTable('stocks')
      .set({
        qty_on_hand: sql<string>`qty_on_hand + ${delta}::numeric`,
        updated_by: userId,
        updated_at: new Date(),
      })
      .where('id', '=', stockId)
      .execute();

    await trx
      .insertInto('stock_movements')
      .values({
        stock_id: stockId,
        movement_type: movementType,
        ref_table: ref.table,
        ref_id: ref.id,
        qty: delta,
        qty_before: before.qty_on_hand,
        qty_after: String(after),
        ...(movedOn
          ? { moved_at: sql<Date>`(${movedOn}::date + (now() at time zone 'Asia/Tokyo')::time) at time zone 'Asia/Tokyo'` }
          : {}),
        created_by: userId,
      })
      .execute();
  }
}
