// マスター編_3（2026-10-16）担当 C：得意先別商品（M3-25〜M3-28・M3-08 後半）の回帰確認。
// smoke-backend.ps1 から呼ばれる想定（API・DB は smoke が立てた使い捨て環境）。
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は GC＋時刻。
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
async function raw(path, token) {
  const r = await fetch(B + path, { headers: { authorization: `Bearer ${token}` } });
  if (r.status >= 300) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}
async function text(path, token) {
  const r = await fetch(B + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, text: await r.text() };
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (id) => ok(await call('POST', '/auth/login', '', { login_id: id, password: PASS }), 'login').access_token;

/** PDF から文字を取り出す（verify-fb1009-masters1.mjs と同じ。ToUnicode を読んで字形番号を文字に戻す） */
function pdfText(buf) {
  const s = buf.toString('latin1');
  const streams = [];
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const len = /\/Length (\d+)(?!\s+\d+\s+R)/.exec(m[1]);
    const end = len ? start + Number(len[1]) : s.indexOf('endstream', start);
    let data = Buffer.from(s.slice(start, end), 'latin1');
    if (/FlateDecode/.test(m[1])) { try { data = inflateSync(data); } catch { continue; } }
    streams.push(data.toString('latin1'));
  }
  const utf16 = (h) => { let o = ''; for (let i = 0; i + 4 <= h.length; i += 4) o += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return o; };
  const map = new Map();
  for (const st of streams.filter((x) => x.includes('begincmap'))) {
    for (const b of st.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const x of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(x[1], 16), utf16(x[2]));
    }
    for (const b of st.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const x of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
        const lo = parseInt(x[1], 16), hi = parseInt(x[2], 16);
        if (x[3].startsWith('[')) [...x[3].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((y, i) => map.set(lo + i, utf16(y[1])));
        else { const base = parseInt(x[3].slice(1, -1), 16); for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(base + c - lo)); }
      }
    }
  }
  let out = '';
  for (const st of streams.filter((x) => !x.includes('begincmap'))) {
    for (const t of st.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g)) {
      const hexes = t[1] !== undefined ? [...t[1].matchAll(/<([0-9a-fA-F]+)>/g)].map((y) => y[1]) : [t[2]];
      for (const h of hexes) for (let i = 0; i + 4 <= h.length; i += 4) out += map.get(parseInt(h.slice(i, i + 4), 16)) ?? '';
      out += '\n';
    }
  }
  return out;
}

/** CSV を作って取り込む（dry=true で下見） */
const csvOf = (rows) => '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
const imp = (slug, rows, dry, token) =>
  call('POST', `/masters/csv/${slug}/import`, token, { content_base64: Buffer.from(csvOf(rows), 'utf8').toString('base64'), dry_run: dry });

const A = await login('admin');
const V = await login('viewer1');
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const t = String(Date.now()).slice(-6);
const P = `GC${t}`;

// ---- 準備（接頭辞 GC） --------------------------------------------------------
const category = Number((await one('select id from sales_categories order by id limit 1')).id);
const warehouse = Number((await one('select id from warehouses where is_active order by id limit 1')).id);
const SKU_JAN = `49${t}00001`.padEnd(13, '0').slice(0, 13);
const SHIP_JAN1 = `45${t}11111`.padEnd(13, '0').slice(0, 13);
const PJAN2 = `47${t}22222`.padEnd(13, '0').slice(0, 13);
const media1 = ok(await call('POST', '/masters/simple/media', A, { code: `${P}M1`, name: `${P}テレビ` }), 'media1');
const media2 = ok(await call('POST', '/masters/simple/media', A, { code: `${P}M2`, name: `${P}カタログ` }), 'media2');
const cust = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}C`, name1: `${P}得意先株式会社`, short_name: `${P}略`, is_customer: true, media_id: media1.id, closing_day: 99 }), 'customer');
const other = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}X`, name1: `${P}別の得意先`, is_customer: true, media_id: media2.id, closing_day: 99 }), 'other customer');
const dest = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: cust.id, delivery_code: `${P}D`, name: `${P}納品先`, default_warehouse_id: warehouse }), 'dest');
const product = ok(await call('POST', '/masters/products', A, { product_code: `${P}`, product_name: `${P}骨盤ショーツ`, cost_price: '150' }), 'product');
const sku = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}-0102-100`, jan: SKU_JAN }), 'sku');
const sku2 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}-0104-100` }), 'sku2');
const rc = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: warehouse, planned_date: today, lines: [{ line_no: 1, sku_id: sku.id, qty: '50' }] }), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');

// 同じ取引先・同じ SKU に2行（先方コードなし＝1行目、先方コード B＝2行目）。原価は API では受けるが使わない
const pp1 = ok(await call('POST', '/masters/partner-products', A, {
  partner_id: cust.id, sku_id: sku.id, unit_price: '1000', retail_price: '7777', shipping_jan: SHIP_JAN1, sales_name: `${P}販売名1`, cost_price: '777', sort_order: 2,
}), 'pp1');
const CODE_B = `${P}B`;

// ---- M3-26 複数行 ---------------------------------------------------------------
let pp2 = null;
await check('M3-26 同じ取引先・同じ SKU に先方コードの違う2行目を登録できる', async () => {
  const r = await call('POST', '/masters/partner-products', A, {
    partner_id: cust.id, sku_id: sku.id, partner_product_code: CODE_B, partner_jan: PJAN2, unit_price: '1200', sales_name: `${P}販売名2`, sort_order: 1, note: `${P}秋の企画`,
  });
  pp2 = r.body;
  return r.status === 201 || r.status === 200 || r;
});
await check('M3-26 先方の商品コードが空の行は、同じ取引先・SKU に2つ目を作れない（409）', async () => {
  const r = await call('POST', '/masters/partner-products', A, { partner_id: cust.id, sku_id: sku.id, partner_product_code: ' ', unit_price: '900' });
  return (r.status === 409 && String(r.body?.message).includes('先方の商品コード')) || r;
});
await check('M3-26 先方の商品コードは取引先の中で重ねられない（別の SKU でも 409）', async () => {
  const r = await call('POST', '/masters/partner-products', A, { partner_id: cust.id, sku_id: sku2.id, partner_product_code: CODE_B, unit_price: '900' });
  return r.status === 409 || r;
});
await check('M3-26 先方コードを空に直して「コードなしの2行目」にすることもできない（409）', async () => {
  const r = await call('PATCH', `/masters/partner-products/${pp2.id}`, A, { partner_product_code: '' });
  const row = await one('select partner_product_code from partner_products where id = $1', [pp2.id]);
  return (r.status === 409 && row.partner_product_code === CODE_B) || { r, row };
});
await check('M3-26 別の取引先なら先方コードなしの行を持てる', async () => {
  const r = await call('POST', '/masters/partner-products', A, { partner_id: other.id, sku_id: sku.id, unit_price: '500' });
  return r.status === 201 || r.status === 200 || r;
});
await check('M3-26 受注入力の lookup は使っている行をすべて、表示順で返す', async () => {
  const r = ok(await call('GET', `/masters/partner-products/lookup?partner_id=${cust.id}&sku_id=${sku.id}`, A), 'lookup');
  return (Array.isArray(r) && r.length === 2 && r[0].id === pp2.id && r[1].id === pp1.id && r[0].note === `${P}秋の企画` && Number(r[0].unit_price) === 1200) || r;
});
await check('M3-26 SKU の候補は SKU ごとに1つ。商品コードで探すと行は決まらず、行の数を返す', async () => {
  const r = ok(await call('GET', `/masters/skus?q=${encodeURIComponent(`${P}-0102`)}&partner_id=${cust.id}&limit=20`, A), 'search');
  const hits = r.filter((x) => x.sku_id === sku.id);
  return (hits.length === 1 && hits[0].partner_product_id === null && hits[0].partner_product_count === 2 && hits[0].shipping_jan === null) || hits;
});
await check('M3-26 先方の JAN で探すと、その行（partner_product_id）が決まる', async () => {
  const r = ok(await call('GET', `/masters/skus?q=${PJAN2}&partner_id=${cust.id}&limit=20`, A), 'search');
  return (r.length === 1 && r[0].sku_id === sku.id && r[0].partner_product_id === pp2.id && r[0].partner_jan === PJAN2) || r;
});
await check('M3-26 先方の商品コードで探すと、その行が決まる', async () => {
  const r = ok(await call('GET', `/masters/skus?q=${encodeURIComponent(CODE_B)}&partner_id=${cust.id}&limit=20`, A), 'search');
  return (r.length === 1 && r[0].partner_product_id === pp2.id && r[0].partner_product_code === CODE_B) || r;
});
await check('M3-26 出荷JAN で探すと、その行（1行目）が決まる', async () => {
  const r = ok(await call('GET', `/masters/skus?q=${SHIP_JAN1}&partner_id=${cust.id}&limit=20`, A), 'search');
  return (r.length === 1 && r[0].partner_product_id === pp1.id && r[0].shipping_jan === SHIP_JAN1) || r;
});
await check('M3-26 行が1つだけの取引先は、商品コードで探しても行が決まる', async () => {
  const r = ok(await call('GET', `/masters/skus?q=${encodeURIComponent(`${P}-0102`)}&partner_id=${other.id}&limit=20`, A), 'search');
  const row = await one('select id from partner_products where partner_id = $1 and sku_id = $2', [other.id, sku.id]);
  return (r.length === 1 && r[0].partner_product_id === Number(row.id) && r[0].partner_product_count === 1) || r;
});

// ---- M3-26 受注 ------------------------------------------------------------------
const order = (lines, partner = cust, d = dest.id) =>
  call('POST', '/orders', A, { order_type: '卸', partner_id: partner.id, delivery_destination_id: d, sales_category_id: category, order_date: today, ship_date: today, lines });
let ord2 = null;
await check('M3-26 受注明細に選んだ行（2行目）を入れて登録でき、詳細で行と先方コードを返す', async () => {
  ord2 = ok(await order([{ line_no: 1, line_type: '商品', sku_id: sku.id, partner_product_id: pp2.id, item_name: `${P}販売名2`, qty: '1', unit_price: '1200' }]), 'order');
  const d = ok(await call('GET', `/orders/${ord2.id}`, A), 'detail');
  const l = d.lines[0];
  return (l.partner_product_id === pp2.id && l.partner_product_code === CODE_B && l.partner_jan === PJAN2) || l;
});
await check('M3-26 ほかの取引先の行を明細に入れると 400', async () => {
  const row = await one('select id from partner_products where partner_id = $1 and sku_id = $2', [other.id, sku.id]);
  const r = await order([{ line_no: 1, line_type: '商品', sku_id: sku.id, partner_product_id: Number(row.id), item_name: 'x', qty: '1', unit_price: '1' }]);
  return (r.status === 400 && String(r.body?.message).includes('1行目')) || r;
});
await check('M3-26 別の SKU の行を明細に入れると 400', async () => {
  const r = await order([{ line_no: 1, line_type: '商品', sku_id: sku2.id, partner_product_id: pp2.id, item_name: 'x', qty: '1', unit_price: '1' }]);
  return r.status === 400 || r;
});
const shipOf = async (orderId) => {
  const sh = await one('select id from shipments where sales_order_id = $1', [orderId]);
  if (!sh) throw new Error('出荷が作られていません');
  return Number(sh.id);
};
await check('M3-26 帳票：2行目（出荷JAN・上代なし）を選んだ明細は、1行目の出荷JAN・上代を出さない', async () => {
  const sh = await shipOf(ord2.id);
  const si = pdfText(await raw(`/reports/shipping-instructions?shipment_ids=${sh}`, A));
  const dn = pdfText(await raw(`/reports/delivery-notes?shipment_ids=${sh}&form=${encodeURIComponent('上代あり')}`, A));
  return (si.includes(SKU_JAN) && !si.includes(SHIP_JAN1) && !dn.includes('7,777') && !dn.includes(SHIP_JAN1)) || { si: si.slice(0, 300), dn: dn.slice(0, 300) };
});
let ord1 = null;
await check('M3-26 帳票：1行目を選んだ明細は、1行目の出荷JAN・上代を出す', async () => {
  ord1 = ok(await order([{ line_no: 1, line_type: '商品', sku_id: sku.id, partner_product_id: pp1.id, item_name: `${P}販売名1`, qty: '2', unit_price: '1000' }]), 'order');
  const sh = await shipOf(ord1.id);
  const si = pdfText(await raw(`/reports/shipping-instructions?shipment_ids=${sh}`, A));
  const dn = pdfText(await raw(`/reports/delivery-notes?shipment_ids=${sh}&form=${encodeURIComponent('上代あり')}`, A));
  return (si.includes(SHIP_JAN1) && !si.includes(SKU_JAN) && dn.includes('7,777') && dn.includes(`${P}販売名1`)) || { si: si.slice(0, 300), dn: dn.slice(0, 300) };
});

// ---- M3-28 原価は SKU の原価（得意先別原価は使わない） ------------------------------------
await check('M3-28 販売実績の原価は得意先別商品の原価ではなく SKU・商品の原価', async () => {
  const sh = await shipOf(ord1.id);
  ok(await call('POST', `/shipments/${sh}/confirm`, A, { ship_date: today }), 'confirm');
  const r = ok(await call('POST', '/analytics/sales', A, { from: today, to: today, dimensions: ['取引先'], measures: ['金額', '原価'], partner_id: cust.id, limit: 100 }), 'analytics');
  const row = r.rows[0];
  return (r.rows.length === 1 && Number(row?.['原価']) === 300) || r.rows;
});

// ---- M3-25・M3-08 一覧 ---------------------------------------------------------------
await check('M3-25 一覧は取引先の略称・媒体を返し、同じ SKU の行は表示順に並ぶ', async () => {
  const r = ok(await call('GET', `/masters/partner-products?partner_id=${cust.id}`, A), 'list');
  const it = r.items.filter((x) => x.sku_id === sku.id);
  return (it.length === 2 && it[0].id === pp2.id && it[0].partner_short_name === `${P}略` && it[0].media_name === `${P}テレビ` && !('partner_category_names' in it[0])) || it;
});
await check('M3-08 一覧を媒体で絞れる', async () => {
  const a = ok(await call('GET', `/masters/partner-products?media_id=${media1.id}&limit=200`, A), 'list1');
  const b = ok(await call('GET', `/masters/partner-products?media_id=${media2.id}&limit=200`, A), 'list2');
  return (a.items.length === 2 && a.items.every((x) => x.partner_id === cust.id) && b.items.length === 1 && b.items[0].partner_id === other.id) || { a: a.items.length, b: b.items.length };
});
await check('M3-25 一覧を略称で探せる', async () => {
  const r = ok(await call('GET', `/masters/partner-products?q=${encodeURIComponent(`${P}略`)}`, A), 'list');
  return (r.items.length === 2 && r.items.every((x) => x.partner_id === cust.id)) || r.items.length;
});

// ---- M3-26・M3-28 CSV ------------------------------------------------------------------
await check('M3-28 CSV の列に原価・メモが無い（先方の商品コードは鍵）', async () => {
  const c = ok(await call('GET', '/masters/csv/partner-products/columns', A), 'columns');
  const labels = c.columns.map((x) => x.label);
  return (!labels.includes('原価') && !labels.includes('メモ') && c.key_labels.join() === '取引先コード,SKUコード,先方の商品コード') || c;
});
await check('M3-26 CSV 書き出しに同じ SKU の2行がそれぞれ出る', async () => {
  const r = await text('/masters/csv/partner-products/export', A);
  const lines = r.text.split('\r\n').filter((l) => l.includes(`${P}C`) && l.includes(`${P}-0102-100`));
  return (lines.length === 2 && lines.some((l) => l.includes(CODE_B))) || lines;
});
await check('M3-26 CSV 取込：取引先＋SKU＋先方の商品コードで2行目だけを直す', async () => {
  ok(await imp('partner-products', [['取引先コード', 'SKUコード', '先方の商品コード', '単価'], [`${P}C`, sku.sku_code, CODE_B, '1250']], false, A), 'import');
  const rows = await all('select id, unit_price::text as p from partner_products where partner_id = $1 and sku_id = $2 order by id', [cust.id, sku.id]);
  return (rows.length === 2 && Number(rows[0].p) === 1000 && Number(rows[1].p) === 1250) || rows;
});
await check('M3-26 CSV 取込：先方の商品コードが空の行は、コードなしの行（1行目）を直す', async () => {
  ok(await imp('partner-products', [['取引先コード', 'SKUコード', '先方の商品コード', '単価'], [`${P}C`, sku.sku_code, '', '1010']], false, A), 'import');
  const rows = await all('select id, unit_price::text as p from partner_products where partner_id = $1 and sku_id = $2 order by id', [cust.id, sku.id]);
  return (rows.length === 2 && Number(rows[0].p) === 1010 && Number(rows[1].p) === 1250) || rows;
});
await check('M3-26 CSV 取込：新しい先方の商品コードの行は追加になる', async () => {
  const d = ok(await imp('partner-products', [['取引先コード', 'SKUコード', '先方の商品コード', '単価'], [`${P}C`, sku.sku_code, `${P}C3`, '1300']], true, A), 'dry');
  return (d.added === 1 && d.updated === 0) || d.rows;
});
await check('M3-26 CSV 取込：先方の商品コードの列が無く行が2つあると、その行はエラー（どれを直すか決められない）', async () => {
  const d = ok(await imp('partner-products', [['取引先コード', 'SKUコード', '単価'], [`${P}C`, sku.sku_code, '1']], true, A), 'dry');
  const row = d.rows[0];
  return (row?.action === 'エラー' && row.message.includes('先方の商品コード')) || d.rows;
});
await check('M3-26 CSV 取込：先方の商品コードの列が無くても、行が1つなら今までどおり直せる', async () => {
  ok(await imp('partner-products', [['取引先コード', 'SKUコード', '単価'], [`${P}X`, sku.sku_code, '555']], false, A), 'import');
  const r = await one('select unit_price::text as p from partner_products where partner_id = $1 and sku_id = $2', [other.id, sku.id]);
  return Number(r.p) === 555 || r;
});
await check('M3-26 一覧で編集：先方の商品コードは鍵（書き換えない欄）として返る', async () => {
  const r = ok(await call('GET', `/masters/csv/partner-products/rows?q=${encodeURIComponent(CODE_B)}`, A), 'rows');
  const col = r.columns.find((c) => c.field === 'partner_product_code');
  return (col?.read_only === true && r.key_fields.includes('partner_product_code') && !r.columns.some((c) => c.field === 'cost_price' || c.field === 'memo')) || { col, keys: r.key_fields };
});

// ---- M3-26 販社CSV取込 ------------------------------------------------------------------
const shirahato = (rows) => {
  // 白鳩の書式（29列、列の位置で読む）。1 伝票№ 2 得意先ID 4 納品先CD 16 JANCD 22 下代 23 発注数
  const line = (r) => { const c = Array(29).fill(''); c[0] = r.no; c[1] = r.partner; c[3] = r.dest; c[15] = r.jan; c[21] = r.price; c[22] = r.qty; return c.join(','); };
  return Buffer.from([Array(29).fill('h').join(','), ...rows.map(line)].join('\r\n') + '\r\n', 'utf8').toString('base64');
};
const importedLines = (externalNo) =>
  all(
    `select l.partner_product_id, l.item_name, l.unit_price::text as unit_price, l.sku_id
       from sales_order_lines l join sales_orders o on o.id = l.sales_order_id join external_orders eo on eo.id = o.external_order_id
      where eo.external_order_no = $1 order by l.line_no`,
    [externalNo],
  );
await check('M3-26 販社CSV取込（照合が JAN）：先方の JAN の行を使い、品名は販売名、明細に行を入れる', async () => {
  const r = await call('POST', '/imports/partner-orders', A, {
    template_code: 'SHIRAHATO', file_name: `${P}-shirahato.csv`,
    content_base64: shirahato([{ no: `${P}S1`, partner: `${P}C`, dest: `${P}D`, jan: PJAN2, price: '1180', qty: '1' }]),
  });
  if (r.status >= 300) return `${r.status} ${JSON.stringify(r.body)}`;
  const l = await importedLines(`${P}S1`);
  return (l.length === 1 && l[0].partner_product_id === String(pp2.id) && l[0].item_name === `${P}販売名2` && Number(l[0].unit_price) === 1180) || l;
});
const connectCsv = (rows) =>
  Buffer.from('﻿,注文ID,取引先コード,お届け先コード,出荷日,納品予定日,納品希望日,商品コード,数量,発注単価\r\n' + rows.map((r) => `${r.join(',')}\r\n`).join('')).toString('base64');
await check('M3-26 販社CSV取込（照合が SKU）：同じ SKU に行が2つあって決まらなければ、明細は行を指さず SKU の品名', async () => {
  const r = await call('POST', '/imports/partner-orders', A, {
    template_code: 'CONNECT', file_name: `${P}-connect.csv`,
    content_base64: connectCsv([[`${P}N1`, `${P}PO1`, `${P}C`, `${P}D`, today, '', '', sku.sku_code, '1', '990']]),
  });
  if (r.status >= 300) return `${r.status} ${JSON.stringify(r.body)}`;
  const l = await importedLines(`${P}N1`);
  return (l.length === 1 && l[0].partner_product_id === null && l[0].item_name.startsWith(`${P}骨盤ショーツ`) && Number(l[0].unit_price) === 990) || l;
});
// 照合が先方の商品コードの取込先（初期データには無いので、コネクトの書式で作る。単価の列は任意）
const tpl = await one(
  `insert into import_templates (template_code, name, import_type, file_encoding, has_header, order_no_source, sku_match_key, default_order_type, is_active, note)
   values ($1, $2, 'PARTNER_ORDER', 'UTF8', true, 'csv', 'partner_code', '卸', false, '回帰確認用（担当C）') returning id`,
  [`${P}T`, `${P}先方コード照合`],
);
await db.query(
  `insert into import_template_columns (import_template_id, column_index, source_header, target_field, transform, is_required)
   select $1, v.idx, v.hdr, v.fld, v.tr, v.req from (values
     (1, '（見出し空欄）', 'order_no', null, true), (2, '注文ID', 'po_no', 'trim', false), (3, '取引先コード', 'partner_code', 'trim', true),
     (4, 'お届け先コード', 'delivery_code', 'trim', true), (5, '出荷日', 'ship_date', 'date_slash', false), (6, '納品予定日', 'delivery_date', 'date_slash', false),
     (7, '納品希望日', 'requested_delivery_date', 'date_slash', false), (8, '商品コード', 'partner_product_code', 'trim', true),
     (9, '数量', 'qty', 'number', true), (10, '発注単価', 'unit_price', 'number', false)
   ) as v(idx, hdr, fld, tr, req)`,
  [tpl.id],
);
await check('M3-26 販社CSV取込（照合が先方の商品コード）：その行を使い、単価が空ならその行の卸単価・品名は販売名', async () => {
  await db.query('update import_templates set is_active = true where id = $1', [tpl.id]);
  const r = await call('POST', '/imports/partner-orders', A, {
    template_code: `${P}T`, file_name: `${P}-code.csv`,
    content_base64: connectCsv([[`${P}K1`, `${P}PO2`, `${P}C`, `${P}D`, today, '', '', CODE_B, '1', '']]),
  });
  await db.query('update import_templates set is_active = false where id = $1', [tpl.id]);
  if (r.status >= 300) return `${r.status} ${JSON.stringify(r.body)}`;
  const l = await importedLines(`${P}K1`);
  return (l.length === 1 && l[0].partner_product_id === String(pp2.id) && Number(l[0].unit_price) === 1250 && l[0].item_name === `${P}販売名2`) || { l, body: r.body };
});

// ---- 閲覧者 -------------------------------------------------------------------------
await check('閲覧者にも lookup は配列で返る（受注入力の権限）／一覧に原価は出ない', async () => {
  const l = await call('GET', `/masters/partner-products?partner_id=${cust.id}`, V);
  return (l.status === 200 && l.body.items.every((x) => !('cost_price' in x))) || l.status;
});

// 画面確認 W3 N1: 検索の文字が空のまま商品欄を押すと SKU 検索が 500 になり、候補が出なかった
await check('W3 N1 SKU 検索は文字が空でも 200（取引先あり・なし）。候補の一覧が返る', async () => {
  const a = await call('GET', '/masters/skus?limit=20', A);
  const b = await call('GET', `/masters/skus?limit=20&partner_id=${cust.id}`, A);
  const c = await call('GET', `/masters/skus?partner_id=${cust.id}&q=`, A);
  const lists = [a, b, c].every((r) => r.status === 200 && Array.isArray(r.body) && r.body.length > 0);
  return lists || { a: a.status, b: b.status, c: c.status };
});

// 後片付け：受注の引当を外す（在庫を他の確認に残さない）
for (const o of [ord2]) if (o) await call('POST', `/orders/${o.id}/cancel`, A);

await db.end();
process.exit(ng > 0 ? 1 : 0);
