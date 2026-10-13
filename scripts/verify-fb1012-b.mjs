// 2026-10-12 受入テスト T2 の修正（担当 B：商品マスタ・セット登録）の回帰確認。
//   No.16  JAN の左6桁ルール：品番の付け替えですり抜けない／相手の品番・SKU を出す／JAN を触らない保存は通る
//   M-14   セットの新規・コピーで既存のセットを上書きしない（409）。構成の入れ替えは編集（PUT）だけ
//   M-15   API でセット商品でない SKU をセット SKU に送ると 400
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は FB。
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
const msg = (r) => String(r.body?.message ?? '');
const login = async (id) => ok(await call('POST', '/auth/login', '', { login_id: id, password: PASS }), 'login').access_token;
const A = await login('admin');
const t4 = String(Date.now()).slice(-4);
const t3 = String(Date.now()).slice(-3);

// ---- 準備（接頭辞 FB） --------------------------------------------------------
// 品番の左6桁のグループ: G1 = FB1234（6文字）、G2 = FBX123（左6桁が G1 と違う）
const G1 = `FB${t4}`;
const G2 = `FBX${t3}`;
// まだどこにも使われていない 13 桁の JAN を作る
const freshJan = async () => {
  for (;;) {
    const j = '49' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0');
    if (!(await one(`select 1 from skus where jan = $1 or fba_jan = $1`, [j]))) return j;
  }
};
const J1 = await freshJan();
const J2 = await freshJan();

const p1 = ok(await call('POST', '/masters/products', A, { product_code: G1, product_name: `FB商品${t4}` }), 'p1');
const s1 = ok(await call('POST', '/masters/skus', A, { product_id: p1.id, sku_code: `${G1}-0101-100`, jan: J1, pack_division: '100' }), 's1');
const p1l = ok(await call('POST', '/masters/products', A, { product_code: `${G1}L`, product_name: `FB商品L${t4}` }), 'p1l');
const p2 = ok(await call('POST', '/masters/products', A, { product_code: G2, product_name: `FB別グループ${t3}` }), 'p2');
const s2 = ok(await call('POST', '/masters/skus', A, { product_id: p2.id, sku_code: `${G2}-0101-100`, jan: J2 }), 's2');

// ---- No.16 JAN の左6桁ルール ----------------------------------------------------
let s1l;
await check('No.16 左6桁が同じ品番の SKU には同じ JAN を付けられる', async () => {
  const r = await call('POST', '/masters/skus', A, { product_id: p1l.id, sku_code: `${G1}L-0101-100`, jan: J1, pack_division: '100' });
  s1l = r.body;
  return r.status === 201 || r;
});

await check('No.16 品番を左6桁が違うものに付け替えると 409、相手の品番・SKU コードと JAN を出す', async () => {
  const r = await call('PATCH', `/masters/products/${p1l.id}`, A, { product_code: `${G2}L`, product_name: `FB商品L${t4}` });
  const m = msg(r);
  if (r.status !== 409) return r;
  return (m.includes(G1) && m.includes(`${G1}-0101-100`) && m.includes(`${G1}L-0101-100`) && m.includes(J1)) || m;
});
await check('No.16 断られた付け替えで品番は変わっていない', async () => {
  const r = await one(`select product_code from products where id = $1`, [p1l.id]);
  return r.product_code === `${G1}L` || r;
});
await check('No.16 左6桁が同じ品番への付け替えは通る', async () => {
  const r = await call('PATCH', `/masters/products/${p1l.id}`, A, { product_code: `${G1}M` });
  return r.status === 200 || r;
});
await check('No.16 品番を変えない商品の更新（商品名だけ）は通る', async () => {
  const r = await call('PATCH', `/masters/products/${p1l.id}`, A, { product_code: `${G1}M`, product_name: `FB商品M${t4}` });
  return r.status === 200 || r;
});

await check('No.16 左6桁が違う商品の SKU を同じ JAN で作ると 409、相手の品番・SKU コードを出す', async () => {
  const r = await call('POST', '/masters/skus', A, { product_id: p2.id, sku_code: `${G2}-0102-100`, jan: J1 });
  const m = msg(r);
  if (r.status !== 409) return r;
  return (m.includes(G1) && m.includes(`${G1}-0101-100`) && m.includes(J1)) || m;
});
await check('No.16 既存 SKU の JAN を左6桁が違う商品の JAN に変えると 409、相手の品番を出す', async () => {
  const r = await call('PATCH', `/masters/skus/${s2.id}`, A, { product_id: p2.id, sku_code: `${G2}-0101-100`, jan: J1 });
  const m = msg(r);
  if (r.status !== 409) return r;
  return (m.includes(G1) && m.includes(`${G2}-0101-100`)) || m;
});
await check('No.16 SKU を左6桁が違う商品へ移すと 409', async () => {
  const r = await call('PATCH', `/masters/skus/${s1l.id}`, A, { product_id: p2.id });
  return (r.status === 409 && msg(r).includes(G1)) || r;
});

// すでに規則に反した状態（以前のすり抜けで出来たもの）を DB で直接作る：p1l の品番を G2 のグループに
await db.query(`update products set product_code = $1 where id = $2`, [`${G2}Q`, p1l.id]);
await check('No.16 規則に反した状態でも、JAN を触らない SKU の保存（入数区分だけ）は通る（画面と同じ全欄の送り方）', async () => {
  const r = await call('PATCH', `/masters/skus/${s1.id}`, A, {
    product_id: p1.id, sku_code: `${G1}-0101-100`, sku_name: null, jan: J1, fba_jan: null, shop_product_code: null,
    color_id: null, size_id: null, pack_division: '101', is_active: true,
  });
  if (r.status !== 200) return r;
  const d = await one(`select pack_division, jan from skus where id = $1`, [s1.id]);
  return (d.pack_division === '101' && d.jan === J1) || d;
});
await check('No.16 規則に反した相手側の SKU も、JAN を触らなければ保存できる', async () => {
  const r = await call('PATCH', `/masters/skus/${s1l.id}`, A, { product_id: p1l.id, sku_code: `${G1}L-0101-100`, jan: J1, pack_division: '200' });
  return r.status === 200 || r;
});
await check('No.16 規則に反した状態で JAN を変えようとすると、どの JAN・相手かを出して断る', async () => {
  // s2 の JAN を J1 に（G1 と重なる）。断られ、文言に相手の SKU が出る
  const r = await call('PATCH', `/masters/skus/${s2.id}`, A, { jan: J1 });
  return (r.status === 409 && msg(r).includes(`${G1}-0101-100`)) || r;
});
await check('No.16 規則に反した状態から JAN を空にして直せる', async () => {
  const r = await call('PATCH', `/masters/skus/${s1l.id}`, A, { jan: null });
  if (r.status !== 200) return r;
  const d = await one(`select jan from skus where id = $1`, [s1l.id]);
  return d.jan === null || d;
});

// CSV 取り込み（一覧で編集も同じ経路）
const csvImport = async (rows, dryRun) => {
  const csv = '﻿' + rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\r\n') + '\r\n';
  return call('POST', '/masters/csv/skus/import', A, { content_base64: Buffer.from(csv, 'utf8').toString('base64'), dry_run: dryRun });
};
await check('No.16 CSV 取り込みの下見で、左6桁が違う商品と重なる JAN の行はエラー（相手の品番・SKU を出す）', async () => {
  const r = await csvImport([['SKUコード', '商品コード', 'JANコード'], [`${G2}-0101-100`, G2, J1]], true);
  if (r.status !== 200) return r;
  const row = r.body.rows?.[0];
  return (row?.action === 'エラー' && String(row.message).includes(G1) && String(row.message).includes(`${G1}-0101-100`)) || r.body;
});
await check('No.16 CSV 取り込みで、規則に反した SKU の入数区分だけを直せる（JAN の列は今と同じ）', async () => {
  // 規則に反した状態を作り直す（DB で直接）。JAN は引き金に止められないよう同じグループのうちに付け、そのあと品番を付け替える
  await db.query(`update products set product_code = $1 where id = $2`, [`${G1}M`, p1l.id]);
  await db.query(`update skus set jan = $1 where id = $2`, [J1, s1l.id]);
  await db.query(`update products set product_code = $1 where id = $2`, [`${G2}Q`, p1l.id]);
  const r = await csvImport([['SKUコード', '商品コード', 'JANコード', '入数区分'], [`${G1}-0101-100`, G1, J1, '102']], false);
  if (r.status !== 200) return r;
  const d = await one(`select pack_division from skus where id = $1`, [s1.id]);
  return d.pack_division === '102' || d;
});
await check('No.16 JAN エラー文に相手の品番が出る（データベースの引き金が断ったときも固定文言にしない）', async () => {
  // 同じファイルの2行で、左6桁が違う2つの SKU に同じ新しい JAN を付ける。下見の検査は既存の SKU としか比べないので、
  // 2行目はデータベースの引き金で断られる
  const J3 = await freshJan();
  const r = await csvImport([['SKUコード', '商品コード', 'JANコード'], [`${G1}-0102-100`, G1, J3], [`${G2}-0102-100`, G2, J3]], true);
  if (r.status !== 200) return r;
  const row = r.body.rows?.[1];
  return (row?.action === 'エラー' && String(row.message).includes(G1)) || r.body;
});
await db.query(`update skus set jan = null where id = $1`, [s1l.id]);

// ---- M-14・M-15 セット登録 ------------------------------------------------------
const sp = ok(await call('POST', '/masters/products', A, { product_code: `FBS${t3}`, product_name: `FBセット${t3}`, is_set: true }), 'set product');
const ss1 = ok(await call('POST', '/masters/skus', A, { product_id: sp.id, sku_code: `FBS${t3}-0101-200` }), 'ss1');
const ss2 = ok(await call('POST', '/masters/skus', A, { product_id: sp.id, sku_code: `FBS${t3}-0102-200` }), 'ss2');
const comps = async (headerId) =>
  (await all(`select component_sku_id::int as id, qty::text as qty from set_components where set_header_id = $1 order by sort_order`, [headerId]));

let set1;
await check('M-14 セットの新規登録は 201', async () => {
  const r = await call('POST', '/masters/sets', A, { sku_id: ss1.id, components: [{ component_sku_id: s1.id, qty: '1' }, { component_sku_id: s2.id, qty: '1' }] });
  set1 = r.body;
  return (r.status === 201 && !!set1?.id) || r;
});
await check('M-14 登録済みのセット SKU で新規・コピーを送ると 409、構成は変わらない', async () => {
  const r = await call('POST', '/masters/sets', A, { sku_id: ss1.id, components: [{ component_sku_id: s1.id, qty: '1' }] });
  const m = msg(r);
  if (r.status !== 409 || !m.includes(`セット SKU FBS${t3}-0101-200 はすでにセット登録があります`) || !m.includes('編集')) return r;
  const c = await comps(set1.id);
  return c.length === 2 || c;
});
await check('M-15 セット商品でない SKU をセット SKU に送ると 400、セット登録は作られない', async () => {
  const r = await call('POST', '/masters/sets', A, { sku_id: s2.id, components: [{ component_sku_id: s1.id, qty: '1' }] });
  if (r.status !== 400 || !msg(r).includes('セット商品ではありません')) return r;
  const n = await one(`select count(*)::int as n from set_headers where sku_id = $1`, [s2.id]);
  return n.n === 0 || n;
});
await check('M-14 編集（PUT）で構成を入れ替えられる', async () => {
  const r = await call('PUT', `/masters/sets/${set1.id}`, A, { components: [{ component_sku_id: s1.id, qty: '2' }], note: `FB備考${t3}` });
  if (r.status !== 200) return r;
  const c = await comps(set1.id);
  const h = await one(`select note, sku_id::int as sku_id from set_headers where id = $1`, [set1.id]);
  return (c.length === 1 && c[0].id === Number(s1.id) && Number(c[0].qty) === 2 && h.note === `FB備考${t3}` && h.sku_id === Number(ss1.id)) || { c, h };
});
await check('M-14 編集は操作履歴に「更新」で残る', async () => {
  const n = await one(`select count(*)::int as n from audit_logs where ref_table = 'set_headers' and ref_id = $1 and action = 'update'`, [set1.id]);
  return n.n >= 1 || n;
});
await check('M-14 存在しないセットの編集は 404', async () => {
  const r = await call('PUT', '/masters/sets/999999999', A, { components: [{ component_sku_id: s1.id, qty: '1' }] });
  return r.status === 404 || r;
});
await check('M-14 セット SKU の候補（without_set）から登録済みのセット SKU を外す', async () => {
  const r = ok(await call('GET', `/masters/skus?is_set=true&without_set=true&q=FBS${t3}`, A), 'search');
  const codes = r.map((x) => x.sku_code);
  return (!codes.includes(`FBS${t3}-0101-200`) && codes.includes(`FBS${t3}-0102-200`)) || codes;
});
await check('M-14 without_set を付けない検索（受注入力など）は今までどおり両方出る', async () => {
  const r = ok(await call('GET', `/masters/skus?is_set=true&q=FBS${t3}`, A), 'search');
  const codes = r.map((x) => x.sku_code);
  return (codes.includes(`FBS${t3}-0101-200`) && codes.includes(`FBS${t3}-0102-200`)) || codes;
});
await check('M-14 未登録のセット SKU には新規登録できる（コピーの用途）', async () => {
  const r = await call('POST', '/masters/sets', A, { sku_id: ss2.id, components: [{ component_sku_id: s1.id, qty: '2' }] });
  return r.status === 201 || r;
});

await db.end();
process.exit(ng > 0 ? 1 : 0);
