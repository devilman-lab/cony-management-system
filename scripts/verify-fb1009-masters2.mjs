// マスター編②フィードバック（2026-10-09）のうち M-06〜M-16（商品・SKU・セット）の回帰確認。
// API・DB は使い捨て環境を立てて流す（smoke-backend.ps1 の第1〜3節と同じ用意）。
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';

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
/** CSV・PDF など本文をそのまま受け取る */
async function raw(path, token) {
  const r = await fetch(B + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (id) => ok(await call('POST', '/auth/login', '', { login_id: id, password: PASS }), 'login').access_token;
const A = await login('admin');
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const t = String(Date.now()).slice(-6);

/**
 * PDF の文字を取り出す（帳票の品名の確認用）。
 * pdfkit は埋め込みフォントの字形番号で文字を書き、ToUnicode の対応表を付けるので、
 * 圧縮された中身を展開して対応表を作り、TJ/Tj の16進の文字列を文字に戻す。
 */
function pdfText(buf) {
  const src = buf.toString('latin1');
  const streams = [];
  // 中身の長さは辞書の /Length で知る（圧縮した中身に「stream」の並びが偶然現れることがあるため）
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const len = Number((/\/Length (\d+)(?!\s+\d+\s+R)/.exec(m[1]) ?? [])[1]);
    const end = Number.isFinite(len) ? start + len : src.indexOf('endstream', start);
    if (end < start) break;
    const body = Buffer.from(src.slice(start, end), 'latin1');
    try { streams.push(inflateSync(body).toString('latin1')); } catch { streams.push(body.toString('latin1')); }
    re.lastIndex = end;
  }
  const map = new Map();
  const u16 = (hex) => Buffer.from(hex, 'hex').swap16().toString('utf16le');
  for (const s of streams) {
    if (!s.includes('beginbfrange') && !s.includes('beginbfchar')) continue;
    for (const b of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(p[1], 16), u16(p[2]));
    }
    for (const b of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
        const lo = parseInt(p[1], 16);
        const hi = parseInt(p[2], 16);
        if (p[3].startsWith('[')) {
          [...p[3].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((d, i) => map.set(lo + i, u16(d[1])));
        } else {
          const base = parseInt(p[3].slice(1, -1), 16);
          for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(base + c - lo));
        }
      }
    }
  }
  let text = '';
  for (const s of streams) {
    for (const op of s.matchAll(/\[((?:[^\]])*)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g)) {
      const hexes = op[1] !== undefined ? [...op[1].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]) : [op[2]];
      for (const h of hexes) for (let i = 0; i + 4 <= h.length; i += 4) text += map.get(parseInt(h.slice(i, i + 4), 16)) ?? '';
      text += '\n';
    }
  }
  return text;
}

// ---- 準備（接頭辞 M2） --------------------------------------------------------
const category = Number((await one('select id from sales_categories order by id limit 1')).id);
const warehouse = Number((await one('select id from warehouses where is_active order by id limit 1')).id);
const color = ok(await call('POST', '/masters/simple/colors', A, { code: `M2C${t}`, name: `M2黒${t}` }), 'color');
const size = ok(await call('POST', '/masters/simple/sizes', A, { code: `M2Z${t}`, name: `M2S${t}` }), 'size');
const cust = ok(await call('POST', '/masters/partners', A, { partner_code: `M2P${t}`, name1: `M2販売先${t}`, is_customer: true, closing_day: 99 }), 'customer');
const dest = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: cust.id, delivery_code: `M2D${t}`, name: 'M2納品先', default_warehouse_id: warehouse }), 'dest');
const product = ok(await call('POST', '/masters/products', A, { product_code: `M2${t}`, product_name: `M2商品${t}`, cost_price: '100' }), 'product');
const skuName = `M2のSKU名${t}`;

// ---- M-07・M-10 SKU のカラー・サイズ・SKU の商品名 -------------------------------
const sku = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `M2${t}-0101-100`, sku_name: skuName, color_id: color.id, size_id: size.id, jan: `49${t}00011`.slice(0, 13) }), 'sku');
const sku2 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `M2${t}-0102-100`, color_id: color.id }), 'sku2');
await check('M-07/M-10 SKU のカラー・サイズ・SKU の商品名が保存され、商品の詳細で返る', async () => {
  const d = ok(await call('GET', `/masters/products/${product.id}`, A), 'detail');
  const k = d.skus.find((s) => s.id === sku.id);
  return (k?.sku_name === skuName && Number(k?.color_id) === color.id && Number(k?.size_id) === size.id && k?.color_name === `M2黒${t}` && k?.size_name === `M2S${t}`) || k;
});
await check('M-10 SKU の商品名を直して保存し直すと、その値で返る（往復）', async () => {
  ok(await call('PATCH', `/masters/skus/${sku2.id}`, A, { sku_name: `${skuName}改` }), 'patch');
  const d1 = ok(await call('GET', `/masters/products/${product.id}`, A), 'detail');
  ok(await call('PATCH', `/masters/skus/${sku2.id}`, A, { sku_name: null }), 'clear');
  const d2 = ok(await call('GET', `/masters/products/${product.id}`, A), 'detail');
  return (d1.skus.find((s) => s.id === sku2.id)?.sku_name === `${skuName}改` && d2.skus.find((s) => s.id === sku2.id)?.sku_name === null) || [d1.skus, d2.skus];
});
await check('M-09 FBA用JAN・ショップ商品コードは、ほかの欄だけを保存し直しても消えない', async () => {
  ok(await call('PATCH', `/masters/skus/${sku.id}`, A, { fba_jan: `45${t}00012`.slice(0, 13), shop_product_code: `M2SHOP${t}` }), 'patch');
  const d = ok(await call('GET', `/masters/products/${product.id}`, A), 'detail');
  const k = d.skus.find((s) => s.id === sku.id);
  // 画面と同じく、詳細で受け取った値をそのまま送り返す
  ok(await call('PATCH', `/masters/skus/${sku.id}`, A, { product_id: product.id, sku_code: k.sku_code, sku_name: k.sku_name, jan: k.jan, fba_jan: k.fba_jan, shop_product_code: k.shop_product_code, color_id: k.color_id, size_id: k.size_id, pack_division: k.pack_division, is_active: true }), 'resave');
  const r = await one('select fba_jan, shop_product_code from skus where id = $1', [sku.id]);
  return (r.fba_jan === `45${t}00012`.slice(0, 13) && r.shop_product_code === `M2SHOP${t}`) || r;
});

// ---- M-10 SKU の検索 ------------------------------------------------------------
await check('M-10 SKU の検索は SKU の商品名を返す（無い SKU は商品名）', async () => {
  const r = ok(await call('GET', `/masters/skus?q=M2${t}`, A), 'search');
  const a = r.find((s) => s.sku_id === sku.id);
  const b = r.find((s) => s.sku_id === sku2.id);
  return (a?.item_name === skuName && a?.sku_name === skuName && a?.product_name === `M2商品${t}` && b?.item_name === `M2商品${t}`) || r;
});
await check('M-10 SKU の商品名で SKU を引ける', async () => {
  const r = ok(await call('GET', `/masters/skus?q=${encodeURIComponent(skuName)}`, A), 'search');
  return (r.length === 1 && r[0].sku_id === sku.id) || r;
});
await check('M-10 マスタの CSV（SKU）に「SKUの商品名」の列があり、値が出る', async () => {
  const r = await raw('/masters/csv/skus/export', A);
  const text = r.buf.toString('utf8');
  const head = text.split(/\r?\n/)[0];
  return (r.status === 200 && head.includes('SKUの商品名') && text.includes(skuName)) || `${r.status} ${head}`;
});
await check('M-10 マスタの CSV（SKU）から SKU の商品名を取り込める', async () => {
  const csv = `SKUコード,SKUの商品名\r\nM2${t}-0102-100,CSV名${t}\r\n`;
  ok(await call('POST', '/masters/csv/skus/import', A, { content_base64: Buffer.from(csv, 'utf8').toString('base64'), dry_run: false }), 'import');
  const r = await one('select sku_name from skus where id = $1', [sku2.id]);
  await call('PATCH', `/masters/skus/${sku2.id}`, A, { sku_name: null });
  return r.sku_name === `CSV名${t}` || r;
});
await check('M-10 JANコード一覧CSV の商品名は SKU の商品名（無ければ商品名）', async () => {
  const r = await raw('/masters/skus/jan-export', A);
  const lines = r.buf.toString('utf8').split(/\r?\n/);
  const a = lines.find((l) => l.startsWith(`"M2${t}-0101-100"`)) ?? '';
  const b = lines.find((l) => l.startsWith(`"M2${t}-0102-100"`)) ?? '';
  return (a.includes(`"${skuName}"`) && b.includes(`"M2商品${t}"`)) || [a, b];
});

// ---- M-10 出荷系帳票の品名 -------------------------------------------------------
// 在庫を入れ、受注入力と同じ品名（検索の item_name＋カラー＋サイズ）で受注して出荷を作る
const rc = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: warehouse, planned_date: today, lines: [{ line_no: 1, sku_id: sku.id, qty: '20' }, { line_no: 2, sku_id: sku2.id, qty: '20' }] }), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');
const hit = ok(await call('GET', `/masters/skus?q=M2${t}-0101-100`, A), 'search').find((s) => s.sku_id === sku.id);
const itemName = `${hit.item_name}${hit.color_name ? ' ' + hit.color_name : ''}${hit.size_name ? ' ' + hit.size_name : ''}`;
const ord = ok(await call('POST', '/orders', A, { order_type: '卸', partner_id: cust.id, delivery_destination_id: dest.id, sales_category_id: category, order_date: today, ship_date: today, lines: [{ line_no: 1, line_type: '商品', sku_id: sku.id, item_name: itemName, qty: '1', unit_price: '1000' }] }), 'order');
let ship = await one('select id from shipments where sales_order_id = $1', [ord.id]);
if (!ship) {
  await call('POST', `/orders/${ord.id}/allocate`, A, {});
  await call('POST', `/orders/${ord.id}/shipping-instruction`, A, {});
  ship = await one('select id from shipments where sales_order_id = $1', [ord.id]);
}
await check('M-10 受注入力の品名（SKU の商品名＋カラー＋サイズ）で受注が登録できる（前提）', async () => {
  const l = await one('select item_name from sales_order_lines where sales_order_id = $1', [ord.id]);
  return (l.item_name === `${skuName} M2黒${t} M2S${t}` && !!ship) || { l, ship };
});
for (const [label, path] of [
  ['出荷指示書', `/reports/shipping-instructions?shipment_ids=${ship?.id}`],
  ['ピッキングリスト', `/reports/picking-list?shipment_ids=${ship?.id}`],
  ['納品書', `/reports/delivery-notes?shipment_ids=${ship?.id}`],
]) {
  await check(`M-10 ${label}の品名に SKU の商品名が出る`, async () => {
    const r = await raw(path, A);
    if (r.status !== 200) return `${r.status} ${r.buf.toString('utf8').slice(0, 200)}`;
    const text = pdfText(r.buf);
    return text.includes(skuName) || text.slice(0, 400);
  });
}

// ---- M-15 セット SKU の候補は is_set の商品だけ -----------------------------------
const setProduct = ok(await call('POST', '/masters/products', A, { product_code: `M2SET${t}`, product_name: `M2セット${t}`, is_set: true }), 'set product');
const setSku = ok(await call('POST', '/masters/skus', A, { product_id: setProduct.id, sku_code: `M2SET${t}-0101-200`, color_id: color.id, size_id: size.id }), 'set sku');
const setSku2 = ok(await call('POST', '/masters/skus', A, { product_id: setProduct.id, sku_code: `M2SET${t}-0102-200`, sku_name: `M2セットSKU名${t}` }), 'set sku2');
await check('M-15 SKU の検索で is_set=true にするとセット商品の SKU だけ（カラー・サイズ付き）', async () => {
  const r = ok(await call('GET', `/masters/skus?q=M2&is_set=true&limit=100`, A), 'search');
  const mine = r.filter((s) => s.sku_code.includes(t));
  return (r.every((s) => s.is_set === true) && mine.some((s) => s.sku_id === setSku.id && s.color_name === `M2黒${t}` && s.size_name === `M2S${t}`) && !mine.some((s) => s.sku_id === sku.id)) || mine;
});
await check('M-15 is_set=false にするとセット商品の SKU は出ない', async () => {
  const r = ok(await call('GET', `/masters/skus?q=M2&is_set=false&limit=100`, A), 'search');
  return (r.every((s) => s.is_set === false) && r.some((s) => s.sku_id === sku.id) && !r.some((s) => s.sku_id === setSku.id)) || r.map((s) => s.sku_code);
});
await check('M-15 is_set を省くと絞らない（今までどおり）', async () => {
  const r = ok(await call('GET', `/masters/skus?q=M2&limit=100`, A), 'search');
  return (r.some((s) => s.sku_id === sku.id) && r.some((s) => s.sku_id === setSku.id)) || r.map((s) => s.sku_code);
});

// ---- M-12・M-16 セットの一覧・詳細 ------------------------------------------------
const setBody = (skuId) => ({ sku_id: skuId, components: [{ component_sku_id: sku.id, qty: '2' }], note: 'M2' });
ok(await call('POST', '/masters/sets', A, setBody(setSku.id)), 'set');
ok(await call('POST', '/masters/sets', A, setBody(setSku2.id)), 'set2');
const setRow = async (skuId) => ok(await call('GET', `/masters/sets?q=M2SET${t}`, A), 'list').items.find((x) => Number(x.sku_id) === skuId);
await check('M-12 セット一覧の商品名は「商品名　カラー　サイズ」', async () => {
  const r = await setRow(setSku.id);
  return r?.display_name === `M2セット${t}　M2黒${t}　M2S${t}` || r;
});
await check('M-12 セット一覧の商品名は SKU の商品名があればそれ', async () => {
  const r = await setRow(setSku2.id);
  return (r?.display_name === `M2セットSKU名${t}` && r?.product_name === `M2セットSKU名${t}`) || r;
});
await check('M-15/M-16 セットの詳細はセット SKU と構成品のカラー・サイズ・SKU の商品名を返す', async () => {
  const r = await setRow(setSku.id);
  const d = ok(await call('GET', `/masters/sets/${r.id}`, A), 'detail');
  const c = d.components[0];
  return (d.sku_code === `M2SET${t}-0101-200` && d.color_name === `M2黒${t}` && d.size_name === `M2S${t}` && c.product_name === skuName && c.color_name === `M2黒${t}` && c.size_name === `M2S${t}`) || d;
});

// ---- M-14 セットの削除 -------------------------------------------------------------
await check('M-14 使われていないセットは構成ごと消える（セット SKU は残る）', async () => {
  const r = await setRow(setSku2.id);
  const del = await call('DELETE', `/masters/sets/${r.id}`, A);
  if (del.status !== 200) return `${del.status} ${JSON.stringify(del.body)}`;
  const h = await one('select count(*)::int n from set_headers where id = $1', [r.id]);
  const c = await one('select count(*)::int n from set_components where set_header_id = $1', [r.id]);
  const s = await one('select count(*)::int n from skus where id = $1', [setSku2.id]);
  return (h.n === 0 && c.n === 0 && s.n === 1) || { h, c, s };
});
await check('M-14 受注で使われているセットは、理由（受注）を付けて断る', async () => {
  const o = ok(await call('POST', '/orders', A, { order_type: '卸', partner_id: cust.id, delivery_destination_id: dest.id, sales_category_id: category, order_date: today, ship_date: today, lines: [{ line_no: 1, line_type: 'セット商品', sku_id: setSku.id, item_name: 'M2セット', qty: '1', unit_price: '2000' }] }), 'set order');
  void o;
  const r = await setRow(setSku.id);
  const del = await call('DELETE', `/masters/sets/${r.id}`, A);
  const still = await one('select count(*)::int n from set_headers where id = $1', [r.id]);
  return (del.status === 409 && String(del.body?.message).includes('受注') && still.n === 1) || { status: del.status, body: del.body };
});

// ---- M-08 SKU の削除 ---------------------------------------------------------------
await check('M-08 使われていない SKU は削除できる', async () => {
  const k = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `M2${t}-0199-100` }), 'sku');
  const del = await call('DELETE', `/masters/skus/${k.id}`, A);
  const n = await one('select count(*)::int n from skus where id = $1', [k.id]);
  return (del.status === 200 && n.n === 0) || { status: del.status, body: del.body };
});
await check('M-08 使われている SKU は、どこで使われているか（入荷・在庫表）を付けて断る', async () => {
  const del = await call('DELETE', `/masters/skus/${sku2.id}`, A);
  const m = String(del.body?.message ?? '');
  return (del.status === 409 && m.includes('入荷') && m.includes('在庫表') && m.includes(`M2${t}-0102-100`)) || { status: del.status, body: del.body };
});

// ---- M-11 商品の削除 ---------------------------------------------------------------
await check('M-11 使われていない商品は SKU ごと消える', async () => {
  const p = ok(await call('POST', '/masters/products', A, { product_code: `M2DEL${t}`, product_name: 'M2消す商品' }), 'product');
  for (const n of [1, 2]) ok(await call('POST', '/masters/skus', A, { product_id: p.id, sku_code: `M2DEL${t}-010${n}-100`, color_id: color.id }), 'sku');
  const del = await call('DELETE', `/masters/products/${p.id}`, A);
  const a = await one('select count(*)::int n from products where id = $1', [p.id]);
  const b = await one('select count(*)::int n from skus where product_id = $1', [p.id]);
  return (del.status === 200 && a.n === 0 && b.n === 0 && del.body?.skus === 2) || { status: del.status, body: del.body, a, b };
});
await check('M-11 使われている商品は、どこで使われているか（在庫表・入荷・受注・セット）を付けて断る', async () => {
  const del = await call('DELETE', `/masters/products/${product.id}`, A);
  const m = String(del.body?.message ?? '');
  const n = await one('select count(*)::int n from skus where product_id = $1', [product.id]);
  return (del.status === 409 && ['在庫表', '入荷', '受注', 'セット登録（構成品）'].every((w) => m.includes(w)) && n.n === 2) || { status: del.status, body: del.body };
});
await check('M-11 得意先別商品だけで使われている商品も、その旨を出して断る', async () => {
  const p = ok(await call('POST', '/masters/products', A, { product_code: `M2PP${t}`, product_name: 'M2得意先別' }), 'product');
  const k = ok(await call('POST', '/masters/skus', A, { product_id: p.id, sku_code: `M2PP${t}-0101-100` }), 'sku');
  ok(await call('POST', '/masters/partner-products', A, { partner_id: cust.id, sku_id: k.id, unit_price: '100' }), 'pp');
  const del = await call('DELETE', `/masters/products/${p.id}`, A);
  return (del.status === 409 && String(del.body?.message).includes('得意先別商品')) || { status: del.status, body: del.body };
});
await check('M-11 存在しない商品の削除は 404', async () => {
  const r = await call('DELETE', '/masters/products/99999999', A);
  return r.status === 404 || r.status;
});
await check('削除は監査ログに残る（商品・SKU・セット）', async () => {
  const r = await one(`select count(distinct ref_table)::int n from audit_logs where action = 'delete' and ref_table in ('products', 'skus', 'set_headers') and acted_at > now() - interval '1 hour'`);
  return r.n === 3 || r;
});

await db.end();
process.exit(ng === 0 ? 0 : 1);
