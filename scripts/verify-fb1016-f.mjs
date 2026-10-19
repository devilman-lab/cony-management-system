// 在庫編_2（2026-10-16）Z3-01〜Z3-15 の回帰確認（担当 F）。
//  - 在庫表: 並び（既定は商品コードの昇順）・CSV 出力（絞り込みのまま全件・権限で列を出し分け）・備考は更新権限の人だけ
//  - 在庫調整: 理由の選択肢（その他・再生・棚卸差異）・明細のメモ・品質の振替を残したまま編集・品質の列の無い CSV 取込
//  - 引当在庫: 販売カテゴリーを空にできる（空の確保はどの販売カテゴリーの受注でも減る。同じ段では指定した確保が先）・
//    取消・修正で戻る・取引先は略称・キーワードで項目・備考を探す・CSV の（指定なし）
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は GF。受注・確保は 2027-11 の月に作る（ほかの確認の受注・確保と重ならないように）。
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
async function text(path, token) {
  const r = await fetch(B + path, { headers: { authorization: `Bearer ${token}` } });
  // BOM を確かめるため、BOM を落とさずに読む（r.text() は落とす）
  const body = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer());
  return { status: r.status, body, type: r.headers.get('content-type') ?? '' };
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (id) => ok(await call('POST', '/auth/login', '', { login_id: id, password: PASS }), 'login').access_token;
const A = await login('admin');
const V = await login('viewer1');
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const t = String(Date.now()).slice(-6);
const N = (v) => Number(v);
const qs = (o) => '?' + new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
/** CSV の行（BOM・末尾の空行を除く） */
const csvLines = (s) => s.replace(/^﻿/, '').split('\r\n').filter((l) => l !== '');

// ---- 準備（接頭辞 GF） --------------------------------------------------------
let kony = await one(`select id from warehouses where short_name = 'コニー倉庫' and is_active order by id limit 1`);
if (!kony) kony = await one(`insert into warehouses (warehouse_code, short_name, is_consignment) values ($1, 'コニー倉庫', false) returning id`, [`GF${t}`]);
const WH = Number(kony.id);
const cats = (await db.query('select id from sales_categories order by id limit 2')).rows.map((r) => Number(r.id));
const [catA, catB] = cats;

const pclassB = ok(await call('POST', '/masters/simple/product_classes', A, { code: `GFB${t}`, name: `GF分類B${t}` }), 'class B');
const pclassA = ok(await call('POST', '/masters/simple/product_classes', A, { code: `GFA${t}`, name: `GF分類A${t}` }), 'class A');
// 商品コードの順と分類コードの順が逆になるように作る（並びの確認のため）
const prodB = ok(await call('POST', '/masters/products', A, { product_code: `GF${t}A`, product_name: `GF商品A${t}`, product_class_id: pclassB.id, cost_price: '100' }), 'product B');
const prodA = ok(await call('POST', '/masters/products', A, { product_code: `GF${t}B`, product_name: `GF商品B${t}`, product_class_id: pclassA.id, cost_price: '100' }), 'product A');
const skus = [];
for (let i = 1; i <= 6; i++) skus.push(ok(await call('POST', '/masters/skus', A, { product_id: prodB.id, sku_code: `GF${t}A-000${i}-100` }), `sku${i}`));
const skuZ = ok(await call('POST', '/masters/skus', A, { product_id: prodA.id, sku_code: `GF${t}B-0001-100` }), 'skuZ');
const noStock = ok(await call('POST', '/masters/skus', A, { product_id: prodA.id, sku_code: `GF${t}B-0002-100` }), 'noStock');
// セット: setSku ＝ skus[4] × 2 ＋ skus[5] × 1
const setProduct = ok(await call('POST', '/masters/products', A, { product_code: `GFS${t}`, product_name: `GFセット${t}`, is_set: true, cost_price: '0' }), 'set product');
const setSku = ok(await call('POST', '/masters/skus', A, { product_id: setProduct.id, sku_code: `GFS${t}-0000-100` }), 'set sku');
ok(await call('POST', '/masters/sets', A, { sku_id: setSku.id, components: [{ component_sku_id: skus[4].id, qty: '2', sort_order: 1 }, { component_sku_id: skus[5].id, qty: '1', sort_order: 2 }] }), 'set');

const rc = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: WH, planned_date: today, lines: [...skus, skuZ].map((s, i) => ({ line_no: i + 1, sku_id: s.id, qty: '300' })) }), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');
// 在庫が 0 の行（有効在庫のあるものだけ、の確認用）: 入荷して同じ数を減らす
const rc2 = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: WH, planned_date: today, lines: [{ line_no: 1, sku_id: noStock.id, qty: '1' }] }), 'receipt2');
ok(await call('POST', `/inventory/receipts/${rc2.id}/receive`, A, { received_date: today }), 'receive2');
const adj0 = ok(await call('POST', '/inventory/adjustments', A, { warehouse_id: WH, adjustment_date: today, reason_code: 'OTHER', lines: [{ line_no: 1, sku_id: noStock.id, qty: '-1' }] }), 'adj0');
ok(await call('POST', `/inventory/adjustments/${adj0.id}/confirm`, A), 'adj0 confirm');

const partner = ok(await call('POST', '/masters/partners', A, { partner_code: `GFP${t}`, name1: `GF株式会社テスト販売先${t}`, short_name: `GF略${t}`, is_customer: true, closing_day: 99 }), 'partner');
const dest = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: partner.id, delivery_code: `GFD${t}`, name: 'GF納品先', default_warehouse_id: WH }), 'dest');
const partner2 = ok(await call('POST', '/masters/partners', A, { partner_code: `GFQ${t}`, name1: `GF略称なし販売先${t}`, is_customer: true, closing_day: 99 }), 'partner2');
const dest2 = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: partner2.id, delivery_code: `GFE${t}`, name: 'GF納品先2', default_warehouse_id: WH }), 'dest2');

// ---- 在庫表（Z3-01〜Z3-05） ------------------------------------------------------
const stockList = (token, extra = {}) => call('GET', `/inventory/stocks${qs({ q: `GF${t}`, warehouse_id: WH, limit: 200, ...extra })}`, token);
await check('Z3-01 在庫表は既定で商品コードの昇順（分類コードの順ではない）', async () => {
  const r = ok(await stockList(A), 'list');
  const codes = r.items.map((x) => x.sku_code);
  const sorted = [...codes].sort();
  return (codes.length >= 8 && JSON.stringify(codes) === JSON.stringify(sorted)) || codes;
});
await check('Z3-01 並び「分類コード順」では分類コード → 商品コードの順', async () => {
  const r = ok(await stockList(A, { sort: 'class' }), 'list');
  const codes = r.items.map((x) => x.product_class_code);
  // 分類 A（GFA）の商品が先、分類 B（GFB）が後
  return (codes[0] === `GFA${t}` && codes[codes.length - 1] === `GFB${t}`) || codes;
});
await check('Z3-01 有効在庫のあるものだけ（available_only）で 0 の行が出ない', async () => {
  const all = ok(await stockList(A), 'all').items.map((x) => x.sku_code);
  const avail = ok(await stockList(A, { available_only: 'true' }), 'avail').items.map((x) => x.sku_code);
  return (all.includes(noStock.sku_code) && !avail.includes(noStock.sku_code)) || { all, avail };
});
await check('Z3-03 CSV は絞り込み・検索のまま、ページの件数に関係なく全件（一覧の total と同じ行数）', async () => {
  const list = ok(await stockList(A, { available_only: 'true', limit: 2 }), 'list');
  const r = await text(`/inventory/stocks/export${qs({ q: `GF${t}`, warehouse_id: WH, available_only: 'true' })}`, A);
  const lines = csvLines(r.body);
  return (r.status === 200 && /text\/csv/.test(r.type) && r.body.startsWith('﻿') && lines.length - 1 === list.total && list.items.length === 2 && list.total > 2) || { status: r.status, rows: lines.length - 1, total: list.total };
});
await check('Z3-03 CSV の並びは一覧と同じ（商品コードの昇順）で、見出しに実在庫・引当済・有効在庫・原価', async () => {
  const r = await text(`/inventory/stocks/export${qs({ q: `GF${t}`, warehouse_id: WH })}`, A);
  const lines = csvLines(r.body);
  const head = lines[0];
  const codes = lines.slice(1).map((l) => l.split(',')[2].replace(/"/g, ''));
  return (/"実在庫"/.test(head) && /"引当済"/.test(head) && /"有効在庫"/.test(head) && /"原価"/.test(head) && JSON.stringify(codes) === JSON.stringify([...codes].sort())) || { head, codes };
});
await check('Z3-03 閲覧だけの人も CSV を出せるが、実在庫・引当済・原価の列は無い（画面と同じ）', async () => {
  const r = await text(`/inventory/stocks/export${qs({ q: `GF${t}`, warehouse_id: WH })}`, V);
  const head = csvLines(r.body)[0] ?? '';
  return (r.status === 200 && /"有効在庫"/.test(head) && !/"実在庫"/.test(head) && !/"引当済"/.test(head) && !/"原価"/.test(head)) || { status: r.status, head };
});
await check('Z3-05 備考を直せるのは在庫を更新できる人だけ（閲覧だけの人は 403、admin は保存できる）', async () => {
  const row = ok(await stockList(A), 'list').items[0];
  const v = await call('PATCH', `/inventory/stocks/${row.id}`, V, { note: 'GF閲覧' });
  const a = await call('PATCH', `/inventory/stocks/${row.id}`, A, { note: `GF備考${t}` });
  return (v.status === 403 && a.status < 300 && a.body.note === `GF備考${t}`) || { v: v.status, a };
});

// ---- 在庫調整（Z3-08〜Z3-10） ------------------------------------------------------
await check('Z3-08 在庫調整理由の選択肢は その他・再生・棚卸差異 の順で始まり、破損・紛失・品質振替は出ない', async () => {
  const r = ok(await call('GET', '/masters/codes/ADJUSTMENT_REASON', A), 'codes');
  const names = r.values.map((v) => v.name);
  // 試験用に足した理由（smoke の「テスト理由」など）が後ろにあってもよい
  return (JSON.stringify(names.slice(0, 3)) === JSON.stringify(['その他', '再生', '棚卸差異']) && !names.some((n) => ['破損', '紛失', '品質振替'].includes(n))) || names;
});
let adj;
await check('Z3-08 理由「その他」（OTHER）・「再生」（REFURB）で登録できる', async () => {
  adj = ok(await call('POST', '/inventory/adjustments', A, { warehouse_id: WH, adjustment_date: today, reason_code: 'OTHER', lines: [{ line_no: 1, sku_id: skus[0].id, qty: '2', note: `GFメモ${t}` }, { line_no: 2, sku_id: skus[1].id, qty: '-1' }] }), 'adj');
  const r2 = await call('POST', '/inventory/adjustments', A, { warehouse_id: WH, adjustment_date: today, reason_code: 'REFURB', lines: [{ line_no: 1, sku_id: skus[0].id, qty: '1' }] });
  if (r2.status < 300) ok(await call('POST', `/inventory/adjustments/${r2.body.id}/cancel`, A), 'cancel');
  return (adj.adjustment_no.startsWith('AJ') && r2.status < 300) || r2;
});
await check('Z3-10 在庫調整の一覧の明細に、明細のメモが返る', async () => {
  const r = ok(await call('GET', `/inventory/adjustments${qs({ limit: 50 })}`, A), 'list');
  const a = r.items.find((x) => x.id === adj.id);
  return (a && a.reason_code === 'OTHER' && a.lines[0].note === `GFメモ${t}` && a.lines[1].note === null) || a;
});
await check('Z3-09 品質の振替で登録した調整は、品質を送り返す編集でもそのまま残る（以前の調整の表示用）', async () => {
  const q = ok(await call('POST', '/inventory/adjustments', A, { warehouse_id: WH, adjustment_date: today, reason_code: 'QUALITY', lines: [{ line_no: 1, sku_id: skus[2].id, qty: '1', from_quality: 'GOOD', to_quality: 'DEFECTIVE' }] }), 'q adj');
  const d = ok(await call('GET', `/inventory/adjustments/${q.id}`, A), 'detail');
  // 画面と同じ送り方（理由はそのまま、品質は読んだ値をそのまま、メモを足す）
  ok(await call('PATCH', `/inventory/adjustments/${q.id}`, A, { reason_code: d.reason_code, lines: d.lines.map((l) => ({ line_no: l.line_no, sku_id: l.sku_id, qty: String(Number(l.qty)), from_quality: l.from_quality, to_quality: l.to_quality, note: 'GF直した' })) }), 'patch');
  const after = ok(await call('GET', `/inventory/adjustments/${q.id}`, A), 'after');
  ok(await call('POST', `/inventory/adjustments/${q.id}/cancel`, A), 'cancel');
  return (after.reason_code === 'QUALITY' && after.lines[0].from_quality === 'GOOD' && after.lines[0].to_quality === 'DEFECTIVE' && after.lines[0].note === 'GF直した') || after;
});
await check('Z3-09 品質(前)・品質(後) の列の無い CSV も取り込める（下見）', async () => {
  const csv = `調整日,倉庫,理由,商品コード,増減,メモ,備考\r\n${today},${WH === Number(kony.id) ? 'コニー倉庫' : ''},その他,${skus[3].sku_code},3,GF取込メモ,GF取込${t}\r\n`;
  const r = ok(await call('POST', '/inventory/adjustments/import', A, { content_base64: Buffer.from(csv, 'utf8').toString('base64'), dry_run: true }), 'import');
  return (r.errors.length === 0 && r.adjustments.length === 1 && r.adjustments[0].reason_name === 'その他' && r.adjustments[0].lines[0].from_quality === null) || r;
});
ok(await call('POST', `/inventory/adjustments/${adj.id}/cancel`, A), 'cancel adj');

// ---- 引当在庫（Z3-11〜Z3-15） ------------------------------------------------------
const PF = '2027-11-01';
const PT = '2027-11-30';
const OD = '2027-11-10';
const order = (lines, cat = catA, p = partner, d = dest) =>
  call('POST', '/orders', A, { order_type: '卸', partner_id: p.id, delivery_destination_id: d.id, sales_category_id: cat, order_date: OD, ship_date: OD, lines });
const line = (sku, qty) => [{ line_no: 1, line_type: '商品', sku_id: sku.id, item_name: 'GF', qty: String(qty), unit_price: '1000' }];
const setLine = (qty) => [{ line_no: 1, line_type: 'セット商品', sku_id: setSku.id, item_name: 'GFセット', qty: String(qty), unit_price: '2000' }];
const used = async (frameId) => N((await one('select consumed_qty from reservations where id = $1', [frameId])).consumed_qty);
const create = async (extra, lines) => ok(await call('POST', '/inventory/reservation-groups', A, { period_from: PF, period_to: PT, ...extra, lines }), 'create group');
const orders = [];

let gNull;
await check('Z3-15 販売カテゴリーを送らずに確保を登録できる（空のまま。明細も空）', async () => {
  gNull = await create({ partner_id: partner.id, item_label: `GF項目${t}`, note: `GF備考メモ${t}` }, [{ sku_id: skus[0].id, reserved_qty: '10' }]);
  const rows = (await db.query('select sales_category_id from reservations where group_id = $1', [gNull.id])).rows;
  return (gNull.sales_category_id === null && gNull.sales_category_name === null && rows.every((r) => r.sales_category_id === null)) || { gNull, rows };
});
await check('Z3-15 空の確保は、どの販売カテゴリーの受注でも減る（A で 2、B で 3）', async () => {
  orders.push(ok(await order(line(skus[0], 2), catA), 'order A'));
  orders.push(ok(await order(line(skus[0], 3), catB), 'order B'));
  return (await used(gNull.lines[0].id)) === 5 || (await used(gNull.lines[0].id));
});
await check('Z3-15 取消で空の確保に戻る（5 → 2）', async () => {
  ok(await call('POST', `/orders/${orders[1].id}/cancel`, A), 'cancel');
  return (await used(gNull.lines[0].id)) === 2 || (await used(gNull.lines[0].id));
});
await check('Z3-15 修正で引き直される（2 → 4）', async () => {
  ok(await call('PATCH', `/orders/${orders[0].id}`, A, { lines: line(skus[0], 4) }), 'patch order');
  return (await used(gNull.lines[0].id)) === 4 || (await used(gNull.lines[0].id));
});
ok(await call('POST', `/orders/${orders[0].id}/cancel`, A), 'cleanup order');

// 同じ段（取引先指定）に、販売カテゴリー A を選んだ確保と空の確保
const gCatA = await create({ partner_id: partner.id, sales_category_id: catA }, [{ sku_id: skus[1].id, reserved_qty: '5' }]);
const gCatNull = await create({ partner_id: partner.id }, [{ sku_id: skus[1].id, reserved_qty: '20' }]);
const fA = gCatA.lines[0].id;
const fN = gCatNull.lines[0].id;
await check('Z3-15 同じ段では、販売カテゴリーを選んだ確保を先に使う（A の受注 3 → A の確保から）', async () => {
  orders.push(ok(await order(line(skus[1], 3), catA), 'order'));
  return ((await used(fA)) === 3 && (await used(fN)) === 0) || { a: await used(fA), n: await used(fN) };
});
await check('Z3-15 選んだ確保は、ほかの販売カテゴリーの受注では減らない（B の受注 4 → 空の確保から）', async () => {
  orders.push(ok(await order(line(skus[1], 4), catB), 'order'));
  return ((await used(fA)) === 3 && (await used(fN)) === 4) || { a: await used(fA), n: await used(fN) };
});
await check('Z3-15 選んだ確保の残りが足りなければ、同じ段の空の確保から減る（A の受注 6 > 残り 2）', async () => {
  orders.push(ok(await order(line(skus[1], 6), catA), 'order'));
  return ((await used(fA)) === 3 && (await used(fN)) === 10) || { a: await used(fA), n: await used(fN) };
});
await check('Z3-15 取消すと、減らした確保にそれぞれ戻る', async () => {
  for (const o of orders.splice(-3)) ok(await call('POST', `/orders/${o.id}/cancel`, A), 'cancel');
  return ((await used(fA)) === 0 && (await used(fN)) === 0) || { a: await used(fA), n: await used(fN) };
});
await check('Z3-15 取引先指定の段は、空の販売カテゴリーでも媒体・指定なしの段より先（段の決まりは今のまま）', async () => {
  const gAll = await create({ sales_category_id: catA }, [{ sku_id: skus[2].id, reserved_qty: '9' }]);
  const gP = await create({ partner_id: partner.id }, [{ sku_id: skus[2].id, reserved_qty: '9' }]);
  const o = ok(await order(line(skus[2], 2), catA), 'order');
  const r = { all: await used(gAll.lines[0].id), p: await used(gP.lines[0].id) };
  ok(await call('POST', `/orders/${o.id}/cancel`, A), 'cancel');
  return (r.all === 0 && r.p === 2) || r;
});
await check('Z3-15 セット商品で構成品の空の確保から減らし、取消で戻る（reservation_takes のまま）', async () => {
  const gc = await create({ partner_id: partner.id }, [{ sku_id: skus[4].id, reserved_qty: '20' }, { sku_id: skus[5].id, reserved_qty: '10' }]);
  const o = ok(await order(setLine(3), catB), 'set order');
  const mid = { c1: await used(gc.lines[0].id), c2: await used(gc.lines[1].id) };
  ok(await call('PATCH', `/orders/${o.id}`, A, { lines: setLine(2) }), 'patch');
  const mid2 = { c1: await used(gc.lines[0].id), c2: await used(gc.lines[1].id) };
  ok(await call('POST', `/orders/${o.id}/cancel`, A), 'cancel');
  const after = { c1: await used(gc.lines[0].id), c2: await used(gc.lines[1].id) };
  return (mid.c1 === 6 && mid.c2 === 3 && mid2.c1 === 4 && mid2.c2 === 2 && after.c1 === 0 && after.c2 === 0) || { mid, mid2, after };
});
await check('Z3-15 足りないときの断りの文で、空の販売カテゴリーは「（指定なし）」', async () => {
  const r = await order(line(skus[0], 50), catA);
  const msg = JSON.stringify(r.body);
  return (r.status === 400 && msg.includes('販売カテゴリー （指定なし）') && msg.includes(`取引先 GF略${t}`)) || r;
});
await check('Z3-15 編集で販売カテゴリーを選ぶ・空に戻すことができ、明細にも写る', async () => {
  ok(await call('PATCH', `/inventory/reservation-groups/${gNull.id}`, A, { sales_category_id: catB }), 'set');
  const a = await one('select count(*) filter (where sales_category_id = $2)::int n from reservations where group_id = $1', [gNull.id, catB]);
  const g = ok(await call('PATCH', `/inventory/reservation-groups/${gNull.id}`, A, { sales_category_id: null }), 'clear');
  const b = await one('select count(*) filter (where sales_category_id is null)::int n from reservations where group_id = $1', [gNull.id]);
  const keep = ok(await call('PATCH', `/inventory/reservation-groups/${gNull.id}`, A, { note: `GF備考メモ${t}` }), 'keep');
  return (a.n === 1 && g.sales_category_id === null && b.n === 1 && keep.sales_category_id === null) || { a, g, b, keep };
});
await check('Z3-15 1行ずつの古い経路（POST /inventory/reservations）も販売カテゴリーなしで作れる', async () => {
  const r = ok(await call('POST', '/inventory/reservations', A, { partner_id: partner2.id, sku_id: skus[3].id, period_from: PF, period_to: PT, reserved_qty: '3' }), 'legacy');
  const l = ok(await call('GET', `/inventory/reservations${qs({ partner_id: partner2.id, from: PF, to: PT })}`, A), 'legacy list');
  return (l.items.some((x) => x.id === r.id && x.sales_category_id === null)) || l;
});

const listOf = (extra) => call('GET', `/inventory/reservation-groups${qs({ from: PF, to: PT, limit: 200, ...extra })}`, A);
await check('Z3-15 一覧を「（指定なし）」で絞ると、販売カテゴリーが空の確保だけ', async () => {
  const r = ok(await listOf({ sales_category_id: 'none', partner_id: partner.id }), 'list');
  return (r.items.length > 0 && r.items.every((g) => g.sales_category_id === null) && r.items.some((g) => g.id === gNull.id) && !r.items.some((g) => g.id === gCatA.id)) || r.items.map((g) => [g.id, g.sales_category_id]);
});
await check('Z3-12 取引先は略称で返る（正式な名称は partner_full_name）。略称の無い取引先は名称', async () => {
  const r = ok(await listOf({ partner_id: partner.id }), 'list');
  const g = r.items.find((x) => x.id === gNull.id);
  const r2 = ok(await listOf({ partner_id: partner2.id }), 'list2');
  return (g.partner_name === `GF略${t}` && g.partner_full_name === `GF株式会社テスト販売先${t}` && r2.items[0]?.partner_name === `GF略称なし販売先${t}`) || { g, r2: r2.items[0] };
});
await check('Z3-13 キーワードで項目・備考を探せる（商品の欄とは別）', async () => {
  const a = ok(await listOf({ q: `GF項目${t}` }), 'item');
  const b = ok(await listOf({ q: `GF備考メモ${t}` }), 'note');
  const c = ok(await listOf({ q: skus[1].sku_code }), 'sku');
  return (a.items.length === 1 && a.items[0].id === gNull.id && b.items.length === 1 && b.items[0].id === gNull.id && c.items.some((g) => g.id === gCatA.id)) || { a: a.items.map((g) => g.id), b: b.items.map((g) => g.id), c: c.items.map((g) => g.id) };
});
await check('Z3-12・Z3-15 CSV は取引先を略称で、空の販売カテゴリーを「（指定なし）」で出す。キーワードも効く', async () => {
  const r = await text(`/inventory/reservation-groups/export${qs({ from: PF, to: PT, q: `GF項目${t}` })}`, A);
  const lines = csvLines(r.body);
  return (r.status === 200 && lines.length === 2 && lines[1].includes(`"GF略${t}"`) && lines[1].includes('"（指定なし）"')) || lines;
});
await check('Z3-14 前月の複写の API は残っている（画面のボタンだけ外した）', async () => {
  const r = await call('POST', '/inventory/reservation-groups/copy-month', V, { from_month: '2027-10', to_month: '2027-11' });
  return r.status === 403 || r; // 閲覧者は権限で断られる＝経路はある
});

await db.end();
if (ng > 0) {
  console.log(`NG ${ng} 件`);
  process.exit(1);
}
