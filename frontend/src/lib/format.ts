/** 表示用の整形。API は金額・数量を文字列で返すので、ここで見た目に直す。 */

export function money(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString('ja-JP', { maximumFractionDigits: 0 });
}

/**
 * 通貨つきの金額（2026-10-12 受入テスト No.39「売上仕入用の通貨」）。
 * 円（JPY・空）は今までどおり整数で、外貨は小数2桁で出す。帳票（backend/src/common/currency.ts）と同じ見せ方。
 */
export function isYen(currency: string | null | undefined): boolean {
  return !currency || currency === 'JPY';
}

/** 金額だけ（通貨の文字なし）。表の列のように、見出しや隣の欄で通貨が分かる所に使う。 */
export function moneyIn(v: string | number | null | undefined, currency: string | null | undefined): string {
  if (isYen(currency)) return money(v);
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 一覧の金額の欄。円は今までどおり数字だけ、外貨は「USD 12.50」（円の行と見分けがつくように）。 */
export function moneyCell(v: string | number | null | undefined, currency: string | null | undefined): string {
  const s = moneyIn(v, currency);
  return s === '' || isYen(currency) ? s : `${currency} ${s}`;
}

/** 単位つき。円は「1,000 円」、外貨は「USD 12.50」。 */
export function moneyWithCurrency(v: string | number | null | undefined, currency: string | null | undefined): string {
  const s = moneyIn(v, currency);
  if (s === '') return '';
  return isYen(currency) ? `${s} 円` : `${currency} ${s}`;
}

/**
 * 通貨ごとの合計。外貨を円の合計に黙って足さないため、一覧の合計はこれで出す。
 * 円を先に、あとは通貨コード順。
 */
export function sumByCurrency<T>(
  rows: T[],
  amount: (r: T) => string | number | null | undefined,
  currency: (r: T) => string | null | undefined,
): { currency: string; total: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const c = currency(r) || 'JPY';
    m.set(c, (m.get(c) ?? 0) + Number(amount(r) ?? 0));
  }
  return [...m.entries()]
    .map(([c, total]) => ({ currency: c, total }))
    .sort((a, b) => (a.currency === 'JPY' ? -1 : b.currency === 'JPY' ? 1 : a.currency.localeCompare(b.currency)));
}

/** 通貨ごとの合計を1行の文字にする（例「1,000 円 ／ USD 12.50」）。 */
export function formatTotals(totals: { currency: string; total: number }[]): string {
  if (totals.length === 0) return moneyWithCurrency(0, 'JPY');
  return totals.map((t) => moneyWithCurrency(t.total, t.currency)).join(' ／ ');
}

export function qty(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString('ja-JP', { maximumFractionDigits: 2 });
}

/**
 * NUMERIC の "12.5000" を入力欄に入れる形 "12.5" にする（桁区切りは付けない。数値には通さないので桁落ちしない）。
 */
export function plainDecimal(v: string | null | undefined): string {
  return (v ?? '').replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

/** YYYY-MM-DD → YYYY/MM/DD。日時（ISO）なら日付部分だけ。 */
export function ymd(v: string | null | undefined): string {
  if (!v) return '';
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.replace(/-/g, '/') : s;
}

export function ymdhm(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 今日を YYYY-MM-DD で（端末の時刻） */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function thisMonth(): string {
  return today().slice(0, 7);
}

export function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 受注・出荷の状態に応じたバッジの色。 */
export function statusTone(status: string | null | undefined): string {
  switch (status) {
    case '未確定':
    case '未発行':
    case '指示':
      return 'bg-[#f4f7f8] text-[var(--color-ink-2)] border border-[var(--color-line)]';
    case '引当待ち':
      return 'bg-[#fbf3e2] text-[#7a5407] border border-[#e8c88a]';
    case '引当済':
    case '出荷指示済':
    case '確定済':
      return 'bg-[var(--color-brand-50)] text-[var(--color-brand-700)] border border-[#bcd2dc]';
    case '出荷済':
    case '発行済':
    case '入荷済':
    case '確定':
    case '変換済':
      return 'bg-[#e8f4ee] text-[#1f6b45] border border-[#bfe0cc]';
    case '取消':
    case '削除':
    case 'エラー':
      return 'bg-[var(--color-crit-50)] text-[var(--color-crit-500)] border border-[#e8b4a8]';
    default:
      return 'bg-[#f4f7f8] text-[var(--color-ink-2)] border border-[var(--color-line)]';
  }
}
