// 在庫編フィードバック（2026-10-09）Z-25〜Z-32「引当在庫（確保数）」の回帰確認。
// 確保を「見出し＋明細」で登録・編集・削除・複写でき、受注で減らすときの当て方
// （取引先指定／媒体／販売カテゴリー）、セット商品の構成品の枠、CSV 出力の列の並びを確かめる。
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
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
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const month = today.slice(0, 7);
const [yy, mm] = month.split('-').map(Number);
const monthEnd = `${month}-${String(new Date(Date.UTC(yy, mm, 0)).getUTCDate()).padStart(2, '0')}`;
const t = String(Date.now()).slice(-6);
const N = (v) => Number(v);

// ---- 準備（接頭辞 RV） --------------------------------------------------------
const cats = (await db.query('select id from sales_categories order by id limit 2')).rows.map((r) => Number(r.id));
const [catA, catB] = cats;
const warehouse = Number((await one('select id from warehouses where is_active order by id limit 1')).id);
const media1 = ok(await call('POST', '/masters/simple/media', A, { code: `RVM1${t}`, name: `RV媒体1-${t}` }), 'media1');
const media2 = ok(await call('POST', '/masters/simple/media', A, { code: `RVM2${t}`, name: `RV媒体2-${t}` }), 'media2');
const pclass = ok(await call('POST', '/masters/simple/product_classes', A, { code: `RVC${t}`, name: `RV分類${t}` }), 'class');
const customer = async (n, mediaId) => {
  const p = ok(await call('POST', '/masters/partners', A, { partner_code: `RVP${n}${t}`, name1: `RV販売先${n}-${t}`, is_customer: true, closing_day: 99, media_id: mediaId }), 'partner');
  const d = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: p.id, delivery_code: `RVD${n}${t}`, name: `RV納品先${n}`, default_warehouse_id: warehouse }), 'dest');
  return { ...p, dest: d.id };
};
const p1 = await customer(1, media1.id); // 媒体1
const p2 = await customer(2, media1.id); // 媒体1
const p3 = await customer(3, media2.id); // 媒体2

const product = ok(await call('POST', '/masters/products', A, { product_code: `RV${t}`, product_name: `RV商品${t}`, product_class_id: pclass.id, cost_price: '100' }), 'product');
const skus = [];
for (let i = 1; i <= 9; i++) skus.push(ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `RV${t}-000${i}-100` }), `sku${i}`));
const other = ok(await call('POST', '/masters/products', A, { product_code: `RVX${t}`, product_name: `RV別分類${t}`, cost_price: '100' }), 'other');
const otherSku = ok(await call('POST', '/masters/skus', A, { product_id: other.id, sku_code: `RVX${t}-0000-100` }), 'otherSku');
// セット商品: セット SKU（2枚組）＝ 構成品 skus[6] × 2 ＋ skus[7] × 1
const setProduct = ok(await call('POST', '/masters/products', A, { product_code: `RVS${t}`, product_name: `RVセット${t}`, is_set: true, cost_price: '0' }), 'setProduct');
const setSku = ok(await call('POST', '/masters/skus', A, { product_id: setProduct.id, sku_code: `RVS${t}-0000-100` }), 'setSku');
ok(await call('POST', '/masters/sets', A, { sku_id: setSku.id, components: [{ component_sku_id: skus[6].id, qty: '2', sort_order: 1 }, { component_sku_id: skus[7].id, qty: '1', sort_order: 2 }] }), 'set');
// 在庫（受注登録で実在庫も見るため）
const rc = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: warehouse, planned_date: today, lines: [...skus, otherSku].map((s, i) => ({ line_no: i + 1, sku_id: s.id, qty: '500' })) }), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');

const order = (c, lines, cat = catA) => call('POST', '/orders', A, { order_type: '卸', partner_id: c.id, delivery_destination_id: c.dest, sales_category_id: cat, order_date: today, ship_date: today, lines });
const line = (sku, qty) => [{ line_no: 1, line_type: '商品', sku_id: sku.id, item_name: 'RV', qty: String(qty), unit_price: '1000' }];
const setLine = (qty) => [{ line_no: 1, line_type: 'セット商品', sku_id: setSku.id, item_name: 'RVセット', qty: String(qty), unit_price: '2000' }];
const used = async (frameId) => N((await one('select consumed_qty from reservations where id = $1', [frameId])).consumed_qty);
const header = (extra = {}) => ({ period_from: `${month}-01`, period_to: monthEnd, sales_category_id: catA, ...extra });
const create = async (extra, lines) => ok(await call('POST', '/inventory/reservation-groups', A, { ...header(extra), lines }), 'create group');
const lineOf = (g, sku) => g.lines.find((l) => l.sku_id === sku.id);

// ---- 登録（Z-27） -------------------------------------------------------------
let g1;
await check('Z-27 見出し（媒体・項目・取引先・商品分類・販売カテゴリー・備考・期間）＋明細2行で登録できる', async () => {
  g1 = await create({ media_id: media1.id, partner_id: p1.id, item_label: 'チラシ', product_class_id: pclass.id, note: `RV備考${t}` }, [
    { sku_id: skus[0].id, reserved_qty: '10' },
    { sku_id: skus[1].id, reserved_qty: '5' },
  ]);
  return (g1.lines.length === 2 && g1.item_label === 'チラシ' && g1.product_class_code === `RVC${t}` && g1.media_name === `RV媒体1-${t}` && N(g1.reserved_total) === 15) || g1;
});
await check('Z-27 明細に見出しの取引先・媒体・販売カテゴリー・期間が写る', async () => {
  const rows = (await db.query('select partner_id, media_id, sales_category_id, period_from::text pf, period_to::text pt from reservations where group_id = $1', [g1.id])).rows;
  return rows.every((r) => N(r.partner_id) === p1.id && N(r.media_id) === media1.id && N(r.sales_category_id) === catA && r.pf === `${month}-01` && r.pt === monthEnd) || rows;
});
await check('1つの確保に同じ商品が2行あると 400', async () => {
  const r = await call('POST', '/inventory/reservation-groups', A, { ...header(), lines: [{ sku_id: skus[2].id, reserved_qty: '1' }, { sku_id: skus[2].id, reserved_qty: '2' }] });
  return (r.status === 400 && /同じ商品/.test(r.body?.message)) || r;
});
await check('販売期間が逆転していると 400（日本語）', async () => {
  const r = await call('POST', '/inventory/reservation-groups', A, { ...header({ period_from: '2026-12-31', period_to: '2026-01-01' }), lines: [{ sku_id: skus[2].id, reserved_qty: '1' }] });
  return (r.status === 400 && /開始日が終了日より後/.test(r.body?.message)) || r;
});
await check('明細が無い確保は 400', async () => {
  const r = await call('POST', '/inventory/reservation-groups', A, { ...header(), lines: [] });
  return r.status === 400 || r;
});

// ---- 当て方（Z-25） -----------------------------------------------------------
await check('Z-25 取引先を指定した確保は、その取引先の受注で減る（10 → 7）', async () => {
  ok(await order(p1, line(skus[0], 3)), 'order');
  return (await used(lineOf(g1, skus[0]).id)) === 3 || (await used(lineOf(g1, skus[0]).id));
});
await check('Z-25 同じ媒体でも、ほかの取引先の受注では減らない', async () => {
  ok(await order(p2, line(skus[0], 2)), 'order');
  return (await used(lineOf(g1, skus[0]).id)) === 3 || (await used(lineOf(g1, skus[0]).id));
});
const gMedia = await create({ media_id: media1.id, item_label: 'テレビ' }, [{ sku_id: skus[2].id, reserved_qty: '10' }]);
const fMedia = gMedia.lines[0].id;
await check('Z-25 取引先が空で媒体がある確保は、その媒体の取引先の受注で減る（2社とも）', async () => {
  ok(await order(p1, line(skus[2], 1)), 'order p1');
  ok(await order(p2, line(skus[2], 2)), 'order p2');
  return (await used(fMedia)) === 3 || (await used(fMedia));
});
await check('Z-25 ほかの媒体の取引先の受注では減らない', async () => {
  ok(await order(p3, line(skus[2], 1)), 'order p3');
  return (await used(fMedia)) === 3 || (await used(fMedia));
});
await check('Z-25 販売カテゴリーが違う受注では減らない', async () => {
  ok(await order(p1, line(skus[2], 1), catB), 'order catB');
  return (await used(fMedia)) === 3 || (await used(fMedia));
});
await check('Z-25 取引先指定と媒体指定が両方当たるときは、取引先指定の確保から減る', async () => {
  const gp = await create({ partner_id: p2.id }, [{ sku_id: skus[2].id, reserved_qty: '4' }]);
  ok(await order(p2, line(skus[2], 2)), 'order');
  return ((await used(gp.lines[0].id)) === 2 && (await used(fMedia)) === 3) || { partner: await used(gp.lines[0].id), media: await used(fMedia) };
});
await check('Z-25 媒体も取引先も無い確保（従来の枠）は、販売カテゴリーだけで当たる', async () => {
  const gAll = await create({}, [{ sku_id: skus[3].id, reserved_qty: '5' }]);
  ok(await order(p3, line(skus[3], 1)), 'order');
  return (await used(gAll.lines[0].id)) === 1 || (await used(gAll.lines[0].id));
});
await check('Z-25 項目は当て方に使わない（項目のある確保でも当たる）', async () => {
  // gMedia は項目「テレビ」。上で媒体の取引先の受注が当たっている
  return gMedia.item_label === 'テレビ' && (await used(fMedia)) === 3;
});
let overOrder;
await check('枠を超える受注は 400 で登録されない', async () => {
  const r = await order(p1, line(skus[1], 6)); // g1 の skus[1] は 5
  overOrder = r;
  return (r.status === 400 && (await used(lineOf(g1, skus[1]).id)) === 0) || r;
});
await check('受注を取り消すと枠に戻る', async () => {
  const o = ok(await order(p1, line(skus[1], 4)), 'order');
  const mid = await used(lineOf(g1, skus[1]).id);
  ok(await call('POST', `/orders/${o.id}/cancel`, A), 'cancel');
  return (mid === 4 && (await used(lineOf(g1, skus[1]).id)) === 0) || { mid, after: await used(lineOf(g1, skus[1]).id) };
});
void overOrder;

// ---- セット商品（Z-31） --------------------------------------------------------
const gComp = await create({ partner_id: p3.id, item_label: '構成品' }, [
  { sku_id: skus[6].id, reserved_qty: '20' },
  { sku_id: skus[7].id, reserved_qty: '10' },
]);
const fC1 = lineOf(gComp, skus[6]).id;
const fC2 = lineOf(gComp, skus[7]).id;
let setOrder;
await check('Z-31 セット SKU の枠が無ければ、構成品の枠が「構成数 × セット数」減る（2組 → 4 と 2）', async () => {
  setOrder = ok(await order(p3, setLine(2)), 'set order');
  return ((await used(fC1)) === 4 && (await used(fC2)) === 2) || { c1: await used(fC1), c2: await used(fC2) };
});
await check('Z-31 セットの受注を修正すると引き直される（3組 → 6 と 3）', async () => {
  ok(await call('PATCH', `/orders/${setOrder.id}`, A, { lines: setLine(3) }), 'patch');
  return ((await used(fC1)) === 6 && (await used(fC2)) === 3) || { c1: await used(fC1), c2: await used(fC2) };
});
await check('Z-31 セットの受注を取り消すと構成品の枠に戻る', async () => {
  ok(await call('POST', `/orders/${setOrder.id}/cancel`, A), 'cancel');
  return ((await used(fC1)) === 0 && (await used(fC2)) === 0) || { c1: await used(fC1), c2: await used(fC2) };
});
await check('Z-31 構成品の枠が足りなければ 400（11組 → 22 > 20）', async () => {
  const r = await order(p3, setLine(11));
  return (r.status === 400 && (await used(fC1)) === 0 && (await used(fC2)) === 0) || r;
});
await check('Z-31 セット SKU の枠があれば、それを減らし構成品の枠は減らない', async () => {
  const gSet = await create({ partner_id: p3.id, item_label: 'セット' }, [{ sku_id: setSku.id, reserved_qty: '5' }]);
  const o = ok(await order(p3, setLine(2)), 'order');
  const r = { set: await used(gSet.lines[0].id), c1: await used(fC1), c2: await used(fC2) };
  ok(await call('POST', `/orders/${o.id}/cancel`, A), 'cancel');
  const back = await used(gSet.lines[0].id);
  return (r.set === 2 && r.c1 === 0 && r.c2 === 0 && back === 0) || { ...r, back };
});

// ---- 編集（Z-32） --------------------------------------------------------------
// g1: skus[0] 使用 3、skus[1] 使用 0
await check('Z-32 見出しのすべて（媒体・取引先・販売カテゴリー・項目・商品分類・備考・期間）を直せ、明細にも写る', async () => {
  const r = ok(await call('PATCH', `/inventory/reservation-groups/${g1.id}`, A, { media_id: media2.id, partner_id: p2.id, sales_category_id: catB, item_label: 'カタログ', product_class_id: null, note: '直した', period_to: monthEnd }), 'patch');
  const rows = (await db.query('select distinct partner_id, media_id, sales_category_id from reservations where group_id = $1', [g1.id])).rows;
  // 戻しておく（以降の確認のため）
  ok(await call('PATCH', `/inventory/reservation-groups/${g1.id}`, A, { media_id: media1.id, partner_id: p1.id, sales_category_id: catA, product_class_id: pclass.id }), 'patch back');
  return (r.item_label === 'カタログ' && r.note === '直した' && r.product_class_id === null && rows.length === 1 && N(rows[0].partner_id) === p2.id && N(rows[0].media_id) === media2.id && N(rows[0].sales_category_id) === catB) || { r, rows };
});
const linesOf = (g) => g.lines.map((l) => ({ id: l.id, sku_id: l.sku_id, reserved_qty: String(N(l.reserved_qty)) }));
await check('Z-32 使用数より少ない確保数にはできない（400、保存もされない）', async () => {
  const ls = linesOf(g1).map((l) => (l.sku_id === skus[0].id ? { ...l, reserved_qty: '2' } : l));
  const r = await call('PATCH', `/inventory/reservation-groups/${g1.id}`, A, { note: '保存されないはず', lines: ls });
  const g = await one('select note from reservation_groups where id = $1', [g1.id]);
  return (r.status === 400 && /減らせません/.test(r.body?.message) && g.note === '直した') || { r, g };
});
await check('Z-32 使用数のある明細は商品を変えられない（400）', async () => {
  const ls = linesOf(g1).map((l) => (l.sku_id === skus[0].id ? { ...l, sku_id: skus[4].id } : l));
  const r = await call('PATCH', `/inventory/reservation-groups/${g1.id}`, A, { lines: ls });
  return r.status === 400 || r;
});
await check('Z-32 使用数のある明細は消せない（400）', async () => {
  const ls = linesOf(g1).filter((l) => l.sku_id !== skus[0].id);
  const r = await call('PATCH', `/inventory/reservation-groups/${g1.id}`, A, { lines: ls });
  return r.status === 400 || r;
});
await check('Z-32 確保数を増やし、未使用の明細の商品を変え、行を足せる', async () => {
  const ls = linesOf(g1).map((l) => (l.sku_id === skus[0].id ? { ...l, reserved_qty: '12' } : { ...l, sku_id: skus[4].id }));
  ls.push({ sku_id: skus[5].id, reserved_qty: '7' });
  const r = ok(await call('PATCH', `/inventory/reservation-groups/${g1.id}`, A, { lines: ls }), 'patch');
  const s = r.lines.map((l) => `${l.sku_code}:${N(l.reserved_qty)}:${N(l.consumed_qty)}`).join(',');
  return s === `${skus[0].sku_code}:12:3,${skus[4].sku_code}:5:0,${skus[5].sku_code}:7:0` || s;
});
await check('Z-32 未使用の明細は消せる', async () => {
  const g = ok(await call('GET', `/inventory/reservation-groups/${g1.id}`, A), 'get');
  const ls = linesOf(g).filter((l) => l.sku_id !== skus[5].id);
  const r = ok(await call('PATCH', `/inventory/reservation-groups/${g1.id}`, A, { lines: ls }), 'patch');
  return (r.lines.length === 2 && N(r.reserved_total) === 17 && N(r.consumed_total) === 3) || r;
});

// ---- 削除・コピー（Z-28） ------------------------------------------------------
await check('Z-28 受注で使われている確保は削除できない（400）', async () => {
  const r = await call('DELETE', `/inventory/reservation-groups/${g1.id}`, A);
  return (r.status === 400 && (await one('select count(*)::int n from reservation_groups where id = $1', [g1.id])).n === 1) || r;
});
await check('Z-28 コピー（詳細を読んで新しい確保として登録）すると、見出し・明細が写り使用数は 0', async () => {
  const src = ok(await call('GET', `/inventory/reservation-groups/${g1.id}`, A), 'get');
  const body = { period_from: src.period_from, period_to: src.period_to, media_id: src.media_id, partner_id: src.partner_id, sales_category_id: src.sales_category_id, item_label: src.item_label, product_class_id: src.product_class_id, note: src.note, lines: src.lines.map((l) => ({ sku_id: l.sku_id, reserved_qty: l.reserved_qty })) };
  const c = ok(await call('POST', '/inventory/reservation-groups', A, body), 'copy');
  const del = await call('DELETE', `/inventory/reservation-groups/${c.id}`, A);
  return (c.id !== g1.id && c.lines.length === src.lines.length && N(c.consumed_total) === 0 && N(c.reserved_total) === N(src.reserved_total) && c.item_label === src.item_label && del.status === 200) || { c, del: del.status };
});
await check('Z-28 使われていない確保は削除でき、明細も消える', async () => {
  const g = await create({ item_label: '消す' }, [{ sku_id: skus[8].id, reserved_qty: '1' }]);
  const r = ok(await call('DELETE', `/inventory/reservation-groups/${g.id}`, A), 'delete');
  const n = (await one('select count(*)::int n from reservations where group_id = $1', [g.id])).n;
  return (r.deleted === true && n === 0) || { r, n };
});

// ---- 一覧（Z-30）・CSV（Z-29） --------------------------------------------------
await check('Z-30 一覧は確保ごとに見出し＋明細＋確保数合計・使用数合計を返す', async () => {
  const r = ok(await call('GET', `/inventory/reservation-groups?from=${month}-01&to=${monthEnd}&partner_id=${p1.id}`, A), 'list');
  const g = r.items.find((x) => x.id === g1.id);
  const l = g?.lines.find((x) => x.sku_id === skus[0].id);
  return (g && g.lines.length === 2 && N(g.reserved_total) === 17 && N(g.consumed_total) === 3 && N(l.remaining_qty) === 9 && l.item_name.includes(`RV商品${t}`) && N(r.summary?.reserved) >= 17) || r;
});
await check('Z-30 一覧の商品名は SKU の商品名があればそれ', async () => {
  await db.query('update skus set sku_name = $1 where id = $2', [`RV個別名${t}`, skus[0].id]);
  const r = ok(await call('GET', `/inventory/reservation-groups/${g1.id}`, A), 'get');
  return r.lines.find((x) => x.sku_id === skus[0].id)?.item_name === `RV個別名${t}` || r.lines;
});
await check('Z-30 媒体で絞ると、取引先の媒体が一致する確保も出る', async () => {
  const r = ok(await call('GET', `/inventory/reservation-groups?media_id=${media2.id}&limit=200`, A), 'list');
  // gComp は取引先 p3（媒体2）で、見出しの媒体は空
  return r.items.some((x) => x.id === gComp.id) && !r.items.some((x) => x.id === gMedia.id) || r.items.map((x) => x.id);
});
await check('Z-30 商品・販売カテゴリーで絞れる', async () => {
  const a = ok(await call('GET', `/inventory/reservation-groups?sku_id=${skus[2].id}&sales_category_id=${catA}&limit=200`, A), 'list');
  const b = ok(await call('GET', `/inventory/reservation-groups?sku_id=${skus[2].id}&sales_category_id=${catB}&limit=200`, A), 'list');
  return (a.items.some((x) => x.id === gMedia.id) && !b.items.some((x) => x.id === gMedia.id)) || { a: a.total, b: b.total };
});
await check('Z-29 CSV は BOM 付きで、一覧と同じ列の並び、1明細1行（見出しの列は各行に繰り返す）', async () => {
  const res = await fetch(`${B}/inventory/reservation-groups/export?partner_id=${p1.id}`, { headers: { authorization: `Bearer ${A}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  const rows = text.replace(/^﻿/, '').trim().split('\r\n');
  const head = rows[0].replace(/"/g, '');
  const want = '販売期間,媒体,取引先,販売カテゴリー,項目,備考,商品分類コード,商品分類,商品コード,商品名,確保数,使用数,残り,確保数合計,使用数合計';
  const mine = rows.filter((r) => r.includes(`RV販売先1-${t}`));
  const first = mine.find((r) => r.includes(skus[0].sku_code));
  const okBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return (res.status === 200 && okBom && head === want && mine.length === 2 && /,12,3,9,17,3$/.test(first ?? '') && mine.every((r) => r.startsWith(`"${month.replace('-', '/')}/01〜`))) || { status: res.status, okBom, head, mine };
});
await check('CSV は印刷の権限が無いと 403（閲覧者）', async () => {
  const pass = await db.query("select 1 from users where login_id = 'viewer1'");
  if (pass.rowCount === 0) return true; // smoke の外で流したときは閲覧者がいない
  try {
    const V = await login('viewer1');
    const r = await call('GET', '/inventory/reservation-groups/export', V);
    return r.status === 403 || r.status;
  } catch { return true; }
});

// ---- 商品の候補（Z-26） ---------------------------------------------------------
await check('Z-26 商品分類を渡すと、明細の商品の候補がその分類の商品だけになる', async () => {
  const r = ok(await call('GET', `/inventory/reservation-groups/sku-options?q=RV&product_class_id=${pclass.id}&limit=100`, A), 'options');
  const all = ok(await call('GET', `/inventory/reservation-groups/sku-options?q=RVX${t}`, A), 'options all');
  return (r.length > 0 && r.every((x) => N(x.product_class_id) === pclass.id) && !r.some((x) => x.sku_id === otherSku.id) && all.some((x) => x.sku_id === otherSku.id)) || { r, all };
});

// ---- 翌月への複写 -----------------------------------------------------------------
await check('前月の確保を翌月に複写すると、見出しごとに明細も写り、使用数は 0 から', async () => {
  // ほかのデータと混ざらない月で試す
  const src = ok(await call('POST', '/inventory/reservation-groups', A, { period_from: '2001-01-05', period_to: '2001-01-20', partner_id: p1.id, sales_category_id: catA, item_label: `複写${t}`, lines: [{ sku_id: skus[0].id, reserved_qty: '3' }, { sku_id: skus[1].id, reserved_qty: '4' }] }), 'src');
  await db.query('update reservations set consumed_qty = 1 where group_id = $1', [src.id]);
  const r = ok(await call('POST', '/inventory/reservation-groups/copy-month', A, { from_month: '2001-01', to_month: '2001-02' }), 'copy');
  const g = await one(`select id, period_from::text pf, period_to::text pt from reservation_groups where item_label = $1 and period_from = '2001-02-01'`, [`複写${t}`]);
  const ls = (await db.query('select reserved_qty, consumed_qty, period_from::text pf from reservations where group_id = $1 order by id', [g?.id ?? 0])).rows;
  return (r.copied === 1 && r.lines === 2 && g?.pt === '2001-02-28' && ls.length === 2 && ls.every((l) => N(l.consumed_qty) === 0 && l.pf === '2001-02-01')) || { r, g, ls };
});
await check('同じ月にもう一度複写しても二重にならない', async () => {
  const r = ok(await call('POST', '/inventory/reservation-groups/copy-month', A, { from_month: '2001-01', to_month: '2001-02' }), 'copy');
  return (r.copied === 0 && r.skipped >= 1) || r;
});

// ---- 古い経路（明細1行ずつ）との互換 -------------------------------------------------
await check('古い経路 POST /inventory/reservations は明細1行の確保を作り、GET で残数が見える', async () => {
  const r = ok(await call('POST', '/inventory/reservations', A, { sales_category_id: catB, sku_id: skus[8].id, period_from: `${month}-01`, period_to: monthEnd, reserved_qty: '6' }), 'old post');
  const l = ok(await call('GET', `/inventory/reservations?sku_id=${skus[8].id}&on=${today}`, A), 'old get');
  const row = l.items.find((x) => x.id === r.id);
  const p = ok(await call('PATCH', `/inventory/reservations/${r.id}`, A, { reserved_qty: '8' }), 'old patch');
  const d = ok(await call('DELETE', `/inventory/reservations/${r.id}`, A), 'old delete');
  const left = (await one('select count(*)::int n from reservation_groups where id = $1', [r.group_id])).n;
  return (r.group_id > 0 && N(row?.remaining_qty) === 6 && row?.group_id === r.group_id && N(p.reserved_qty) === 8 && d.deleted && left === 0) || { r, row, p, d, left };
});

// ---- 操作履歴 -------------------------------------------------------------------------
await check('確保の登録・変更が操作履歴に残る', async () => {
  const r = await one(`select count(*)::int n from audit_logs where ref_table = 'reservation_groups' and ref_id = $1`, [g1.id]);
  return r.n >= 2 || r;
});

await db.end();
process.exit(ng === 0 ? 0 : 1);
