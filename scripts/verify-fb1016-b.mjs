// マスター編_3（2026-10-16 ご要望）担当 B の回帰確認: 商品マスタ（M3-15〜M3-24）、商品分類のブランド（M3-18・M3-42）、
// 仕入品目の一覧（M3-30）。
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は GB＋時刻。
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
  return { status: r.status, text: await r.text() };
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (id) => ok(await call('POST', '/auth/login', '', { login_id: id, password: PASS }), 'login').access_token;
const A = await login('admin');
const V = await login('viewer1');
const t = String(Date.now()).slice(-6);
const P = `GB${t}`;

/** CSV を作って取り込む（dry=true で下見） */
const csvOf = (rows) => '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
const imp = (slug, rows, dry, token = A) =>
  call('POST', `/masters/csv/${slug}/import`, token, { content_base64: Buffer.from(csvOf(rows), 'utf8').toString('base64'), dry_run: dry });
/** CSV の文字（BOM・="..." を外す）を行・欄に分ける。簡易版（欄の中に改行・カンマが無い前提） */
const parse = (s) =>
  s.replace(/^﻿/, '').trim().split(/\r?\n/).map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').replace(/^=""(.*)""$/, '$1')));

// ---- 準備 ------------------------------------------------------------------
const brand = ok(await call('POST', '/masters/simple/brands', A, { code: `${P}B`, name: `${P}ブランド` }), 'brand');
const brand2 = ok(await call('POST', '/masters/simple/brands', A, { code: `${P}B2`, name: `${P}ブランド2` }), 'brand2');
const cat = ok(await call('POST', '/masters/simple/categories', A, { code: `${P}C`, name: `${P}カテゴリー` }), 'category');
const color = ok(await call('POST', '/masters/simple/colors', A, { code: `${P}01`, name: `${P}ブラック` }), 'color');
const size = ok(await call('POST', '/masters/simple/sizes', A, { code: `${P}S`, name: `${P}S寸` }), 'size');
const machine = await one(`select c.id from codes c join code_categories cc on cc.id = c.code_category_id where cc.code = 'ROYALTY_CLASS' and c.code = 'MACHINE'`);

// ---- 商品分類のブランド（M3-18・M3-42） ---------------------------------------
const pclass = ok(await call('POST', '/masters/simple/product_classes', A, { code: `${P}K`, name: `${P}分類`, brand_id: brand.id }), 'class');
await check('M3-42 商品分類にブランドを登録でき、一覧で返る', async () => {
  const r = ok(await call('GET', `/masters/simple/product_classes?q=${P}K`, A), 'list');
  const row = r.items.find((x) => x.id === pclass.id);
  return Number(row?.brand_id) === Number(brand.id) || row;
});
await check('M3-42 ブランドを送らない更新（名前だけ）ではブランドが消えない', async () => {
  ok(await call('PATCH', `/masters/simple/product_classes/${pclass.id}`, A, { name: `${P}分類A` }), 'patch');
  const r = await one(`select brand_id from product_classes where id = $1`, [pclass.id]);
  return Number(r.brand_id) === Number(brand.id) || r;
});
await check('M3-42 ブランドを空にできる（共通の分類）', async () => {
  ok(await call('PATCH', `/masters/simple/product_classes/${pclass.id}`, A, { brand_id: null }), 'patch');
  const r = await one(`select brand_id from product_classes where id = $1`, [pclass.id]);
  ok(await call('PATCH', `/masters/simple/product_classes/${pclass.id}`, A, { brand_id: brand.id }), 'patch back');
  return r.brand_id === null || r;
});
await check('M3-42 商品分類の CSV にブランドコードが出て、取り込みで変えられる', async () => {
  const e = await text('/masters/csv/product-classes/export', A);
  const rows = parse(e.text);
  const h = rows[0];
  const bi = h.indexOf('ブランドコード');
  const row = rows.find((r) => r[0] === `${P}K`);
  if (bi < 0 || row?.[bi] !== `${P}B`) return { header: h, row };
  const d = ok(await imp('product-classes', [['コード', 'ブランドコード'], [`${P}K`, `${P}B2`]], false), 'import');
  const r = await one(`select brand_id from product_classes where id = $1`, [pclass.id]);
  ok(await call('PATCH', `/masters/simple/product_classes/${pclass.id}`, A, { brand_id: brand.id }), 'patch back');
  return (d.errors === 0 && Number(r.brand_id) === Number(brand2.id)) || { d, r };
});

// ---- 商品（M3-19・M3-23） ----------------------------------------------------
const product = ok(await call('POST', '/masters/products', A, {
  product_code: `${P}P`, product_name: `${P}骨盤ショーツ`, brand_id: brand.id, category_id: cat.id, product_class_id: pclass.id,
  royalty_class_code_id: Number(machine.id), is_wholesale_adjust_target: true, cost_price: '500',
}), 'product');
const sku1 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}P-0102-100`, color_id: color.id, size_id: size.id, jan: null, cost_price: '940', old_cost_price: '900' }), 'sku1');
const sku2 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}P-0104-100`, sku_name: `${P}別名` }), 'sku2');
const sku3 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}P-0106-100` }), 'sku3');
ok(await call('PATCH', `/masters/skus/${sku3.id}`, A, { is_active: false }), 'sku3 off');
const product2 = ok(await call('POST', '/masters/products', A, { product_code: `${P}Q`, product_name: `${P}SKUなし` }), 'product2');

await check('M3-23 ロイヤリティ区分・下代調整対象が登録でき、詳細で返る', async () => {
  const d = ok(await call('GET', `/masters/products/${product.id}`, A), 'detail');
  return (Number(d.royalty_class_code_id) === Number(machine.id) && d.is_wholesale_adjust_target === true) || d;
});
await check('M3-23 下代調整対象は既定で対象外、更新で切り替えられる', async () => {
  const d0 = ok(await call('GET', `/masters/products/${product2.id}`, A), 'detail');
  ok(await call('PATCH', `/masters/products/${product2.id}`, A, { is_wholesale_adjust_target: true }), 'patch');
  const d1 = ok(await call('GET', `/masters/products/${product2.id}`, A), 'detail');
  ok(await call('PATCH', `/masters/products/${product2.id}`, A, { is_wholesale_adjust_target: false }), 'patch back');
  return (d0.is_wholesale_adjust_target === false && d1.is_wholesale_adjust_target === true) || { d0, d1 };
});
await check('M3-19 SKU の旧原価が保存され、詳細で返る（直すことも空にすることもできる）', async () => {
  const d = ok(await call('GET', `/masters/products/${product.id}`, A), 'detail');
  const k = d.skus.find((x) => x.id === sku1.id);
  if (Number(k?.old_cost_price) !== 900 || Number(k?.cost_price) !== 940) return k;
  ok(await call('PATCH', `/masters/skus/${sku1.id}`, A, { old_cost_price: '880' }), 'patch');
  const r = await one(`select old_cost_price::text v from skus where id = $1`, [sku1.id]);
  return Number(r.v) === 880 || r;
});
await check('M3-19 閲覧者には SKU の原価・旧原価を返さない（詳細）', async () => {
  const d = ok(await call('GET', `/masters/products/${product.id}`, V), 'detail');
  const k = d.skus.find((x) => x.id === sku1.id);
  return (k && !('cost_price' in k) && !('old_cost_price' in k) && !('cost_price' in d)) || d;
});
await check('M3-19 商品の画面からは原価を送らなくても登録・更新できる（商品の原価は既存のまま）', async () => {
  ok(await call('PATCH', `/masters/products/${product.id}`, A, { product_name: `${P}骨盤ショーツ07` }), 'patch');
  const r = await one(`select cost_price::text c from products where id = $1`, [product.id]);
  return Number(r.c) === 500 || r;
});

// ---- 一覧（M3-15） -------------------------------------------------------------
await check('M3-15 一覧は品番ごとに SKU を並べて返す（商品名にカラー・サイズ、商品分類コード・名前）', async () => {
  const r = ok(await call('GET', `/masters/products?q=${P}P&limit=50`, A), 'list');
  const p = r.items.find((x) => x.id === product.id);
  if (!p) return r;
  const k = p.skus.find((x) => x.id === sku1.id);
  const k2 = p.skus.find((x) => x.id === sku2.id);
  return (
    (p.product_class_code === `${P}K` && p.product_class_name === `${P}分類A` && p.category_name === `${P}カテゴリー` && p.brand_name === `${P}ブランド` &&
      k?.item_name === `${P}骨盤ショーツ07 ${P}ブラック ${P}S寸` && k2?.item_name === `${P}別名` && Number(k.cost_price) === 940) || p
  );
});
await check('M3-15 使わない SKU は既定では出ず、「使わないものも表示」で出る', async () => {
  const a = ok(await call('GET', `/masters/products?q=${P}P`, A), 'list');
  const b = ok(await call('GET', `/masters/products?q=${P}P&include_inactive=true`, A), 'list');
  const na = a.items.find((x) => x.id === product.id)?.skus.length;
  const nb = b.items.find((x) => x.id === product.id)?.skus.length;
  return (na === 2 && nb === 3) || { na, nb };
});
await check('M3-15 件数・ページ送りは品番の数（1ページ1件でも SKU は全部付く）', async () => {
  const r = ok(await call('GET', `/masters/products?q=${P}&limit=1&offset=0`, A), 'list');
  const r2 = ok(await call('GET', `/masters/products?q=${P}&limit=1&offset=1`, A), 'list');
  return (r.total === 2 && r.items.length === 1 && r.items[0].skus.length === 2 && r2.items.length === 1 && r2.items[0].skus.length === 0) || { r, r2 };
});
await check('M3-15 SKU の商品コード・JAN でも品番を引ける', async () => {
  const r = ok(await call('GET', `/masters/products?q=${P}P-0104`, A), 'list');
  return (r.total === 1 && r.items[0].id === product.id) || r;
});
await check('M3-15 ブランドの絞り込みは今までどおり効く', async () => {
  const r = ok(await call('GET', `/masters/products?q=${P}&brand_id=${brand.id}`, A), 'list');
  return (r.total === 1 && r.items[0].id === product.id) || r;
});
await check('M3-15 閲覧者の一覧には原価を返さない', async () => {
  const r = ok(await call('GET', `/masters/products?q=${P}P`, V), 'list');
  const p = r.items.find((x) => x.id === product.id);
  return (p && p.skus.length === 2 && p.skus.every((k) => !('cost_price' in k) && !('old_cost_price' in k) && !('product_cost_price' in k)) && !('cost_price' in p)) || p;
});

// ---- 名称（M3-16）・CSV ---------------------------------------------------------
await check('M3-16 商品コードの重複は「商品コード」の言葉で断る', async () => {
  const r = await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}P-0102-100` });
  return (r.status === 409 && String(r.body?.message).includes('商品コード')) || r;
});
await check('M3-16 商品コードが空のときの入力エラーは「商品コード」の言葉で出る', async () => {
  const r = await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: '' });
  return (r.status === 400 && JSON.stringify(r.body).includes('商品コード') && !JSON.stringify(r.body).includes('SKUコード')) || r;
});
await check('M3-23 商品の CSV にロイヤリティ区分・下代調整対象（対象／対象外）が出て、原価の列は無い', async () => {
  const e = await text('/masters/csv/products/export', A);
  const rows = parse(e.text);
  const h = rows[0];
  const row = rows.find((r) => r[0] === `${P}P`);
  const ri = h.indexOf('ロイヤリティ区分');
  const wi = h.indexOf('下代調整対象');
  return (ri >= 0 && wi >= 0 && row?.[ri] === 'MACHINE' && row?.[wi] === '対象' && !h.includes('原価') && !h.includes('旧原価') && !h.includes('原価未定')) || { h, row };
});
await check('M3-16 商品の CSV 取込は見出し「品番（商品分類コード）」でも読め、下代調整対象「対象外」を受ける', async () => {
  const d = ok(await imp('products', [['品番（商品分類コード）', '下代調整対象', 'ロイヤリティ区分'], [`${P}P`, '対象外', 'NON_MACHINE']], false), 'import');
  const r = await one(`select p.is_wholesale_adjust_target w, c.code from products p left join codes c on c.id = p.royalty_class_code_id where p.id = $1`, [product.id]);
  return (d.errors === 0 && d.updated === 1 && r.w === false && r.code === 'NON_MACHINE') || { d, r };
});
await check('M3-23 下代調整対象に決まった言葉以外は断る', async () => {
  const d = ok(await imp('products', [['商品コード', '下代調整対象'], [`${P}P`, 'たぶん']], true), 'import');
  return (d.errors === 1 && String(d.rows[0]?.message).includes('対象外')) || d;
});
await check('M3-19 SKU の CSV に旧原価が出て、取り込みで変えられる（見出し「品番」でも品番を読む）', async () => {
  const e = await text('/masters/csv/skus/export', A);
  const rows = parse(e.text);
  const h = rows[0];
  const oi = h.indexOf('旧原価');
  const row = rows.find((r) => r[0] === `${P}P-0102-100`);
  if (oi < 0 || Number(row?.[oi]) !== 880) return { h, row };
  const d = ok(await imp('skus', [['SKUコード', '品番', '旧原価'], [`${P}P-0104-100`, `${P}P`, '777']], false), 'import');
  const r = await one(`select old_cost_price::text v from skus where id = $1`, [sku2.id]);
  return (d.errors === 0 && Number(r.v) === 777) || { d, r };
});
await check('M3-19 閲覧者の SKU の CSV には原価・旧原価の列が無い', async () => {
  const e = await text('/masters/csv/skus/export', V);
  if (e.status === 403) return true; // 書き出しの権限が無ければそれでよい
  const h = parse(e.text)[0];
  return (!h.includes('原価') && !h.includes('旧原価')) || h;
});

// ---- 仕入品目の一覧（M3-30） -------------------------------------------------------
await check('M3-30 仕入品目の一覧にブランド・商品分類・カテゴリーの名前が付く', async () => {
  ok(await call('POST', '/masters/purchase-items', A, { purchase_code: `${P}PI`, item_name: `${P}品目`, brand_id: brand.id, category_id: cat.id, product_class_id: pclass.id }), 'pi');
  const r = ok(await call('GET', `/masters/purchase-items?q=${P}PI`, A), 'list');
  const x = r.items[0];
  return (r.total === 1 && x.brand_name === `${P}ブランド` && x.category_name === `${P}カテゴリー` && x.product_class_name === `${P}分類A` && x.product_class_code === `${P}K`) || r;
});

await db.end();
process.exit(ng === 0 ? 0 : 1);
