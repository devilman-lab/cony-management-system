// 在庫編フィードバック（2026-10-09、Z-02〜Z-24：在庫表・入荷登録・在庫調整）の回帰確認。
// smoke-backend.ps1 から呼ばれる想定（API・DB は smoke が立てた使い捨て環境）。
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は ZK（在庫）。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'package.json'));
const { Client } = require('pg');

const B = process.env.CONY_API ?? 'http://localhost:3011/api';
const PASS = process.env.CONY_PASS ?? 'SmokeTest123456';
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query('set search_path = cony');
const one = async (q, p = []) => (await db.query(q, p)).rows[0];
const all = async (q, p = []) => (await db.query(q, p)).rows;

let ng = 0;
const check = async (label, fn) => {
  try {
    const r = await fn();
    if (r === true) console.log(`OK\t${label}`);
    else { ng++; console.log(`NG\t${label}\t${typeof r === 'string' ? r : JSON.stringify(r)}`); }
  } catch (e) { ng++; console.log(`NG\t${label}\t${e.message}`); }
};
async function call(method, path, token, body) {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (id) => ok(await call('POST', '/auth/login', '', { login_id: id, password: PASS }), 'login').access_token;
const A = await login('admin');
const V = await login('viewer1');
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const t = String(Date.now()).slice(-6);

// ---- 準備（接頭辞 ZK） --------------------------------------------------------
// 入荷倉庫は略称「コニー倉庫」に決め打ち（Z-07）。初期データには無いので、無ければ作る。
let kony = await one(`select id from warehouses where short_name = 'コニー倉庫' and is_active order by id limit 1`);
if (!kony) {
  kony = await one(`insert into warehouses (warehouse_code, short_name, is_consignment) values ($1, 'コニー倉庫', false) returning id`, [`ZK${t}`]);
}
const WH = Number(kony.id);
const stockOf = async (skuId, quality = 'GOOD') =>
  one(
    `select s.id, s.qty_on_hand::text as on_hand, s.qty_allocated::text as allocated from stocks s join codes q on q.id = s.quality_code_id
      where s.sku_id = $1 and s.warehouse_id = $2 and s.lot_no = '' and q.code = $3`,
    [skuId, WH, quality],
  );
const movesOf = async (adjId) => Number((await one(`select count(*)::int as n from stock_movements where ref_table = 'stock_adjustments' and ref_id = $1`, [adjId])).n);

const pclass = ok(await call('POST', '/masters/simple/product_classes', A, { code: `ZKC${t}`, name: `ZK分類${t}` }), 'product class');
const product = ok(await call('POST', '/masters/products', A, { product_code: `ZK${t}`, product_name: `ZK商品${t}`, product_class_id: pclass.id, cost_price: '150' }), 'product');
const sku = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `ZK${t}-0102-100` }), 'sku');
const sku2 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `ZK${t}-0104-100` }), 'sku2');
// セット商品にも在庫の行がある状態を作る（過去に入荷して在庫表に出ていた、という顧客の画面と同じ）
const setProduct = ok(await call('POST', '/masters/products', A, { product_code: `ZKS${t}`, product_name: `ZKセット${t}`, is_set: true }), 'set product');
const setSku = ok(await call('POST', '/masters/skus', A, { product_id: setProduct.id, sku_code: `ZKS${t}-0102-200` }), 'set sku');
await db.query(
  `insert into stocks (sku_id, warehouse_id, lot_no, quality_code_id, qty_on_hand)
   select $1, $2, '', c.id, 5 from codes c join code_categories cc on cc.id = c.code_category_id where cc.code = 'QUALITY_DIVISION' and c.code = 'GOOD'`,
  [setSku.id, WH],
);

// ---- 入荷登録（Z-07・Z-12・Z-15・Z-16） -----------------------------------------
await check('Z-07 入荷倉庫は略称「コニー倉庫」の倉庫に決まる', async () => {
  const r = ok(await call('GET', '/inventory/receipt-warehouse', A), 'receipt-warehouse');
  return (r.id === WH && r.short_name === 'コニー倉庫') || r;
});

const rc = ok(await call('POST', '/inventory/receipts', A, {
  warehouse_id: WH, planned_date: today,
  lines: [{ line_no: 1, sku_id: sku.id, qty: '5', note: `備考A${t}` }],
}), 'receipt');
await check('Z-12 入荷明細の備考が保存され、詳細で返る', async () => {
  const d = ok(await call('GET', `/inventory/receipts/${rc.id}`, A), 'detail');
  const row = await one('select note from receipt_lines where receipt_id = $1 and line_no = 1', [rc.id]);
  return (d.lines[0]?.note === `備考A${t}` && row.note === `備考A${t}`) || { d: d.lines, row };
});
await check('Z-15 確定前の入荷は編集でき、明細も入れ替わる', async () => {
  ok(await call('PATCH', `/inventory/receipts/${rc.id}`, A, {
    note: `見出し${t}`,
    lines: [
      { line_no: 1, sku_id: sku.id, qty: '7', note: `備考B${t}` },
      { line_no: 2, sku_id: sku2.id, qty: '3' },
    ],
  }), 'patch');
  const h = await one('select note from receipts where id = $1', [rc.id]);
  const ls = await all('select sku_id, qty::text as qty, note from receipt_lines where receipt_id = $1 order by line_no', [rc.id]);
  return (h.note === `見出し${t}` && ls.length === 2 && Number(ls[0].qty) === 7 && ls[0].note === `備考B${t}` && Number(ls[1].sku_id) === sku2.id) || { h, ls };
});
await check('Z-15 編集で数量 0 の明細は断る', async () => {
  const r = await call('PATCH', `/inventory/receipts/${rc.id}`, A, { lines: [{ line_no: 1, sku_id: sku.id, qty: '0' }] });
  return r.status === 400 || r;
});
await check('Z-16 入荷の一覧が明細（商品コード・商品名・数量・備考）を付けて返す', async () => {
  const r = ok(await call('GET', '/inventory/receipts?limit=200', A), 'list');
  const mine = r.items.find((x) => x.id === rc.id);
  const l = mine?.lines?.[0];
  return (mine.lines.length === 2 && l.sku_code === sku.sku_code && l.product_name === `ZK商品${t}` && Number(l.qty) === 7 && l.note === `備考B${t}`) || mine;
});
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');
await check('Z-15 入荷確定後は編集できない（409）', async () => {
  const r = await call('PATCH', `/inventory/receipts/${rc.id}`, A, { note: 'x' });
  return r.status === 409 || r;
});
await check('閲覧者は入荷を編集できない（403）', async () => {
  const r = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: WH, planned_date: today, lines: [{ line_no: 1, sku_id: sku.id, qty: '1' }] }), 'receipt2');
  const p = await call('PATCH', `/inventory/receipts/${r.id}`, V, { note: 'x' });
  await call('POST', `/inventory/receipts/${r.id}/cancel`, A);
  return p.status === 403 || p;
});

// ---- 在庫表（Z-02〜Z-06） ---------------------------------------------------------
const stockRow = async (token, q = sku.sku_code) => {
  const r = ok(await call('GET', `/inventory/stocks?q=${encodeURIComponent(q)}&limit=200`, token), 'stocks');
  return r.items.find((x) => x.sku_code === q && x.warehouse_id === WH);
};
await check('Z-02 管理者には実在庫・引当済・有効在庫を返す', async () => {
  const s = await stockRow(A);
  return (s && Number(s.qty_on_hand) === 7 && 'qty_allocated' in s && Number(s.qty_available) === 7) || s;
});
await check('Z-02 閲覧者には有効在庫だけを返す（実在庫・引当済の項目が無い）', async () => {
  const s = await stockRow(V);
  return (s && !('qty_on_hand' in s) && !('qty_allocated' in s) && Number(s.qty_available) === 7) || s;
});
await check('Z-02 閲覧者には SKU 別の在庫でも実在庫・引当済を返さない', async () => {
  const r = ok(await call('GET', `/inventory/stocks/by-sku/${sku.id}`, V), 'by-sku');
  return (!('qty_on_hand' in r.total) && r.by_warehouse.every((w) => !('qty_on_hand' in w) && !('qty_allocated' in w))) || r;
});
await check('Z-03 セット商品の SKU は在庫の行があっても在庫表に出ない', async () => {
  const r = ok(await call('GET', `/inventory/stocks?q=${encodeURIComponent(setSku.sku_code)}`, A), 'stocks');
  return r.items.length === 0 || r.items;
});
await check('Z-04 分類コード・商品分類・原価（管理者）を返し、ロットは返さない', async () => {
  const s = await stockRow(A);
  return (s.product_class_code === `ZKC${t}` && s.product_class_name === `ZK分類${t}` && Number(s.cost_price) === 150 && !('lot_no' in s)) || s;
});
await check('Z-04 閲覧者には原価を返さない', async () => {
  const s = await stockRow(V);
  return !('cost_price' in s) || s;
});
await check('Z-04 商品名は SKU の商品名があればそれを返す', async () => {
  // SKU の商品名の入力画面はマスタ側の担当。ここでは DB に直接入れて、在庫表の出し方だけを見る
  await db.query('update skus set sku_name = $1 where id = $2', [`ZKのSKU名${t}`, sku.id]);
  const s = await stockRow(A);
  await db.query('update skus set sku_name = null where id = $1', [sku.id]);
  return s.product_name === `ZKのSKU名${t}` || s;
});
await check('Z-05 在庫表の備考を直せる（数量は変わらない）', async () => {
  const s = await stockRow(A);
  ok(await call('PATCH', `/inventory/stocks/${s.id}`, A, { note: `在庫備考${t}` }), 'patch note');
  const after = await stockRow(A);
  return (after.note === `在庫備考${t}` && after.qty_on_hand === s.qty_on_hand) || after;
});
await check('Z-05 閲覧者は在庫表の備考を直せない（403）', async () => {
  const s = await stockRow(A);
  const r = await call('PATCH', `/inventory/stocks/${s.id}`, V, { note: 'x' });
  return r.status === 403 || r;
});

// ---- 在庫調整（Z-20〜Z-23） -------------------------------------------------------
const adjBody = (lines, extra = {}) => ({ warehouse_id: WH, adjustment_date: today, reason_code: 'STOCKTAKE', lines, ...extra });
const adj = ok(await call('POST', '/inventory/adjustments', A, adjBody([{ line_no: 1, sku_id: sku.id, qty: '4' }])), 'adjustment');
await check('Z-20 登録しただけでは在庫が動かない（状態「登録」・移動履歴なし）', async () => {
  const h = await one('select status from stock_adjustments where id = $1', [adj.id]);
  const s = await stockOf(sku.id);
  return (h.status === '登録' && Number(s.on_hand) === 7 && (await movesOf(adj.id)) === 0) || { h, s };
});
await check('Z-23 登録のものは調整日・理由・備考を直せる', async () => {
  ok(await call('PATCH', `/inventory/adjustments/${adj.id}`, A, { adjustment_date: '2026-01-02', reason_code: 'DAMAGE', note: `調整備考${t}` }), 'patch');
  const h = await one(`select to_char(a.adjustment_date, 'YYYY-MM-DD') as d, c.code, a.note from stock_adjustments a join codes c on c.id = a.reason_code_id where a.id = $1`, [adj.id]);
  return (h.d === '2026-01-02' && h.code === 'DAMAGE' && h.note === `調整備考${t}`) || h;
});
await check('Z-21 編集で明細を入れ替えられる', async () => {
  ok(await call('PATCH', `/inventory/adjustments/${adj.id}`, A, { lines: [{ line_no: 1, sku_id: sku.id, qty: '3' }, { line_no: 2, sku_id: sku2.id, qty: '2' }] }), 'patch lines');
  const ls = await all('select qty::text as qty from stock_adjustment_lines where stock_adjustment_id = $1 order by line_no', [adj.id]);
  return (ls.length === 2 && Number(ls[0].qty) === 3) || ls;
});
await check('Z-22 一覧が明細（商品コード・商品名・数量）と状態を返す', async () => {
  const r = ok(await call('GET', '/inventory/adjustments?limit=200', A), 'list');
  const mine = r.items.find((x) => x.id === adj.id);
  return (mine.status === '登録' && mine.lines.length === 2 && mine.lines[0].sku_code === sku.sku_code && mine.lines[0].product_name === `ZK商品${t}` && Number(mine.lines[0].qty) === 3) || mine;
});
await check('閲覧者は「調整」できない（403）', async () => {
  const r = await call('POST', `/inventory/adjustments/${adj.id}/confirm`, V);
  return r.status === 403 || r;
});
await check('Z-21 「調整」で在庫が動き、状態が「確定」になる', async () => {
  ok(await call('POST', `/inventory/adjustments/${adj.id}/confirm`, A), 'confirm');
  const h = await one('select status from stock_adjustments where id = $1', [adj.id]);
  const s1 = await stockOf(sku.id);
  const s2 = await stockOf(sku2.id);
  return (h.status === '確定' && Number(s1.on_hand) === 10 && Number(s2.on_hand) === 5) || { h, s1, s2 };
});
await check('Z-21 確定したものに「調整」をもう一度押しても二重に動かない（409）', async () => {
  const r = await call('POST', `/inventory/adjustments/${adj.id}/confirm`, A);
  const s = await stockOf(sku.id);
  return (r.status === 409 && Number(s.on_hand) === 10) || { r, s };
});
await check('Z-21 確定したものは編集できない（409）', async () => {
  const r = await call('PATCH', `/inventory/adjustments/${adj.id}`, A, { note: 'x' });
  return r.status === 409 || r;
});
await check('Z-21 確定したものの取消は在庫を元に戻す', async () => {
  ok(await call('POST', `/inventory/adjustments/${adj.id}/cancel`, A), 'cancel');
  const h = await one('select status from stock_adjustments where id = $1', [adj.id]);
  const s1 = await stockOf(sku.id);
  const s2 = await stockOf(sku2.id);
  return (h.status === '取消' && Number(s1.on_hand) === 7 && Number(s2.on_hand) === 3) || { h, s1, s2 };
});
await check('Z-21 登録のものの取消は在庫を動かさない', async () => {
  const a = ok(await call('POST', '/inventory/adjustments', A, adjBody([{ line_no: 1, sku_id: sku.id, qty: '-2' }])), 'adj');
  ok(await call('POST', `/inventory/adjustments/${a.id}/cancel`, A), 'cancel');
  const h = await one('select status from stock_adjustments where id = $1', [a.id]);
  const s = await stockOf(sku.id);
  return (h.status === '取消' && Number(s.on_hand) === 7 && (await movesOf(a.id)) === 0) || { h, s };
});
await check('Z-21 戻すと引当済を下回るときは、理由の分かる言葉で取消を断る（在庫・状態はそのまま）', async () => {
  const a = ok(await call('POST', '/inventory/adjustments', A, adjBody([{ line_no: 1, sku_id: sku.id, qty: '5' }])), 'adj');
  ok(await call('POST', `/inventory/adjustments/${a.id}/confirm`, A), 'confirm');
  // 調整のあとに受注で 12 全部を押さえた、という状態を作る
  const s = await stockOf(sku.id);
  await db.query('update stocks set qty_allocated = qty_on_hand where id = $1', [s.id]);
  const r = await call('POST', `/inventory/adjustments/${a.id}/cancel`, A);
  const h = await one('select status from stock_adjustments where id = $1', [a.id]);
  const after = await stockOf(sku.id);
  await db.query('update stocks set qty_allocated = 0 where id = $1', [s.id]);
  ok(await call('POST', `/inventory/adjustments/${a.id}/cancel`, A), 'cancel after release');
  return (r.status === 409 && /引当|押さえ/.test(r.body?.message ?? '') && h.status === '確定' && Number(after.on_hand) === 12) || { r, h, after };
});
await check('品質の振替は「調整」で良品→不良に移り、取消で戻る', async () => {
  const a = ok(await call('POST', '/inventory/adjustments', A, adjBody([{ line_no: 1, sku_id: sku.id, qty: '2', from_quality: 'GOOD', to_quality: 'DEFECTIVE' }], { reason_code: 'QUALITY' })), 'adj');
  ok(await call('POST', `/inventory/adjustments/${a.id}/confirm`, A), 'confirm');
  const g1 = await stockOf(sku.id, 'GOOD');
  const d1 = await stockOf(sku.id, 'DEFECTIVE');
  ok(await call('POST', `/inventory/adjustments/${a.id}/cancel`, A), 'cancel');
  const g2 = await stockOf(sku.id, 'GOOD');
  const d2 = await stockOf(sku.id, 'DEFECTIVE');
  return (Number(g1.on_hand) === 5 && Number(d1.on_hand) === 2 && Number(g2.on_hand) === 7 && Number(d2.on_hand) === 0) || { g1, d1, g2, d2 };
});
await check('変更前に作られた調整（状態「登録」のまま在庫が動いた）は「確定」扱いで、二度目の「調整」は断る', async () => {
  // 以前は登録と同時に在庫を動かしていた。そのデータを再現する（状態は登録・移動履歴はある）
  const a = ok(await call('POST', '/inventory/adjustments', A, adjBody([{ line_no: 1, sku_id: sku.id, qty: '1' }])), 'adj');
  const s = await stockOf(sku.id);
  await db.query(
    `insert into stock_movements (stock_id, movement_type, ref_table, ref_id, qty, qty_before, qty_after) values ($1, '棚卸調整', 'stock_adjustments', $2, 1, $3::numeric, $3::numeric + 1)`,
    [s.id, a.id, s.on_hand],
  );
  await db.query('update stocks set qty_on_hand = qty_on_hand + 1 where id = $1', [s.id]);
  const list = ok(await call('GET', '/inventory/adjustments?limit=200', A), 'list');
  const mine = list.items.find((x) => x.id === a.id);
  const r = await call('POST', `/inventory/adjustments/${a.id}/confirm`, A);
  const after = await stockOf(sku.id);
  return (mine.status === '確定' && r.status === 409 && Number(after.on_hand) === 8) || { mine, r, after };
});

// ---- CSV 登録（Z-24） ---------------------------------------------------------------
const b64 = (text) => Buffer.from('﻿' + text, 'utf8').toString('base64');
const csv = [
  '調整日,倉庫,理由,商品コード,増減,品質（前）,品質（後）,メモ,備考',
  `2026/10/09,コニー倉庫,棚卸差異,${sku.sku_code},3,,,メモ1,CSV${t}`,
  `2026-10-09,コニー倉庫,STOCKTAKE,${sku2.sku_code},-1,,,メモ2,CSV${t}`,
  `20261010,コニー倉庫,品質振替,${sku.sku_code},1,良品,DEFECTIVE,,CSV${t}`,
].join('\r\n');
await check('Z-24 CSV の下見は登録せず、同じ調整日・倉庫・理由・備考の行を1件にまとめる', async () => {
  const before = Number((await one('select count(*)::int as n from stock_adjustments')).n);
  const r = ok(await call('POST', '/inventory/adjustments/import', A, { content_base64: b64(csv), dry_run: true }), 'dry run');
  const after = Number((await one('select count(*)::int as n from stock_adjustments')).n);
  return (before === after && r.errors.length === 0 && r.adjustments.length === 2 && r.adjustments[0].lines.length === 2 && r.adjustments[1].lines[0].to_quality === '不良') || r;
});
await check('Z-24 CSV に誤りがある行は下見で行番号付きで示し、確定は断る', async () => {
  const bad = `${csv}\r\n2026/10/09,どこにもない倉庫,棚卸差異,NOSKU${t},0,,,,`;
  const r = ok(await call('POST', '/inventory/adjustments/import', A, { content_base64: b64(bad), dry_run: true }), 'dry run');
  const c = await call('POST', '/inventory/adjustments/import', A, { content_base64: b64(bad), dry_run: false });
  return (r.errors.length === 1 && r.errors[0].row === 5 && /倉庫/.test(r.errors[0].message) && /商品コード/.test(r.errors[0].message) && c.status === 400) || { r, c };
});
await check('Z-24 CSV の確定で在庫調整が「登録」でできる（在庫は動かない）', async () => {
  const s = await stockOf(sku.id);
  const r = ok(await call('POST', '/inventory/adjustments/import', A, { content_base64: b64(csv), dry_run: false }), 'commit');
  const nos = r.adjustments.map((a) => a.adjustment_no);
  const hs = await all(
    `select a.id, a.status, a.note, (select count(*)::int from stock_adjustment_lines l where l.stock_adjustment_id = a.id) as n
       from stock_adjustments a where a.adjustment_no = any($1) order by a.adjustment_no`,
    [nos],
  );
  const after = await stockOf(sku.id);
  const moved = (await Promise.all(hs.map((h) => movesOf(h.id)))).reduce((x, y) => x + y, 0);
  return (hs.length === 2 && hs.every((h) => h.status === '登録' && h.note === `CSV${t}`) && hs[0].n + hs[1].n === 3 && moved === 0 && after.on_hand === s.on_hand) || { hs, s, after, moved };
});
await check('Z-24 閲覧者は CSV 取込できない（403）', async () => {
  const r = await call('POST', '/inventory/adjustments/import', V, { content_base64: b64(csv), dry_run: true });
  return r.status === 403 || r;
});

await db.end();
process.exit(ng === 0 ? 0 : 1);
