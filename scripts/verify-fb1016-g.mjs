// 2026-10-18 画面確認（W1・W2・W3）の指摘の直し（担当 G）の回帰確認。
// smoke-backend.ps1 から呼ばれる想定（API・DB は smoke が立てた使い捨て環境）。
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は GG＋時刻。
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

/** PDF から文字を取り出す（verify-fb1016-c.mjs と同じ。ToUnicode を読んで字形番号を文字に戻す） */
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
const imp = (slug, rows, dry) =>
  call('POST', `/masters/csv/${slug}/import`, A, { content_base64: Buffer.from(csvOf(rows), 'utf8').toString('base64'), dry_run: dry });
/** CSV の文字を行と欄に分ける（="..." の形は中身だけ） */
const parse = (s) =>
  s.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).map((line) => {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((v) => v.replace(/^="(.*)"$/, '$1'));
  });

const A = await login('admin');
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const month = today.slice(0, 7);
const t = String(Date.now()).slice(-6);
const P = `GG${t}`;

const freshJan = async () => {
  for (;;) {
    const j = '49' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0');
    if (!(await one('select 1 from skus where jan = $1 or fba_jan = $1 union all select 1 from partner_products where partner_jan = $1', [j]))) return j;
  }
};

// ---- 準備（接頭辞 GG） --------------------------------------------------------
const category = Number((await one('select id from sales_categories order by id limit 1')).id);
const warehouse = Number((await one('select id from warehouses where is_active order by id limit 1')).id);
const cust = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}C`, name1: `${P}国内得意先`, is_customer: true, closing_day: 99 }), 'customer');
const dest = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: cust.id, delivery_code: `${P}D`, name: `${P}納品先`, default_warehouse_id: warehouse }), 'dest');
const J1 = await freshJan();
const PJ2 = await freshJan();
const product = ok(await call('POST', '/masters/products', A, { product_code: `${P}`, product_name: `${P}骨盤ショーツ` }), 'product');
const sku = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}-0101-100`, jan: J1, cost_price: '100' }), 'sku');
const rc = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: warehouse, planned_date: today, lines: [{ line_no: 1, sku_id: sku.id, qty: '50' }] }), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');

// ---- W2 M3-16：CSV・販売実績の名前を画面の呼び方に -------------------------------------
await check('W2 SKU の CSV の見出しは「商品コード」（SKU）・「品番（商品分類コード）」で、「SKUコード」は無い', async () => {
  const h = parse((await text('/masters/csv/skus/export', A)).text)[0];
  return (h[0] === '商品コード' && h.includes('品番（商品分類コード）') && !h.includes('SKUコード')) || h;
});
await check('W2 商品の CSV の見出しは「品番（商品分類コード）」', async () => {
  const h = parse((await text('/masters/csv/products/export', A)).text)[0];
  return (h[0] === '品番（商品分類コード）' && !h.includes('商品コード')) || h;
});
await check('W2 SKU の CSV 取込：今の見出し（商品コード＝SKU、品番（商品分類コード））で読める', async () => {
  const d = ok(await imp('skus', [['商品コード', '品番（商品分類コード）', 'SKUの商品名'], [sku.sku_code, `${P}`, `${P}新しい名前`]], false), 'import');
  const r = await one('select sku_name from skus where id = $1', [sku.id]);
  return (d.errors === 0 && d.updated === 1 && r.sku_name === `${P}新しい名前`) || { d, r };
});
await check('W2 SKU の CSV 取込：前の見出し（SKUコード＝SKU、商品コード＝品番）もそのまま読める', async () => {
  const d = ok(await imp('skus', [['SKUコード', '商品コード', 'SKUの商品名'], [sku.sku_code, `${P}`, `${P}前の書式`]], false), 'import');
  const r = await one('select sku_name, product_id from skus where id = $1', [sku.id]);
  return (d.errors === 0 && d.updated === 1 && r.sku_name === `${P}前の書式` && Number(r.product_id) === product.id) || { d, r };
});
await check('W2 SKU の CSV 取込：今の見出しで「商品コード」に品番を入れると SKU として読む（品番の行は無いので新しい行の扱い）', async () => {
  const d = ok(await imp('skus', [['商品コード', 'SKUの商品名'], [`${P}`, 'x']], true), 'import');
  return (d.updated === 0 && (d.added === 1 || d.errors === 1)) || d;
});
await check('W2 商品の CSV 取込：前の見出し「商品コード」も品番として読める', async () => {
  const d = ok(await imp('products', [['商品コード', '商品名'], [`${P}`, `${P}骨盤ショーツ改`]], false), 'import');
  const r = await one('select product_name from products where id = $1', [product.id]);
  return (d.errors === 0 && d.updated === 1 && r.product_name === `${P}骨盤ショーツ改`) || { d, r };
});
await check('W2 販売実績の軸は「品番（商品分類コード）」「商品コード（SKU）」（「SKU」「商品コード」は選択肢に無い）', async () => {
  const o = ok(await call('GET', '/analytics/options', A), 'options');
  return (o.dimensions.includes('品番（商品分類コード）') && o.dimensions.includes('商品コード（SKU）') && !o.dimensions.includes('SKU') && !o.dimensions.includes('商品コード')) || o.dimensions;
});

// ---- 受注・出荷（販売実績・請求書の確認に使う） ------------------------------------------
const ord = ok(await call('POST', '/orders', A, {
  order_type: '卸', partner_id: cust.id, delivery_destination_id: dest.id, sales_category_id: category, order_date: today, ship_date: today,
  lines: [{ line_no: 1, line_type: '商品', sku_id: sku.id, item_name: `${P}品`, qty: '2', unit_price: '1000' }],
}), 'order');
const sh = await one('select id from shipments where sales_order_id = $1', [ord.id]);
if (sh) ok(await call('POST', `/shipments/${sh.id}/confirm`, A, { ship_date: today }), 'confirm');

await check('W2 販売実績：前の軸の名前（商品コード＝品番、SKU）で呼んでも前と同じ意味で集計し、列は今の名前', async () => {
  const r = ok(await call('POST', '/analytics/sales', A, { from: today, to: today, dimensions: ['商品コード', 'SKU'], measures: ['数量'], partner_id: cust.id, limit: 100 }), 'sales');
  const row = r.rows[0] ?? {};
  return (r.dimensions[0] === '品番（商品分類コード）' && r.dimensions[1] === '商品コード（SKU）' && row['品番（商品分類コード）'] === `${P}` && row['商品コード（SKU）'] === sku.sku_code) || r;
});
await check('W2 販売実績：今の名前の軸で集計できる', async () => {
  const r = ok(await call('POST', '/analytics/sales', A, { from: today, to: today, dimensions: ['商品コード（SKU）'], measures: ['数量'], partner_id: cust.id, limit: 100 }), 'sales');
  return (r.rows.length === 1 && r.rows[0]['商品コード（SKU）'] === sku.sku_code && Number(r.rows[0]['数量']) === 2) || r;
});

// ---- W3：入出荷履歴の在庫調整は理由が分かる種別 -------------------------------------------
await check('W3 入出荷履歴：在庫調整（理由 再生）の行は「在庫調整（再生）」と調整番号で出る。種別の絞り込みは今までどおり', async () => {
  const adj = ok(await call('POST', '/inventory/adjustments', A, { warehouse_id: warehouse, adjustment_date: today, reason_code: 'REFURB', lines: [{ line_no: 1, sku_id: sku.id, qty: '1' }] }), 'adj');
  ok(await call('POST', `/inventory/adjustments/${adj.id}/confirm`, A), 'confirm');
  const no = (await one('select adjustment_no from stock_adjustments where id = $1', [adj.id])).adjustment_no;
  const r = ok(await call('GET', `/inventory/stocks/movements?sku_id=${sku.id}&movement_type=${encodeURIComponent('棚卸調整')}&limit=10`, A), 'movements');
  const m = r.items.find((x) => x.ref_table === 'stock_adjustments' && Number(x.ref_id) === adj.id);
  const others = ok(await call('GET', `/inventory/stocks/movements?sku_id=${sku.id}&limit=50`, A), 'all').items.filter((x) => x.ref_table !== 'stock_adjustments');
  return (m && m.movement_label === '在庫調整（再生）' && m.ref_no === no && others.every((x) => x.movement_label === x.movement_type)) || { m, others: others.map((x) => [x.movement_type, x.movement_label]) };
});

// ---- W2：JAN 照合の販社CSVで、得意先別商品が2行ある SKU の単価が決まらないとき --------------------
const pp1 = ok(await call('POST', '/masters/partner-products', A, { partner_id: cust.id, sku_id: sku.id, partner_product_code: `${P}A`, unit_price: '1000', sales_name: `${P}販売名甲` }), 'pp1');
const pp2 = ok(await call('POST', '/masters/partner-products', A, { partner_id: cust.id, sku_id: sku.id, partner_product_code: `${P}B`, partner_jan: PJ2, unit_price: '1200', sales_name: `${P}販売名乙` }), 'pp2');
// 照合が JAN で、単価の列が任意の取込先（W2 が試した書式。初期データの白鳩は下代が必須なので、確認用に作る。ふだんは使わないにしておく）
const TPL = `${P}J`;
const tpl = await one(
  `insert into import_templates (template_code, name, import_type, file_encoding, has_header, order_no_source, sku_match_key, default_order_type, is_active, note)
   values ($1, $2, 'PARTNER_ORDER', 'UTF8', true, 'csv', 'jan', '卸', false, '回帰確認用（担当G）') returning id`,
  [TPL, `${P}JAN照合`],
);
await db.query(
  `insert into import_template_columns (import_template_id, column_index, source_header, target_field, transform, is_required)
   select $1, v.idx, v.hdr, v.fld, v.tr, v.req from (values
     (1, '伝票番号', 'order_no', null, true), (2, '取引先コード', 'partner_code', 'trim', true), (3, '納品先コード', 'delivery_code', 'trim', true),
     (4, 'JAN', 'jan', 'trim', true), (5, '数量', 'qty', 'number', true), (6, '単価', 'unit_price', 'number', false)
   ) as v(idx, hdr, fld, tr, req)`,
  [tpl.id],
);
const importJan = async (no, jan, price) => {
  await db.query('update import_templates set is_active = true where id = $1', [tpl.id]);
  const csv = `伝票番号,取引先コード,納品先コード,JAN,数量,単価\r\n${P}${no},${P}C,${P}D,${jan},1,${price}\r\n`;
  const r = await call('POST', '/imports/partner-orders', A, { template_code: TPL, file_name: `${P}-${no}.csv`, content_base64: Buffer.from(csv, 'utf8').toString('base64') });
  await db.query('update import_templates set is_active = false where id = $1', [tpl.id]);
  return r;
};
const linesOf = (no) =>
  all(
    `select l.partner_product_id, l.unit_price::text as unit_price, l.item_name from sales_order_lines l join sales_orders o on o.id = l.sales_order_id
       join external_orders eo on eo.id = o.external_order_id where eo.external_order_no = $1 order by l.line_no`,
    [`${P}${no}`],
  );
await check('W2 JAN 照合：コニーの JAN で、得意先別商品が2行あり CSV に単価が無いと、0 円の受注にせず要確認にして理由を出す', async () => {
  const r = ok(await importJan('J1', J1, ''), 'import');
  const eo = await one('select status, sales_order_id, error_message from external_orders where channel = $1 and external_order_no = $2', [TPL, `${P}J1`]);
  const o = r.orders[0];
  return (r.created_orders === 0 && r.pending_orders === 1 && o.status.includes('単価が決まらない') && r.warnings.some((w) => w.includes(`${P}J1`) && w.includes('2 件')) &&
    eo.status === '取込済' && eo.sales_order_id === null && eo.error_message.includes(sku.sku_code)) || { r, eo };
});
await check('W2 JAN 照合：要確認の取込は、得意先別商品を直したあと同じファイルで取り込み直せる（片方を非表示→残った行の単価）', async () => {
  ok(await call('PATCH', `/masters/partner-products/${pp2.id}`, A, { is_active: false }), 'hide pp2');
  const r = ok(await importJan('J1', J1, ''), 'reimport');
  ok(await call('PATCH', `/masters/partner-products/${pp2.id}`, A, { is_active: true }), 'show pp2');
  const l = await linesOf('J1');
  const n = Number((await one('select count(*)::int n from external_orders where channel = $1 and external_order_no = $2', [TPL, `${P}J1`])).n);
  return (r.created_orders === 1 && n === 1 && l.length === 1 && l[0].partner_product_id === String(pp1.id) && Number(l[0].unit_price) === 1000) || { r, l, n };
});
await check('W2 JAN 照合：CSV に単価があれば、行が決まらなくてもその単価で受注にする', async () => {
  const r = ok(await importJan('J2', J1, '1500'), 'import');
  const l = await linesOf('J2');
  return (r.created_orders === 1 && l.length === 1 && Number(l[0].unit_price) === 1500) || { r, l };
});
await check('W2 JAN 照合：取込済み（受注になったもの）は今までどおり二重に取り込まない', async () => {
  const r = ok(await importJan('J2', J1, '1500'), 'import');
  return (r.skipped_orders === 1 && r.created_orders === 0) || r;
});

// ---- W1 N8：非表示の得意先別商品は照合に使わない ----------------------------------------------
await check('W1 N8 先方の JAN の照合：使っている行はその行の単価・販売名', async () => {
  const r = ok(await importJan('N1', PJ2, ''), 'import');
  const l = await linesOf('N1');
  return (r.created_orders === 1 && l[0]?.partner_product_id === String(pp2.id) && Number(l[0].unit_price) === 1200) || { r, l };
});
await check('W1 N8 先方の JAN の照合：非表示にした行は使わない（商品が見つからず要確認）', async () => {
  ok(await call('PATCH', `/masters/partner-products/${pp2.id}`, A, { is_active: false }), 'hide pp2');
  const r = ok(await importJan('N2', PJ2, ''), 'import');
  ok(await call('PATCH', `/masters/partner-products/${pp2.id}`, A, { is_active: true }), 'show pp2');
  // 2026-10-19 受入 X1-4 から、非表示の行に当たったときの要確認は「得意先別商品が非表示」と出る（以前は「商品未登録」）
  return (r.created_orders === 0 && r.pending_orders === 1 && r.orders[0].status.includes('得意先別商品が非表示')) || r;
});
await check('W1 N8 受注入力の候補（lookup）にも非表示の行は出ない', async () => {
  ok(await call('PATCH', `/masters/partner-products/${pp2.id}`, A, { is_active: false }), 'hide pp2');
  const l = ok(await call('GET', `/masters/partner-products/lookup?partner_id=${cust.id}&sku_id=${sku.id}`, A), 'lookup');
  const s = ok(await call('GET', `/masters/skus?partner_id=${cust.id}&q=${PJ2}`, A), 'search');
  ok(await call('PATCH', `/masters/partner-products/${pp2.id}`, A, { is_active: true }), 'show pp2');
  return (l.length === 1 && l[0].id === pp1.id && !s.some((x) => x.sku_id === sku.id)) || { l, s };
});

// ---- W1 N5：商品と SKU をまとめて1回で登録する ----------------------------------------------
await check('W1 N5 商品の登録で SKU も送ると、商品と SKU が1回で登録される', async () => {
  const J = await freshJan();
  const r = await call('POST', '/masters/products', A, {
    product_code: `${P}N`, product_name: `${P}まとめて`,
    skus: [{ sku_code: `${P}N-0101-100`, jan: J, cost_price: '120', row_no: 1 }, { sku_code: `${P}N-0102-100`, row_no: 2 }],
  });
  const s = await all('select s.sku_code, s.cost_price::text c from skus s join products p on p.id = s.product_id where p.product_code = $1 order by s.sku_code', [`${P}N`]);
  return (r.status === 201 && r.body.sku_count === 2 && s.length === 2 && Number(s[0].c) === 120) || { r, s };
});
await check('W1 N5 SKU の商品コードが重なると、行番号と理由を返し、商品も登録しない（SKU の無い商品が残らない）', async () => {
  const r = await call('POST', '/masters/products', A, {
    product_code: `${P}X`, product_name: `${P}重なり`,
    skus: [{ sku_code: `${P}X-0101-100`, row_no: 1 }, { sku_code: sku.sku_code, row_no: 2 }],
  });
  const p = await one('select id from products where product_code = $1', [`${P}X`]);
  const s = await one('select id from skus where sku_code = $1', [`${P}X-0101-100`]);
  const msg = String(r.body?.message ?? '');
  return (r.status === 409 && msg.includes('2行目') && msg.includes(sku.sku_code) && msg.includes(`品番 ${P}`) && !p && !s) || { r, p, s };
});
await check('W1 N5 同じ商品コードの行が2つ・JAN が品番の左6桁の違う商品と重なる行も、まとめて理由を返す', async () => {
  const r = await call('POST', '/masters/products', A, {
    product_code: `ZZ${t}`, product_name: `${P}JAN重なり`,
    skus: [{ sku_code: `${P}Y-1`, jan: J1, row_no: 1 }, { sku_code: `${P}Y-2`, row_no: 2 }, { sku_code: `${P}Y-2`, row_no: 3 }],
  });
  const p = await one('select id from products where product_code = $1', [`ZZ${t}`]);
  const msg = String(r.body?.message ?? '');
  return (r.status === 409 && msg.includes('1行目') && msg.includes('JAN') && msg.includes('3行目') && msg.includes('同じ商品コード') && !p) || { r, p };
});
await check('W1 N5 SKU を送らない商品の登録は今までどおり', async () => {
  const r = await call('POST', '/masters/products', A, { product_code: `${P}E`, product_name: `${P}SKUなし` });
  return r.status === 201 || r;
});

// ---- W1 N7：請求書の明細の単価・免税の取引先の税率別の行 -------------------------------------
const invoicePdf = async (partner) => {
  const inv = ok(await call('POST', '/billing/closings', A, { target_month: month, partner_id: partner.id }), 'closing').invoices[0];
  return { inv, txt: pdfText(await raw(`/reports/invoices?invoice_ids=${inv.id}`, A)) };
};
await check('W1 N7 請求書（国内）：出荷の明細の単価は 0 と印字しない。金額・請求額は今までどおり、未計上10% などの行はある', async () => {
  if (!sh) return '出荷が作られていません';
  const { inv, txt } = await invoicePdf(cust);
  const l = await one('select unit_price::text u, amount::text a from invoice_lines where invoice_id = $1 and shipment_id is not null', [inv.id]);
  const i = await one('select shipment_amount::text s from invoices where id = $1', [inv.id]);
  const lines = txt.split('\n');
  const at = lines.findIndex((x) => x.startsWith('出荷 '));
  const after = lines.slice(at + 1, at + 5);
  return (Number(l.u) === 0 && Number(l.a) === 2000 && Number(i.s) === 2000 && txt.includes('未計上10%') && at >= 0 && after[0] === '2' && after[1] === '10%') || { after, l, i };
});
await check('W1 N7 請求書（消費税免税区分あり）：未計上・調整は「未計上（免税（税抜扱い））」の形で、10%・8% の行を出さない', async () => {
  const ex = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}F`, name1: `${P}免税先`, is_customer: true, overseas_tax_treatment: 'exempt', closing_day: 99 }), 'exempt');
  const d2 = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: ex.id, delivery_code: `${P}DF`, name: `${P}納品先F`, default_warehouse_id: warehouse }), 'dest2');
  const o = ok(await call('POST', '/orders', A, {
    order_type: '卸', partner_id: ex.id, delivery_destination_id: d2.id, sales_category_id: category, order_date: today, ship_date: today,
    lines: [{ line_no: 1, line_type: '商品', sku_id: sku.id, item_name: `${P}品`, qty: '1', unit_price: '3000' }],
  }), 'order');
  const s2 = await one('select id from shipments where sales_order_id = $1', [o.id]);
  if (!s2) return '出荷が作られていません';
  ok(await call('POST', `/shipments/${s2.id}/confirm`, A, { ship_date: today }), 'confirm');
  const { txt } = await invoicePdf(ex);
  return (txt.includes('未計上（免税（税抜扱い））') && txt.includes('調整（免税（税抜扱い））') && !txt.includes('未計上10%') && !txt.includes('調整8%') && txt.includes('免税（税抜扱い）')) || txt.slice(0, 600);
});

// ---- W3 N1（取りまとめ役の直し）の確認 -----------------------------------------------------
await check('W3 N1 SKU 検索は文字が空でも 200（取引先あり・なし）', async () => {
  const a = await call('GET', '/masters/skus?is_set=false&limit=20', A);
  const b = await call('GET', `/masters/skus?partner_id=${cust.id}&limit=20`, A);
  return (a.status === 200 && b.status === 200 && Array.isArray(a.body) && a.body.length > 0) || { a: a.status, b: b.status };
});

await db.end();
process.exit(ng > 0 ? 1 : 0);
