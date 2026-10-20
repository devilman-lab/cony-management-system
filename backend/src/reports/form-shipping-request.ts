import type { ReportDoc } from './pdf-builder';
import { FormPainter, LIGHT_GRAY, THICK } from './pdf-form';

/**
 * 出荷依頼書（2026-10-13 受注処理編 O-26。貴社の様式「出荷依頼書」どおり、A4 横）。
 * 1出荷1枚。明細は 11 行の枠で、12 行目からは次の紙に同じ見出しで続ける。
 */

export interface ShippingRequestLine {
  productCode: string;
  /** 明細の品名 */
  itemName: string;
  color: string;
  size: string;
  qty: string;
  /** 出荷依頼書適用（O-09） */
  note: string;
  /** 得意先別商品の出荷JAN、空ならコニーJAN */
  jan: string;
}

export interface ShippingRequestSheet {
  /** No.（コニー伝票No.＝出荷番号） */
  shipmentNo: string;
  /** 依頼日（印刷した日） */
  requestDate: string;
  /** 発注先（出荷倉庫） */
  warehouseName: string;
  isReturn: boolean;
  lines: ShippingRequestLine[];
  /** 出庫日（出荷日、無ければ出荷予定日） */
  shipDate: string;
  /** 納期（納品日）と時間（納品時間） */
  deliveryDate: string;
  deliveryTime: string;
  /** 入出荷先（納品先コード／得意先名） */
  destinationCode: string;
  partnerName: string;
  /** 〒・住所・納品先名（直送などはお届け先） */
  postalCode: string;
  address: string;
  recipientName: string;
  tel: string;
  /** 連絡事項（納品先の作業指示＝各社納品ルール） */
  instructions: string;
  /** 備考（出荷依頼書備考＝別途連絡事項） */
  remarks: string;
}

export const SHIPPING_REQUEST_ROWS = 11;

// 座標（pt）。様式の画像（1256×886px）の罫線を測り、0.671 倍して A4 横に置いた。
const L = 28;
const R = 814;
/** 物品内容の列の境目：No｜商品コード｜商品名｜カラー｜サイズ｜数量｜適用｜JAN */
const COL = [L, 58.5, 185.3, 437.3, 510.4, 557.4, 607.1, 696.3, R];
const TABLE_TOP = 111.2;
const HEAD_BOTTOM = 130;
const ROW_H = 18.49;
const TABLE_BOTTOM = HEAD_BOTTOM + ROW_H * SHIPPING_REQUEST_ROWS;
/** 出荷先の表：出庫日｜納期（日付｜時間）｜入出荷先｜〒・住所・納品先名（｜TEL） */
const SHIP = { top: 355.7, head: 381.6, mid: 407.1, bottom: 432 };
const SX = { date: 123.6, time: 206.2, dest: 290.4, addr: 437.6, tel: 648.7 };
const MEMO = { top: 445.7, bottom: 532.6, split: 511.8, right: 516.8 };
/** 押印欄：梱包｜セットアップ｜ピッキング */
const STAMP = { x: [679.5, 713.8, 765.4, R], top: 61, head: 71 };

export function drawShippingRequests(report: ReportDoc, sheets: ShippingRequestSheet[]): void {
  const paint = new FormPainter(report.doc);
  let first = true;
  for (const sheet of sheets) {
    const pages = Math.max(1, Math.ceil(sheet.lines.length / SHIPPING_REQUEST_ROWS));
    for (let page = 0; page < pages; page++) {
      if (!first) report.newPage();
      first = false;
      drawPage(paint, sheet, page, pages);
    }
  }
}

function drawPage(p: FormPainter, s: ShippingRequestSheet, page: number, pages: number): void {
  // ---- 上部：No.・題・依頼日・押印欄・発注先 ----
  p.box(L, 34, 64.9 - L, 16.5, { fill: LIGHT_GRAY, line: 0 });
  p.hline(L, 332.6, 50.5);
  p.box(64.9, 34, 332.6 - 64.9, 16.5);
  p.text('No.', L, 34, 64.9 - L, 16.5, { size: 7.5, padX: 3 });
  p.text(s.shipmentNo, 64.9, 34, 332.6 - 64.9, 16.5, { size: 12, align: 'center', maxLines: 1 });

  const title = '出荷依頼書';
  const titleW = p.measure(title, 15);
  const titleX = 478.6 - titleW / 2;
  p.label(title, titleX, 58.5, { size: 15, bold: true });
  // 返品の受注は題の横に添える（O-44）
  if (s.isReturn) p.label('（返品）', titleX + titleW + 3, 58.5, { size: 11, bold: true });

  p.label('依頼日', 691, 58.5, { size: 8.5 });
  p.text(s.requestDate, STAMP.x[1], 50.5, R - STAMP.x[1], 10, { size: 8.5, align: 'center', maxLines: 1 });

  const [s0, s1, s2, s3] = STAMP.x;
  p.box(s0, STAMP.top, s3 - s0, TABLE_TOP - STAMP.top);
  p.hline(s0, s3, STAMP.head);
  p.vline(s1, STAMP.top, TABLE_TOP);
  p.vline(s2, STAMP.top, TABLE_TOP);
  const stamp = { size: 7, align: 'center' as const, maxLines: 1, padX: 1, padY: 0 };
  p.text('梱包', s0, STAMP.top, s1 - s0, STAMP.head - STAMP.top, stamp);
  p.text('セットアップ', s1, STAMP.top, s2 - s1, STAMP.head - STAMP.top, stamp);
  p.text('ピッキング', s2, STAMP.top, s3 - s2, STAMP.head - STAMP.top, stamp);

  p.label('発注先：', 31, 82.3, { size: 8.5 });
  p.text(s.warehouseName, 82, 66, 291 - 82, 19, { size: 14, bold: true, valign: 'bottom', maxLines: 1, minSize: 7 });
  p.hline(28.7, 291, 86, 0.75);
  p.label('御中', 293.7, 82.3, { size: 10, bold: true });

  // ---- 物品内容 ----
  p.label('【物品内容】', 29, 108, { size: 8 });
  const head = { size: 11, maxLines: 1, padX: 3 };
  const headCells: [string, 'left' | 'center'][] = [
    ['', 'left'],
    ['商品コード', 'center'],
    ['商品名', 'center'],
    ['カラー', 'left'],
    ['サイズ', 'left'],
    ['数量', 'left'],
    ['適用', 'center'],
    ['JAN', 'center'],
  ];
  headCells.forEach(([label, align], i) =>
    p.text(label, COL[i], TABLE_TOP, COL[i + 1] - COL[i], HEAD_BOTTOM - TABLE_TOP, { ...head, align }),
  );

  const start = page * SHIPPING_REQUEST_ROWS;
  for (let i = 0; i < SHIPPING_REQUEST_ROWS; i++) {
    const y = HEAD_BOTTOM + ROW_H * i;
    const line = s.lines[start + i];
    p.text(String(start + i + 1), COL[0], y, COL[1] - COL[0], ROW_H, { size: 8, padX: 3, maxLines: 1 });
    if (!line) continue;
    const cell = (col: number, value: string, size: number, maxLines = 1) =>
      p.text(value, COL[col], y, COL[col + 1] - COL[col], ROW_H, { size, padX: 3, maxLines, minSize: 5.5 });
    cell(1, line.productCode, 11);
    cell(2, line.itemName, 11, 2);
    cell(3, line.color, 10.5, 2);
    cell(4, line.size, 10.5, 2);
    cell(5, line.qty, 11);
    cell(6, line.note, 9.5, 2);
    cell(7, line.jan, 10.5);
  }

  for (let i = 1; i < SHIPPING_REQUEST_ROWS; i++) p.hline(L, R, HEAD_BOTTOM + ROW_H * i);
  p.hline(L, R, HEAD_BOTTOM, 0.75);
  for (let c = 1; c < COL.length - 1; c++) p.vline(COL[c], TABLE_TOP, TABLE_BOTTOM);

  // ---- 出荷先 ----
  p.label('【出荷先】', 30.5, 352.7, { size: 8 });
  const label = { size: 9, align: 'center' as const, maxLines: 1 };
  p.text('出庫日', L, SHIP.top, SX.date - L, SHIP.head - SHIP.top, label);
  p.text('納期', SX.date, SHIP.top, SX.dest - SX.date, SHIP.head - SHIP.top, label);
  p.text('入出荷先', SX.dest, SHIP.top, SX.addr - SX.dest, SHIP.head - SHIP.top, label);
  p.text(`〒${s.postalCode}`, SX.addr, SHIP.top, R - SX.addr, SHIP.head - SHIP.top, { size: 9, valign: 'top', padX: 4, padY: 3, maxLines: 1 });

  const lowH = SHIP.bottom - SHIP.head;
  const bold = { bold: true, align: 'center' as const, minSize: 6 };
  p.text(s.shipDate, L, SHIP.head, SX.date - L, lowH, { ...bold, size: 13, maxLines: 1 });
  p.text(s.deliveryDate, SX.date, SHIP.head, SX.time - SX.date, lowH, { ...bold, size: 13, maxLines: 1 });
  p.text(s.deliveryTime, SX.time, SHIP.head, SX.dest - SX.time, lowH, { ...bold, size: 11, maxLines: 2 });
  p.text(s.destinationCode, SX.dest, SHIP.head, SX.addr - SX.dest, SHIP.mid - SHIP.head, { ...bold, size: 11, maxLines: 1 });
  p.text(s.partnerName, SX.dest, SHIP.mid, SX.addr - SX.dest, SHIP.bottom - SHIP.mid, { ...bold, size: 10.5, maxLines: 2 });
  const right = { padX: 4, minSize: 6 };
  p.text(s.address, SX.addr, SHIP.head, R - SX.addr, SHIP.mid - SHIP.head, { ...right, size: 11, maxLines: 2 });
  p.text(s.recipientName, SX.addr, SHIP.mid, SX.tel - SX.addr, SHIP.bottom - SHIP.mid, { ...right, size: 11, maxLines: 2 });
  if (s.tel) p.text(`TEL ${s.tel}`, SX.tel, SHIP.mid, R - SX.tel, SHIP.bottom - SHIP.mid, { ...right, size: 9.5, maxLines: 1 });

  p.hline(L, SX.addr, SHIP.head);
  p.hline(SX.dest, SX.addr, SHIP.mid);
  p.vline(SX.date, SHIP.top, SHIP.bottom);
  p.vline(SX.time, SHIP.head, SHIP.bottom);
  p.vline(SX.dest, SHIP.top, SHIP.bottom);
  p.vline(SX.addr, SHIP.top, SHIP.bottom);

  // 外枠（物品内容と出荷先を1つの太枠で囲む。様式どおり）
  p.hline(L, R, TABLE_TOP, THICK);
  p.hline(L, R, TABLE_BOTTOM, THICK);
  p.hline(L, R, SHIP.top, THICK);
  p.hline(L, R, SHIP.bottom, THICK);
  p.vline(L, TABLE_TOP, SHIP.bottom, THICK);
  p.vline(R, TABLE_TOP, SHIP.bottom, THICK);

  // ---- 連絡事項・備考 ----
  p.label('連絡事項', 30, 442.5, { size: 8.5, bold: true });
  p.label('備考', MEMO.right + 2.5, 442.5, { size: 8.5, bold: true });
  p.box(L, MEMO.top, MEMO.split - L, MEMO.bottom - MEMO.top, { line: THICK });
  p.box(MEMO.right, MEMO.top, R - MEMO.right, MEMO.bottom - MEMO.top, { line: THICK });
  const memo = { size: 11, valign: 'top' as const, padX: 4, padY: 3, maxLines: 12, minSize: 5.5 };
  p.text(s.instructions, L, MEMO.top, MEMO.split - L, MEMO.bottom - MEMO.top, memo);
  p.text(s.remarks, MEMO.right, MEMO.top, R - MEMO.right, MEMO.bottom - MEMO.top, memo);

  if (pages > 1) p.text(`${page + 1} / ${pages}`, R - 80, MEMO.bottom + 3, 80, 12, { size: 8, align: 'right', padX: 0 });
}
