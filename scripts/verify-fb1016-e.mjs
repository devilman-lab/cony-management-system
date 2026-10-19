// マスター編3（2026-10-16）担当 E の回帰確認: 共通の仕組み
//   M3-01 登録日・更新日（GET record-stamps/:table/:id）
//   M3-02 「使わない」→ 編集画面の「表示／非表示」（各マスタの PATCH が is_active を受ける・セットも）
//   M3-39 区分値（区分値・通貨・経費科目のタブ）の削除。使われていれば理由を出して断る
//   M3-40 作業指示内容の名称はコードで埋める（CSV 取込でも）
//   M3-41 使わない区分カテゴリー（費用区分 COST_DIVISION）は区分カテゴリーの一覧に出さない
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は GE＋時刻。
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
const t = String(Date.now()).slice(-6);
const P = `GE${t}`;
const admin = await one(`select id, name from users where login_id = 'admin'`);

// ---- M3-01 登録日・更新日 -------------------------------------------------------
const brand = ok(await call('POST', '/masters/simple/brands', A, { code: `${P}B`, name: `${P}ブランド` }), 'brand');
await check('M3-01 登録日・更新日と、登録した人・更新した人の氏名が返る', async () => {
  const r = ok(await call('GET', `/record-stamps/brands/${brand.id}`, A), 'stamp');
  return (r.created_at && r.updated_at && r.created_by_name === admin.name && r.updated_by_name === admin.name) || r;
});
await check('M3-01 閲覧のみの人もマスタの参照権限で読める', async () => {
  const r = await call('GET', `/record-stamps/brands/${brand.id}`, V);
  return r.status === 200 || r;
});
await check('M3-01 決め打ちの表に無いテーブルは読めない（404）', async () => {
  const r = await call('GET', `/record-stamps/users/${admin.id}`, A);
  const r2 = await call('GET', `/record-stamps/brands;drop table x/${brand.id}`, A);
  return (r.status === 404 && r2.status === 404) || { users: r.status, odd: r2.status };
});
await check('M3-01 無い ID は 404', async () => {
  const r = await call('GET', '/record-stamps/brands/999999999', A);
  return r.status === 404 || r;
});
await check('M3-01 入荷・在庫調整・引当在庫・受注・セット・区分値の表も読める', async () => {
  const out = {};
  for (const tb of ['receipts', 'stock_adjustments', 'reservation_groups', 'sales_orders', 'set_headers', 'codes', 'partners', 'delivery_destinations', 'products', 'partner_products', 'warehouses', 'purchase_items', 'royalty_rules', 'work_instructions']) {
    const row = await one(`select id from ${tb} order by id desc limit 1`);
    if (!row) continue;
    const r = await call('GET', `/record-stamps/${tb}/${row.id}`, A);
    if (r.status !== 200 || !r.body.created_at) out[tb] = r.status;
  }
  return Object.keys(out).length === 0 || out;
});
await check('M3-01 権限はその表の画面の参照の権限で見る（受注の参照の権限があれば 200、無ければ 403）', async () => {
  // viewer1 が O-03 を持っているかは役割しだいなので、持っていなければ 403、持っていれば 200 のどちらかを確かめる
  const has = await one(
    `select exists (select 1 from users u join user_roles ur on ur.user_id = u.id join role_permissions rp on rp.role_id = ur.role_id
                     join permissions p on p.id = rp.permission_id where u.login_id = 'viewer1' and p.function_id = 'O-03' and p.action = 'view') as ok`,
  ).catch(() => null);
  const row = await one(`select id from sales_orders order by id desc limit 1`);
  if (!row || !has) return true;
  const r = await call('GET', `/record-stamps/sales_orders/${row.id}`, V);
  return (has.ok ? r.status === 200 : r.status === 403) || { has: has.ok, status: r.status };
});
await check('M3-01 更新すると更新日が進み、登録日は変わらない', async () => {
  const before = ok(await call('GET', `/record-stamps/brands/${brand.id}`, A), 'stamp');
  await new Promise((r) => setTimeout(r, 20));
  ok(await call('PATCH', `/masters/simple/brands/${brand.id}`, A, { name: `${P}ブランド2` }), 'patch');
  const after = ok(await call('GET', `/record-stamps/brands/${brand.id}`, A), 'stamp');
  return (after.created_at === before.created_at && new Date(after.updated_at) > new Date(before.updated_at)) || { before, after };
});

// ---- M3-02 表示／非表示（編集画面の保存で is_active を送る） -----------------------------
await check('M3-02 分類マスタの更新で is_active を送ると非表示・表示に切り替わる', async () => {
  ok(await call('PATCH', `/masters/simple/brands/${brand.id}`, A, { code: `${P}B`, name: `${P}ブランド2`, is_active: false }), 'off');
  const off = await one(`select is_active from brands where id = $1`, [brand.id]);
  const list = ok(await call('GET', `/masters/simple/brands?q=${P}`, A), 'list');
  const listAll = ok(await call('GET', `/masters/simple/brands?q=${P}&include_inactive=true`, A), 'list all');
  ok(await call('PATCH', `/masters/simple/brands/${brand.id}`, A, { code: `${P}B`, name: `${P}ブランド2`, is_active: true }), 'on');
  const on = await one(`select is_active from brands where id = $1`, [brand.id]);
  return (off.is_active === false && list.total === 0 && listAll.total === 1 && on.is_active === true) || { off, on, list: list.total, all: listAll.total };
});
const wh = ok(await call('POST', '/masters/warehouses', A, { warehouse_code: `${P}W`, warehouse_name: `${P}倉庫`, short_name: `${P}倉` }), 'warehouse');
await check('M3-02 倉庫・仕入項目の更新も is_active を受ける', async () => {
  ok(await call('PATCH', `/masters/warehouses/${wh.id}`, A, { warehouse_name: `${P}倉庫`, is_active: false }), 'wh off');
  const w = await one(`select is_active from warehouses where id = $1`, [wh.id]);
  const pi = ok(await call('POST', '/masters/purchase-items', A, { purchase_code: `${P}PI`, item_name: `${P}品目` }), 'pi');
  ok(await call('PATCH', `/masters/purchase-items/${pi.id}`, A, { item_name: `${P}品目`, is_active: false }), 'pi off');
  const p = await one(`select is_active from purchase_items where id = $1`, [pi.id]);
  return (w.is_active === false && p.is_active === false) || { w, p };
});

// セット: 編集（PUT）で is_active を受け、一覧は既定で非表示のセットを出さない
const setProduct = ok(await call('POST', '/masters/products', A, { product_code: `${P}S`, product_name: `${P}セット`, is_set: true }), 'set product');
const setSku = ok(await call('POST', '/masters/skus', A, { product_id: setProduct.id, sku_code: `${P}S-01` }), 'set sku');
const part = ok(await call('POST', '/masters/products', A, { product_code: `${P}P`, product_name: `${P}単品` }), 'part');
const partSku = ok(await call('POST', '/masters/skus', A, { product_id: part.id, sku_code: `${P}P-01` }), 'part sku');
const set = ok(await call('POST', '/masters/sets', A, { sku_id: setSku.id, components: [{ component_sku_id: partSku.id, qty: '2' }] }), 'set');
await check('M3-02 セットの編集で非表示にでき、一覧は「使わないものも表示」のときだけ出す', async () => {
  ok(await call('PUT', `/masters/sets/${set.id}`, A, { components: [{ component_sku_id: partSku.id, qty: '2' }], note: null, is_active: false }), 'set off');
  const h = await one(`select is_active from set_headers where id = $1`, [set.id]);
  const list = ok(await call('GET', `/masters/sets?q=${P}S-01`, A), 'list');
  const all = ok(await call('GET', `/masters/sets?q=${P}S-01&include_inactive=true`, A), 'list all');
  ok(await call('PUT', `/masters/sets/${set.id}`, A, { components: [{ component_sku_id: partSku.id, qty: '2' }], note: null }), 'set keep');
  const keep = await one(`select is_active from set_headers where id = $1`, [set.id]);
  // 後片付け: 表示に戻す（ほかの確認の「セットの一覧の件数＝全件」を崩さないため）
  ok(await call('PUT', `/masters/sets/${set.id}`, A, { components: [{ component_sku_id: partSku.id, qty: '2' }], note: null, is_active: true }), 'set on');
  return (h.is_active === false && list.total === 0 && all.total === 1 && keep.is_active === false) || { h, list: list.total, all: all.total, keep };
});

// ---- M3-39 区分値の削除 ---------------------------------------------------------
const addCode = async (cat, code, name) => ok(await call('POST', '/masters/codes', A, { code_category_code: cat, code, name }), `code ${cat}`);
await check('M3-39 使われていない区分値（経費科目）は削除できる', async () => {
  const c = await addCode('EXPENSE_DIVISION', `${P}X`, `${P}経費`);
  const r = await call('DELETE', `/masters/codes/${c.id}`, A);
  const gone = await one(`select count(*)::int as n from codes where id = $1`, [c.id]);
  return (r.status === 200 && gone.n === 0) || { status: r.status, body: r.body, gone };
});
await check('M3-39 閲覧のみの人は区分値を削除できない（403）', async () => {
  const c = await addCode('EXPENSE_DIVISION', `${P}Y`, `${P}経費Y`);
  const r = await call('DELETE', `/masters/codes/${c.id}`, V);
  await call('DELETE', `/masters/codes/${c.id}`, A);
  return r.status === 403 || r;
});
await check('M3-39 使われている区分値は、どこで何件使われているかを出して断る（409）', async () => {
  const c = await addCode('GROSS_MARGIN_ADJUST', `${P}G`, `${P}粗利`);
  const partner = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}C`, name1: `${P}取引先`, is_customer: true, gross_margin_adjust_code_id: c.id }), 'partner');
  const used = await one(`select gross_margin_adjust_code_id from partners where id = $1`, [partner.id]);
  if (Number(used.gross_margin_adjust_code_id) !== Number(c.id)) await db.query(`update partners set gross_margin_adjust_code_id = $1 where id = $2`, [c.id, partner.id]);
  const r = await call('DELETE', `/masters/codes/${c.id}`, A);
  const msg = r.body?.message ?? '';
  return (r.status === 409 && /取引先 1件/.test(msg) && /非表示/.test(msg)) || r;
});
await check('M3-39 通貨は伝票・取引先に文字で持つので、使われていれば件数を出して断る', async () => {
  const c = await addCode('CURRENCY', `Q${t.slice(-2)}`.replace(/\d/g, (d) => 'ABCDEFGHIJ'[d]).slice(0, 3).padEnd(3, 'Z'), `${P}通貨`);
  const p2 = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}D`, name1: `${P}取引先D`, is_customer: true }), 'partner2');
  await db.query(`update partners set currency = $1 where id = $2`, [c.code, p2.id]);
  const r = await call('DELETE', `/masters/codes/${c.id}`, A);
  await db.query(`update partners set currency = 'JPY' where id = $1`, [p2.id]);
  const r2 = await call('DELETE', `/masters/codes/${c.id}`, A);
  return (r.status === 409 && /取引先 1件/.test(r.body?.message ?? '') && r2.status === 200) || { first: r, second: r2.status };
});
await check('M3-39 システムの処理で使う区分値（JPY・品質区分・調整理由 OTHER）は使われていなくても消さない', async () => {
  const ids = await db.query(
    `select c.id, cc.code as cat, c.code from codes c join code_categories cc on cc.id = c.code_category_id
      where (cc.code, c.code) in (('CURRENCY','JPY'), ('QUALITY_DIVISION','GOOD'), ('ADJUSTMENT_REASON','OTHER'))`,
  );
  const bad = [];
  for (const row of ids.rows) {
    const r = await call('DELETE', `/masters/codes/${row.id}`, A);
    if (r.status !== 409 || !/システムの処理で使う/.test(r.body?.message ?? '')) bad.push({ ...row, status: r.status });
  }
  return (ids.rows.length >= 2 && bad.length === 0) || { n: ids.rows.length, bad };
});
await check('M3-39 区分値の更新で is_active を送ると非表示・表示に切り替わる（編集画面の切り替え）', async () => {
  const c = await addCode('EXPENSE_DIVISION', `${P}Z`, `${P}経費Z`);
  ok(await call('PATCH', `/masters/codes/${c.id}`, A, { name: `${P}経費Z`, sort_order: null, note: null, is_active: false }), 'off');
  const opts = ok(await call('GET', '/masters/codes/EXPENSE_DIVISION', A), 'options');
  const all = ok(await call('GET', '/masters/codes/EXPENSE_DIVISION/all', A), 'all');
  await call('DELETE', `/masters/codes/${c.id}`, A);
  return (!opts.values.some((v) => v.id === c.id) && all.values.some((v) => v.id === c.id && v.is_active === false)) || 'not toggled';
});
await check('M3-39 分類マスタの削除も、使われていればどこで何件かを出して断る', async () => {
  const cls = ok(await call('POST', '/masters/simple/product_classes', A, { code: `${P}K`, name: `${P}分類` }), 'class');
  ok(await call('PATCH', `/masters/products/${part.id}`, A, { product_class_id: cls.id }), 'use class');
  const r = await call('DELETE', `/masters/simple/product_classes/${cls.id}`, A);
  return (r.status === 409 && /商品 1件/.test(r.body?.message ?? '')) || r;
});
await check('M3-39 区分値の削除は操作履歴に残る', async () => {
  const c = await addCode('EXPENSE_DIVISION', `${P}H`, `${P}経費H`);
  ok(await call('DELETE', `/masters/codes/${c.id}`, A), 'delete');
  const log = await one(`select count(*)::int as n from audit_logs where ref_table = 'codes' and ref_id = $1 and action = 'delete'`, [c.id]);
  return log.n === 1 || log;
});

// ---- M3-40 作業指示内容の名称はコードで埋める ----------------------------------------
await check('M3-40 作業指示内容は CSV に「名称」の列が無く、取込で名称をコードで埋める', async () => {
  const head = await fetch(`${B}/masters/csv/work-instructions/export`, { headers: { authorization: `Bearer ${A}` } });
  const text = (await head.text()).replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0];
  if (/名称/.test(first)) return `見出しに名称がある: ${first}`;
  const csv = '﻿"コード","指示内容"\r\n' + `"${P}I","${P}の本文"\r\n`;
  const r = await call('POST', '/masters/csv/work-instructions/import', A, { content_base64: Buffer.from(csv, 'utf8').toString('base64'), dry_run: false });
  const w = await one(`select name, instruction_body from work_instructions where code = $1`, [`${P}I`]);
  return (w && w.name === `${P}I` && w.instruction_body === `${P}の本文`) || { status: r.status, body: r.body, w };
});
await check('M3-40 画面からの登録・更新も名称にコードが入る（画面は名称にコードを入れて送る）', async () => {
  const w = ok(await call('POST', '/masters/simple/work_instructions', A, { code: `${P}J`, name: `${P}J`, instruction_body: '本文' }), 'wi');
  const r = await one(`select name from work_instructions where id = $1`, [w.id]);
  return r.name === `${P}J` || r;
});

// ---- M3-41 使わない区分カテゴリーは出さない -------------------------------------------
await check('M3-41 区分カテゴリーの一覧に費用区分（使わない）を出さない。include_inactive=true なら出る', async () => {
  const cats = ok(await call('GET', '/masters/code-categories', A), 'cats');
  const all = ok(await call('GET', '/masters/code-categories?include_inactive=true', A), 'cats all');
  const off = await one(`select is_active from code_categories where code = 'COST_DIVISION'`);
  if (!off) return true;
  return (off.is_active === false && !cats.some((c) => c.code === 'COST_DIVISION') && all.some((c) => c.code === 'COST_DIVISION') && cats.some((c) => c.code === 'ADJUSTMENT_REASON')) || { off, n: cats.length };
});

await db.end();
process.exit(ng > 0 ? 1 : 0);
