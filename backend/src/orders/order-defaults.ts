import type { Transaction } from 'kysely';

import type { DB } from '../db/schema';

/**
 * 受注を作る入口（受注入力・販社CSV取込・通販取込）で共通に使う決まり。
 * 入口ごとに書くと、片方だけ直して片方が残る（2026-10-12 受入テスト No.5・M-02）。
 */

/**
 * 取引先の「既定の取引区分」→ 受注の取引条件。
 * 取引先の既定値には仕入先向けの「仕入」もあるが（1001 ご要望）、受注の取引条件は
 * 委託・買取の2つだけ（ck_so_trade）なので、委託以外は買取にする。
 */
export function orderTradeType(defaultTradeType: string | null | undefined): '委託' | '買取' {
  return defaultTradeType === '委託' ? '委託' : '買取';
}

/**
 * 海外の得意先（取引先マスタの「消費税免税区分」が「なし」以外）の受注明細の税率。
 * 請求（billing.service の締め）と同じく 0%。免税（税抜扱い）か課税対象外かは
 * 取引先の消費税免税区分（空ならシステム設定 OVERSEAS_TAX_TREATMENT）で決まり、
 * 帳票・画面の表記だけが変わる（2026-10-16 マスター編_3 M3-07）。
 */
export const OVERSEAS_TAX_RATE = '0.00';

/**
 * 取引先が海外か。見つからなければ国内として扱う。
 * 取引先が空の受注（サンプル・社内移動。2026-10-13 受注処理編）も国内として扱う。
 */
export async function isOverseasPartner(trx: Transaction<DB>, partnerId: number | null): Promise<boolean> {
  if (partnerId === null) return false;
  const p = await trx.selectFrom('partners').select('is_overseas').where('id', '=', partnerId).executeTakeFirst();
  return p?.is_overseas === true;
}
