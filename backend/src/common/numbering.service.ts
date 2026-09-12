import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { Transaction } from 'kysely';

import type { DB } from '../db/schema';

export type NumberingTarget =
  | 'sales_order'
  | 'shipment'
  | 'receipt'
  | 'return'
  | 'invoice'
  | 'purchase'
  | 'cash_transaction'
  | 'delivery_code'
  | 'warehouse_code'
  | 'purchase_item'
  | 'stock_adjustment';

/**
 * 伝票番号の採番。
 *
 * numbering_rules の行を排他ロックしてから採番するため、同時に2人が登録しても
 * 同じ番号にならない。必ずトランザクションの中で呼ぶこと。
 *
 * 形式は 接頭辞 ＋ 年月（設定時のみ） ＋ 連番（ゼロ埋め）。
 *   sales_order : SO + 202609 + 00001  -> SO20260900001
 *   shipment    : D  +        + 0209475 -> D0209475（現行の伝票管理番号と同じ形）
 */
@Injectable()
export class NumberingService {
  async next(trx: Transaction<DB>, target: NumberingTarget, at: Date = new Date()): Promise<string> {
    const rule = await trx
      .selectFrom('numbering_rules')
      .selectAll()
      .where('target', '=', target)
      .forUpdate()
      .executeTakeFirst();

    if (!rule) {
      throw new InternalServerErrorException(`採番ルールが登録されていません（${target}）`);
    }

    const yyyy = String(at.getFullYear());
    const yyyymm = yyyy + String(at.getMonth() + 1).padStart(2, '0');

    // 年度・月が変わったら連番を 1 に戻す
    let resetKey: string | null = rule.last_reset_key;
    let seq = Number(rule.current_value) + 1;
    if (rule.reset_unit === 'month') {
      if (rule.last_reset_key !== yyyymm) {
        seq = 1;
        resetKey = yyyymm;
      }
    } else if (rule.reset_unit === 'year') {
      if (rule.last_reset_key !== yyyy) {
        seq = 1;
        resetKey = yyyy;
      }
    }

    await trx
      .updateTable('numbering_rules')
      .set({ current_value: seq, last_reset_key: resetKey, updated_at: new Date() })
      .where('id', '=', rule.id)
      .execute();

    const prefix = rule.prefix ?? '';
    const period = rule.use_yyyymm ? yyyymm : '';
    return `${prefix}${period}${String(seq).padStart(rule.seq_length, '0')}`;
  }
}
