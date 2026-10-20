import type { ReportDoc } from './pdf-builder';
import { FormPainter, LIGHT_GRAY, THICK } from './pdf-form';

/**
 * ピッキングリスト（2026-10-13 受注処理編 O-27。貴社の様式「ピッキングリスト」どおり、A4 横）。
 * 1出荷1枚。表は 20 行で、21 行目からは次の紙に同じ見出しで続ける。
 * 右上の「送り状No.・カートン数・サイズ」の枠は要らないとのことなので描かない。
 */

export interface PickingRow {
  /** 品名（SKU の名前＋カラー＋サイズ。O-01） */
  itemName: string;
  color: string;
  size: string;
  productCode: string;
  qty: string;
}

export interface PickingSheet {
  shipmentNo: string;
  /** 出庫（出荷倉庫） */
  warehouseName: string;
  deliveryDate: string;
  deliveryTime: string;
  partnerCode: string;
  partnerName: string;
  partnerTel: string;
  destinationCode: string;
  destinationName: string;
  /** 住所（〒つき） */
  address: string;
  /** 依頼日時（印刷した日時） */
  requestedAt: string;
  isReturn: boolean;
  rows: PickingRow[];
  /** 別途連絡事項（出荷依頼書の備考と同じ＝受注の出荷依頼書備考） */
  remarks: string;
}

export const PICKING_ROWS = 20;

// 座標（pt）。様式の画像（1251×885px）の罫線を測り、0.68 倍して A4 横に置いた。
/** 左上の表：見出し｜値。行は No.・出庫・納期・得意先・納品先・住所 */
const INFO = { x: 34, label: 93.8, rows: [26, 43, 60, 77, 94, 111, 128] };
/** 納期の日付｜時間の境目 */
const TIME_X = 166;
/** 明細の表：No｜商品名｜カラー｜サイズ｜商品コード｜数量｜（二重線）｜チェック */
const COL = [63.9, 93.8, 282.9, 387.3, 440.3, 547.7, 593.6];
const CHECK = { x: 595.7, right: 651.4 };
const TABLE_TOP = 145;
const HEAD_BOTTOM = 162;
const ROW_H = 17;
const TABLE_BOTTOM = HEAD_BOTTOM + ROW_H * PICKING_ROWS;
const MEMO_BOTTOM = TABLE_BOTTOM + 51;

export function drawPickingLists(report: ReportDoc, sheets: PickingSheet[]): void {
  const paint = new FormPainter(report.doc);
  let first = true;
  for (const sheet of sheets) {
    const pages = Math.max(1, Math.ceil(sheet.rows.length / PICKING_ROWS));
    for (let page = 0; page < pages; page++) {
      if (!first) report.newPage();
      first = false;
      drawPage(paint, sheet, page, pages);
    }
  }
}

function drawPage(p: FormPainter, s: PickingSheet, page: number, pages: number): void {
  // ---- 題・依頼日 ----
  const title = 'ピッキングリスト';
  const titleW = p.measure(title, 14.5);
  const titleX = 414.4 - titleW / 2;
  p.label(title, titleX, 43.5, { size: 14.5, bold: true });
  if (s.isReturn) p.label('（返品）', titleX + titleW + 3, 43.5, { size: 10.5, bold: true });
  const w = p.label('依頼日', 636.5, 38.5, { size: 9.5 });
  p.label(s.requestedAt, 636.5 + w + 6, 38.5, { size: 9.5 });

  // ---- 左上の表 ----
  const [y0, y1, y2, y3, y4, y5, y6] = INFO.rows;
  const lx = INFO.x;
  const vx = INFO.label;
  const right = [227.5, 227.5, 227.5, 433.8, 547.7, 547.7];
  INFO.rows.slice(0, 6).forEach((y, i) => p.box(lx, y, vx - lx, INFO.rows[i + 1] - y, { fill: LIGHT_GRAY, line: 0 }));
  p.box(227.5, y3, 268.9 - 227.5, y4 - y3, { fill: LIGHT_GRAY, line: 0 });

  const labels = ['No.', '出庫', '納期', '得意先', '納品先', '住所'];
  const cell = { size: 9, maxLines: 1, minSize: 5.5 };
  labels.forEach((t, i) => p.text(t, lx, INFO.rows[i], vx - lx, INFO.rows[i + 1] - INFO.rows[i], { ...cell, align: 'center' }));
  p.text(s.shipmentNo, vx, y0, 227.5 - vx, y1 - y0, { ...cell, align: 'center' });
  p.text(s.warehouseName, vx, y1, 227.5 - vx, y2 - y1, { ...cell, align: 'center' });
  // 納期の時間の欄は様式（AM）より少し広げる（納品時間「8:00〜12:00」が読める大きさで入るように）
  p.text(s.deliveryDate, vx, y2, TIME_X - vx, y3 - y2, { ...cell, align: 'center', bold: true });
  p.text(s.deliveryTime, TIME_X, y2, 227.5 - TIME_X, y3 - y2, { ...cell, size: 8.5, align: 'center', bold: true });
  p.text(s.partnerCode, vx, y3, 141.4 - vx, y4 - y3, { ...cell, padX: 4 });
  p.text(s.partnerName, 141.4, y3, 227.5 - 141.4, y4 - y3, { ...cell, align: 'center', maxLines: 2 });
  p.text('電話', 227.5, y3, 268.9 - 227.5, y4 - y3, { ...cell, align: 'center' });
  p.text(s.partnerTel, 268.9, y3, 433.8 - 268.9, y4 - y3, { ...cell, padX: 4 });
  p.text(s.destinationCode, vx, y4, 156.4 - vx, y5 - y4, { ...cell, align: 'center' });
  p.text(s.destinationName, 156.4, y4, 406 - 156.4, y5 - y4, { ...cell, padX: 3, maxLines: 2 });
  p.text(s.address, vx, y5, 547.7 - vx, y6 - y5, { ...cell, padX: 3, maxLines: 2 });

  // 罫線（様式どおり、行ごとに右端が違う）
  p.hline(lx, right[0], y0);
  for (let i = 1; i <= 6; i++) p.hline(lx, Math.max(right[i - 1], right[Math.min(i, 5)]), INFO.rows[i]);
  p.vline(lx, y0, y6);
  p.vline(vx, y0, y6);
  p.vline(227.5, y0, y4);
  p.vline(TIME_X, y2, y3);
  p.vline(268.9, y3, y4);
  p.vline(433.8, y3, y4);
  p.vline(406, y4, y5);
  p.vline(547.7, y4, y6);

  // ---- 明細の表 ----
  const head = { size: 8.5, maxLines: 1 };
  p.text('商品名', COL[0], TABLE_TOP, COL[2] - COL[0], HEAD_BOTTOM - TABLE_TOP, { ...head, align: 'center' });
  p.text('カラー', COL[2], TABLE_TOP, COL[3] - COL[2], HEAD_BOTTOM - TABLE_TOP, { ...head, padX: 12 });
  p.text('サイズ', COL[3], TABLE_TOP, COL[4] - COL[3], HEAD_BOTTOM - TABLE_TOP, { ...head, padX: 12 });
  p.text('商品コード', COL[4], TABLE_TOP, COL[5] - COL[4], HEAD_BOTTOM - TABLE_TOP, { ...head, align: 'center' });
  p.text('数量', COL[5], TABLE_TOP, COL[6] - COL[5], HEAD_BOTTOM - TABLE_TOP, { ...head, align: 'center' });
  p.text('チェック', CHECK.x, TABLE_TOP, CHECK.right - CHECK.x, HEAD_BOTTOM - TABLE_TOP, { ...head, align: 'center' });

  const start = page * PICKING_ROWS;
  const row = { size: 8.5, maxLines: 2, minSize: 5 };
  for (let i = 0; i < PICKING_ROWS; i++) {
    const y = HEAD_BOTTOM + ROW_H * i;
    p.text(String(start + i + 1), COL[0], y, COL[1] - COL[0], ROW_H, { ...row, align: 'center', maxLines: 1 });
    const r = s.rows[start + i];
    if (!r) continue;
    p.text(r.itemName, COL[1], y, COL[2] - COL[1], ROW_H, { ...row, padX: 8 });
    p.text(r.color, COL[2], y, COL[3] - COL[2], ROW_H, { ...row, padX: 12 });
    p.text(r.size, COL[3], y, COL[4] - COL[3], ROW_H, { ...row, padX: 12 });
    p.text(r.productCode, COL[4], y, COL[5] - COL[4], ROW_H, { ...row, align: 'center', maxLines: 1 });
    p.text(r.qty, COL[5], y, COL[6] - COL[5], ROW_H, { ...row, align: 'right', padX: 5, maxLines: 1 });
  }

  for (let i = 0; i < PICKING_ROWS; i++) p.hline(COL[0], CHECK.right, HEAD_BOTTOM + ROW_H * i);
  p.vline(COL[1], HEAD_BOTTOM, TABLE_BOTTOM);
  for (let c = 2; c < COL.length; c++) p.vline(COL[c], TABLE_TOP, TABLE_BOTTOM);
  p.vline(CHECK.x, TABLE_TOP, TABLE_BOTTOM);
  p.hline(COL[0], CHECK.right, TABLE_BOTTOM, 1);
  p.box(COL[0], TABLE_TOP, CHECK.right - COL[0], MEMO_BOTTOM - TABLE_TOP, { line: THICK });

  // ---- 別途連絡事項（出荷依頼書の備考と同じ内容） ----
  p.label('別途連絡事項', COL[0] + 3, TABLE_BOTTOM + 10, { size: 8 });
  p.text(s.remarks, COL[0], TABLE_BOTTOM + 11, CHECK.right - COL[0], MEMO_BOTTOM - TABLE_BOTTOM - 12, {
    size: 9,
    valign: 'top',
    padX: 3,
    maxLines: 4,
    minSize: 5.5,
  });

  if (pages > 1) p.text(`${page + 1} / ${pages}`, CHECK.right - 80, MEMO_BOTTOM + 3, 80, 12, { size: 8, align: 'right', padX: 0 });
}
