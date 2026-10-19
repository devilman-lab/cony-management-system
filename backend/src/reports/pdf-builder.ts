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
    // 書体の登録は、名前が合わないと **status を持たない素の Error** を投げる
    // （Not a supported font format or standard PDF font.）。そのまま上げると
    // 500「処理中に問題が起きました」になり、原因が分からなくなる。
    // ここで受け止めて、何が起きたのか読める 503 に変える。
    try {
      this.doc.registerFont(JP, font.path, font.family);
      this.doc.font(JP);
    } catch (e) {
      throw new ServiceUnavailableException(
        `帳票に使う日本語フォントを読み込めませんでした（${font.path}` +
          `${font.family ? ` / ${font.family}` : ''}）。` +
          'サーバーの .env の PDF_FONT_PATH と PDF_FONT_FAMILY をご確認ください。' +
          `（${e instanceof Error ? e.message : String(e)}）`,
      );
    }

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

  /**
   * 「ラベル：値」を1行ずつ。左右2段組み。
   *
   * 長い得意先名などは欄の中で折り返す。以前は段の高さが 15pt 固定だったため、
   * 折り返した2行目が次の段（出荷倉庫・納品先No など）に重なって読めなかった
   * （2026-10-12 受入テスト）。段ごとに、左右で高いほうの文字の高さだけ下げる。
   */
  keyValues(rows: [string, string][], columns = 2): void {
    const colWidth = CONTENT_WIDTH / columns;
    const lineHeight = 15;
    this.doc.fontSize(9);

    for (let start = 0; start < rows.length; start += columns) {
      const cells = rows.slice(start, start + columns).map(([label, value]) => `${label}：${value}`);
      const height = Math.max(
        lineHeight,
        ...cells.map((t) => Math.ceil(this.doc.heightOfString(t, { width: colWidth - 8 })) + 3),
      );
      if (this.doc.y + height > this.bottom) this.newPage();
      const y = this.doc.y;
      cells.forEach((text, col) => {
        this.doc.text(text, MARGIN + col * colWidth, y, { width: colWidth - 8 });
      });
      this.doc.y = y + height;
    }
    this.doc.y += 6;
  }

  /**
   * 見出しつきの文章（作業指示の本文など）。見出しの右に本文を折り返して全文出し、
   * 2行目以降も本文の左端にそろえる。高さは本文の長さで決まる。
   */
  labeled(label: string, text: string, labelWidth = 54, size = 9): void {
    this.doc.fontSize(size);
    const width = CONTENT_WIDTH - labelWidth;
    const height = Math.ceil(this.doc.heightOfString(text || ' ', { width })) + 2;
    if (this.doc.y + height > this.bottom) this.newPage();
    const y = this.doc.y;
    this.doc.text(label, MARGIN, y, { width: labelWidth, lineBreak: false });
    this.doc.text(text, MARGIN + labelWidth, y, { width });
    this.doc.y = y + height;
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
    this.tableHeader(columns);

    for (const row of rows) {
      // 行の高さは、いちばん長く折り返すセルで決まる（長い品名は2〜3行になる）
      const height = this.rowHeight(columns, row, 9);
      if (this.doc.y + height > this.bottom - 40) {
        this.newPage();
        this.tableHeader(columns);
      }
      this.tableRow(columns, row, 9, height);
    }
    this.rule();
  }

  /**
   * 合計欄など、表のあとに右寄せで並べる。
   * labelWidth は項目名の欄の幅（既定 120pt）。長い項目名（「未計上（免税（税抜扱い））」など）は広げて1行に収める
   */
  totals(rows: [string, string][], labelWidth = 120): void {
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

  /**
   * 見出しの行。
   *
   * **見出しは列の揃え方にそのまま従わせる。**以前はここで中央を強制していたため、
   * 左寄せの列（品名など）は見出しだけ右にずれ、右寄せの列（数量・金額）は
   * 見出しだけ左にずれて、どの値がどの見出しのものか読み取りづらくなっていた。
   */
  private tableHeader(columns: Column[]): void {
    this.rule();
    const labels = columns.map((c) => c.label);
    this.tableRow(columns, labels, 9, this.rowHeight(columns, labels, 9));
    this.rule();
  }

  /**
   * 1行の高さ。1行に収まれば今までどおり 16pt、折り返すセルがあれば、
   * その文字の高さ＋上下の余白（3pt ずつ）まで広げる。
   *
   * 以前は 16pt 固定で、欄に入りきらない品名が折り返して次の行や
   * 「合計数量」「小計」に重なり、読めなかった（2026-10-12 受入テスト M-10）。
   * SKU の商品名＋カラー＋サイズを品名にしたことで、長い品名が普通に出るようになっている。
   */
  private rowHeight(columns: Column[], row: Cell[], size: number): number {
    this.doc.fontSize(size);
    let text = 0;
    columns.forEach((col, i) => {
      const value = cellText(row[i]);
      if (value === '') return;
      text = Math.max(text, this.doc.heightOfString(value, { width: col.width - 4, align: col.align ?? 'left' }));
    });
    return Math.max(16, Math.ceil(text) + 6);
  }

  private tableRow(columns: Column[], row: Cell[], size: number, height: number): void {
    const y = this.doc.y;
    let x = MARGIN;
    this.doc.fontSize(size);

    columns.forEach((col, i) => {
      // 折り返して全文を出す（末尾を「…」で切ると、SKU ごとの違い（(W)・キャップ付など）が読めない）
      this.doc.text(cellText(row[i]), x + 2, y + 3, {
        width: col.width - 4,
        align: col.align ?? 'left',
      });
      x += col.width;
    });

    this.doc.y = y + height;
  }
}

function cellText(value: Cell): string {
  return value === null || value === undefined ? '' : String(value);
}
