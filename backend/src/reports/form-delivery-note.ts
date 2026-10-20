import type { ReportDoc } from './pdf-builder';
import { FormPainter, GRAY, THICK, type TextStyle } from './pdf-form';

/**
 * 納品書（2026-10-13 受注処理編 O-28〜O-32。貴社の様式「単価なし」「単価あり2」「上代」どおり、A4 横）。
 * 上部（題・作成年月日と当社納品書No.・宛名・差出人・納品日と納品場所）は3様式で共通。
 * 明細は 11 行の枠で、12 行目からは次の紙に同じ見出しで続ける。
 */

export type DeliveryNoteForm = '単価あり2' | '上代あり' | '単価なし';

export interface DeliveryNoteRow {
  /** 先方発注番号（単価あり2） */
  poNo: string;
  /** JAN（単価なしの「コード」・単価あり2の「JANコード」） */
  jan: string;
  productCode: string;
  itemName: string;
  /** 納品書適用（単価なしは「備考」の列、単価あり2・上代は商品名の下に小さく。O-09） */
  note: string;
  qty: string;
  /** 単価（単価あり2）・上代（上代あり） */
  unitPrice: string;
  /** 金額（税抜） */
  amount: string;
  size: string;
  color: string;
}

/** 単価あり2 の上の合計。税率が混ざるときは 10%対象・8%対象・合計 の段に分ける（O-29） */
export interface DeliveryTotalRow {
  /** 段の名前。税率が1つなら null */
  label: string | null;
  excl: string;
  incl: string;
}

export interface DeliverySender {
  name: string;
  postalCode: string;
  address1: string;
  address2: string;
  contact: string;
  tel: string;
  fax: string;
  /** 適格請求書発行事業者の登録番号（あれば枠の中に） */
  invoiceNo: string;
}

export interface DeliveryNoteSheet {
  form: DeliveryNoteForm;
  /** 当社納品書No.（出荷番号） */
  noteNo: string;
  /** 作成年月日（印刷した日） */
  createdDate: string;
  /** 宛名（御中・様まで付けたもの） */
  addressee: string;
  sender: DeliverySender;
  deliveryDate: string;
  deliveryPlace: string;
  isReturn: boolean;
  rows: DeliveryNoteRow[];
  /** 単価あり2 の合計（ほかの様式は空） */
  totals: DeliveryTotalRow[];
  /** 「合計金額(税込)」。海外の得意先は「合計金額」 */
  inclLabel: string;
  /** 消費税の扱い・通貨（海外の得意先・外貨の受注だけ） */
  taxNotes: string[];
  /** 備考（受注の納品書備考） */
  remarks: string;
}

export const DELIVERY_NOTE_ROWS = 11;

// 座標（pt）。様式の画像の罫線を測って A4 横（幅 754pt）に置いた。
const L = 44;
const R = 798;
const RIGHT_TABLE = { x: [501, 642.5, R], y: [70, 89, 108] };
const SENDER = { x: 501, top: 138, bottom: 223 };
/** 下の「備考：」の枠。表のすぐ下（MEMO_GAP あけて）に置き、下端は MEMO_LIMIT まで */
const MEMO_H = 42;
const MEMO_GAP = 8;
const MEMO_LIMIT = 572;

interface Column {
  label: string;
  /** 左端（右端は次の列の左端、最後の列は R） */
  x: number;
  /** 見出しの字間 */
  spacing?: number;
  cell: (r: DeliveryNoteRow) => string;
  style: TextStyle;
  /** 商品名の欄：納品書適用を下に小さく添える */
  withNote?: boolean;
}

const left = (size: number, maxLines = 1): TextStyle => ({ size, padX: 3, maxLines, minSize: 5 });
const center = (size: number, maxLines = 1): TextStyle => ({ size, padX: 2, align: 'center', maxLines, minSize: 5 });
const right = (size: number): TextStyle => ({ size, padX: 4, align: 'right', maxLines: 1, minSize: 5 });

const COLUMNS: Record<DeliveryNoteForm, Column[]> = {
  単価なし: [
    { label: '備考', x: L, cell: (r) => r.note, style: left(8.5, 2) },
    { label: 'コード', x: 157.3, cell: (r) => r.jan, style: left(9) },
    { label: '商品コード', x: 261.2, cell: (r) => r.productCode, style: left(10) },
    { label: '商品名', x: 365.1, spacing: 16, cell: (r) => r.itemName, style: left(10, 2) },
    { label: '数量', x: 579.2, spacing: 4, cell: (r) => r.qty, style: right(10) },
    { label: 'サイズ', x: 642.5, cell: (r) => r.size, style: left(10, 2) },
    { label: 'カラー', x: 714.4, cell: (r) => r.color, style: left(10, 2) },
  ],
  単価あり2: [
    { label: '先方発注番号', x: L, cell: (r) => r.poNo, style: center(9, 2) },
    { label: 'JANコード', x: 144.8, cell: (r) => r.jan, style: center(8.5) },
    { label: '商品コード', x: 225.6, cell: (r) => r.productCode, style: center(8.5) },
    { label: '商品名', x: 305.7, spacing: 16, cell: (r) => r.itemName, style: center(10, 2), withNote: true },
    { label: '数量', x: 528.1, spacing: 4, cell: (r) => r.qty, style: center(10) },
    { label: '単価', x: 574.1, cell: (r) => r.unitPrice, style: center(10) },
    { label: '金額（税抜）', x: 663.8, cell: (r) => r.amount, style: center(10) },
  ],
  上代あり: [
    { label: '商品コード', x: L, cell: (r) => r.productCode, style: left(8.5) },
    { label: '商品名', x: 128.3, spacing: 16, cell: (r) => r.itemName, style: left(10, 2), withNote: true },
    { label: 'サイズ', x: 357, cell: (r) => r.size, style: center(10, 2) },
    { label: 'カラー', x: 427.2, cell: (r) => r.color, style: center(10, 2) },
    { label: '数量', x: 521, spacing: 4, cell: (r) => r.qty, style: right(10) },
    { label: '単価', x: 587.2, cell: (r) => r.unitPrice, style: right(10) },
    { label: '金額（税抜）', x: 681, cell: (r) => r.amount, style: right(10) },
  ],
};

/** 単価なし・上代あり の「納品日｜日付｜納品場所｜納品先名」の境目（それぞれの様式の画像から） */
const DATE_ROW: Record<'単価なし' | '上代あり', number[]> = {
  単価なし: [L, 157.3, 365.1, 463.6, R],
  上代あり: [L, 149.4, 316.4, 427.2, R],
};

export function drawDeliveryNotes(report: ReportDoc, sheets: DeliveryNoteSheet[]): void {
  const paint = new FormPainter(report.doc);
  let first = true;
  for (const sheet of sheets) {
    const pages = Math.max(1, Math.ceil(sheet.rows.length / DELIVERY_NOTE_ROWS));
    for (let page = 0; page < pages; page++) {
      if (!first) report.newPage();
      first = false;
      drawPage(paint, sheet, page, pages);
    }
  }
}

function drawPage(p: FormPainter, s: DeliveryNoteSheet, page: number, pages: number): void {
  drawHead(p, s);

  // ---- 合計（単価あり2）・納品日と納品場所 ----
  let y: number;
  if (s.form === '単価あり2') {
    y = drawTotals(p, s, SENDER.bottom + (s.totals.length > 1 ? 8 : 14));
    y += 4;
    const h = 24;
    labeledBox(p, [L, 124.8, 287.2], y, h, '納品日', s.deliveryDate);
    labeledBox(p, [325.7, 427.3, R], y, h, '納品場所', s.deliveryPlace);
    y += h + 7;
  } else {
    y = 248;
    const h = 26;
    const x = DATE_ROW[s.form];
    p.box(x[0], y, x[1] - x[0], h, { fill: GRAY, line: 0 });
    p.box(x[2], y, x[3] - x[2], h, { fill: GRAY, line: 0 });
    const v = { size: 11, align: 'center' as const, maxLines: 2, minSize: 6 };
    p.text('納品日', x[0], y, x[1] - x[0], h, v);
    p.text(s.deliveryDate, x[1], y, x[2] - x[1], h, v);
    p.text('納品場所', x[2], y, x[3] - x[2], h, v);
    p.text(s.deliveryPlace, x[3], y, x[4] - x[3], h, v);
    for (const vx of x.slice(1, -1)) p.vline(vx, y, y + h);
    p.box(L, y, R - L, h, { line: THICK });
    y += h + 7;
  }

  // ---- 明細 ----
  // 行の高さは様式どおり（18.9pt）。合計の段が増えて入りきらないときだけ詰める。備考の枠は表のすぐ下
  const columns = COLUMNS[s.form];
  const headH = s.form === '単価あり2' ? 22 : 24;
  const bodyTop = y + headH;
  const rowH = Math.min(18.9, (MEMO_LIMIT - MEMO_H - MEMO_GAP - bodyTop) / DELIVERY_NOTE_ROWS);
  const bottom = bodyTop + rowH * DELIVERY_NOTE_ROWS;
  const memoTop = bottom + MEMO_GAP;
  const xs = [...columns.map((c) => c.x), R];

  p.box(L, y, R - L, headH, { fill: GRAY, line: 0 });
  columns.forEach((c, i) =>
    p.text(c.label, xs[i], y, xs[i + 1] - xs[i], headH, { size: 9.5, align: 'center', maxLines: 1, spacing: c.spacing, minSize: 6 }),
  );

  const start = page * DELIVERY_NOTE_ROWS;
  for (let i = 0; i < DELIVERY_NOTE_ROWS; i++) {
    const r = s.rows[start + i];
    if (!r) continue;
    const ry = bodyTop + rowH * i;
    columns.forEach((c, ci) => {
      const x = xs[ci];
      const w = xs[ci + 1] - x;
      if (c.withNote && r.note) {
        // 納品書適用は商品名の下に小さく添える（様式に適用の列が無いため。O-09）
        const noteH = Math.min(7.2, rowH * 0.42);
        p.text(c.cell(r), x, ry, w, rowH - noteH, { ...c.style, valign: 'bottom', maxLines: 1, padY: 0 });
        p.text(r.note, x, ry + rowH - noteH, w, noteH, { ...c.style, size: 6, minSize: 4.5, valign: 'top', maxLines: 1, padY: 0 });
      } else {
        p.text(c.cell(r), x, ry, w, rowH, c.style);
      }
    });
  }

  for (let i = 1; i < DELIVERY_NOTE_ROWS; i++) p.hline(L, R, bodyTop + rowH * i);
  // 見出しの下は二重線（様式どおり）
  p.doubleH(L, R, bodyTop - 2, 2, 0.6);
  for (const vx of xs.slice(1, -1)) p.vline(vx, y, bottom);
  p.box(L, y, R - L, bottom - y, { line: THICK });

  // ---- 備考 ----
  p.box(L, memoTop, R - L, MEMO_H, { line: THICK });
  const labelW = p.label('備考：', L + 4, memoTop + 11, { size: 9.5 });
  p.text(s.remarks, L + 4 + labelW, memoTop + 2, R - L - 8 - labelW, MEMO_H - 4, {
    size: 9.5,
    valign: 'top',
    padX: 2,
    padY: 0,
    maxLines: 3,
    minSize: 5.5,
  });

  if (pages > 1) p.text(`${page + 1} / ${pages}`, R - 80, memoTop + MEMO_H + 3, 80, 12, { size: 8, align: 'right', padX: 0 });
}

/** 上部（3様式で共通）。題・右上の表・宛名・差出人・「下記の通り、納品いたします。」 */
function drawHead(p: FormPainter, s: DeliveryNoteSheet): void {
  p.doubleH(L, R, 20, 2.2, 0.6);
  const title = '納品書';
  const spacing = 13;
  const titleW = p.measure(title, 31, spacing);
  const titleX = 421 - titleW / 2;
  p.label(title, titleX, 52, { size: 31, spacing });
  // 返品の受注は題の横に「（返品）」を添える（O-44。数量・金額はマイナスのまま）
  if (s.isReturn) p.label('（返品）', titleX + titleW + 6, 51.6, { size: 14, bold: true });
  p.doubleH(L, R, 57.5, 2.2, 0.6);

  const [tx0, tx1, tx2] = RIGHT_TABLE.x;
  const [ty0, ty1, ty2] = RIGHT_TABLE.y;
  p.box(tx0, ty0, tx1 - tx0, ty2 - ty0, { fill: GRAY, line: 0 });
  const cell = { size: 9.5, align: 'center' as const, maxLines: 1, minSize: 6 };
  p.text('作成年月日', tx0, ty0, tx1 - tx0, ty1 - ty0, cell);
  p.text('当社納品書No.', tx0, ty1, tx1 - tx0, ty2 - ty1, cell);
  p.text(s.createdDate, tx1, ty0, tx2 - tx1, ty1 - ty0, cell);
  p.text(s.noteNo, tx1, ty1, tx2 - tx1, ty2 - ty1, cell);
  p.hline(tx0, tx2, ty1);
  p.vline(tx1, ty0, ty2);
  p.box(tx0, ty0, tx2 - tx0, ty2 - ty0, { line: THICK });

  // 宛名（二重の下線）
  // 長い宛名は折り返す前に1行のまま縮める（「御中」が次の行に分かれないように）
  p.text(s.addressee, 52, 110, 312, 23, { size: 15, valign: 'bottom', maxLines: 2, minSize: 7, oneLineMin: 8, padX: 0 });
  p.doubleH(45.6, 366, 134, 2.2, 0.6);

  // 差出人（システム設定の COMPANY_*）
  const c = s.sender;
  const sx = SENDER.x + 3;
  const sw = R - SENDER.x - 6;
  p.box(SENDER.x, SENDER.top, R - SENDER.x, SENDER.bottom - SENDER.top, { line: 0.75 });
  const regW = c.invoiceNo ? p.measure(`登録番号：${c.invoiceNo}`, 7.5) + 6 : 0;
  p.text(c.name, sx, 140, sw - regW, 15, { size: 11.5, bold: true, maxLines: 1, minSize: 7, padX: 0 });
  if (c.invoiceNo) p.text(`登録番号：${c.invoiceNo}`, sx, 140, sw, 15, { size: 7.5, align: 'right', maxLines: 1, padX: 0 });
  const line = { size: 9.5, maxLines: 1, minSize: 6, padX: 0 };
  const indent = 542;
  if (c.postalCode) {
    p.text(`住所：〒${c.postalCode}`, sx, 156, sw, 13, line);
    p.text(c.address1, indent, 169.5, R - indent - 3, 13, line);
    p.text(c.address2, indent, 183, R - indent - 3, 13, line);
  } else {
    p.text(`住所：${c.address1}`, sx, 156, sw, 13, line);
    p.text(c.address2, indent, 169.5, R - indent - 3, 13, line);
  }
  p.text(`担当：${c.contact}`, sx, 196.5, sw, 13, line);
  const tel = [c.tel ? `TEL：${c.tel}` : '', c.fax ? `FAX：${c.fax}` : ''].filter(Boolean).join('　　');
  p.text(tel, sx, 209.5, sw, 13, line);

  p.label('下記の通り、納品いたします。', 48.7, 208.5, { size: 9.5 });
}

/** 単価あり2 の合計の段。描いた下端の y を返す。 */
function drawTotals(p: FormPainter, s: DeliveryNoteSheet, top: number): number {
  const multi = s.totals.length > 1;
  const h = multi ? 18 : 24;
  const b1 = [285.7, 385.8, 508.9];
  const b2 = [527.4, 640.8, R];
  const labelX = 205.7;
  const v = { size: multi ? 9.5 : 10, align: 'center' as const, maxLines: 1, minSize: 6 };
  const rows = s.totals.length > 0 ? s.totals : [{ label: null, excl: '', incl: '' }];
  rows.forEach((t, i) => {
    const y = top + h * i;
    if (multi) {
      p.box(labelX, y, b1[0] - labelX, h, { fill: GRAY, line: 0 });
      p.text(t.label ?? '', labelX, y, b1[0] - labelX, h, v);
    }
    p.box(b1[0], y, b1[1] - b1[0], h, { fill: GRAY, line: 0 });
    p.box(b2[0], y, b2[1] - b2[0], h, { fill: GRAY, line: 0 });
    p.text('合計金額(税抜)', b1[0], y, b1[1] - b1[0], h, v);
    p.text(t.excl, b1[1], y, b1[2] - b1[1], h, v);
    p.text(s.inclLabel, b2[0], y, b2[1] - b2[0], h, v);
    p.text(t.incl, b2[1], y, b2[2] - b2[1], h, v);
    if (i > 0) {
      p.hline(multi ? labelX : b1[0], b1[2], y);
      p.hline(b2[0], b2[2], y);
    }
  });
  const bottom = top + h * rows.length;
  const x1 = multi ? labelX : b1[0];
  if (multi) p.vline(b1[0], top, bottom);
  p.vline(b1[1], top, bottom);
  p.vline(b2[1], top, bottom);
  p.box(x1, top, b1[2] - x1, bottom - top, { line: THICK });
  p.box(b2[0], top, b2[2] - b2[0], bottom - top, { line: THICK });

  // 消費税の扱い（海外の得意先）・通貨（外貨の受注）は合計の左に書く
  if (s.taxNotes.length > 0) {
    p.text(s.taxNotes.join('\n'), L, top, (multi ? labelX : b1[0]) - L - 6, bottom - top, {
      size: 8.5,
      maxLines: 3,
      minSize: 6,
      padX: 0,
    });
  }
  return bottom;
}

/** 見出し（網掛け）と値の2つの欄を太枠で囲む（単価あり2 の納品日・納品場所）。 */
function labeledBox(p: FormPainter, x: number[], y: number, h: number, label: string, value: string): void {
  p.box(x[0], y, x[1] - x[0], h, { fill: GRAY, line: 0 });
  const v = { size: 11, align: 'center' as const, maxLines: 2, minSize: 6 };
  p.text(label, x[0], y, x[1] - x[0], h, v);
  p.text(value, x[1], y, x[2] - x[1], h, v);
  p.vline(x[1], y, y + h);
  p.box(x[0], y, x[2] - x[0], h, { line: THICK });
}
