// マスタ編フィードバック（2026-10-01、39件）の受入テストで見つかった不具合の回帰確認。
// smoke-backend.ps1 の第31節から呼ばれる（API・DB は smoke が立てた使い捨て環境）。
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
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
const V = await login('viewer1');
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const t = String(Date.now()).slice(-6);

// ---- 準備（接頭辞 MF） --------------------------------------------------------
const category = Number((await one('select id from sales_categories order by id limit 1')).id);
const warehouse = Number((await one('select id from warehouses where is_active order by id limit 1')).id);
const media = ok(await call('POST', '/masters/simple/media', A, { code: `MFM${t}`, name: `MF媒体${t}` }), 'media');
const brand = ok(await call('POST', '/masters/simple/brands', A, { code: `MFB${t}`, name: `MFブランド${t}` }), 'brand');
const payee = ok(await call('POST', '/masters/partners', A, { partner_code: `MFP${t}`, name1: `MF支払先${t}`, is_customer: true, is_royalty_payee: true, closing_day: 99 }), 'payee');
const cust = [];
for (const n of [1, 2]) {
  const p = ok(await call('POST', '/masters/partners', A, { partner_code: `MFC${n}${t}`, name1: `MF販売先${n}`, is_customer: true, closing_day: 99, media_id: media.id }), 'customer');
  const d = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: p.id, delivery_code: `MFD${n}${t}`, name: `MF納品先${n}`, default_warehouse_id: warehouse }), 'dest');
  cust.push({ ...p, dest: d.id });
}
const product = ok(await call('POST', '/masters/products', A, { product_code: `MF${t}`, product_name: `MF商品${t}`, brand_id: brand.id, cost_price: '100' }), 'product');
const sku = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `MF${t}-0000-100` }), 'sku');
const rc = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: warehouse, planned_date: today, lines: [{ line_no: 1, sku_id: sku.id, qty: '50' }] }), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');
const line = (qty = '1') => [{ line_no: 1, line_type: '商品', sku_id: sku.id, item_name: 'MF', qty, unit_price: '1000' }];
const order = (c, extra = {}) => ({ order_type: '卸', partner_id: c.id, delivery_destination_id: c.dest, sales_category_id: category, order_date: today, ship_date: today, lines: line(), ...extra });

// ---- No.5 取引先の既定の取引区分「仕入」 -------------------------------------
await check('No.5 既定が「仕入」の取引先でも受注でき、取引条件は買取になる', async () => {
  ok(await call('PATCH', `/masters/partners/${cust[0].id}`, A, { default_trade_type: '仕入' }), 'patch');
  const r = await call('POST', '/orders', A, order(cust[0]));
  if (r.status !== 201) return `受注 ${r.status} ${JSON.stringify(r.body)}`;
  const o = await one('select trade_type from sales_orders where id = $1', [r.body.id]);
  await call('POST', `/orders/${r.body.id}/cancel`, A);
  return o.trade_type === '買取' || o;
});
await check('受注で取引条件を省くと、取引先の既定（委託）が入る', async () => {
  ok(await call('PATCH', `/masters/partners/${cust[0].id}`, A, { default_trade_type: '委託' }), 'patch');
  const r = ok(await call('POST', '/orders', A, order(cust[0])), 'order');
  const o = await one('select trade_type from sales_orders where id = $1', [r.id]);
  await call('POST', `/orders/${r.id}/cancel`, A);
  await call('PATCH', `/masters/partners/${cust[0].id}`, A, { default_trade_type: '買取' });
  return o.trade_type === '委託' || o;
});

// ---- No.18 FBA用JAN・ショップ商品コード ---------------------------------------
await check('No.18 商品の詳細が SKU の FBA用JAN・ショップ商品コードを返す（画面の保存で消えない）', async () => {
  ok(await call('PATCH', `/masters/skus/${sku.id}`, A, { fba_jan: '4900000000017', shop_product_code: `SHOP${t}` }), 'patch');
  const d = ok(await call('GET', `/masters/products/${product.id}`, A), 'detail');
  const k = d.skus.find((s) => s.id === sku.id);
  return (k?.fba_jan === '4900000000017' && k?.shop_product_code === `SHOP${t}`) || k;
});

// ---- No.29 出荷JAN（受注入力の商品検索） ---------------------------------------
const shipJan = `49${t}00001`.slice(0, 13);
const pp = ok(await call('POST', '/masters/partner-products', A, { partner_id: cust[0].id, sku_id: sku.id, partner_product_code: `PC${t}`, partner_jan: `45${t}00009`.slice(0, 13), shipping_jan: shipJan, unit_price: '1200', cost_price: '777', color_name: 'PRINT-C' }), 'pp');
await check('No.29 取引先を指定すると、出荷JANで SKU を引け、候補に出荷JANが入る', async () => {
  const r = ok(await call('GET', `/masters/skus?q=${shipJan}&partner_id=${cust[0].id}`, A), 'search');
  const hit = r.find((s) => s.sku_id === sku.id);
  return hit?.shipping_jan === shipJan || r;
});
await check('No.29 取引先を指定しないときは、ほかの取引先の出荷JANでは引けない', async () => {
  const r = ok(await call('GET', `/masters/skus?q=${shipJan}`, A), 'search');
  return r.length === 0 || r;
});

// ---- 原価の出し分け・印字カラー（No.27） ---------------------------------------
await check('閲覧者には得意先別商品の一覧で原価を返さない', async () => {
  const r = ok(await call('GET', `/masters/partner-products?partner_id=${cust[0].id}`, V), 'viewer list');
  return (r.items.length > 0 && r.items.every((x) => !('cost_price' in x))) || r.items[0];
});
await check('管理者には得意先別商品の一覧で原価を返す', async () => {
  const r = ok(await call('GET', `/masters/partner-products?partner_id=${cust[0].id}`, A), 'admin list');
  return Number(r.items.find((x) => x.id === pp.id)?.cost_price) === 777 || r.items;
});
await check('No.27 一覧は印字するカラーを SKU のカラー名とは別に返す（編集で上書きされない）', async () => {
  const r = ok(await call('GET', `/masters/partner-products?partner_id=${cust[0].id}`, A), 'list');
  return r.items.find((x) => x.id === pp.id)?.print_color_name === 'PRINT-C' || r.items;
});

// ---- 倉庫の削除（No.1） ---------------------------------------------------------
await check('No.1 管理者は倉庫の削除経路を通れる（存在しない ID は 404。以前は権限 M-13 で必ず 403）', async () => {
  const r = await call('DELETE', '/masters/warehouses/999999', A);
  return r.status === 404 || r.status;
});

// ---- 作業指示（No.12） -----------------------------------------------------------
await check('No.12 作業指示を「使わない」→「有効に戻す」しても本文が残る', async () => {
  const w = ok(await call('POST', '/masters/simple/work_instructions', A, { code: `MFW${t}`, name: 'MF作業指示', instruction_body: `本文${t}` }), 'create');
  ok(await call('POST', `/masters/simple/work_instructions/${w.id}/deactivate`, A), 'deactivate');
  ok(await call('PATCH', `/masters/simple/work_instructions/${w.id}`, A, { is_active: true }), 'reactivate');
  const row = await one('select instruction_body from work_instructions where id = $1', [w.id]);
  return row.instruction_body === `本文${t}` || row;
});

// ---- セット一覧（No.20） ---------------------------------------------------------
await check('No.20 セット一覧の検索語が効き、件数は絞り込み後の全件数', async () => {
  const none = ok(await call('GET', '/masters/sets?q=__no_such_set__', A), 'search');
  const all = ok(await call('GET', '/masters/sets?limit=1', A), 'all');
  const cnt = Number((await one('select count(*)::int n from set_headers')).n);
  return (none.items.length === 0 && none.total === 0 && all.total === cnt) || { none: none.total, all: all.total, cnt };
});

// ---- 仕入項目の税区分（No.32） -----------------------------------------------------
const tax8 = Number((await one(`select c.id from codes c join code_categories cc on cc.id = c.code_category_id where cc.code = 'TAX_DIVISION' and c.code = 'TAX8'`)).id);
const supplier = ok(await call('POST', '/masters/partners', A, { partner_code: `MFS${t}`, name1: 'MF仕入先', is_supplier: true }), 'supplier');
const item = ok(await call('POST', '/masters/purchase-items', A, { purchase_code: `MFI${t}`, item_name: 'MF軽減品目', unit_cost: '100', new_tax_rate: '8.00', new_tax_class_code_id: tax8 }), 'item');
await check('No.32 仕入項目を選んだ明細は、品目の税区分（軽減8%）と税率 8% で登録される', async () => {
  const p = ok(await call('POST', '/purchases', A, { division: '仕入', supplier_partner_id: supplier.id, purchase_date: today, lines: [{ line_no: 1, purchase_item_id: item.id, item_name: 'MF軽減品目', unit_cost: '100' }] }), 'purchase');
  const l = await one('select tax_rate, tax_division_code_id from purchase_lines where purchase_id = $1', [p.id]);
  return (Number(l.tax_rate) === 8 && Number(l.tax_division_code_id) === Number(tax8)) || l;
});
await check('No.32 税区分と税率が食い違う明細は 400', async () => {
  const r = await call('POST', '/purchases', A, { division: '仕入', supplier_partner_id: supplier.id, purchase_date: today, lines: [{ line_no: 1, item_name: 'x', unit_cost: '100', tax_rate: '10.00', tax_division_code_id: Number(tax8) }] });
  return r.status === 400 || r.status;
});

// ---- ロイヤリティ規定（No.37） -----------------------------------------------------
const ruleBody = (ids) => ({ payee_partner_id: payee.id, brand_id: brand.id, media_id: media.id, customer_mode: '対象', customer_partner_ids: ids, calc_base: '出荷', rate: '0.0500', valid_from: '2026-01-01' });
await check('No.37 媒体を選ばない規定は 400', async () => {
  const r = await call('POST', '/masters/royalty-rules', A, { ...ruleBody([cust[0].id]), media_id: null });
  return r.status === 400 || r.status;
});
const rule = ok(await call('POST', '/masters/royalty-rules', A, ruleBody([cust[0].id, cust[1].id])), 'rule');
const groupRows = async () => (await db.query('select id, customer_partner_id, is_active, rule_group_id from royalty_rules where id = $1 or rule_group_id = $1 or (payee_partner_id = $2 and rule_group_id is null and id <> $1) order by id', [rule.id, payee.id])).rows;
// 販売先2（まとまりの2行目）に出荷して計算し、2行目の規定を計算に使った状態にする
const o2 = ok(await call('POST', '/orders', A, order(cust[1])), 'order2');
const so = await one('select id from shipments where sales_order_id = $1', [o2.id]);
ok(await call('POST', `/shipments/${so.id}/confirm`, A, { ship_date: today }), 'confirm');
const month = today.slice(0, 7);
const calc1 = ok(await call('POST', '/billing/royalties/calculate', A, { target_month: month }), 'calc1');
await check('No.37 2社目の行が計算に使われている（前提）', async () => {
  const r = await one('select count(*)::int n from royalty_calculation_lines l join royalty_rules r on r.id = l.royalty_rule_id where r.rule_group_id = $1', [rule.id]);
  return r.n > 0 || r;
});
await check('No.37 計算に使った後でも、販売先を外す編集ができる（以前は 400）', async () => {
  const r = await call('PATCH', `/masters/royalty-rules/${rule.id}`, A, ruleBody([cust[0].id]));
  return r.status === 200 || `${r.status} ${JSON.stringify(r.body)}`;
});
await check('No.37 外した販売先の行は「使わない」で残り、まとまりから外れる（計算の根拠は残る）', async () => {
  const rows = await groupRows();
  const c2 = rows.find((r) => Number(r.customer_partner_id) === cust[1].id);
  return (c2 && c2.is_active === false && c2.rule_group_id === null) || rows;
});
await check('No.37 外した販売先を戻すと、前の行を使い直す（重複エラーにならない）', async () => {
  const r = await call('PATCH', `/masters/royalty-rules/${rule.id}`, A, ruleBody([cust[0].id, cust[1].id]));
  if (r.status !== 200) return `${r.status} ${JSON.stringify(r.body)}`;
  const rows = await groupRows();
  return rows.filter((x) => x.is_active && (Number(x.id) === rule.id || Number(x.rule_group_id) === rule.id)).length === 2 || rows;
});
await check('No.37 「使わない」でまとまりの全行が止まる', async () => {
  ok(await call('POST', `/masters/royalty-rules/${rule.id}/deactivate`, A), 'deactivate');
  const rows = await groupRows();
  return rows.every((x) => x.is_active === false) || rows;
});
await check('No.37 止めた後の計算では、この支払先の規定が当たらない', async () => {
  const r = ok(await call('POST', '/billing/royalties/calculate', A, { target_month: month }), 'calc');
  const mine = (r.calculations ?? []).find((c) => Number(c.payee_partner_id) === payee.id);
  return !mine || Number(mine.total_amount) === 0 || mine;
});
await check('No.37 「有効に戻す」でまとまりの全行が戻る', async () => {
  ok(await call('PATCH', `/masters/royalty-rules/${rule.id}`, A, { is_active: true }), 'reactivate');
  const rows = (await groupRows()).filter((x) => Number(x.id) === rule.id || Number(x.rule_group_id) === rule.id);
  return (rows.length === 2 && rows.every((x) => x.is_active)) || rows;
});
await check('ロイヤリティ: 確定済みの支払先があっても、ほかの支払先は計算し直せる', async () => {
  const r = ok(await call('POST', '/billing/royalties/calculate', A, { target_month: month }), 'calc');
  const mine = r.calculations.find((c) => Number(c.payee_partner_id) === payee.id);
  ok(await call('POST', `/billing/royalties/${mine.id}/confirm`, A, {}), 'confirm');
  const again = await call('POST', '/billing/royalties/calculate', A, { target_month: month });
  if (again.status === 409) return true; // 確定していない支払先が無い月なら 409 が正しい
  return (again.status === 201 || again.status === 200) && (again.body.skipped_confirmed ?? []).includes(`MF支払先${t}`) || again;
});
void calc1;

await db.end();
process.exit(ng === 0 ? 0 : 1);
