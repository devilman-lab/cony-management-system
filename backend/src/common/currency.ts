/**
 * 金額に通貨を添えて見せるための決まり（2026-10-12 受入テスト No.39「売上仕入用の通貨」）。
 *
 * 円（JPY）は今までどおり整数で出し、帳票の見た目を変えない。
 * それ以外の通貨は小数2桁で出し、合計などには「USD 12.50」のように通貨コードを前に付ける。
 * 画面側（frontend/src/lib/format.ts の moneyIn・moneyWithCurrency）と同じ見せ方にしてある。
 */

type Amount = string | number | null | undefined;

/** 円か。通貨が空のもの（古いデータ）も円として扱う。 */
export function isYen(currency: string | null | undefined): boolean {
  return !currency || currency === 'JPY';
}

/**
 * 端数処理の桁（2026-10-13 再テスト N3）。円は1円単位、外貨は最小単位（セント＝小数2桁）。
 * USD 55.25 の 10% を 1ドル単位で切り捨てると 5.00 になってしまうため、外貨は 5.52 にする。
 */
export function currencyDigits(currency: string | null | undefined): number {
  return isYen(currency) ? 0 : 2;
}

/** 金額だけ（通貨コードなし）。表の中のように、見出しで通貨が分かる所に使う。 */
export function amountIn(value: Amount, currency: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  return isYen(currency)
    ? n.toLocaleString('ja-JP', { maximumFractionDigits: 0 })
    : n.toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 通貨コードつき。円は今までどおり数字だけ（帳票の見た目を変えない）、外貨は「USD 12.50」。 */
export function amountWithCode(value: Amount, currency: string | null | undefined): string {
  const s = amountIn(value, currency);
  if (s === '' || isYen(currency)) return s;
  return `${currency} ${s}`;
}
