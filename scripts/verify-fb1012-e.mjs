// 2026-10-12 受入テスト（在庫編 T4・T5）を受けた修正の回帰確認（担当 E）。
//  - Z-02 入出荷履歴の「前・後」（実在庫）を、在庫表で実在庫を隠す人には返さない
//  - Z-14 登録で入れた入荷日を、入荷確定の入荷日・入出荷履歴の日付として残す
//  - セット商品を入荷・在庫調整に入れさせない（候補からも外す）。CSV 下見にカラー・サイズ
//  - Z-31 セット受注で、構成品の確保のほうが上の段（取引先指定）ならそちらで減らす。取消・修正で戻る
//  - 引当在庫を超えたときの文言（確保数）と、足りない確保・必要数・残り
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は FE。受注・確保は 2027-01 の月で作る（ほかの確認と重ならないように）。
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
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (id) => ok(await call('POST', '/auth/login', '', { login_id: id, password: PASS }), 'login').access_token;
const A = await login('admin');
const V = await login('viewer1');
const jst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const today = jst(Date.now());
const daysAgo = (n) => jst(Date.now() - n * 86400e3);
const jstDateOf = (iso) => jst(new Date(iso).getTime());
const t = String(Date.now()).slice(-6);
const N = (v) => Number(v);
const SET_MSG = 'セット商品は在庫を持たないため、構成品で入荷・調整してください';

// ---- 準備（接頭辞 FE） --------------------------------------------------------
let kony = await one(`select id from warehouses where short_name = 'コニー倉庫' and is_active order by id limit 1`);
if (!kony) kony = await one(`insert into warehouses (warehouse_code, short_name, is_consignment) values ($1, 'コニー倉庫', false) returning id`, [`FE${t}`]);
const WH = N(kony.id);
const beige = await one(`select id, name from colors order by id limit 1`);
const sizeM = await one(`select id, name from sizes order by id limit 1`);
const cat = N((await one('select id from sales_categories order by id limit 1')).id);

const pclass = ok(await call('POST', '/masters/simple/product_classes', A, { code: `FEC${t}`, name: `FE分類${t}` }), 'class');
const product = ok(await call('POST', '/masters/products', A, { product_code: `FE${t}`, product_name: `FE骨盤ショーツ${t}`, product_class_id: pclass.id, cost_price: '100' }), 'product');
const sku = async (code, extra = {}) => ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: code, ...extra }), `sku ${code}`);
const s1 = await sku(`FE${t}-0201-100`, { color_id: beige ? N(beige.id) : null, size_id: sizeM ? N(sizeM.id) : null });
const s2 = await sku(`FE${t}-0206-100`);
const setProduct = ok(await call('POST', '/masters/products', A, { product_code: `FES${t}`, product_name: `FE2枚組${t}`, is_set: true, cost_price: '0' }), 'set product');
const st = ok(await call('POST', '/masters/skus', A, { product_id: setProduct.id, sku_code: `FES${t}-0000-200` }), 'set sku');
ok(await call('POST', '/masters/sets', A, { sku_id: st.id, components: [{ component_sku_id: s2.id, qty: '2', sort_order: 1 }] }), 'set');

const media = ok(await call('POST', '/masters/simple/media', A, { code: `FEM${t}`, name: `FE媒体${t}` }), 'media');
const customer = async (n) => {
  const p = ok(await call('POST', '/masters/partners', A, { partner_code: `FEP${n}${t}`, name1: `FE販売先${n}-${t}`, is_customer: true, closing_day: 99, media_id: media.id }), 'partner');
  const d = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: p.id, delivery_code: `FED${n}${t}`, name: `FE納品先${n}`, default_warehouse_id: WH }), 'dest');
  return { ...p, dest: d.id };
};
const p1 = await customer(1);
const p2 = await customer(2);

const receipt = (lines, planned = today) =>
  call('POST', '/inventory/receipts', A, { warehouse_id: WH, planned_date: planned, lines: lines.map((l, i) => ({ line_no: i + 1, sku_id: l.id, qty: String(l.qty ?? 10) })) });
const adjustment = (lines) =>
  call('POST', '/inventory/adjustments', A, { warehouse_id: WH, adjustment_date: today, reason_code: 'STOCKTAKE', lines: lines.map((l, i) => ({ line_no: i + 1, sku_id: l.id, qty: String(l.qty ?? 1) })) });

// ---- Z-14 入荷日 ----------------------------------------------------------------
const movesOfReceipt = async (rcId) => (await db.query(`select moved_at from stock_movements where ref_table = 'receipts' and ref_id = $1`, [rcId])).rows;

await check('Z-14 登録で入れた入荷日（3日前）が、日付を送らずに確定しても入荷日として残る', async () => {
  const rc = ok(await receipt([{ ...s1, qty: 500 }, { ...s2, qty: 500 }], daysAgo(3)), 'receipt');
  const r = ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, {}), 'receive');
  const row = await one('select received_date::text d, planned_date::text p from receipts where id = $1', [rc.id]);
  return (row.d === daysAgo(3) && row.p === daysAgo(3) && r.received_date === daysAgo(3)) || { row, r };
});
await check('Z-14 入出荷履歴の日付も登録した入荷日になる（確定した日ではない）', async () => {
  const rc = await one(`select id from receipts where received_date = $1 and id in (select receipt_id from receipt_lines where sku_id = $2) order by id desc limit 1`, [daysAgo(3), s1.id]);
  const moves = await movesOfReceipt(rc.id);
  return (moves.length === 2 && moves.every((m) => jstDateOf(m.moved_at) === daysAgo(3))) || moves.map((m) => jstDateOf(m.moved_at));
});
await check('Z-14 確定のときに入荷日を直して送れば、その日になる（履歴の日付も）', async () => {
  const rc = ok(await receipt([{ ...s1, qty: 1 }], daysAgo(5)), 'receipt');
  ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: daysAgo(2) }), 'receive');
  const row = await one('select received_date::text d from receipts where id = $1', [rc.id]);
  const moves = await movesOfReceipt(rc.id);
  return (row.d === daysAgo(2) && moves.length === 1 && jstDateOf(moves[0].moved_at) === daysAgo(2)) || { row, moves };
});
await check('Z-14 入荷日が先の日付では確定できない（400・状態は入荷予定のまま・在庫は動かない）', async () => {
  const rc = ok(await receipt([{ ...s1, qty: 1 }], today), 'receipt');
  const r = await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: jst(Date.now() + 2 * 86400e3) });
  const row = await one('select status from receipts where id = $1', [rc.id]);
  const moves = await movesOfReceipt(rc.id);
  ok(await call('POST', `/inventory/receipts/${rc.id}/cancel`, A), 'cancel');
  return (r.status === 400 && /まだ先の日付/.test(r.body?.message) && row.status === '指示' && moves.length === 0) || { r, row };
});
await check('Z-14 入荷日の無い入荷は、確定した日（今日）が入荷日になる', async () => {
  const rc = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: WH, planned_date: null, lines: [{ line_no: 1, sku_id: s1.id, qty: '1' }] }), 'receipt');
  ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, {}), 'receive');
  const row = await one('select received_date::text d from receipts where id = $1', [rc.id]);
  return row.d === today || row;
});

// ---- Z-02 入出荷履歴の前・後 ----------------------------------------------------
await check('Z-02 閲覧者には入出荷履歴の「前」「後」（実在庫）を返さない。増減・種別は返す', async () => {
  const r = await call('GET', `/inventory/stocks/movements?sku_id=${s1.id}`, V);
  const items = r.body?.items ?? [];
  return (r.status === 200 && items.length > 0 && items.every((m) => !('qty_before' in m) && !('qty_after' in m) && m.qty !== undefined && m.movement_type)) || r;
});
await check('Z-02 在庫を更新できる人（管理者）には「前」「後」を返す', async () => {
  const r = ok(await call('GET', `/inventory/stocks/movements?sku_id=${s1.id}`, A), 'moves');
  return (r.items.length > 0 && r.items.every((m) => m.qty_before !== undefined && m.qty_after !== undefined)) || r.items[0];
});
await check('Z-02 種別で絞っても閲覧者には「前」「後」が出ない', async () => {
  const r = ok(await call('GET', `/inventory/stocks/movements?movement_type=${encodeURIComponent('入荷')}&limit=20`, V), 'moves');
  return r.items.every((m) => !('qty_before' in m) && !('qty_after' in m)) || r.items[0];
});

// ---- セット商品を入荷・調整に入れない ------------------------------------------
await check('商品候補（SKU 検索 is_set=false）にセット商品が出ない。is_set=true では出る', async () => {
  const no = ok(await call('GET', `/masters/skus?q=FES${t}&is_set=false`, A), 'search');
  const yes = ok(await call('GET', `/masters/skus?q=FES${t}&is_set=true`, A), 'search');
  return (no.length === 0 && yes.some((s) => s.sku_id === st.id)) || { no, yes };
});
await check('入荷登録でセット商品は 400（CSV 取込とそろえた文言）', async () => {
  const r = await receipt([{ ...s1, qty: 1 }, { ...st, qty: 3 }]);
  return (r.status === 400 && r.body?.message.includes(SET_MSG) && r.body.message.includes(`2行目：商品コード「FES${t}-0000-200」はセット商品です`)) || r;
});
await check('入荷の編集でセット商品に差し替えると 400', async () => {
  const rc = ok(await receipt([{ ...s1, qty: 1 }]), 'receipt');
  const r = await call('PATCH', `/inventory/receipts/${rc.id}`, A, { lines: [{ line_no: 1, sku_id: st.id, qty: '1' }] });
  ok(await call('POST', `/inventory/receipts/${rc.id}/cancel`, A), 'cancel');
  return (r.status === 400 && r.body?.message.includes(SET_MSG)) || r;
});
await check('前に登録されたセット商品の入荷は、確定しようとしても止まる（見えない在庫を作らない）', async () => {
  const rc = ok(await receipt([{ ...s1, qty: 1 }]), 'receipt');
  await db.query('update receipt_lines set sku_id = $1 where receipt_id = $2', [st.id, rc.id]);
  const r = await call('POST', `/inventory/receipts/${rc.id}/receive`, A, {});
  const row = await one('select status from receipts where id = $1', [rc.id]);
  const stock = await one('select count(*)::int n from stocks where sku_id = $1', [st.id]);
  ok(await call('POST', `/inventory/receipts/${rc.id}/cancel`, A), 'cancel');
  return (r.status === 400 && r.body?.message.includes(SET_MSG) && row.status === '指示' && stock.n === 0) || { r, row, stock };
});
await check('在庫調整（手入力）でセット商品は 400', async () => {
  const r = await adjustment([{ ...st, qty: 1 }]);
  return (r.status === 400 && r.body?.message.includes(SET_MSG)) || r;
});
await check('在庫調整の編集でセット商品に差し替えると 400', async () => {
  const a = ok(await adjustment([{ ...s1, qty: 1 }]), 'adj');
  const r = await call('PATCH', `/inventory/adjustments/${a.id}`, A, { lines: [{ line_no: 1, sku_id: st.id, qty: '1' }] });
  ok(await call('POST', `/inventory/adjustments/${a.id}/cancel`, A), 'cancel');
  return (r.status === 400 && r.body?.message.includes(SET_MSG)) || r;
});
await check('前に登録されたセット商品の調整は「調整」で止まり、「取消」はできる', async () => {
  const a = ok(await adjustment([{ ...s1, qty: 1 }]), 'adj');
  await db.query('update stock_adjustment_lines set sku_id = $1 where stock_adjustment_id = $2', [st.id, a.id]);
  const r = await call('POST', `/inventory/adjustments/${a.id}/confirm`, A);
  const c = await call('POST', `/inventory/adjustments/${a.id}/cancel`, A);
  const stock = await one('select count(*)::int n from stocks where sku_id = $1', [st.id]);
  return (r.status === 409 && r.body?.message.includes(SET_MSG) && c.status === 200 && stock.n === 0) || { r, c, stock };
});
await check('在庫調整の CSV 下見で、商品名にカラー・サイズが付き、セット商品の文言がそろう', async () => {
  const csv = `調整日,倉庫,理由,商品コード,増減\r\n${today},コニー倉庫,STOCKTAKE,${s1.sku_code},1\r\n${today},コニー倉庫,STOCKTAKE,${st.sku_code},1\r\n`;
  const r = ok(await call('POST', '/inventory/adjustments/import', A, { content_base64: Buffer.from(csv, 'utf8').toString('base64'), dry_run: true }), 'import');
  const line = r.adjustments[0]?.lines[0];
  const err = r.errors[0]?.message ?? '';
  return (line?.color_name === (beige?.name ?? null) && line?.size_name === (sizeM?.name ?? null) && /セット商品は在庫を持たないため、構成品で調整してください/.test(err)) || r;
});

// ---- Z-31 セット受注の確保の段・Z-25 超えたときの文言（受注日 2027-01） -----------
const OD = '2027-01-10';
const header = (extra) => ({ period_from: '2027-01-01', period_to: '2027-01-31', sales_category_id: cat, ...extra });
const group = async (extra, lines) => ok(await call('POST', '/inventory/reservation-groups', A, { ...header(extra), lines }), 'group');
const used = async (g, skuId) => N((await one('select consumed_qty from reservations where group_id = $1 and sku_id = $2', [g.id, skuId])).consumed_qty);
// G1: 取引先 P1 指定で構成品 s2 を 10。G2: 媒体（取引先は空）でセット st を 5、構成品 s2 を 10
const g1 = await group({ partner_id: p1.id, media_id: media.id, item_label: `FE項目${t}` }, [{ sku_id: s2.id, reserved_qty: '10' }]);
const g2 = await group({ media_id: media.id }, [{ sku_id: st.id, reserved_qty: '5' }, { sku_id: s2.id, reserved_qty: '10' }]);
const order = (c, lines) => call('POST', '/orders', A, { order_type: '卸', partner_id: c.id, delivery_destination_id: c.dest, sales_category_id: cat, order_date: OD, ship_date: OD, lines });
const setLines = (qty) => [{ line_no: 1, line_type: 'セット商品', sku_id: st.id, item_name: 'FE2枚組', qty: String(qty), unit_price: '2000' }];
const snapshot = async () => ({ g1s2: await used(g1, s2.id), g2st: await used(g2, st.id), g2s2: await used(g2, s2.id) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let o1;
await check('Z-31 取引先 P1 のセット受注は、媒体のセット SKU の確保より、P1 指定の構成品の確保（上の段）で減る', async () => {
  o1 = ok(await order(p1, setLines(1)), 'order');
  const s = await snapshot();
  return same(s, { g1s2: 2, g2st: 0, g2s2: 0 }) || s;
});
await check('Z-31 同じ段（媒体）にセット SKU と構成品の確保があれば、セット SKU の確保を使う（P2 の受注）', async () => {
  const o = ok(await order(p2, setLines(1)), 'order');
  const s = await snapshot();
  ok(await call('POST', `/orders/${o.id}/cancel`, A), 'cancel');
  const after = await snapshot();
  return (same(s, { g1s2: 2, g2st: 1, g2s2: 0 }) && same(after, { g1s2: 2, g2st: 0, g2s2: 0 })) || { s, after };
});
await check('Z-31 修正（数量 1→3）で P1 指定の構成品の確保が 2→6 になり、媒体の確保は動かない', async () => {
  ok(await call('PATCH', `/orders/${o1.id}`, A, { lines: setLines(3) }), 'patch');
  const s = await snapshot();
  return same(s, { g1s2: 6, g2st: 0, g2s2: 0 }) || s;
});
await check('Z-31 修正で取引先を P2 にすると、P1 の確保が戻り、媒体のセット SKU の確保で減る', async () => {
  ok(await call('PATCH', `/orders/${o1.id}`, A, { partner_id: p2.id, delivery_destination_id: p2.dest }), 'patch');
  const s = await snapshot();
  return same(s, { g1s2: 0, g2st: 3, g2s2: 0 }) || s;
});
await check('Z-31 取引先を P1 に戻して取消すると、どの確保も 0 に戻る', async () => {
  ok(await call('PATCH', `/orders/${o1.id}`, A, { partner_id: p1.id, delivery_destination_id: p1.dest }), 'patch');
  const mid = await snapshot();
  ok(await call('POST', `/orders/${o1.id}/cancel`, A), 'cancel');
  const s = await snapshot();
  return (same(mid, { g1s2: 6, g2st: 0, g2s2: 0 }) && same(s, { g1s2: 0, g2st: 0, g2s2: 0 })) || { mid, s };
});

await check('Z-31 内訳商品の行が付いたセット受注（通販CSVの形）でも、P1 指定の構成品の確保で1回だけ減り、取消で戻る', async () => {
  const o = ok(await order(p1, [
    ...setLines(1),
    { line_no: 2, line_type: '内訳商品', parent_line_no: 1, sku_id: s2.id, item_name: 'FE内訳', qty: '2', unit_price: '0' },
  ]), 'order');
  const s = await snapshot();
  ok(await call('POST', `/orders/${o.id}/cancel`, A), 'cancel');
  const after = await snapshot();
  return (same(s, { g1s2: 2, g2st: 0, g2s2: 0 }) && same(after, { g1s2: 0, g2st: 0, g2s2: 0 })) || { s, after };
});

await check('引当在庫を超えると「引当在庫（確保数）を超えています。」と、足りない確保・必要数・残りが出る', async () => {
  const r = await order(p1, [{ line_no: 1, line_type: '商品', sku_id: s2.id, item_name: 'FE', qty: '11', unit_price: '1000' }]);
  const o = r.body?.over?.[0] ?? '';
  return (
    (r.status === 400 &&
      r.body?.message === '引当在庫（確保数）を超えています。' &&
      o.includes('1行目') &&
      o.includes(s2.sku_code) &&
      o.includes('必要 11') &&
      o.includes('残り 10') &&
      o.includes('販売期間 2027/01/01〜2027/01/31') &&
      o.includes(`取引先 FE販売先1-${t}`) &&
      o.includes('販売カテゴリー ') &&
      o.includes(`項目 FE項目${t}`)) ||
    r
  );
});
await check('構成品で減らすセット受注が超えたときは、構成品と、その確保（取引先）が出る', async () => {
  const r = await order(p1, setLines(6)); // 構成品 s2 が 12 要る。P1 の確保の残りは 10
  const o = r.body?.over?.[0] ?? '';
  const s = await snapshot();
  return (r.status === 400 && o.includes(`構成品 ${s2.sku_code}`) && o.includes('必要 12') && o.includes('残り 10') && o.includes(`取引先 FE販売先1-${t}`) && same(s, { g1s2: 0, g2st: 0, g2s2: 0 })) || { r, s };
});
await check('媒体の確保が足りないときは「媒体 …」と出る（P2 のセット受注）', async () => {
  const r = await order(p2, setLines(6));
  const o = r.body?.over?.[0] ?? '';
  return (r.status === 400 && o.includes(`媒体 FE媒体${t}`) && o.includes('必要 6') && o.includes('残り 5') && o.includes('項目 なし')) || r;
});

// ---- 3回目の全面テスト（U5）: 構成品が2つのセットの取消で、減らしていない確保まで戻していた（受注日 2027-02） ----
{
  const OD2 = '2027-02-10';
  const s3 = await sku(`FE${t}-0301-100`);
  const su = ok(await call('POST', '/masters/skus', A, { product_id: setProduct.id, sku_code: `FES${t}-0000-201` }), 'set sku 2');
  ok(await call('POST', '/masters/sets', A, { sku_id: su.id, components: [{ component_sku_id: s1.id, qty: '1', sort_order: 1 }, { component_sku_id: s3.id, qty: '1', sort_order: 2 }] }), 'set 2');
  // 受注に要る在庫
  const rc = ok(await receipt([{ id: s1.id, qty: 20 }, { id: s3.id, qty: 20 }]), 'receipt');
  ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, {}), 'receive');
  const grp = async (lines) => ok(await call('POST', '/inventory/reservation-groups', A, { period_from: '2027-02-01', period_to: '2027-02-28', sales_category_id: cat, partner_id: p2.id, lines }), 'group');
  const order2 = (lines) => call('POST', '/orders', A, { order_type: '卸', partner_id: p2.id, delivery_destination_id: p2.dest, sales_category_id: cat, order_date: OD2, ship_date: OD2, lines });
  const usedBy = async (g, skuId) => N((await one('select consumed_qty from reservations where group_id = $1 and sku_id = $2', [g.id, skuId])).consumed_qty);

  await check('Z-31（U5）構成品が2つのセットの取消は、減らした確保だけを戻す（あとから足した確保・ほかの受注の分は戻さない）', async () => {
    // 1. s3 だけに確保がある状態でセット su を受注 → s3 の確保だけが減る（s1 は確保が無いので減らない）
    const g8 = await grp([{ sku_id: s3.id, reserved_qty: '5' }]);
    const oSet = ok(await order2([{ line_no: 1, line_type: 'セット商品', sku_id: su.id, item_name: 'FE2枚組B', qty: '1', unit_price: '2000' }]), 'set order');
    const a = { s3: await usedBy(g8, s3.id) };
    // 2. あとから s1 の確保を作り、s1 単品の受注で 1 使う
    const g9 = await grp([{ sku_id: s1.id, reserved_qty: '2' }]);
    ok(await order2([{ line_no: 1, line_type: '商品', sku_id: s1.id, item_name: 'FE単品', qty: '1', unit_price: '1000' }]), 's1 order');
    // 3. セット受注を取り消す → s3 の確保だけが戻り、s1 の確保（単品の受注の分）はそのまま
    ok(await call('POST', `/orders/${oSet.id}/cancel`, A), 'cancel');
    const b = { s3: await usedBy(g8, s3.id), s1: await usedBy(g9, s1.id) };
    // 4. s1 の確保の残りは 1 なので、s1 ×2 の受注は断られる（以前は戻しすぎて通り、確保 2 に受注 3 が結ばれた）
    const over = await order2([{ line_no: 1, line_type: '商品', sku_id: s1.id, item_name: 'FE単品', qty: '2', unit_price: '1000' }]);
    return (a.s3 === 1 && b.s3 === 0 && b.s1 === 1 && over.status === 400) || { a, b, over: over.status };
  });
}

await db.end();
process.exit(ng > 0 ? 1 : 0);
