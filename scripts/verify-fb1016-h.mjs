// 2026-10-19 全面テスト（X1〜X4）の軽微な指摘の直し（担当 H）の回帰確認。
// smoke-backend.ps1 から呼ばれる想定（API・DB は smoke が立てた使い捨て環境）。
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は GH＋時刻。
// 画面だけの直し（検索欄・操作の列・セットのコピー・文言）は画面で確かめる。ここでは API で分かるものを確かめる。
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
const P = `GH${t}`;

const freshJan = async () => {
  for (;;) {
    const j = '49' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0');
    if (!(await one('select 1 from skus where jan = $1 or fba_jan = $1 union all select 1 from partner_products where partner_jan = $1', [j]))) return j;
  }
};

// ---- 準備（接頭辞 GH） --------------------------------------------------------
const category = Number((await one('select id from sales_categories order by id limit 1')).id);
// 入荷・在庫調整の既定と同じ「コニー倉庫」（略称が一致する倉庫）。初期データには無いので、無ければ作る（verify-fb1009-stock と同じ）
let kony = await one(`select id from warehouses where short_name = 'コニー倉庫' and is_active order by sort_order nulls last, id limit 1`);
if (!kony) kony = await one(`insert into warehouses (warehouse_code, short_name, is_consignment) values ($1, 'コニー倉庫', false) returning id`, [`${P}K`]);
const KONY = Number(kony.id);
const cust = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}C`, name1: `${P}国内得意先`, short_name: `${P}略`, is_customer: true, closing_day: 99 }), 'customer');
// 既定の倉庫が無い納品先（X1-1 の当て先の確認に使う）
const dest = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: cust.id, delivery_code: `${P}D`, name: `${P}納品先` }), 'dest');
const J1 = await freshJan();
const PJ2 = await freshJan();
const product = ok(await call('POST', '/masters/products', A, { product_code: `${P}`, product_name: `${P}骨盤ショーツ` }), 'product');
const sku = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}-0101-100`, jan: J1, cost_price: '100', sku_name: `${P}SKU名` }), 'sku');
const rc = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: KONY, planned_date: today, lines: [{ line_no: 1, sku_id: sku.id, qty: '30' }] }), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');
const pp1 = ok(await call('POST', '/masters/partner-products', A, { partner_id: cust.id, sku_id: sku.id, partner_product_code: `${P}A`, unit_price: '1000', sales_name: `${P}販売名甲` }), 'pp1');
const pp2 = ok(await call('POST', '/masters/partner-products', A, { partner_id: cust.id, sku_id: sku.id, partner_product_code: `${P}B`, partner_jan: PJ2, unit_price: '1200', sales_name: `${P}販売名乙` }), 'pp2');
const allocatedIn = async (wh) => Number((await one('select coalesce(sum(qty_allocated), 0)::text n from stocks where sku_id = $1 and warehouse_id = $2', [sku.id, wh])).n);

// ---- X1-1 出荷倉庫が既定（空）で、納品先にも既定が無い受注はコニー倉庫で確かめて引き当てる ----------------------
// 表示順がコニー倉庫より小さい倉庫（在庫なし）を一時的に作る。以前はその倉庫で「実在庫 0」と断られた
const early = ok(await call('POST', '/masters/warehouses', A, { warehouse_code: `${P}W`, short_name: `${P}倉庫`, sort_order: -1 }), 'early warehouse');
let order1 = null;
await check('X1-1 表示順の小さい倉庫があっても、出荷倉庫が空・納品先の既定も無い受注はコニー倉庫で引き当てる', async () => {
  const before = await allocatedIn(KONY);
  const r = await call('POST', '/orders', A, {
    order_type: '卸', partner_id: cust.id, delivery_destination_id: dest.id, sales_category_id: category, order_date: today, ship_date: today,
    lines: [{ line_no: 1, line_type: '商品', sku_id: sku.id, partner_product_id: pp1.id, item_name: `${P}販売名甲`, qty: '3', unit_price: '1000' }],
  });
  if (r.status >= 300) return r;
  order1 = r.body;
  const after = await allocatedIn(KONY);
  const other = await allocatedIn(early.id);
  return (after - before === 3 && other === 0) || { before, after, other };
});
await check('X1-1 出荷倉庫を指定した受注は今までどおりその倉庫（在庫の無い倉庫なら実在庫を超えると断る）', async () => {
  const r = await call('POST', '/orders', A, {
    order_type: '卸', partner_id: cust.id, delivery_destination_id: dest.id, sales_category_id: category, order_date: today, ship_date: today, ship_from_warehouse_id: early.id,
    lines: [{ line_no: 1, line_type: '商品', sku_id: sku.id, partner_product_id: pp1.id, item_name: `${P}品`, qty: '1', unit_price: '1000' }],
  });
  return (r.status >= 400 && JSON.stringify(r.body).includes('実在庫')) || r;
});
// 一時の倉庫は表示順を空にして使わないにする（ほかの確かめの当て先を変えないため）
ok(await call('PATCH', `/masters/warehouses/${early.id}`, A, { sort_order: null, is_active: false }), 'early off');

// ---- X2-6 受注の詳細は SKU の品名を返す（修正画面の商品の欄はこの名前。販売名で出すと選び直しても古いまま） ----
await check('X2-6 受注の詳細の明細に SKU の品名（SKU の商品名＋カラー・サイズ）が入り、明細の品名（販売名）はそのまま', async () => {
  if (!order1) return '受注が作られていません';
  const o = ok(await call('GET', `/orders/${order1.id}`, A), 'order');
  const l = o.lines[0];
  return (l.sku_item_name === `${P}SKU名` && l.item_name === `${P}販売名甲` && Number(l.partner_product_id) === pp1.id) || l;
});

// ---- X4-3 引当在庫の CSV：取引先が空の確保は「（指定なし）」 -------------------------------------------
await check('X4-3 引当在庫の CSV で、取引先が空の確保の取引先の欄は「（指定なし）」（取引先のある確保は略称）', async () => {
  const g1 = ok(await call('POST', '/inventory/reservation-groups', A, { period_from: `${month}-01`, period_to: `${month}-01`, note: `${P}確保なし`, lines: [{ sku_id: sku.id, reserved_qty: '1' }] }), 'group none');
  const g2 = ok(await call('POST', '/inventory/reservation-groups', A, { period_from: `${month}-01`, period_to: `${month}-01`, partner_id: cust.id, note: `${P}確保あり`, lines: [{ sku_id: sku.id, reserved_qty: '1' }] }), 'group partner');
  const r = await text(`/inventory/reservation-groups/export?q=${encodeURIComponent(P)}`, A);
  const rows = parse(r.text);
  const h = rows[0];
  const pi = h.indexOf('取引先');
  const ni = h.indexOf('備考');
  const none = rows.find((x) => x[ni] === `${P}確保なし`);
  const has = rows.find((x) => x[ni] === `${P}確保あり`);
  ok(await call('DELETE', `/inventory/reservation-groups/${g1.id}`, A), 'del g1');
  ok(await call('DELETE', `/inventory/reservation-groups/${g2.id}`, A), 'del g2');
  return (r.status === 200 && none?.[pi] === '（指定なし）' && has?.[pi] === `${P}略`) || { status: r.status, h, none, has };
});

// ---- X2-2・X2-3 CSV の呼び方 -----------------------------------------------------------------
await check('X2-2 得意先別商品の CSV の見出しは「商品コード」（「SKUコード」は無い）。鍵の説明も同じ', async () => {
  const h = parse((await text('/masters/csv/partner-products/export', A)).text)[0];
  const c = ok(await call('GET', '/masters/csv/partner-products/columns', A), 'columns');
  return (h[1] === '商品コード' && !h.includes('SKUコード') && c.key_labels.join() === '取引先コード,商品コード,先方の商品コード') || { h, k: c.key_labels };
});
await check('X2-2 得意先別商品の CSV 取込：今の見出し「商品コード」でも前の見出し「SKUコード」でも読める', async () => {
  ok(await imp('partner-products', [['取引先コード', '商品コード', '先方の商品コード', '販売名2'], [`${P}C`, sku.sku_code, `${P}A`, `${P}今`]], false), 'import now');
  const a = await one('select sales_name2 from partner_products where id = $1', [pp1.id]);
  ok(await imp('partner-products', [['取引先コード', 'SKUコード', '先方の商品コード', '販売名2'], [`${P}C`, sku.sku_code, `${P}A`, `${P}前`]], false), 'import old');
  const b = await one('select sales_name2 from partner_products where id = $1', [pp1.id]);
  return (a.sales_name2 === `${P}今` && b.sales_name2 === `${P}前`) || { a, b };
});
await check('X2-3 商品の CSV：商品分類の列は「商品分類（コード）」で、品番の「品番（商品分類コード）」と別の名前', async () => {
  const h = parse((await text('/masters/csv/products/export', A)).text)[0];
  return (h[0] === '品番（商品分類コード）' && h.includes('商品分類（コード）') && !h.includes('商品分類コード')) || h;
});
await check('X2-3 商品の CSV 取込：前の見出し「商品分類コード」でも商品分類として読める', async () => {
  // ブランドの無い（どの商品にも使える）商品分類。無ければ作る
  const pc = (await one('select code from product_classes where is_active and brand_id is null order by id limit 1')) ??
    ok(await call('POST', '/masters/simple/product_classes', A, { code: `${P}PC`, name: `${P}分類` }), 'product class');
  ok(await imp('products', [['品番（商品分類コード）', '商品分類コード'], [`${P}`, pc.code]], false), 'import old');
  const a = await one('select pc.code from products p join product_classes pc on pc.id = p.product_class_id where p.id = $1', [product.id]);
  ok(await imp('products', [['品番（商品分類コード）', '商品分類（コード）'], [`${P}`, '']], false), 'import new');
  const b = await one('select product_class_id from products where id = $1', [product.id]);
  return (a?.code === pc.code && b.product_class_id === null) || { a, b };
});
await check('X2-3 SKU の CSV の書き出し・一覧で編集・欄の説明に「入数区分」の列が無い', async () => {
  const h = parse((await text('/masters/csv/skus/export', A)).text)[0];
  const c = ok(await call('GET', '/masters/csv/skus/columns', A), 'columns');
  const g = ok(await call('GET', `/masters/csv/skus/rows?q=${encodeURIComponent(P)}&limit=5`, A), 'rows');
  return (!h.includes('入数区分') && !c.columns.some((x) => x.label === '入数区分') && !g.columns.some((x) => x.field === 'pack_division') && g.items.length > 0 && g.items.every((x) => !('pack_division' in x))) || { h, g: g.columns.map((x) => x.label) };
});
await check('X2-3 SKU の CSV 取込：前に書き出した CSV の「入数区分」の列は今までどおり読める', async () => {
  ok(await imp('skus', [['商品コード', '入数区分'], [sku.sku_code, '102']], false), 'import');
  const r = await one('select pack_division from skus where id = $1', [sku.id]);
  return r.pack_division === '102' || r;
});

// ---- X1-2 分類・区分・設定のタブでコードが重なったときの文言 ------------------------------------------
await check('X1-2 分類のタブ（ブランド）で同じコードを登録すると「このブランドコードはすでに登録されています」', async () => {
  const b = ok(await call('POST', '/masters/simple/brands', A, { code: `${P}B`, name: `${P}ブランド` }), 'brand');
  const r = await call('POST', '/masters/simple/brands', A, { code: `${P}B`, name: `${P}ブランド2` });
  await call('DELETE', `/masters/simple/brands/${b.id}`, A);
  return (r.status === 409 && r.body?.message === 'このブランドコードはすでに登録されています') || r;
});
await check('X1-2 区分値のタブで同じコードを登録すると「このコードはすでに登録されています…」（「同じ内容」ではない）', async () => {
  const c = ok(await call('POST', '/masters/codes', A, { code_category_code: 'RECEIPT_METHOD', code: `${P}R`, name: `${P}入金` }), 'code');
  const r = await call('POST', '/masters/codes', A, { code_category_code: 'RECEIPT_METHOD', code: `${P}R`, name: `${P}入金2` });
  await call('DELETE', `/masters/codes/${c.id}`, A);
  return (r.status === 409 && String(r.body?.message).startsWith('このコードはすでに登録されています') && !String(r.body?.message).includes('同じ内容')) || r;
});

// ---- X1-4 非表示の得意先別商品に当たった取込の理由 ----------------------------------------------
// 照合が JAN で、単価の列が任意の取込先（verify-fb1016-g と同じ作り。ふだんは使わないにしておく）
const TPL = `${P}J`;
const tpl = await one(
  `insert into import_templates (template_code, name, import_type, file_encoding, has_header, order_no_source, sku_match_key, default_order_type, is_active, note)
   values ($1, $2, 'PARTNER_ORDER', 'UTF8', true, 'csv', 'jan', '卸', false, '回帰確認用（担当H）') returning id`,
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
const importJan = async (no, jans) => {
  await db.query('update import_templates set is_active = true where id = $1', [tpl.id]);
  const body = jans.map((jan) => `${P}${no},${P}C,${P}D,${jan},1,1000`).join('\r\n');
  const csv = `伝票番号,取引先コード,納品先コード,JAN,数量,単価\r\n${body}\r\n`;
  const r = await call('POST', '/imports/partner-orders', A, { template_code: TPL, file_name: `${P}-${no}.csv`, content_base64: Buffer.from(csv, 'utf8').toString('base64') });
  await db.query('update import_templates set is_active = false where id = $1', [tpl.id]);
  return r;
};
const eoOf = (no) => one('select status, sales_order_id, error_message from external_orders where channel = $1 and external_order_no = $2', [TPL, `${P}${no}`]);
await check('X1-4 非表示にした得意先別商品の先方 JAN で取り込むと、理由は「得意先別商品が非表示のため使いません」', async () => {
  ok(await call('PATCH', `/masters/partner-products/${pp2.id}`, A, { is_active: false }), 'hide pp2');
  const r = ok(await importJan('H1', [PJ2]), 'import');
  ok(await call('PATCH', `/masters/partner-products/${pp2.id}`, A, { is_active: true }), 'show pp2');
  const eo = await eoOf('H1');
  const o = r.orders[0];
  return (r.created_orders === 0 && r.pending_orders === 1 && o.status === '要確認（得意先別商品が非表示 1 行）' &&
    eo.sales_order_id === null && eo.error_message.includes(`先方の JAN ${PJ2} は得意先別商品が非表示のため使いません`) && !eo.error_message.includes('商品マスタにありません') &&
    r.warnings.some((w) => w.includes(`${P}H1`) && w.includes('非表示'))) || { r, eo };
});
await check('X1-4 どこにも無い JAN は今までどおり「商品マスタにありません」。非表示の行と混ざれば両方の理由', async () => {
  const none = await freshJan();
  ok(await call('PATCH', `/masters/partner-products/${pp2.id}`, A, { is_active: false }), 'hide pp2');
  const r = ok(await importJan('H2', [none, PJ2]), 'import');
  ok(await call('PATCH', `/masters/partner-products/${pp2.id}`, A, { is_active: true }), 'show pp2');
  const eo = await eoOf('H2');
  return (r.orders[0].status === '要確認（商品未登録 1 行・得意先別商品が非表示 1 行）' && eo.error_message.startsWith('1 行の商品が商品マスタにありません') && eo.error_message.includes(`2行目：先方の JAN ${PJ2} は`)) || { s: r.orders[0].status, eo };
});
await check('X1-4 表示に戻した行の先方 JAN なら、同じファイルの取り込み直しで受注になる', async () => {
  const r = ok(await importJan('H1', [PJ2]), 'reimport');
  return r.created_orders === 1 || r;
});

// ---- X3 免税の取引先の請求の詳細（画面）は税率別に免税の表記 ------------------------------------------
await check('X3 請求の詳細：消費税免税区分の取引先は税の表記（免税（税抜扱い））を返し、国内は null', async () => {
  const ex = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}F`, name1: `${P}免税先`, is_customer: true, overseas_tax_treatment: 'exempt', closing_day: 99 }), 'exempt');
  const d2 = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: ex.id, delivery_code: `${P}DF`, name: `${P}納品先F`, default_warehouse_id: KONY }), 'dest2');
  const o = ok(await call('POST', '/orders', A, {
    order_type: '卸', partner_id: ex.id, delivery_destination_id: d2.id, sales_category_id: category, order_date: today, ship_date: today,
    lines: [{ line_no: 1, line_type: '商品', sku_id: sku.id, item_name: `${P}品`, qty: '1', unit_price: '3000' }],
  }), 'order');
  const s2 = await one('select id from shipments where sales_order_id = $1', [o.id]);
  if (!s2) return '出荷が作られていません';
  ok(await call('POST', `/shipments/${s2.id}/confirm`, A, { ship_date: today }), 'confirm');
  const inv = ok(await call('POST', '/billing/closings', A, { target_month: month, partner_id: ex.id }), 'closing').invoices[0];
  const d = ok(await call('GET', `/billing/invoices/${inv.id}`, A), 'detail');
  const s1 = await one('select id from shipments where sales_order_id = $1', [order1?.id ?? 0]);
  if (s1) ok(await call('POST', `/shipments/${s1.id}/confirm`, A, { ship_date: today }), 'confirm dom');
  const dom = ok(await call('POST', '/billing/closings', A, { target_month: month, partner_id: cust.id }), 'closing dom').invoices[0];
  const dd = ok(await call('GET', `/billing/invoices/${dom.id}`, A), 'detail dom');
  return (d.overseas_tax_label === '免税（税抜扱い）' && d.tax_summaries.length >= 1 && !('partner_overseas_tax_treatment' in d) && dd.overseas_tax_label === null && dd.tax_summaries.length >= 1) || { d: [d.overseas_tax_label, d.tax_summaries], dd: [dd.overseas_tax_label, dd.tax_summaries] };
});

await db.end();
process.exit(ng > 0 ? 1 : 0);
