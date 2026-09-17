/** 表示用の整形。API は金額・数量を文字列で返すので、ここで見た目に直す。 */

export function money(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString('ja-JP', { maximumFractionDigits: 0 });
}

export function qty(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString('ja-JP', { maximumFractionDigits: 2 });
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
