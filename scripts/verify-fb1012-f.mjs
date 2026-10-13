// 受入テスト No.39「売上仕入用の通貨」（2026-10-12、担当 F）の回帰確認。
// 取引先の通貨 → 受注 → 締め・請求書 → 入金消込 → 仕入・買掛 → 入出金 → 販売実績 の順に、
// 外貨（USD）が円と混ざらずに流れることを見る。
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は FF（担当 F）。
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
async function raw(path, token) {
  const r = await fetch(B + path, { headers: { authorization: `Bearer ${token}` } });
  if (r.status >= 300) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (id) => ok(await call('POST', '/auth/login', '', { login_id: id, password: PASS }), 'login').access_token;

/** PDF から文字を取り出す（verify-fb1009-masters1.mjs と同じ。フォントの ToUnicode で字形番号を文字に戻す）。 */
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

const A = await login('admin');
const V = await login('viewer1');
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const month = today.slice(0, 7);
const t = String(Date.now()).slice(-6);

// ---- 準備（接頭辞 FF） --------------------------------------------------------
const category = Number((await one('select id from sales_categories order by id limit 1')).id);
const warehouse = Number((await one('select id from warehouses where is_active order by id limit 1')).id);
const product = ok(await call('POST', '/masters/products', A, { product_code: `FF${t}`, product_name: `FF商品${t}`, cost_price: '100' }), 'product');
const sku = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `FF${t}-0000-100` }), 'sku');
const rc = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: warehouse, planned_date: today, lines: [{ line_no: 1, sku_id: sku.id, qty: '50' }] }), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');

const customer = async (code, currency, overseas = currency === 'USD') => {
  const body = { partner_code: code, name1: `FF得意先${code}`, is_customer: true, is_supplier: true, is_overseas: overseas, closing_day: 99 };
  if (currency) body.currency = currency;
  const p = ok(await call('POST', '/masters/partners', A, body), 'customer');
  const d = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: p.id, delivery_code: `D${code}`, name: `FF納品先${code}`, default_warehouse_id: warehouse }), 'dest');
  return { ...p, dest: d.id };
};
const usd = await customer(`FFU${t}`, 'USD');
const jpy = await customer(`FFJ${t}`, undefined);
// 海外の印なしの米ドルの得意先（消費税がかかる外貨。2026-10-13 再テスト N3）
const usdTax = await customer(`FFT${t}`, 'USD', false);

const orderFor = (c, unitPrice, extra = {}) => call('POST', '/orders', A, {
  order_type: '卸', partner_id: c.id, delivery_destination_id: c.dest, sales_category_id: category, order_date: today, ship_date: today,
  lines: [{ line_no: 1, line_type: '商品', sku_id: sku.id, item_name: 'FF', qty: '2', unit_price: unitPrice }],
  ...extra,
});
const shipOrder = async (orderId) => {
  let sh = await one('select id from shipments where sales_order_id = $1', [orderId]);
  if (!sh) { await call('POST', `/orders/${orderId}/allocate`, A, {}); sh = await one('select id from shipments where sales_order_id = $1', [orderId]); }
  if (!sh) throw new Error('出荷が作られていません');
  ok(await call('POST', `/shipments/${sh.id}/confirm`, A, { ship_date: today }), 'confirm');
  return Number(sh.id);
};

// ---- 1. 取引先の通貨 ---------------------------------------------------------------
await check('No.39 取引先に通貨を登録でき、詳細と一覧が currency を返す（省略は JPY）', async () => {
  const d = ok(await call('GET', `/masters/partners/${usd.id}`, A), 'detail');
  const l = ok(await call('GET', `/masters/partners?q=FF${'U'}${t}`, A), 'list');
  const j = ok(await call('GET', `/masters/partners/${jpy.id}`, A), 'detail jpy');
  return (d.currency === 'USD' && l.items.find((x) => x.id === usd.id)?.currency === 'USD' && j.currency === 'JPY') || { d: d.currency, j: j.currency };
});
await check('No.39 区分値に無い通貨・3文字でない通貨は 400', async () => {
  const a = await call('PATCH', `/masters/partners/${jpy.id}`, A, { currency: 'ZZZ' });
  const b = await call('PATCH', `/masters/partners/${jpy.id}`, A, { currency: 'usd' });
  return (a.status === 400 && b.status === 400) || { a: a.status, b: b.status };
});
await check('No.39 閲覧者は取引先の通貨を変えられない（403）', async () => {
  const r = await call('PATCH', `/masters/partners/${usd.id}`, V, { currency: 'JPY' });
  return r.status === 403 || r.status;
});
await check('No.39 取引先 CSV の書き出しに「通貨」列がある', async () => {
  const csv = (await raw('/masters/csv/partners/export', A)).toString('utf8').replace(/^﻿/, '');
  const lines = csv.split(/\r?\n/);
  const head = lines[0].split(',').map((c) => c.replace(/^"|"$/g, ''));
  const idx = head.indexOf('通貨');
  const row = lines.find((x) => x.includes(usd.partner_code));
  return (idx >= 0 && row?.includes('USD')) || { idx, row };
});
await check('No.39 取引先 CSV の取込で通貨を書き換えられ、英大文字3文字でない値は止まる', async () => {
  const put = async (v, dry) => call('POST', '/masters/csv/partners/import', A, { content_base64: Buffer.from(`取引先コード,通貨\r\n${jpy.partner_code},${v}\r\n`, 'utf8').toString('base64'), dry_run: dry });
  // 小文字の usd は3文字だが英大文字ではない（取込の行の決まりで止まる）
  const bad = await put('usd', true);
  const badRow = bad.body?.rows?.[0];
  ok(await put('EUR', false), 'import');
  const a = await one('select currency from partners where id = $1', [jpy.id]);
  ok(await call('PATCH', `/masters/partners/${jpy.id}`, A, { currency: 'JPY' }), 'back');
  return (a.currency === 'EUR' && badRow?.action === 'エラー' && /通貨/.test(badRow.message ?? '')) || { a, bad: bad.status, badRow };
});

// ---- 2. 受注の通貨 ---------------------------------------------------------------
const o1 = ok(await orderFor(usd, '12.50', { currency: 'JPY' }), 'usd order');
await check('No.39 受注の通貨は取引先の通貨（JPY を送っても USD）', async () => {
  const r = await one('select currency from sales_orders where id = $1', [o1.id]);
  return r.currency === 'USD' || r;
});
await check('No.39 受注の詳細・一覧が currency を返し、金額は小数のまま（12.50×2=25）', async () => {
  const d = ok(await call('GET', `/orders/${o1.id}`, A), 'detail');
  const l = ok(await call('GET', `/orders?partner_id=${usd.id}`, A), 'list');
  const row = l.items.find((x) => x.id === o1.id);
  return (d.currency === 'USD' && row?.currency === 'USD' && Number(row.total_amount) === 25) || { d: d.currency, row };
});
await check('No.39 取込のように SQL で直接作った受注も取引先の通貨になる（引き金）', async () => {
  const r = await one(
    `insert into sales_orders (order_no, order_type, partner_id, sales_category_id, order_date, direct_name, currency)
     values ($1, '直送', $2, $3, current_date, 'FF', 'JPY') returning id, currency`, [`FFSQL${t}`, usd.id, category]);
  await db.query('delete from sales_orders where id = $1', [r.id]);
  return r.currency === 'USD' || r;
});
const usdShip = await shipOrder(o1.id);
const oj = ok(await orderFor(jpy, '1000'), 'jpy order');
await shipOrder(oj.id);

// ---- 3. 締め・請求書 ---------------------------------------------------------------
const closeFor = async (c) => ok(await call('POST', '/billing/closings', A, { target_month: month, partner_id: c.id }), 'closing').invoices[0];
let usdInv = await closeFor(usd);
const jpyInv = await closeFor(jpy);
await check('No.39 締めると請求は取引先の通貨（USD）、円の得意先は JPY', async () => {
  const a = await one('select currency, shipment_amount, shipping_fee_amount, current_invoice_amount from invoices where id = $1', [usdInv.id]);
  const b = await one('select currency from invoices where id = $1', [jpyInv.id]);
  return (a.currency === 'USD' && Number(a.shipment_amount) === 25 && b.currency === 'JPY') || { a, b };
});
await check('No.39 外貨の請求には円の自動送料（3万円未満 750 円）を付けない／円の請求には付く', async () => {
  const a = await one('select shipping_fee_amount from invoices where id = $1', [usdInv.id]);
  const b = await one('select shipping_fee_amount from invoices where id = $1', [jpyInv.id]);
  return (Number(a.shipping_fee_amount) === 0 && Number(b.shipping_fee_amount) > 0) || { a, b };
});
await check('No.39 海外の外貨請求の消費税は 0（今の計算どおり）', async () => {
  const s = await one('select coalesce(sum(tax_amount),0) as tax from invoice_tax_summaries where invoice_id = $1', [usdInv.id]);
  return Number(s.tax) === 0 || s;
});
await check('No.39 請求の一覧・売掛残高・詳細が currency を返す', async () => {
  const l = ok(await call('GET', `/billing/invoices?partner_id=${usd.id}`, A), 'list').items.find((x) => x.id === usdInv.id);
  const ar = ok(await call('GET', `/billing/ar-balances?partner_id=${usd.id}`, A), 'ar').items.find((x) => x.id === usdInv.id);
  const d = ok(await call('GET', `/billing/invoices/${usdInv.id}`, A), 'detail');
  return (l?.currency === 'USD' && ar?.currency === 'USD' && d.currency === 'USD') || { l: l?.currency, ar: ar?.currency, d: d.currency };
});
await check('No.39 請求書 PDF に通貨と小数2桁の金額（USD 25.00）が出る。円の請求書は今までどおり', async () => {
  const u = pdfText(await raw(`/reports/invoices?invoice_ids=${usdInv.id}`, A));
  const j = pdfText(await raw(`/reports/invoices?invoice_ids=${jpyInv.id}`, A));
  return (u.includes('USD 25.00') && u.includes('通貨') && !j.includes('JPY') && !j.includes('通貨')) || { u: u.slice(0, 400), j: j.slice(0, 200) };
});
await check('No.39 納品書 PDF も通貨と小数2桁（12.50・USD 25.00）で出る', async () => {
  const u = pdfText(await raw(`/reports/delivery-notes?shipment_ids=${usdShip}&form=${encodeURIComponent('単価あり')}`, A));
  return (u.includes('12.50') && u.includes('USD 25.00')) || u.slice(0, 500);
});

// ---- 再テスト N3：外貨の消費税は最小単位（セント）で端数処理 --------------------------------
const oTax = ok(await call('POST', '/orders', A, {
  order_type: '卸', partner_id: usdTax.id, delivery_destination_id: usdTax.dest, sales_category_id: category, order_date: today, ship_date: today,
  lines: [{ line_no: 1, line_type: '商品', sku_id: sku.id, item_name: 'FF', qty: '1', unit_price: '55.25', tax_rate: '10.00' }],
}), 'usd tax order');
const taxShip = await shipOrder(oTax.id);
const taxInv = await closeFor(usdTax);
await check('再テスト N3 外貨の請求の消費税はセント単位（USD 55.25 の 10% → 5.52。1ドル単位の 5.00 にしない）', async () => {
  const s1 = await one('select sum(tax_amount)::text as tax from invoice_tax_summaries where invoice_id = $1', [taxInv.id]);
  const i = await one('select current_invoice_amount::text as total from invoices where id = $1', [taxInv.id]);
  return (Number(s1.tax) === 5.52 && Number(i.total) === 60.77) || { s1, i };
});
await check('再テスト N3 納品書・請求書 PDF の消費税も USD 5.52（合計 USD 60.77）', async () => {
  const d = pdfText(await raw(`/reports/delivery-notes?shipment_ids=${taxShip}&form=${encodeURIComponent('単価あり')}`, A));
  const v = pdfText(await raw(`/reports/invoices?invoice_ids=${taxInv.id}`, A));
  return (d.includes('USD 5.52') && d.includes('USD 60.77') && v.includes('USD 60.77')) || { d: d.slice(0, 400), v: v.slice(0, 400) };
});
await check('再テスト N3 円の消費税は今までどおり1円単位（1,000×2 の 10% → 200）', async () => {
  const s1 = await one('select sum(tax_amount)::text as tax from invoice_tax_summaries where invoice_id = $1', [jpyInv.id]);
  return Number(s1.tax) === 200 || s1;
});

// ---- 4. 入金と消込 ---------------------------------------------------------------
await check('No.39 円の入金は USD の請求に消し込めない（400）', async () => {
  const r = await call('POST', '/billing/cash-receipts', A, { partner_id: usd.id, receipt_date: today, amount: '10', currency: 'JPY', invoice_id: usdInv.id });
  return (r.status === 400 && /通貨/.test(JSON.stringify(r.body))) || r;
});
const rcpt = ok(await call('POST', '/billing/cash-receipts', A, { partner_id: usd.id, receipt_date: today, amount: '10.25', invoice_id: usdInv.id }), 'usd receipt');
await check('No.39 通貨を省いた入金は消込先の請求の通貨（USD）になる', async () => rcpt.currency === 'USD' || rcpt);
await check('No.39 請求を選ばない入金は取引先の通貨（USD）になる', async () => {
  const r = ok(await call('POST', '/billing/cash-receipts', A, { partner_id: usd.id, receipt_date: today, amount: '1' }), 'free receipt');
  await call('DELETE', `/billing/cash-receipts/${r.id}`, A);
  return r.currency === 'USD' || r;
});
await check('No.39 消し込んだ入金の通貨だけを JPY に直すことはできない（400）', async () => {
  const r = await call('PATCH', `/billing/cash-receipts/${rcpt.id}`, A, { currency: 'JPY' });
  return r.status === 400 || r;
});
await check('No.39 売掛残高の今回入金額は請求と同じ通貨の入金だけを数える（円の入金 999 を足さない）', async () => {
  const j = ok(await call('POST', '/billing/cash-receipts', A, { partner_id: usd.id, receipt_date: today, amount: '999', currency: 'JPY' }), 'jpy receipt');
  const ar = ok(await call('GET', `/billing/ar-balances?partner_id=${usd.id}`, A), 'ar').items.find((x) => x.id === usdInv.id);
  await call('DELETE', `/billing/cash-receipts/${j.id}`, A);
  return Number(ar?.current_receipt_amount) === 10.25 || ar;
});
await check('No.39 入金の一覧が currency を返す', async () => {
  const l = ok(await call('GET', `/billing/cash-receipts?partner_id=${usd.id}`, A), 'list').items.find((x) => x.id === rcpt.id);
  return l?.currency === 'USD' || l;
});

// ---- 再テスト N1：登録済みの入金の通貨は、消込先を選んでも変わらない ------------------------------
await check('再テスト N1 円の入金をあとから USD の請求に付け替えると 400（通貨を送らなくても、USD を送っても）', async () => {
  const j = ok(await call('POST', '/billing/cash-receipts', A, { partner_id: usd.id, receipt_date: today, amount: '5000', currency: 'JPY' }), 'jpy receipt');
  const a = await call('PATCH', `/billing/cash-receipts/${j.id}`, A, { invoice_id: usdInv.id });
  const b = await call('PATCH', `/billing/cash-receipts/${j.id}`, A, { invoice_id: usdInv.id, currency: 'USD' });
  const row = await one('select currency, invoice_id, applied_amount::text as applied from cash_receipts where id = $1', [j.id]);
  await call('DELETE', `/billing/cash-receipts/${j.id}`, A);
  return (a.status === 400 && b.status === 400 && row.currency === 'JPY' && row.invoice_id === null && Number(row.applied) === 0) || { a: a.status, b: b.status, row };
});
await check('再テスト N1 消込を外した入金なら通貨を直せる（入力の誤りを直す用）', async () => {
  const j = ok(await call('POST', '/billing/cash-receipts', A, { partner_id: usd.id, receipt_date: today, amount: '7', currency: 'JPY' }), 'jpy receipt');
  const a = await call('PATCH', `/billing/cash-receipts/${j.id}`, A, { currency: 'USD' });
  const b = await call('PATCH', `/billing/cash-receipts/${j.id}`, A, { invoice_id: usdInv.id });
  const row = await one('select currency, invoice_id from cash_receipts where id = $1', [j.id]);
  await call('DELETE', `/billing/cash-receipts/${j.id}`, A);
  return (a.status === 200 && b.status === 200 && row.currency === 'USD' && Number(row.invoice_id) === usdInv.id) || { a: a.status, b: b.status, row };
});

// ---- 5. 取引先の通貨を直したとき ------------------------------------------------------
const o2 = ok(await orderFor(usd, '3.00'), 'usd order 2');
await check('No.39 取引先の通貨を直すと、未請求の受注だけがその通貨になる（請求済みの受注は USD のまま）', async () => {
  ok(await call('PATCH', `/masters/partners/${usd.id}`, A, { currency: 'EUR' }), 'to EUR');
  const a = await one('select currency from sales_orders where id = $1', [o2.id]);
  const b = await one('select currency from sales_orders where id = $1', [o1.id]);
  ok(await call('PATCH', `/masters/partners/${usd.id}`, A, { currency: 'USD' }), 'back to USD');
  const c = await one('select currency from sales_orders where id = $1', [o2.id]);
  return (a.currency === 'EUR' && b.currency === 'USD' && c.currency === 'USD') || { a, b, c };
});
await check('No.39 取引先の通貨を直して締め直すと、請求も受注もその通貨になり、前の通貨の入金は消込が外れる', async () => {
  ok(await call('PATCH', `/masters/partners/${usd.id}`, A, { currency: 'EUR' }), 'to EUR');
  const inv = await closeFor(usd);
  const i = await one('select currency from invoices where id = $1', [inv.id]);
  const o = await one('select currency from sales_orders where id = $1', [o1.id]);
  const r = await one('select invoice_id, applied_amount from cash_receipts where id = $1', [rcpt.id]);
  // 元に戻す（USD で締め直し、入金を消し込み直す）
  ok(await call('PATCH', `/masters/partners/${usd.id}`, A, { currency: 'USD' }), 'back to USD');
  usdInv = await closeFor(usd);
  ok(await call('PATCH', `/billing/cash-receipts/${rcpt.id}`, A, { invoice_id: usdInv.id }), 'relink');
  const back = await one('select currency from invoices where id = $1', [usdInv.id]);
  return (i.currency === 'EUR' && o.currency === 'EUR' && r.invoice_id === null && Number(r.applied_amount) === 0 && back.currency === 'USD') || { i, o, r, back };
});

// ---- 6. 仕入・買掛 ---------------------------------------------------------------
const pu = ok(await call('POST', '/purchases', A, { division: '仕入', supplier_partner_id: usd.id, purchase_date: today, currency: 'USD', lines: [{ line_no: 1, item_name: 'FF', qty: '2', unit_cost: '350' }] }), 'usd purchase');
const pj = ok(await call('POST', '/purchases', A, { division: '仕入', supplier_partner_id: usd.id, purchase_date: today, currency: 'JPY', lines: [{ line_no: 1, item_name: 'FF', qty: '1', unit_cost: '5000' }] }), 'jpy purchase');
await check('No.39 仕入の一覧・詳細が currency を返す', async () => {
  const l = ok(await call('GET', `/purchases?supplier_partner_id=${usd.id}`, A), 'list').items.find((x) => x.id === pu.id);
  const d = ok(await call('GET', `/purchases/${pu.id}`, A), 'detail');
  return (l?.currency === 'USD' && d.currency === 'USD' && Number(l.total_amount) === 700) || { l, d: d.currency };
});
const pay = ok(await call('POST', '/payments', A, { partner_id: usd.id, payment_date: today, amount: '100', purchase_id: pu.id }), 'payment');
await check('再テスト N5 支払に通貨があり、対象の仕入の通貨（USD）になる。仕入を選ばない支払は仕入先の通貨', async () => {
  const free = ok(await call('POST', '/payments', A, { partner_id: usd.id, payment_date: today, amount: '1' }), 'free payment');
  const row = await one('select currency from cash_payments where id = $1', [pay.id]);
  const f = await one('select currency from cash_payments where id = $1', [free.id]);
  await call('DELETE', `/payments/${free.id}`, A);
  return (row.currency === 'USD' && f.currency === 'USD') || { row, f };
});
await check('再テスト N5 円の支払は USD の仕入に消し込めない（登録・付け替えとも 400）', async () => {
  const a = await call('POST', '/payments', A, { partner_id: usd.id, payment_date: today, amount: '5000', currency: 'JPY', purchase_id: pu.id });
  const j = ok(await call('POST', '/payments', A, { partner_id: usd.id, payment_date: today, amount: '5000', currency: 'JPY' }), 'jpy payment');
  const b = await call('PATCH', `/payments/${j.id}`, A, { purchase_id: pu.id });
  const c = await call('PATCH', `/payments/${j.id}`, A, { purchase_id: pu.id, currency: 'USD' });
  const okJ = await call('PATCH', `/payments/${j.id}`, A, { purchase_id: pj.id });
  const row = await one('select currency, purchase_id from cash_payments where id = $1', [j.id]);
  await call('DELETE', `/payments/${j.id}`, A);
  return (a.status === 400 && b.status === 400 && c.status === 400 && okJ.status === 200 && row.currency === 'JPY' && Number(row.purchase_id) === pj.id) || { a: a.status, b: b.status, c: c.status, okJ: okJ.status, row };
});
await check('No.39 買掛残高は通貨ごとの行に分かれる（USD 700−100、JPY 5,000 を足さない）', async () => {
  const rows = ok(await call('GET', `/ap-balances?from=${month}-01&to=${today}`, A), 'ap').filter((x) => x.partner_id === usd.id);
  const u = rows.find((x) => x.currency === 'USD');
  const j = rows.find((x) => x.currency === 'JPY');
  return (rows.length === 2 && Number(u?.purchase_amount) === 700 && Number(u?.payment_amount) === 100 && Number(u?.balance) === 600 && Number(j?.purchase_amount) === 5000 && Number(j?.payment_amount) === 0) || rows;
});
await check('No.39 支払の一覧は対象の仕入の通貨（USD）を返す', async () => {
  const l = ok(await call('GET', `/payments?partner_id=${usd.id}`, A), 'list').items.find((x) => x.id === pay.id);
  return l?.currency === 'USD' || l;
});
await call('DELETE', `/payments/${pay.id}`, A);
await call('POST', `/purchases/${pu.id}/cancel`, A);
await call('POST', `/purchases/${pj.id}/cancel`, A);

// ---- 7. 入出金 ---------------------------------------------------------------
await check('No.39 入出金を USD で登録でき、一覧が currency を返す', async () => {
  const c = ok(await call('POST', '/cash-transactions', A, { division: '入金', target_month: month, transaction_date: today, partner_id: usd.id, currency: 'USD', transfer_amount: '25' }), 'cash');
  const l = ok(await call('GET', `/cash-transactions?target_month=${month}`, A), 'list').find((x) => x.id === c.id);
  await call('DELETE', `/cash-transactions/${c.id}`, A);
  return (c.currency === 'USD' && l?.currency === 'USD') || { c: c.currency, l };
});

await check('再テスト 円の入出金の合計に海外送金 (USD) を足さない（振込 10,000＋海外送金 USD 100 → 合計 10,000）', async () => {
  const c = ok(await call('POST', '/cash-transactions', A, { division: '入金', target_month: month, transaction_date: today, partner_id: jpy.id, currency: 'JPY', transfer_amount: '10000', overseas_usd: '100' }), 'cash jpy');
  const u = ok(await call('POST', '/cash-transactions', A, { division: '入金', target_month: month, transaction_date: today, partner_id: usd.id, currency: 'USD', transfer_amount: '10', overseas_usd: '5' }), 'cash usd');
  const e = ok(await call('PATCH', `/cash-transactions/${c.id}`, A, { overseas_usd: '200' }), 'cash patch');
  await call('DELETE', `/cash-transactions/${c.id}`, A);
  await call('DELETE', `/cash-transactions/${u.id}`, A);
  return (Number(c.amount) === 10000 && Number(u.amount) === 15 && Number(e.amount) === 10000) || { c: c.amount, u: u.amount, e: e.amount };
});

// ---- 再テスト：返品・得意先別商品の金額に通貨を添える ------------------------------------------
await check('再テスト 返品の一覧・得意先別商品の一覧が取引先の通貨を返す（外貨は小数2桁で見せるため）', async () => {
  const r = await one(
    `insert into returns (return_no, return_type, partner_id, warehouse_id, return_date, return_amount)
     values ($1, '販社返品', $2, $3, current_date, 12.5) returning id`, [`FFR${t}`, usd.id, warehouse]);
  const l = ok(await call('GET', `/returns?partner_id=${usd.id}`, A), 'returns').items.find((x) => Number(x.id) === Number(r.id));
  await db.query('delete from returns where id = $1', [r.id]);
  const pp = ok(await call('POST', '/masters/partner-products', A, { partner_id: usd.id, sku_id: sku.id, unit_price: '12.50' }), 'pp');
  const pl = ok(await call('GET', `/masters/partner-products?partner_id=${usd.id}`, A), 'pp list').items.find((x) => x.id === pp.id);
  return (l?.currency === 'USD' && pl?.partner_currency === 'USD') || { l, pl };
});

// ---- 8. 販売実績 ---------------------------------------------------------------
await check('No.39 販売実績は通貨ごとに分かれ、外貨の行は原価・利益を出さない', async () => {
  const r = ok(await call('POST', '/analytics/sales', A, { from: today, to: today, dimensions: ['取引先'], measures: ['金額', '原価', '利益'], limit: 2000 }), 'sales');
  const u = r.rows.find((x) => x['取引先'] === `FF得意先${usd.partner_code}`);
  const j = r.rows.find((x) => x['取引先'] === `FF得意先${jpy.partner_code}`);
  return (r.dimensions.includes('通貨') && u?.['通貨'] === 'USD' && Number(u['金額']) === 25 && u['利益'] === null && u['原価'] === null
    && j?.['通貨'] === 'JPY' && Number(j['金額']) === 2000 && j['利益'] !== null) || { dims: r.dimensions, u, j };
});

// ---- 後片付け（作った請求は取り消しておく。他の担当の締めに影響しないよう、FF の得意先は使わないにする） ----
await call('DELETE', `/billing/cash-receipts/${rcpt.id}`, A);
await call('POST', `/billing/invoices/${usdInv.id}/cancel`, A);
await call('POST', `/billing/invoices/${jpyInv.id}/cancel`, A);
await call('POST', `/billing/invoices/${taxInv.id}/cancel`, A);
await call('POST', `/masters/partners/${usdTax.id}/deactivate`, A);
await call('POST', `/orders/${o2.id}/cancel`, A);
await call('POST', `/masters/partners/${usd.id}/deactivate`, A);
await call('POST', `/masters/partners/${jpy.id}/deactivate`, A);

await db.end();
if (ng > 0) process.exitCode = 1;
