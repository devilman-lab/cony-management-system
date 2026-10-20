// 2026-10-13 顧客フィードバック（受注処理編）のうち、受注の登録と流れ（担当 B）の回帰確認。使い捨ての API・DB に対して流す。
//   O-02 社内移動・返品／O-03 納品時間／O-04・O-05 絞り込みの候補・登録した商品だけ／O-06・O-19 登録だけ・1件の引当／
//   O-07 作業指示／O-09 適用／O-10 送料の記載／O-11 非商品／O-12 委託／O-14 サンプル／O-24 詳細の明細／O-25 出荷一覧／O-44 返品
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は HB＋時刻。システム設定 ALLOCATION_TIMING は manual（既定）のまま使う（変えない）。
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
const has = (r, status, text) => r.status === status && JSON.stringify(r.body).includes(text);

const A = await login('admin');
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const month = today.slice(0, 7);
const t = String(Date.now()).slice(-6);
const P = `HB${t}`;

const timing = (await one("select value_text from system_settings where setting_key = 'ALLOCATION_TIMING'"))?.value_text;
if (timing !== 'manual') {
  console.log(`NG\t引当のタイミングが manual（登録だけ）で流す\t今の設定は ${timing}`);
  await db.end();
  process.exit(1);
}

// ---- 準備（接頭辞 HB） --------------------------------------------------------
const codeId = async (cat, code) =>
  Number((await one('select c.id from codes c join code_categories cc on cc.id = c.code_category_id where cc.code = $1 and c.code = $2', [cat, code])).id);
const DT1416 = await codeId('DELIVERY_TIME', '1416');
const GOOD = await codeId('QUALITY_DIVISION', 'GOOD');
const category = Number((await one('select id from sales_categories where is_active order by id limit 1')).id);
// カラー・サイズ・媒体・ブランド・商品分類はこの検査で作る（初期データには無い）
const color = ok(await call('POST', '/masters/simple/colors', A, { code: `${P}CL`, name: `HB色${t}` }), 'color');
const size = ok(await call('POST', '/masters/simple/sizes', A, { code: `${P}SZ`, name: `HBサイズ${t}` }), 'size');
const media = Number(ok(await call('POST', '/masters/simple/media', A, { code: `${P}MD`, name: `HB媒体${t}` }), 'media').id);
const brand = ok(await call('POST', '/masters/simple/brands', A, { code: `${P}BR`, name: `HBブランド${t}` }), 'brand');
const pclass = ok(await call('POST', '/masters/simple/product_classes', A, { code: `${P}PC`, name: `HB分類${t}`, brand_id: brand.id }), 'product class');
const freshJan = async () => {
  for (;;) {
    const j = '49' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0');
    if (!(await one('select 1 from skus where jan = $1 or fba_jan = $1 union all select 1 from partner_products where partner_jan = $1 or shipping_jan = $1', [j]))) return j;
  }
};
const J1 = await freshJan();
const J2 = await freshJan();
const J3 = await freshJan();

// 出荷倉庫（納品先の既定）と委託の入庫倉庫
const w1 = ok(await call('POST', '/masters/warehouses', A, { warehouse_code: `${P}W1`, short_name: `HB出荷${t}` }), 'w1');
const w2 = ok(await call('POST', '/masters/warehouses', A, { warehouse_code: `${P}W2`, short_name: `HB委託先${t}`, is_consignment: true }), 'w2');
const partner = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}C`, name1: `HB得意先${t}`, is_customer: true, closing_day: 99, default_trade_type: '買取', media_id: media }), 'partner');
const wi = ok(await call('POST', '/masters/simple/work_instructions', A, { code: `${P}WI`, name: `HB作業指示${t}`, instruction_body: `HB本文${t} 割れ物シールを貼る` }), 'work instruction');
const dest = ok(await call('POST', '/masters/delivery-destinations', A, {
  partner_id: partner.id, delivery_code: `${P}D`, name: `HB納品先${t}`, default_warehouse_id: w1.id, work_instruction_id: wi.id,
}), 'destination');
const product = ok(await call('POST', '/masters/products', A, {
  product_code: `${P}`, product_name: `HB商品${t} 2枚組`, cost_price: '300', brand_id: brand.id, product_class_id: pclass.id,
}), 'product');
const sku1 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}-01`, jan: J1, color_id: Number(color.id), size_id: Number(size.id) }), 'sku1');
const sku2 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}-02`, jan: J2 }), 'sku2');
const setProduct = ok(await call('POST', '/masters/products', A, { product_code: `${P}S`, product_name: `HBセット${t}`, is_set: true }), 'set product');
const setSku = ok(await call('POST', '/masters/skus', A, { product_id: setProduct.id, sku_code: `${P}-S1` }), 'set sku');
ok(await call('POST', '/masters/sets', A, { sku_id: setSku.id, components: [{ component_sku_id: sku2.id, qty: '2' }] }), 'set');
// 得意先別商品は SKU1 にだけ2行（先方コード・単価の違う行。M3-26）。SKU2 は登録しない
const pp1 = ok(await call('POST', '/masters/partner-products', A, {
  partner_id: partner.id, sku_id: sku1.id, partner_product_code: `${P}A`, sales_name: `HB販売名${t}`, unit_price: '1200', retail_price: '2400', shipping_jan: J3,
}), 'pp1');
const pp2 = ok(await call('POST', '/masters/partner-products', A, { partner_id: partner.id, sku_id: sku1.id, partner_product_code: `${P}B`, unit_price: '1100' }), 'pp2');
const rc = ok(await call('POST', '/inventory/receipts', A, {
  warehouse_id: w1.id, planned_date: today,
  lines: [{ line_no: 1, sku_id: sku1.id, qty: '10' }, { line_no: 2, sku_id: sku2.id, qty: '20' }],
}), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');

const stock = async (skuId, whId) =>
  (await one(
    `select coalesce(sum(qty_on_hand), 0)::numeric::text as on_hand, coalesce(sum(qty_allocated), 0)::numeric::text as allocated
       from stocks where sku_id = $1 and warehouse_id = $2 and quality_code_id = $3`, [skuId, whId, GOOD]));
const allocs = async (orderId) =>
  Number((await one(
    `select coalesce(sum(a.qty), 0) as q from allocations a join sales_order_lines l on l.id = a.sales_order_line_id
      where l.sales_order_id = $1 and a.status = '引当中'`, [orderId])).q);
const shipmentOf = async (orderId) => one(`select id, shipment_no, status from shipments where sales_order_id = $1 and status <> '削除'`, [orderId]);
const line = (o) => ({ line_no: 1, line_type: '商品', item_name: 'HB', qty: '1', unit_price: '1000', ...o });
const wholesale = (o) => ({
  order_type: '卸', partner_id: partner.id, delivery_destination_id: dest.id, sales_category_id: category, order_date: today, ship_date: today, ...o,
});
const create = async (body, what) => ok(await call('POST', '/orders', A, body), what);
const allocate = async (id) => ok(await call('POST', `/orders/${id}/allocate`, A), `allocate ${id}`);
const confirm = async (orderId) => {
  const sh = await shipmentOf(orderId);
  if (!sh) throw new Error(`受注 ${orderId} に出荷がありません`);
  ok(await call('POST', `/shipments/${sh.id}/confirm`, A, { ship_date: today }), `confirm ${orderId}`);
  return sh;
};

// ---- O-06 登録だけ・O-19 1件の引当 ---------------------------------------------------
const orderA = await create(wholesale({ lines: [line({ sku_id: sku1.id, qty: '15' })] }), 'order A');
await check('O-06 実在庫（10）を超える数量（15）でも登録でき、状態は引当待ち。在庫は引き当てない', async () => {
  const s = await stock(sku1.id, w1.id);
  const sh = await shipmentOf(orderA.id);
  return (orderA.status === '引当待ち' && Number(s.allocated) === 0 && (await allocs(orderA.id)) === 0 && !sh) || { status: orderA.status, s, sh };
});
await check('O-19 引当：足りなければ取れた分（10）だけ押さえ、引当待ちのまま足りない内容を返す', async () => {
  const r = await allocate(orderA.id);
  const s = await stock(sku1.id, w1.id);
  return (r.status === '引当待ち' && r.shortages.length === 1 && r.shipment_id === null && Number(s.allocated) === 10 && (await allocs(orderA.id)) === 10) || { r, s };
});
const orderB = await create(wholesale({ delivery_date: today, lines: [line({ sku_id: sku2.id, qty: '4' })] }), 'order B');
await check('O-19 引当：全部取れたら引当済になり、出荷の行ができる', async () => {
  const r = await allocate(orderB.id);
  const sh = await shipmentOf(orderB.id);
  return (r.status === '引当済' && r.shortages.length === 0 && sh?.status === '確定済' && Number(r.shipment_id) === Number(sh.id) && (await allocs(orderB.id)) === 4) || { r, sh };
});
await check('O-06 引当済の受注を直すと、直した数（5）で引き当て直す', async () => {
  const r = ok(await call('PATCH', `/orders/${orderB.id}`, A, { lines: [line({ sku_id: sku2.id, qty: '5' })] }), 'patch B');
  const s = await stock(sku2.id, w1.id);
  const sh = await shipmentOf(orderB.id);
  return (r.status === '引当済' && (await allocs(orderB.id)) === 5 && Number(s.allocated) === 5 && sh?.status === '確定済') || { r, s, sh };
});
const orderC = await create(wholesale({ lines: [line({ sku_id: sku2.id, qty: '2' })] }), 'order C');
await check('O-06 まだ引き当てていない受注を直しても引き当てない（引当待ちのまま）', async () => {
  const r = ok(await call('PATCH', `/orders/${orderC.id}`, A, { lines: [line({ sku_id: sku2.id, qty: '3' })] }), 'patch C');
  const o = await one('select status from sales_orders where id = $1', [orderC.id]);
  return (r.status === '引当待ち' && o.status === '引当待ち' && (await allocs(orderC.id)) === 0 && !(await shipmentOf(orderC.id))) || { r, o };
});
await check('O-06 一部だけ引き当てた受注を直すと、戻してから取れた分を引き当て直す', async () => {
  const r = ok(await call('PATCH', `/orders/${orderA.id}`, A, { lines: [line({ sku_id: sku1.id, qty: '12' })] }), 'patch A');
  const s = await stock(sku1.id, w1.id);
  return (r.status === '引当待ち' && r.shortages.length === 1 && (await allocs(orderA.id)) === 10 && Number(s.allocated) === 10) || { r, s };
});
ok(await call('POST', `/orders/${orderA.id}/cancel`, A), 'cancel A');
await check('取消で押さえていた分が戻る', async () => {
  const s = await stock(sku1.id, w1.id);
  return Number(s.allocated) === 0 || s;
});

// ---- O-03・O-09・O-10・O-24・O-07 納品時間・適用・送料の記載・詳細 ----------------------
const longNote = 'あ'.repeat(201);
await check('O-09 出荷依頼書適用は200文字まで', async () => {
  const r = await call('POST', '/orders', A, wholesale({ lines: [line({ sku_id: sku1.id, shipping_note: longNote })] }));
  return has(r, 400, '出荷依頼書適用は200文字以内') || r;
});
await check('O-03 納品時間は区分値「納品時間」の値だけ', async () => {
  const r = await call('POST', '/orders', A, wholesale({ delivery_time_code_id: GOOD, lines: [line({ sku_id: sku1.id })] }));
  return has(r, 400, '納品時間') || r;
});
const orderD = await create(wholesale({
  requested_delivery_date: '2026-12-01', delivery_time_code_id: DT1416, print_shipping_fee: true,
  lines: [
    line({ sku_id: sku1.id, partner_product_id: pp1.id, item_name: `HB販売名${t}`, unit_price: '1200', shipping_note: 'HB出荷依頼書適用', delivery_slip_note: 'HB納品書適用' }),
    { line_no: 2, line_type: '非商品', item_name: '作業費', qty: '1', unit_price: '500' },
  ],
}), 'order D');
await check('O-03・O-10・O-07・O-23 詳細に納品時間・送料の記載・作業指示が出る', async () => {
  const d = ok(await call('GET', `/orders/${orderD.id}`, A), 'detail D');
  const good = d.delivery_time_code_id !== null && Number(d.delivery_time_code_id) === DT1416 && d.delivery_time_name === '14:00〜16:00'
    && d.print_shipping_fee === true && d.work_instruction_name === `HB作業指示${t}` && String(d.work_instruction_body).includes(`HB本文${t}`)
    && d.partner_name === `HB得意先${t}` && d.consignment_warehouse_id === null;
  return good || { dt: d.delivery_time_name, fee: d.print_shipping_fee, wi: d.work_instruction_name, body: d.work_instruction_body };
});
await check('O-09・O-24 詳細の明細に適用・カラー・サイズ・JAN（出荷JAN）・マスタの品名が出る', async () => {
  const d = ok(await call('GET', `/orders/${orderD.id}`, A), 'detail D');
  const l = d.lines[0];
  const n = d.lines[1];
  const sku = (await one('select fn_item_name($1, $2, $3) as a, fn_item_name($4, $2, $3) as b', [`HB販売名${t}`, color.name, size.name, `HB商品${t} 2枚組`]));
  const good = l.shipping_note === 'HB出荷依頼書適用' && l.delivery_slip_note === 'HB納品書適用' && l.color_name === color.name && l.size_name === size.name
    && l.jan === J3 && l.master_item_name === sku.a && l.sku_item_name === sku.b && sku.b.endsWith('2枚組')
    && n.line_type === '非商品' && n.item_name === '作業費' && n.shipping_note === null && n.jan === null && n.master_item_name === null;
  return good || { l, n, want: sku };
});
await check('O-24 得意先別商品の出荷JANが空なら、明細の JAN はコニーJAN', async () => {
  const o = await create(wholesale({ lines: [line({ sku_id: sku1.id, partner_product_id: pp2.id })] }), 'order D2');
  const d = ok(await call('GET', `/orders/${o.id}`, A), 'detail D2');
  ok(await call('POST', `/orders/${o.id}/cancel`, A), 'cancel D2');
  return d.lines[0].jan === J1 || d.lines[0];
});
await check('修正で納品希望日を送らなければ変えない', async () => {
  ok(await call('PATCH', `/orders/${orderD.id}`, A, { delivery_note_remarks: 'HB納品書備考' }), 'patch D');
  const o = await one("select to_char(requested_delivery_date, 'YYYY-MM-DD') as r, delivery_note_remarks, delivery_time_code_id, print_shipping_fee from sales_orders where id = $1", [orderD.id]);
  return (o.r === '2026-12-01' && o.delivery_note_remarks === 'HB納品書備考' && Number(o.delivery_time_code_id) === DT1416 && o.print_shipping_fee === true) || o;
});

// ---- O-11 非商品 ------------------------------------------------------------------
await check('O-11 非商品の行は品名が必須（行番号を添える）', async () => {
  const r = await call('POST', '/orders', A, wholesale({ lines: [line({ sku_id: sku1.id }), { line_no: 2, line_type: '非商品', item_name: '', qty: '1', unit_price: '100' }] }));
  return has(r, 400, '2行目：非商品の行は品名を入れてください') || r;
});
const orderE = await create(wholesale({ lines: [{ line_no: 1, line_type: '非商品', item_name: '運賃', qty: '1', unit_price: '500' }] }), 'order E');
await check('O-11 非商品だけの受注は、引当で在庫を押さえずに引当済になり、出荷確定できる', async () => {
  const r = await allocate(orderE.id);
  const sh = await confirm(orderE.id);
  const o = await one('select status from sales_orders where id = $1', [orderE.id]);
  const s = await one("select status from shipments where id = $1", [sh.id]);
  return (orderE.status === '引当待ち' && r.status === '引当済' && r.shipment_id !== null && o.status === '出荷済' && s.status === '出荷済') || { r, o, s };
});

// ---- O-14 サンプル（取引先なし） -----------------------------------------------------
// 取引先・媒体の指定なしの確保（どの取引先の受注でも減る）。取引先の無いサンプルでは減らない
ok(await call('POST', '/inventory/reservation-groups', A, { period_from: today, period_to: today, item_label: `${P}`, lines: [{ sku_id: sku2.id, reserved_qty: '5' }] }), 'reservation');
const frame = async () => one('select consumed_qty from reservations where sku_id = $1', [sku2.id]);
await check('O-14 サンプルはお届け先のお名前が必須', async () => {
  const r = await call('POST', '/orders', A, { order_type: 'サンプル', order_date: today, lines: [line({ sku_id: sku2.id })] });
  return has(r, 400, 'サンプルの受注ではお届け先のお名前を入力してください') || r;
});
const sample = await create({
  order_type: 'サンプル', trade_type: '委託', order_date: today, ship_date: today, ship_from_warehouse_id: w1.id, direct_name: `HBサンプル様${t}`, direct_postal_code: '5410052',
  lines: [line({ sku_id: sku2.id, qty: '1', unit_price: '0' })],
}, 'sample');
await check('O-14 取引先・販売カテゴリーなしでサンプルを登録できる（売上に計上しない・取引条件は買取・引当待ち）', async () => {
  const o = await one('select partner_id, sales_category_id, is_billable, trade_type, status, consignment_warehouse_id from sales_orders where id = $1', [sample.id]);
  return (sample.status === '引当待ち' && o.partner_id === null && o.sales_category_id === null && o.is_billable === false && o.trade_type === '買取' && o.consignment_warehouse_id === null) || o;
});
await check('O-14 取引先が空のサンプルは引当在庫（確保数）を減らさない', async () => {
  const f = await frame();
  return Number(f.consumed_qty) === 0 || f;
});
await check('手入力の受注は今どおり登録時に引当在庫（確保数）から減らし、超えれば登録できない', async () => {
  const over = await call('POST', '/orders', A, wholesale({ lines: [line({ sku_id: sku2.id, qty: '6' })] }));
  const o = await create(wholesale({ lines: [line({ sku_id: sku2.id, qty: '2' })] }), 'framed order');
  const f = await frame();
  ok(await call('POST', `/orders/${o.id}/cancel`, A), 'cancel framed');
  const g = await frame();
  return (has(over, 400, '引当在庫（確保数）を超えています') && Number(f.consumed_qty) === 2 && Number(g.consumed_qty) === 0) || { over, f, g };
});
await check('O-14 取引先なしの受注が詳細・受注一覧（ダッシュボード）に出る', async () => {
  const d = ok(await call('GET', `/orders/${sample.id}`, A), 'detail sample');
  const l = ok(await call('GET', '/orders?order_type=サンプル&limit=200', A), 'list');
  return (d.partner_id === null && d.partner_name === null && d.sales_category_name === null && d.direct_name === `HBサンプル様${t}`
    && d.partner_is_overseas === false && l.items.some((x) => x.id === sample.id && x.partner_name === null)) || { d: { p: d.partner_name, c: d.sales_category_name }, found: l.items.length };
});
await check('O-14 サンプル：引当 → 出荷確定で在庫が落ちる', async () => {
  const before = await stock(sku2.id, w1.id);
  const r = await allocate(sample.id);
  await confirm(sample.id);
  const after = await stock(sku2.id, w1.id);
  return (r.status === '引当済' && Number(before.on_hand) - Number(after.on_hand) === 1) || { r, before, after };
});

// ---- O-02 社内移動 -------------------------------------------------------------------
await check('O-02 社内移動は納品先かお届け先のお名前のどちらかが必須', async () => {
  const r = await call('POST', '/orders', A, { order_type: '社内移動', order_date: today, lines: [line({ sku_id: sku2.id })] });
  return has(r, 400, '社内移動の受注では、納品先を選ぶか、お届け先のお名前を入力してください') || r;
});
const internal = await create({
  order_type: '社内移動', order_date: today, ship_date: today, ship_from_warehouse_id: w1.id, direct_name: `HB社内${t}`, lines: [line({ sku_id: sku2.id, qty: '1', unit_price: '0' })],
}, 'internal');
await check('O-02 社内移動：取引先なしで登録でき、売上に計上しない。引当 → 出荷確定できる', async () => {
  const r = await allocate(internal.id);
  await confirm(internal.id);
  const o = await one('select partner_id, is_billable, status from sales_orders where id = $1', [internal.id]);
  return (o.partner_id === null && o.is_billable === false && o.status === '出荷済' && r.status === '引当済') || { o, r };
});
await check('O-02 社内移動は販売実績に出ない', async () => {
  const r = ok(await call('POST', '/analytics/sales', A, { from: today, to: today, dimensions: ['受注区分'], measures: ['件数'], order_type: '社内移動' }), 'analytics');
  return r.rows.length === 0 || r.rows;
});

// ---- O-44 返品 -----------------------------------------------------------------------
await check('O-44 返品は取引先・販売カテゴリーが必須', async () => {
  const a = await call('POST', '/orders', A, { order_type: '返品', sales_category_id: category, order_date: today, lines: [line({ sku_id: sku1.id })] });
  const b = await call('POST', '/orders', A, { order_type: '返品', partner_id: partner.id, order_date: today, lines: [line({ sku_id: sku1.id })] });
  return (has(a, 400, '取引先を選んでください') && has(b, 400, '販売カテゴリーを選んでください')) || { a, b };
});
await check('O-44 返品の商品の数量は 0 にできない', async () => {
  const r = await call('POST', '/orders', A, { order_type: '返品', partner_id: partner.id, sales_category_id: category, order_date: today, lines: [line({ sku_id: sku1.id, qty: '0' })] });
  return has(r, 400, '1行目：数量は 0 より大きい数で入力してください') || r;
});
const ret = await create({
  order_type: '返品', partner_id: partner.id, sales_category_id: category, trade_type: '委託', order_date: today, ship_date: today,
  lines: [line({ sku_id: sku1.id, qty: '2', unit_price: '1000' })],
}, 'return');
await check('O-44 返品は正の数で受け取り、マイナスの数量・金額で登録する（取引条件は買取）', async () => {
  const l = await one('select qty::text, amount::text from sales_order_lines where sales_order_id = $1', [ret.id]);
  const o = await one('select trade_type, is_billable from sales_orders where id = $1', [ret.id]);
  const d = ok(await call('GET', `/orders/${ret.id}`, A), 'detail return');
  return (Number(l.qty) === -2 && Number(l.amount) === -2000 && Number(d.lines[0].qty) === -2 && o.trade_type === '買取' && o.is_billable === true) || { l, o };
});
await check('O-44 返品は引当で在庫を押さえずに引当済になり、出荷の行ができる', async () => {
  const before = await stock(sku1.id, w1.id);
  const r = await allocate(ret.id);
  const after = await stock(sku1.id, w1.id);
  return (r.status === '引当済' && r.shipment_id !== null && (await allocs(ret.id)) === 0 && after.allocated === before.allocated && after.on_hand === before.on_hand) || { r, before, after };
});
await check('O-44 返品の出荷確定・確定の取消・再確定で在庫は動かない', async () => {
  const before = await stock(sku1.id, w1.id);
  const sh = await confirm(ret.id);
  const un = ok(await call('POST', `/shipments/${sh.id}/unconfirm`, A), 'unconfirm return');
  const o = await one('select status from sales_orders where id = $1', [ret.id]);
  await confirm(ret.id);
  const after = await stock(sku1.id, w1.id);
  const moves = await one("select count(*)::int as n from stock_movements where ref_table = 'shipments' and ref_id = $1", [sh.id]);
  return (un.status === '確定済' && o.status === '引当済' && after.on_hand === before.on_hand && after.allocated === before.allocated && moves.n === 0) || { un, o, before, after, moves };
});

// ---- O-12 委託 -----------------------------------------------------------------------
await check('O-12 委託は入庫倉庫が必須', async () => {
  const r = await call('POST', '/orders', A, wholesale({ trade_type: '委託', lines: [line({ sku_id: sku1.id })] }));
  return has(r, 400, '取引条件が委託のときは入庫倉庫を選んでください') || r;
});
await check('O-12 入庫倉庫に出荷倉庫（納品先の既定倉庫）と同じ倉庫は選べない', async () => {
  const r = await call('POST', '/orders', A, wholesale({ trade_type: '委託', consignment_warehouse_id: w1.id, lines: [line({ sku_id: sku1.id })] }));
  return has(r, 400, `入庫倉庫に出荷倉庫（HB出荷${t}）と同じ倉庫は選べません`) || r;
});
const consign = await create(wholesale({ trade_type: '委託', consignment_warehouse_id: w2.id, lines: [line({ sku_id: sku1.id, qty: '3', unit_price: '1000' })] }), 'consignment');
await check('O-12 委託は単価・金額 0 で登録し、詳細に入庫倉庫が出る', async () => {
  const l = await one('select unit_price::text, amount::text from sales_order_lines where sales_order_id = $1', [consign.id]);
  const d = ok(await call('GET', `/orders/${consign.id}`, A), 'detail consignment');
  return (Number(l.unit_price) === 0 && Number(l.amount) === 0 && Number(d.consignment_warehouse_id) === Number(w2.id) && d.consignment_warehouse_name === `HB委託先${t}`) || { l, d: d.consignment_warehouse_name };
});
let consignShipment = null;
await check('O-12 委託の出荷確定で、出荷倉庫から減らし入庫倉庫に良品で入れる（倉庫間移動・出荷日）', async () => {
  const r = await allocate(consign.id);
  const b1 = await stock(sku1.id, w1.id);
  consignShipment = await confirm(consign.id);
  const a1 = await stock(sku1.id, w1.id);
  const a2 = await stock(sku1.id, w2.id);
  const mv = await one(
    `select count(*)::int as n, sum(qty)::numeric::text as q, min(to_char(moved_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD')) as d
       from stock_movements where ref_table = 'shipments' and ref_id = $1 and movement_type = '倉庫間移動'`, [consignShipment.id]);
  return (r.status === '引当済' && Number(b1.on_hand) - Number(a1.on_hand) === 3 && Number(a2.on_hand) === 3 && mv.n === 1 && Number(mv.q) === 3 && mv.d === today) || { r, b1, a1, a2, mv };
});
await check('O-12 委託の確定の取消で、入庫倉庫から減らして出荷倉庫に戻す', async () => {
  const b1 = await stock(sku1.id, w1.id);
  const un = ok(await call('POST', `/shipments/${consignShipment.id}/unconfirm`, A), 'unconfirm consignment');
  const a1 = await stock(sku1.id, w1.id);
  const a2 = await stock(sku1.id, w2.id);
  return (un.status === '確定済' && Number(a1.on_hand) - Number(b1.on_hand) === 3 && Number(a2.on_hand) === 0) || { un, b1, a1, a2 };
});
await check('O-12 入庫倉庫の在庫が足りない（委託先で売れた）ときは確定を取り消せない', async () => {
  await confirm(consign.id);
  // 委託先で1つ売れた（入庫倉庫の在庫が減った）ことにする
  await db.query('update stocks set qty_on_hand = qty_on_hand - 1 where sku_id = $1 and warehouse_id = $2 and quality_code_id = $3', [sku1.id, w2.id, GOOD]);
  const r = await call('POST', `/shipments/${consignShipment.id}/unconfirm`, A);
  const a2 = await stock(sku1.id, w2.id);
  await db.query('update stocks set qty_on_hand = qty_on_hand + 1 where sku_id = $1 and warehouse_id = $2 and quality_code_id = $3', [sku1.id, w2.id, GOOD]);
  const o = await one('select status from sales_orders where id = $1', [consign.id]);
  return (has(r, 409, `入庫倉庫（HB委託先${t}）の在庫が足りないため取り消せません`) && JSON.stringify(r.body).includes('委託先で売れた分') && Number(a2.on_hand) === 2 && o.status === '出荷済') || { r, a2, o };
});

// ---- 出荷一覧（O-25） -------------------------------------------------------------------
await check('O-25 出荷一覧に納品日・納品先No.・納品先名・納品時間が出る（取引先なしはお届け先のお名前）', async () => {
  const shD = await allocate(orderD.id);
  const find = async (id) => {
    for (let offset = 0; offset < 5000; offset += 200) {
      const r = ok(await call('GET', `/shipments?from=${today}&to=${today}&limit=200&offset=${offset}`, A), 'shipments');
      const hit = r.items.find((x) => Number(x.id) === Number(id));
      if (hit || r.items.length < 200) return hit;
    }
    return undefined;
  };
  const d = await find(shD.shipment_id);
  const b = await find((await shipmentOf(orderB.id)).id);
  const s = await find((await shipmentOf(sample.id)).id);
  const good = d?.delivery_code === `${P}D` && d?.destination_name === `HB納品先${t}` && d?.delivery_time_name === '14:00〜16:00'
    && String(b?.delivery_date).slice(0, 10) === today && b?.delivery_time_name === null
    && s?.partner_name === null && s?.destination_name === `HBサンプル様${t}`;
  return good || { d, b, s };
});

// ---- 請求（締め） -----------------------------------------------------------------------
// 得意先 HB の今月の出荷: B（卸 5,000）、E（非商品だけ 500）、返品（-2,000）、委託（0 円・請求に載せない）。サンプル（取引先あり）も載せない
const sampleWithPartner = await create({
  order_type: 'サンプル', partner_id: partner.id, order_date: today, ship_date: today, ship_from_warehouse_id: w1.id, direct_name: `HBサンプル2様${t}`,
  lines: [line({ sku_id: sku2.id, qty: '1', unit_price: '100' })],
}, 'sample with partner');
await allocate(sampleWithPartner.id);
await confirm(sampleWithPartner.id);
await confirm(orderB.id);
const fee = await one("select (select value_text from system_settings where setting_key = 'SHIPPING_FEE_THRESHOLD') as th, (select value_text from system_settings where setting_key = 'SHIPPING_FEE_AMOUNT') as amt");
let invoice = null;
await check('締め：請求を作れる', async () => {
  const r = ok(await call('POST', '/billing/closings', A, { target_month: month, partner_id: partner.id }), 'closing');
  invoice = r.invoices[0];
  return !!invoice?.id || r;
});
await check('O-44 締め：返品の受注は「返品 ＋出荷番号」のマイナスの明細になり、返品額に入って出荷には入らない', async () => {
  const lines = await all('select item_name, amount::text from invoice_lines where invoice_id = $1 order by line_no', [invoice.id]);
  const shNo = (await shipmentOf(ret.id)).shipment_no;
  const r = lines.find((l) => l.item_name === `返品 ${shNo}`);
  const iv = await one('select shipment_amount::text, return_amount::text from invoices where id = $1', [invoice.id]);
  return (r && Number(r.amount) === -2000 && Number(iv.return_amount) === 2000 && Number(iv.shipment_amount) === 5500) || { lines, iv };
});
await check('O-12・O-14 締め：委託・サンプルの受注は請求の明細に入らない', async () => {
  const ids = [(await shipmentOf(consign.id)).id, (await shipmentOf(sampleWithPartner.id)).id];
  const n = await one('select count(*)::int as n from invoice_lines where invoice_id = $1 and shipment_id = any($2::bigint[])', [invoice.id, ids]);
  const lines = await one('select count(*)::int as n from invoice_lines where invoice_id = $1', [invoice.id]);
  return (n.n === 0 && lines.n === 3) || { n, lines };
});
await check('O-44・O-12 締め：送料は卸の出荷だけ（返品・委託・サンプルには付けない）', async () => {
  const iv = await one('select shipping_fee_amount::text from invoices where id = $1', [invoice.id]);
  // B（5,000）・E（500）はどちらも閾値未満なので1出荷ずつ自動の送料
  const per = (total) => (total < Number(fee.th) ? Number(fee.amt) : 0);
  const want = per(5000) + per(500);
  return Number(iv.shipping_fee_amount) === want || { got: iv.shipping_fee_amount, want };
});
await check('O-44 締め：当月請求額・今回請求残高で返品は1回だけ差し引かれる', async () => {
  const iv = await one(
    `select shipment_amount, return_amount, shipping_fee_amount, current_invoice_amount, current_balance, carryover_balance,
            (select coalesce(sum(tax_amount), 0) from invoice_tax_summaries where invoice_id = $1) as tax,
            (select coalesce(sum(taxable_base), 0) from invoice_tax_summaries where invoice_id = $1) as base
       from invoices where id = $1`, [invoice.id]);
  const want = Number(iv.shipment_amount) - Number(iv.return_amount) + Number(iv.tax) + Number(iv.shipping_fee_amount);
  return (Number(iv.base) === 3500 && Number(iv.current_invoice_amount) === want && Number(iv.current_balance) === Number(iv.carryover_balance) + want) || iv;
});
await check('O-44・O-12 販売実績：返品はマイナス、委託は入らない', async () => {
  const r = ok(await call('POST', '/analytics/sales', A, { from: today, to: today, dimensions: ['受注区分', '取引条件'], measures: ['金額', '数量'], partner_id: partner.id }), 'analytics');
  const w = r.rows.find((x) => x['受注区分'] === '卸');
  const rt = r.rows.find((x) => x['受注区分'] === '返品');
  const consignmentRows = r.rows.filter((x) => x['取引条件'] === '委託');
  return (Number(w?.['金額']) === 5500 && Number(w?.['数量']) === 5 && Number(rt?.['金額']) === -2000 && Number(rt?.['数量']) === -2 && consignmentRows.length === 0) || r.rows;
});

await check('O-44・O-12 ロイヤリティ：返品の受注はマイナスの返品の行、委託・サンプル・社内移動は数えない', async () => {
  const includeReturns = (await one("select value_text from system_settings where setting_key = 'ROYALTY_INCLUDE_RETURNS'"))?.value_text !== 'false';
  const payee = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}Y`, name1: `HBロイヤリティ${t}`, is_supplier: true, is_royalty_payee: true }), 'payee');
  // この検査の商品だけに当たる定額の規定（1個 10 円・出荷の月）。委託の 0 円の出荷に定額が付かないことも見る
  const rule = ok(await call('POST', '/masters/royalty-rules', A, {
    payee_partner_id: payee.id, media_id: media, product_ids: [product.id], calc_base: '出荷', fixed_amount: '10', valid_from: '2026-01-01',
  }), 'rule');
  const r = ok(await call('POST', '/billing/royalties/calculate', A, { target_month: month }), 'calculate');
  await call('POST', `/masters/royalty-rules/${rule.id}/deactivate`, A);
  const c = r.calculations.find((x) => Number(x.payee_partner_id) === Number(payee.id));
  const lines = await all('select qty::text, royalty_amount::text from royalty_calculation_lines where royalty_calculation_id = $1 order by qty', [c?.id ?? 0]);
  // B（卸 5 個 → 50 円）と返品（-2 個 → -20 円。設定 ROYALTY_INCLUDE_RETURNS が false なら数えない）
  const good = includeReturns
    ? Number(c?.total_amount) === 30 && lines.length === 2 && Number(lines[0].qty) === -2 && Number(lines[0].royalty_amount) === -20 && Number(lines[1].qty) === 5
    : Number(c?.total_amount) === 50 && lines.length === 1;
  return good || { c, lines };
});

// ---- O-04・O-05 絞り込みの候補・登録した商品だけ ---------------------------------------
await check('O-04 絞り込みの候補：取引先ありは使っている得意先別商品の行ごと（登録の無い SKU は出ない）', async () => {
  const r = ok(await call('GET', `/orders/sku-picker?partner_id=${partner.id}`, A), 'picker');
  const mine = r.filter((x) => String(x.sku_code).startsWith(P));
  const want = await one('select fn_item_name($1, $2, $3) as n', [`HB商品${t} 2枚組`, color.name, size.name]);
  const a = mine.find((x) => Number(x.partner_product_id) === Number(pp1.id));
  const good = mine.length === 2 && mine.every((x) => Number(x.sku_id) === Number(sku1.id)) && Number(a?.unit_price) === 1200 && Number(a?.retail_price) === 2400
    && a?.partner_product_code === `${P}A` && a?.sales_name === `HB販売名${t}` && a?.shipping_jan === J3 && a?.jan === J1
    && a?.item_name === want.n && a?.color_name === color.name && Number(a?.color_id) === Number(color.id) && a?.size_name === size.name
    && a?.is_set === false && a?.tax_rate !== undefined && !('cost_price' in a)
    && Number(a?.brand_id) === Number(brand.id) && a?.brand_name === `HBブランド${t}`
    && Number(a?.product_class_id) === Number(pclass.id) && a?.product_class_name === `HB分類${t}`;
  return good || mine;
});
await check('O-04 絞り込みの候補：取引先なしは使っている SKU ごとに1件（セット商品も含む・得意先別商品の項目は空）', async () => {
  const r = ok(await call('GET', '/orders/sku-picker', A), 'picker all');
  const mine = r.filter((x) => String(x.sku_code).startsWith(P));
  const ids = mine.map((x) => Number(x.sku_id)).sort((a, b) => a - b);
  const set = mine.find((x) => Number(x.sku_id) === Number(setSku.id));
  const good = ids.length === 3 && JSON.stringify(ids) === JSON.stringify([sku1.id, sku2.id, setSku.id].map(Number).sort((a, b) => a - b))
    && mine.every((x) => x.partner_product_id === null && x.unit_price === null) && set?.is_set === true;
  return good || mine;
});
await check('O-05 商品の検索 registered_only：取引先の得意先別商品に登録した SKU だけ', async () => {
  const a = ok(await call('GET', `/masters/skus?q=${encodeURIComponent(P)}&partner_id=${partner.id}&registered_only=true`, A), 'registered');
  const b = ok(await call('GET', `/masters/skus?q=${encodeURIComponent(P)}&partner_id=${partner.id}`, A), 'all');
  const c = ok(await call('GET', `/masters/skus?q=${encodeURIComponent(P)}&registered_only=true`, A), 'no partner');
  return (a.length === 1 && Number(a[0].sku_id) === Number(sku1.id) && b.length === 3 && c.length === 3) || { a: a.map((x) => x.sku_code), b: b.map((x) => x.sku_code), c: c.length };
});

// ---- O-07 納品先の一覧の作業指示 ---------------------------------------------------------
await check('O-07 受注入力の納品先の一覧に作業指示（名称・本文）が付く', async () => {
  const r = ok(await call('GET', `/masters/partners/${partner.id}/delivery-destinations`, A), 'destinations');
  const d = r.find((x) => x.id === dest.id);
  return (d?.work_instruction_name === `HB作業指示${t}` && String(d?.work_instruction_body).includes(`HB本文${t}`)) || r;
});

// ---- 文言 -------------------------------------------------------------------------------
await check('卸・直送の決まりと文言（取引先・販売カテゴリー・納品先・お届け先）', async () => {
  const a = await call('POST', '/orders', A, wholesale({ partner_id: null, lines: [line({ sku_id: sku1.id })] }));
  const b = await call('POST', '/orders', A, wholesale({ sales_category_id: null, lines: [line({ sku_id: sku1.id })] }));
  const c = await call('POST', '/orders', A, wholesale({ delivery_destination_id: null, lines: [line({ sku_id: sku1.id })] }));
  const d = await call('POST', '/orders', A, wholesale({ order_type: '直送', delivery_destination_id: null, lines: [line({ sku_id: sku1.id })] }));
  const good = has(a, 400, '取引先を選んでください') && has(b, 400, '販売カテゴリーを選んでください')
    && has(c, 400, '卸の受注では納品先を選んでください') && has(d, 400, '直送の受注ではお届け先のお名前を入力してください');
  return good || { a: a.body, b: b.body, c: c.body, d: d.body };
});
await check('受注区分は 卸・直送・通販・社内移動・サンプル・返品 だけ', async () => {
  const r = await call('POST', '/orders', A, wholesale({ order_type: '販促', lines: [line({ sku_id: sku1.id })] }));
  return r.status === 400 || r;
});

// 片付け: 作った倉庫・分類は使わないにする（ほかの検査・画面の選択肢に出ないように）
await db.query('update warehouses set is_active = false where id = any($1::bigint[])', [[w1.id, w2.id]]);
await db.query('update colors set is_active = false where id = $1', [color.id]);
await db.query('update sizes set is_active = false where id = $1', [size.id]);
await db.query('update media set is_active = false where id = $1', [media]);
await db.query('update brands set is_active = false where id = $1', [brand.id]);
await db.query('update product_classes set is_active = false where id = $1', [pclass.id]);

await db.end();
process.exit(ng > 0 ? 1 : 0);
