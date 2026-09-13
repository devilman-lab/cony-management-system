import { ServiceUnavailableException } from '@nestjs/common';
import PDFDocument from 'pdfkit';

import { FONT_MISSING_MESSAGE, findJapaneseFont } from './pdf-font';

export const JP = 'jp';

export interface Column {
  /** 見出し。 */
  label: string;
  /** 列幅（pt）。 */
  width: number;
  align?: 'left' | 'right' | 'center';
}

export type Cell = string | number | null | undefined;

const A4_WIDTH = 595.28;
const MARGIN = 36;
export const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;

/** 数量。小数が付かないものは整数で出す（12.00 → 12）。 */
export function qty(value: Cell): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  return n % 1 === 0 ? n.toLocaleString('ja-JP') : n.toLocaleString('ja-JP');
}

/** 金額。円単位で三桁区切り。 */
export function money(value: Cell): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  return n.toLocaleString('ja-JP', { maximumFractionDigits: 0 });
}

/**
 * 日付。DATE は文字列で来るので、そのまま年月日に直す（時差でずらさない）。
 * TIMESTAMPTZ は Date で来るため、そのときだけ現地時刻の年月日にする。
 */
export function ymd(value: Cell | Date): string {
  if (!value) return '';
  const s =
    value instanceof Date
      ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(
          value.getDate(),
        ).padStart(2, '0')}`
      : String(value).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : s;
}

/**
 * 帳票1本分の PDF を組み立てる。
 *
 * 業務の帳票は「表が続いて、入りきらなければ次ページに見出しごと繰り越す」だけで
 * ほぼ足りる。pdfkit を直接触ると毎回同じ座標計算を書くことになるため、
 * その部分だけをここに集めている。
 */
export class ReportDoc {
  readonly doc: PDFKit.PDFDocument;
  private readonly chunks: Buffer[] = [];
  private readonly done: Promise<Buffer>;

  constructor(title: string) {
    const font = findJapaneseFont();
    if (!font) throw new ServiceUnavailableException(FONT_MISSING_MESSAGE);

    this.doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      info: { Title: title },
      autoFirstPage: true,
    });
    this.doc.registerFont(JP, font.path, font.family);
    this.doc.font(JP);

    this.done = new Promise<Buffer>((resolve, reject) => {
      this.doc.on('data', (c: Buffer) => this.chunks.push(c));
      this.doc.on('end', () => resolve(Buffer.concat(this.chunks)));
      this.doc.on('error', reject);
    });
  }

  get y(): number {
    return this.doc.y;
  }
  set y(value: number) {
    this.doc.y = value;
  }
  get bottom(): number {
    return this.doc.page.height - MARGIN;
  }
  get left(): number {
    return MARGIN;
  }

  newPage(): void {
    this.doc.addPage();
  }

  /** 帳票名を中央に大きく。 */
  title(text: string): void {
    this.doc.fontSize(18).text(text, MARGIN, this.doc.y, { width: CONTENT_WIDTH, align: 'center' });
    this.doc.moveDown(0.6);
  }

  /** 「ラベル：値」を1行ずつ。左右2段組み。 */
  keyValues(rows: [string, string][], columns = 2): void {
    const colWidth = CONTENT_WIDTH / columns;
    const lineHeight = 15;
    const startY = this.doc.y;
    this.doc.fontSize(9);

    rows.forEach(([label, value], i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const x = MARGIN + col * colWidth;
      const y = startY + row * lineHeight;
      this.doc.text(`${label}：${value}`, x, y, { width: colWidth - 8, lineBreak: false });
    });

    const lines = Math.ceil(rows.length / columns);
    this.doc.y = startY + lines * lineHeight + 6;
  }

  /** 左寄せの1行。 */
  line(text: string, size = 9): void {
    this.doc.fontSize(size).text(text, MARGIN, this.doc.y, { width: CONTENT_WIDTH });
    this.doc.moveDown(0.2);
  }

  rule(): void {
    const y = this.doc.y;
    this.doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_WIDTH, y).lineWidth(0.7).stroke();
    this.doc.y = y + 4;
  }

  /**
   * 明細表。行が入りきらなければ改ページして見出しを引き直す。
   * 罫線は上下と見出しの下だけにしてある（頂いた帳票サンプルに合わせた）。
   */
  table(columns: Column[], rows: Cell[][]): void {
    const rowHeight = 16;
    this.tableHeader(columns);

    for (const row of rows) {
      if (this.doc.y + rowHeight > this.bottom - 40) {
        this.newPage();
        this.tableHeader(columns);
      }
      this.tableRow(columns, row, 9);
    }
    this.rule();
  }

  /** 合計欄など、表のあとに右寄せで並べる。 */
  totals(rows: [string, string][]): void {
    const labelWidth = 120;
    const valueWidth = 110;
    const x = MARGIN + CONTENT_WIDTH - labelWidth - valueWidth;
    this.doc.fontSize(10);

    for (const [label, value] of rows) {
      if (this.doc.y + 18 > this.bottom) this.newPage();
      const y = this.doc.y;
      this.doc.text(label, x, y, { width: labelWidth, align: 'left', lineBreak: false });
      this.doc.text(value, x + labelWidth, y, { width: valueWidth, align: 'right', lineBreak: false });
      this.doc.y = y + 16;
    }
  }

  async finish(): Promise<Buffer> {
    this.doc.end();
    return this.done;
  }

  private tableHeader(columns: Column[]): void {
    this.rule();
    this.tableRow(columns, columns.map((c) => c.label), 9, 'center');
    this.rule();
  }

  private tableRow(columns: Column[], row: Cell[], size: number, forceAlign?: Column['align']): void {
    const y = this.doc.y;
    let x = MARGIN;
    this.doc.fontSize(size);

    columns.forEach((col, i) => {
      const text = row[i] === null || row[i] === undefined ? '' : String(row[i]);
      this.doc.text(text, x + 2, y + 3, {
        width: col.width - 4,
        align: forceAlign ?? col.align ?? 'left',
        lineBreak: false,
        ellipsis: true,
      });
      x += col.width;
    });

    this.doc.y = y + 16;
  }
}
