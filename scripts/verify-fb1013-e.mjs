// 2026-10-13 顧客フィードバック（受注処理編）のうち、受注一覧（O-15〜O-22、O-19 のまとめて引当の入口）の回帰確認（担当 E）。
// 使い捨ての API・DB に対して流す。
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は HE＋時刻。受注は自分で作る（ほかの受注は変えない）。設定 ALLOCATION_TIMING は manual のまま使う。
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
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
/** GET /order-list（limit 200）の id の並び */
const list = async (params, token) => ok(await call('GET', `/order-list?${qs({ limit: 200, ...params })}`, token ?? A), `list ${qs(params)}`);
const ids = async (params) => (await list(params)).items.map((r) => r.id);
const sameSet = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
const facets = async (params) => ok(await call('GET', `/order-list/facets?${qs(params)}`, A), `facets ${qs(params)}`);
const countOf = (rows, value) => rows.find((r) => r.value === String(value))?.count ?? 0;

const A = await login('admin');
const V = await login('viewer1');
const jstNow = Date.now() + 9 * 3600e3;
const today = new Date(jstNow).toISOString().slice(0, 10);
const day = (n) => new Date(jstNow + n * 86400e3).toISOString().slice(0, 10);
const t = String(Date.now()).slice(-6);
const P = `HE${t}`;

// ---- 準備（接頭辞 HE） --------------------------------------------------------
// 納品先の無い受注（直送・サンプル）は「コニー倉庫」から引き当てるので、在庫も納品先の既定倉庫もそこにそろえる
const warehouse = Number((await one("select id from warehouses where is_active order by (short_name = 'コニー倉庫') desc, sort_order nulls last, id limit 1")).id);
const category = Number((await one('select id from sales_categories where is_active order by id limit 1')).id);
const staff = Number((await one('select id from sales_staff where is_active order by id limit 1')).id);
const color = await one('select id, name from colors where is_active order by id limit 1');
const size = await one('select id, name from sizes where is_active order by id limit 1');
const dtCodes = await all("select c.id, c.code, c.name from codes c join code_categories cc on cc.id = c.code_category_id where cc.code = 'DELIVERY_TIME' and c.is_active order by c.sort_order");
const otherCode = Number((await one("select c.id from codes c join code_categories cc on cc.id = c.code_category_id where cc.code <> 'DELIVERY_TIME' order by c.id limit 1")).id);
const freshJan = async () => {
  for (;;) {
    const j = '49' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0');
    if (!(await one('select 1 from skus where jan = $1 or fba_jan = $1 union all select 1 from partner_products where partner_jan = $1 or shipping_jan = $1', [j]))) return j;
  }
};
const [J1, J2, J3, J4, J5] = [await freshJan(), await freshJan(), await freshJan(), await freshJan(), await freshJan()];

const partner = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}P`, name1: `${P}取引先`, is_customer: true }), 'partner');
const partner2 = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}Q`, name1: `${P}取引先二`, is_customer: true }), 'partner2');
const dest = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: partner.id, delivery_code: `${P}D`, name: `${P}納品先`, default_warehouse_id: warehouse }), 'dest');
const product = ok(await call('POST', '/masters/products', A, { product_code: P, product_name: `${P}商品`, cost_price: '100' }), 'product');
const sku1 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}-0101-100`, jan: J1, color_id: Number(color.id), size_id: Number(size.id) }), 'sku1');
const sku2 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}-0102-100`, jan: J2 }), 'sku2');
const sku3 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}-0103-100`, jan: J3 }), 'sku3');
const pp1 = ok(await call('POST', '/masters/partner-products', A, { partner_id: partner.id, sku_id: sku1.id, unit_price: '1000', shipping_jan: J4, partner_jan: J5 }), 'partner product');
// 在庫: SKU1 10、SKU2 3（受注は 5 → 足りない）、SKU3 2（2つの受注が 2 ずつ → 出荷日の早いほうだけ引き当たる）
const rc = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: warehouse, planned_date: today, lines: [
  { line_no: 1, sku_id: sku1.id, qty: '10' }, { line_no: 2, sku_id: sku2.id, qty: '3' }, { line_no: 3, sku_id: sku3.id, qty: '2' },
] }), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');

const line = (sku, qty, extra = {}) => ({ line_no: 1, line_type: '商品', sku_id: sku.id, item_name: `${P}明細`, qty: String(qty), unit_price: '1000', ...extra });
const order = async (body, what) => ok(await call('POST', '/orders', A, { order_date: today, sales_category_id: category, ...body }), what);
const wholesale = (o) => ({ order_type: '卸', partner_id: partner.id, delivery_destination_id: dest.id, sales_staff_id: staff, ...o });

const O1 = await order(wholesale({ ship_date: day(3), delivery_date: day(4), po_no: `${P}PO1`, shipping_remarks: `${P}出荷備考`, delivery_note_remarks: `${P}納品備考`,
  lines: [line(sku1, 2, { partner_product_id: pp1.id, item_name: `${P}品名` })] }), 'O1');
const O2 = await order(wholesale({ ship_date: day(1), lines: [line(sku2, 5)] }), 'O2');
const O3 = await order(wholesale({ ship_date: null, lines: [line(sku1, 1)] }), 'O3');
const O4 = await order({ order_type: '直送', partner_id: partner.id, sales_staff_id: staff, direct_name: `${P}お届け`, direct_address1: '大阪府', ship_date: day(2), lines: [line(sku1, 1)] }, 'O4');
// サンプル（取引先・販売カテゴリーなし。O-14）。受注入力の API がまだ受けない間は、卸で作って取引先を外す
let O5r = await call('POST', '/orders', A, { order_type: 'サンプル', partner_id: null, sales_category_id: null, order_date: today, direct_name: `${P}サンプル先`, ship_date: day(2), lines: [line(sku1, 1)] });
if (O5r.status >= 300) {
  O5r = { body: await order({ order_type: '直送', partner_id: partner.id, direct_name: `${P}サンプル先`, ship_date: day(2), lines: [line(sku1, 1)] }, 'O5 fallback') };
  await db.query("update sales_orders set order_type = 'サンプル', partner_id = null, sales_category_id = null, sales_staff_id = null, is_billable = false where id = $1", [O5r.body.id]);
}
const O5 = O5r.body;
// 返品（数量・金額はマイナスで登録される。O-44）。受注入力の API がまだ受けない間は、直送で作って返品にする
let O6r = await call('POST', '/orders', A, { order_type: '返品', partner_id: partner2.id, sales_category_id: category, order_date: today, ship_date: day(2), lines: [line(sku1, 1)] });
if (O6r.status >= 300) {
  O6r = { body: await order({ order_type: '直送', partner_id: partner2.id, direct_name: `${P}返品元`, ship_date: day(2), lines: [line(sku1, 1)] }, 'O6 fallback') };
  await db.query("update sales_orders set order_type = '返品' where id = $1", [O6r.body.id]);
  await db.query('update sales_order_lines set qty = -qty, amount = -amount where sales_order_id = $1', [O6r.body.id]);
}
const O6 = O6r.body;
const O7 = await order({ order_type: '卸', partner_id: partner2.id, delivery_destination_id: dest.id, ship_date: day(5), lines: [line(sku1, 1)] }, 'O7');
ok(await call('POST', `/orders/${O7.id}/cancel`, A), 'cancel O7');
const O8 = await order(wholesale({ ship_date: day(4), lines: [line(sku3, 2)] }), 'O8');
const O9 = await order(wholesale({ ship_date: day(1), lines: [line(sku3, 2)] }), 'O9');
const MINE = [O1, O2, O3, O4, O5, O6, O8, O9].map((o) => o.id);

// ---- O-15〜O-18 一覧・既定の絞り込み・並び --------------------------------------
await check('準備: 登録した受注は引当待ち（manual。登録だけでは引き当てない）', async () => {
  const rows = await all('select order_no, status from sales_orders where id = any($1)', [MINE]);
  return rows.every((r) => r.status === '引当待ち') || rows;
});
await check('O-15 一覧の行に納品日・納品時間・出荷依頼書備考・納品書備考・先方発注番号が載り、受注日は載らない', async () => {
  const r = (await list({ q: `${P}PO1` })).items[0];
  const good = r?.id === O1.id && r.delivery_date === day(4) && 'delivery_time_name' in r && 'delivery_time_code_id' in r && r.shipping_remarks === `${P}出荷備考`
    && r.delivery_note_remarks === `${P}納品備考` && r.po_no === `${P}PO1` && !('order_date' in r) && r.delivery_code === `${P}D` && r.delivery_name === `${P}納品先`;
  return good || r;
});
await check('O-18 取消は既定で出ず、「取消も表示」・状態「取消」で出る', async () => {
  const a = await ids({ q: P });
  const b = await ids({ q: P, include_cancelled: 'true' });
  const c = await ids({ q: P, status: '取消' });
  return (sameSet(a, MINE) && sameSet(b, [...MINE, O7.id]) && sameSet(c, [O7.id])) || { a, b, c, mine: MINE, o7: O7.id };
});
await check('O-18 状態を複数で絞る（既定の 引当待ち,引当済）／引当済だけ', async () => {
  const a = await ids({ q: P, status: '引当待ち,引当済' });
  const b = await ids({ q: P, status: '引当済' });
  return (sameSet(a, MINE) && b.length === 0) || { a, b };
});
await check('O-18 並びの既定は出荷日の新しい順（空は後、同じ日は受注番号の新しい順）', async () => {
  const got = await ids({ q: P });
  const want = (await all('select id from sales_orders where id = any($1) order by ship_date desc nulls last, order_no desc', [MINE])).map((r) => Number(r.id));
  return (JSON.stringify(got) === JSON.stringify(want) && got[got.length - 1] === O3.id) || { got, want };
});
await check('O-18 受注番号の新しい順（sort=order_no）', async () => {
  const got = await ids({ q: P, sort: 'order_no' });
  const want = (await all('select id from sales_orders where id = any($1) order by order_no desc', [MINE])).map((r) => Number(r.id));
  return JSON.stringify(got) === JSON.stringify(want) || { got, want };
});
await check('件数は全体の件数（limit・offset で切っても total は同じ）', async () => {
  const a = ok(await call('GET', `/order-list?${qs({ q: P, limit: 3, offset: 0 })}`, A), 'p1');
  const b = ok(await call('GET', `/order-list?${qs({ q: P, limit: 3, offset: 6 })}`, A), 'p3');
  return (a.total === MINE.length && a.items.length === 3 && b.total === MINE.length && b.items.length === MINE.length - 6) || { a: [a.total, a.items.length], b: [b.total, b.items.length] };
});
await check('O-17 出荷日の範囲・納品日の範囲で絞る', async () => {
  const a = await ids({ q: P, ship_from: day(2), ship_to: day(3) });
  const b = await ids({ q: P, delivery_from: day(4), delivery_to: day(4) });
  const c = await ids({ q: P, ship_from: day(4) });
  return (sameSet(a, [O1.id, O4.id, O5.id, O6.id]) && sameSet(b, [O1.id]) && sameSet(c, [O8.id])) || { a, b, c };
});

// ---- O-16 キーワード --------------------------------------------------------------
const kw = [
  ['受注番号', O2.order_no, [O2.id]],
  ['先方発注番号', `${P}PO1`, [O1.id]],
  ['取引先コード', `${P}Q`, [O6.id]],
  ['取引先名', `${P}取引先二`, [O6.id]],
  ['納品先コード', `${P}D`, [O1.id, O2.id, O3.id, O8.id, O9.id]],
  ['納品先名', `${P}納品先`, [O1.id, O2.id, O3.id, O8.id, O9.id]],
  ['お届け先のお名前', `${P}サンプル先`, [O5.id]],
  ['出荷依頼書備考', `${P}出荷備考`, [O1.id]],
  ['納品書備考', `${P}納品備考`, [O1.id]],
  ['明細の商品コード', `${P}-0103`, [O8.id, O9.id]],
  ['明細の品名', `${P}品名`, [O1.id]],
  ['SKU の JAN', J2, [O2.id]],
  ['得意先別商品の出荷JAN', J4, [O1.id, O3.id, O4.id]],
  ['得意先別商品の先方JAN', J5, [O1.id, O3.id, O4.id]],
  ['空白で区切ると全部を含む受注（AND）', `${P}D ${P}-0103`, [O8.id, O9.id]],
  ['空白で区切って合わないものは出ない', `${P}PO1 ${P}-0102`, []],
  ['% は文字として探す（全件にならない）', `${P} %`, []],
];
for (const [what, q, want] of kw) {
  await check(`O-16 キーワード：${what}`, async () => {
    const got = await ids({ q });
    return sameSet(got, want) || { q, got, want };
  });
}

// ---- O-20 列の絞り込み（区分・取引先・納品先・販売カテゴリー・販売担当） ------------------
await check('O-20 区分を複数で絞る', async () => {
  const a = await ids({ q: P, order_type: '直送' });
  const b = await ids({ q: P, order_type: 'サンプル,返品' });
  return (sameSet(a, [O4.id]) && sameSet(b, [O5.id, O6.id])) || { a, b };
});
await check('O-20 取引先を複数で絞る（none＝取引先の無い受注）', async () => {
  const a = await ids({ q: P, partner_ids: String(partner2.id) });
  const b = await ids({ q: P, partner_ids: 'none' });
  const c = await ids({ q: P, partner_ids: `${partner.id},none` });
  return (sameSet(a, [O6.id]) && sameSet(b, [O5.id]) && sameSet(c, MINE.filter((x) => x !== O6.id))) || { a, b, c };
});
await check('O-20 納品先・販売カテゴリー・販売担当で絞る（none も）', async () => {
  const a = await ids({ q: P, destination_ids: String(dest.id) });
  const b = await ids({ q: P, destination_ids: 'none' });
  const c = await ids({ q: P, sales_category_ids: 'none' });
  const d = await ids({ q: P, sales_staff_ids: String(staff) });
  const e = await ids({ q: P, sales_staff_ids: 'none' });
  const good = sameSet(a, [O1.id, O2.id, O3.id, O8.id, O9.id]) && sameSet(b, [O4.id, O5.id, O6.id]) && sameSet(c, [O5.id])
    && sameSet(d, [O1.id, O2.id, O3.id, O4.id, O8.id, O9.id]) && sameSet(e, [O5.id, O6.id]);
  return good || { a, b, c, d, e };
});
await check('O-20 絞り込みの値が正しくなければ 400（状態・ID・並び・列）', async () => {
  const a = await call('GET', `/order-list?status=${encodeURIComponent('出荷待ち')}`, A);
  const b = await call('GET', '/order-list?partner_ids=abc', A);
  const c = await call('GET', '/order-list?sort=ship', A);
  const d = await call('GET', '/order-list/facets?field=foo', A);
  return (a.status === 400 && b.status === 400 && c.status === 400 && d.status === 400) || [a.status, b.status, c.status, d.status];
});
await check('O-20 値の一覧（区分）：6つの区分をすべて並べ、件数を添える', async () => {
  const f = await facets({ q: P, field: 'type' });
  const good = JSON.stringify(f.map((x) => x.value)) === JSON.stringify(['卸', '直送', '通販', '社内移動', 'サンプル', '返品'])
    && countOf(f, '卸') === 5 && countOf(f, '直送') === 1 && countOf(f, 'サンプル') === 1 && countOf(f, '返品') === 1 && countOf(f, '通販') === 0;
  return good || f;
});
await check('O-20 値の一覧は自分の列の絞り込みを外して数え、ほかの列の絞り込みは当てる（Excel と同じ）', async () => {
  const a = await facets({ q: P, field: 'type', order_type: '直送' });
  const b = await facets({ q: P, field: 'partner', order_type: '直送' });
  return (countOf(a, '卸') === 5 && countOf(a, '直送') === 1 && b.length === 1 && countOf(b, partner.id) === 1) || { a, b };
});
await check('O-20 値の一覧（取引先・納品先・販売カテゴリー・販売担当）：件数・名前・空の値（none）', async () => {
  const p = await facets({ q: P, field: 'partner' });
  const d = await facets({ q: P, field: 'destination' });
  const c = await facets({ q: P, field: 'category' });
  const s = await facets({ q: P, field: 'staff' });
  const good = countOf(p, partner.id) === 6 && countOf(p, partner2.id) === 1 && countOf(p, 'none') === 1
    && p.find((x) => x.value === String(partner.id))?.label === `${P}取引先` && p.find((x) => x.value === String(partner.id))?.code === `${P}P`
    && countOf(d, dest.id) === 5 && countOf(d, 'none') === 3 && countOf(c, category) === 7 && countOf(c, 'none') === 1
    && countOf(s, staff) === 6 && countOf(s, 'none') === 2;
  return good || { p, d, c, s };
});
await check('O-20 値の一覧（状態）：取消は数えない（「取消も表示」でも）', async () => {
  const a = await facets({ q: P, field: 'status', include_cancelled: 'true' });
  return (countOf(a, '引当待ち') === MINE.length && !a.some((x) => x.value === '取消') && a.some((x) => x.value === '出荷済')) || a;
});

// ---- 取引先の無い受注・返品の見せ方、O-21 明細 ------------------------------------------
await check('サンプル（取引先なし）：取引先は空、納品先の欄はお届け先のお名前', async () => {
  const r = (await list({ q: `${P}サンプル先` })).items[0];
  return (r?.partner_id === null && r.partner_name === null && r.sales_category_id === null && r.delivery_name === `${P}サンプル先` && r.direct_name === `${P}サンプル先`) || r;
});
await check('返品：金額はマイナス', async () => {
  const r = (await list({ q: `${P}Q` })).items[0];
  return (r?.id === O6.id && r.order_type === '返品' && Number(r.total_amount) < 0) || r;
});
await check('O-21 with_lines で明細を一緒に返す（品名・カラー・サイズ・JAN は帳票と同じ出荷JAN・適用）', async () => {
  const r = (await list({ q: `${P}PO1`, with_lines: 'true' })).items[0];
  const l = r?.lines?.[0];
  const good = r?.lines?.length === 1 && l.sku_code === `${P}-0101-100` && l.item_name === `${P}品名` && l.color_name === color.name && l.size_name === size.name
    && l.jan === J4 && Number(l.qty) === 2 && Number(l.unit_price) === 1000 && Number(l.amount) === 2000 && 'shipping_note' in l && 'delivery_slip_note' in l && typeof l.id === 'number';
  return good || r;
});
await check('O-21 JAN：取引先の無い受注は SKU の JAN（コニーJAN）、明細を頼まなければ lines は返さない', async () => {
  const a = (await list({ q: `${P}サンプル先`, with_lines: 'true' })).items[0];
  const b = (await list({ q: `${P}PO1` })).items[0];
  return (a?.lines?.[0]?.jan === J1 && b && !('lines' in b)) || { a: a?.lines, b };
});
await check('納品時間の選択肢（DELIVERY_TIME の5つ）', async () => {
  const r = ok(await call('GET', '/order-list/delivery-times', A), 'times');
  return (r.length === dtCodes.length && r.length >= 5 && r[0].name === dtCodes[0].name) || r;
});

// ---- 権限 ----------------------------------------------------------------------------
await check('権限：閲覧のみの人は一覧・値の一覧は見られるが、まとめて引当・一覧のまま修正はできない', async () => {
  const a = await call('GET', `/order-list?${qs({ q: P })}`, V);
  const b = await call('GET', `/order-list/facets?${qs({ q: P, field: 'partner' })}`, V);
  const c = await call('POST', '/order-list/allocate', V, { order_ids: [O2.id] });
  const d = await call('PATCH', `/order-list/${O2.id}`, V, { shipping_remarks: 'x' });
  const st = await one('select status, shipping_remarks from sales_orders where id = $1', [O2.id]);
  return (a.status === 200 && b.status === 200 && c.status === 403 && d.status === 403 && st.status === '引当待ち' && st.shipping_remarks === null) || [a.status, b.status, c.status, d.status, st];
});

// ---- O-19 まとめて引当 ------------------------------------------------------------------
const NOPE = 2147483000;
let bulk = null;
await check('O-19 まとめて引当：選んだ順ではなく出荷日の早い順（空は後）・同じ日は受注番号順に引き当て、受注ごとの結果を返す', async () => {
  bulk = ok(await call('POST', '/order-list/allocate', A, { order_ids: [O3.id, O1.id, O2.id, O4.id, O7.id, O8.id, O9.id, NOPE] }), 'allocate');
  const got = bulk.map((r) => r.order_id);
  const want = [O2.id, O9.id, O4.id, O1.id, O8.id, O7.id, O3.id, NOPE];
  const shape = bulk.every((r) => 'order_no' in r && 'status' in r && Array.isArray(r.shortages) && 'error' in r);
  return (JSON.stringify(got) === JSON.stringify(want) && shape) || { got, want, bulk };
});
const res = (id) => bulk?.find((r) => r.order_id === id);
await check('O-19 結果：全部取れた受注は引当済、足りない受注は引当待ち（足りない内容つき）', async () => {
  const good = [O9, O4, O1, O3].every((o) => res(o.id)?.status === '引当済' && res(o.id)?.error === null)
    && res(O2.id)?.status === '引当待ち' && res(O2.id)?.shortages.length > 0 && res(O2.id)?.error === null;
  return good || bulk;
});
await check('O-19 出荷日の早い受注から在庫を取る（同じ商品を取り合うと、出荷日の遅い受注が引当待ち）', async () => {
  return (res(O9.id)?.status === '引当済' && res(O8.id)?.status === '引当待ち' && res(O8.id)?.shortages.some((s) => s.includes(`${P}-0103-100`))) || { o9: res(O9.id), o8: res(O8.id) };
});
await check('O-19 一部が失敗しても続ける（取消の受注・無い受注はエラー、そのあとの受注も引き当てる）', async () => {
  const good = typeof res(O7.id)?.error === 'string' && res(O7.id).error.includes('取り消') && res(O7.id).status === '取消'
    && typeof res(NOPE)?.error === 'string' && res(O3.id)?.status === '引当済';
  return good || { o7: res(O7.id), nope: res(NOPE), o3: res(O3.id) };
});
await check('O-19 データベースの状態が結果と同じ（引当済には出荷の行ができる）', async () => {
  const rows = await all(
    `select o.id, o.status, exists (select 1 from shipments sh where sh.sales_order_id = o.id and sh.status <> '削除') as has_shipment
       from sales_orders o where o.id = any($1)`, [[O1.id, O2.id, O3.id, O4.id, O8.id, O9.id]]);
  const by = new Map(rows.map((r) => [Number(r.id), r]));
  const good = [O1, O3, O4, O9].every((o) => by.get(o.id)?.status === '引当済' && by.get(o.id)?.has_shipment === true)
    && [O2, O8].every((o) => by.get(o.id)?.status === '引当待ち' && by.get(o.id)?.has_shipment === false);
  return good || rows;
});
await check('O-19 まとめて引当は操作履歴に結果ごと残る', async () => {
  const r = await one(
    `select after_data::text as a from audit_logs where ref_table = 'sales_orders' and ref_id is null and action = 'update'
      and after_data::text like $1 order by id desc limit 1`, [`%${O9.order_no}%`]);
  return (!!r && r.a.includes('order_ids')) || r;
});
await check('O-19 引き当てる受注を選ばないと 400', async () => {
  const r = await call('POST', '/order-list/allocate', A, { order_ids: [] });
  return r.status === 400 || r;
});

// ---- O-22 一覧のまま修正 -----------------------------------------------------------------
const lineOf = async (orderId) => Number((await one('select id from sales_order_lines where sales_order_id = $1 order by line_no limit 1', [orderId])).id);
const allocSnap = async (orderId) => (await all(
  `select a.id, a.qty::text, a.status from allocations a join sales_order_lines l on l.id = a.sales_order_line_id
    where l.sales_order_id = $1 order by a.id`, [orderId])).map((r) => `${r.id}:${r.qty}:${r.status}`).join(',');
const L1 = await lineOf(O1.id);
const dt = dtCodes[0];
await check('O-22 出荷日・納品日・納品時間・備考・明細の適用を直す（引当は変わらず、出荷の予定日がそろう）', async () => {
  const before = await allocSnap(O1.id);
  const moves = Number((await one("select count(*) as n from stock_movements where ref_table = 'sales_order_lines' and ref_id = $1", [L1])).n);
  const r = ok(await call('PATCH', `/order-list/${O1.id}`, A, {
    ship_date: day(6), delivery_date: day(7), delivery_time_code_id: Number(dt.id),
    shipping_remarks: `${P}直した出荷備考`, delivery_note_remarks: `${P}直した納品備考`,
    lines: [{ id: L1, shipping_note: `${P}出荷適用`, delivery_slip_note: `${P}納品適用` }],
  }), 'patch');
  const o = await one('select status, ship_date::text, delivery_date::text, delivery_time_code_id, shipping_remarks, delivery_note_remarks from sales_orders where id = $1', [O1.id]);
  const l = await one('select shipping_note, delivery_slip_note from sales_order_lines where id = $1', [L1]);
  const sh = await one("select planned_ship_date::text as d from shipments where sales_order_id = $1 and status <> '削除'", [O1.id]);
  const after = await allocSnap(O1.id);
  const moves2 = Number((await one("select count(*) as n from stock_movements where ref_table = 'sales_order_lines' and ref_id = $1", [L1])).n);
  const good = o.status === '引当済' && o.ship_date === day(6) && o.delivery_date === day(7) && Number(o.delivery_time_code_id) === Number(dt.id)
    && o.shipping_remarks === `${P}直した出荷備考` && o.delivery_note_remarks === `${P}直した納品備考`
    && l.shipping_note === `${P}出荷適用` && l.delivery_slip_note === `${P}納品適用`
    && sh?.d === day(6) && before === after && before !== '' && moves === moves2
    && r.id === O1.id && r.delivery_time_name === dt.name && r.lines?.[0]?.shipping_note === `${P}出荷適用` && r.ship_date === day(6);
  return good || { o, l, sh, before, after, moves, moves2, r };
});
await check('O-22 渡した項目だけ直す（明細の適用だけ・空にすると空）', async () => {
  ok(await call('PATCH', `/order-list/${O1.id}`, A, { lines: [{ id: L1, shipping_note: '' }] }), 'patch line only');
  const o = await one('select ship_date::text, shipping_remarks from sales_orders where id = $1', [O1.id]);
  const l = await one('select shipping_note, delivery_slip_note from sales_order_lines where id = $1', [L1]);
  return (o.ship_date === day(6) && o.shipping_remarks === `${P}直した出荷備考` && l.shipping_note === null && l.delivery_slip_note === `${P}納品適用`) || { o, l };
});
await check('O-22 出荷日・納品時間は空にもできる（出荷の予定日も空に）', async () => {
  ok(await call('PATCH', `/order-list/${O1.id}`, A, { ship_date: '', delivery_time_code_id: null }), 'clear');
  const o = await one('select ship_date, delivery_time_code_id, status from sales_orders where id = $1', [O1.id]);
  const sh = await one("select planned_ship_date from shipments where sales_order_id = $1 and status <> '削除'", [O1.id]);
  ok(await call('PATCH', `/order-list/${O1.id}`, A, { ship_date: day(6) }), 'restore');
  return (o.ship_date === null && o.delivery_time_code_id === null && o.status === '引当済' && sh?.planned_ship_date === null) || { o, sh };
});
await check('O-22 一覧のまま修正は操作履歴に変更前後が残る', async () => {
  const r = await one(
    `select before_data::text as b, after_data::text as a from audit_logs where ref_table = 'sales_orders' and ref_id = $1 and action = 'update'
      and after_data::text like $2 order by id asc limit 1`, [O1.id, `%${P}直した出荷備考%`]);
  return (!!r && r.b.includes(`${P}出荷備考`)) || r;
});
await check('O-22 納品時間に別の区分の値・ほかの受注の明細・直せない項目・長すぎる適用は 400', async () => {
  const a = await call('PATCH', `/order-list/${O1.id}`, A, { delivery_time_code_id: otherCode });
  const b = await call('PATCH', `/order-list/${O1.id}`, A, { lines: [{ id: await lineOf(O2.id), shipping_note: 'x' }] });
  const c = await call('PATCH', `/order-list/${O1.id}`, A, { status: '出荷済' });
  const d = await call('PATCH', `/order-list/${O1.id}`, A, { lines: [{ id: L1, delivery_slip_note: 'x'.repeat(201) }] });
  const l = await one('select delivery_slip_note from sales_order_lines where id = $1', [L1]);
  return (a.status === 400 && b.status === 400 && c.status === 400 && d.status === 400 && l.delivery_slip_note === `${P}納品適用`) || [a, b, c, d].map((x) => x.status);
});
await check('O-22 出荷済の受注は出荷日を直せない（400）。納品日・備考は直せる', async () => {
  const sh = await one("select id from shipments where sales_order_id = $1 and status <> '削除'", [O4.id]);
  ok(await call('POST', `/shipments/${sh.id}/confirm`, A, { ship_date: today }), 'confirm O4');
  const a = await call('PATCH', `/order-list/${O4.id}`, A, { ship_date: day(9) });
  const b = await call('PATCH', `/order-list/${O4.id}`, A, { delivery_date: day(9), shipping_remarks: `${P}出荷後の備考` });
  const c = await call('PATCH', `/order-list/${O4.id}`, A, { ship_date: day(2) }); // 今と同じ出荷日は通す（変えていない）
  const o = await one('select status, ship_date::text, delivery_date::text, shipping_remarks from sales_orders where id = $1', [O4.id]);
  const good = a.status === 400 && JSON.stringify(a.body).includes('出荷') && b.status === 200 && c.status === 200
    && o.status === '出荷済' && o.ship_date === day(2) && o.delivery_date === day(9) && o.shipping_remarks === `${P}出荷後の備考`;
  return good || { a, b: b.status, c: c.status, o };
});
await check('O-22 取り消した受注は直せない', async () => {
  const r = await call('PATCH', `/order-list/${O7.id}`, A, { shipping_remarks: 'x' });
  const o = await one('select shipping_remarks from sales_orders where id = $1', [O7.id]);
  return (r.status === 400 && o.shipping_remarks === null) || { r, o };
});
await check('O-22 無い受注は 404', async () => {
  const r = await call('PATCH', `/order-list/${NOPE}`, A, { shipping_remarks: 'x' });
  return r.status === 404 || r;
});

await db.end();
process.exit(ng > 0 ? 1 : 0);
