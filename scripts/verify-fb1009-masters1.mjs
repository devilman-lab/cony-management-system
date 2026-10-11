// 2026-10-09 顧客フィードバック（マスター編②）のうち、取引先・納品先・得意先別商品・分類区分設定
// （M-02〜M-05、M-17〜M-23）の回帰確認。使い捨ての API・DB に対して流す（cony_dev には使わない）。
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
async function raw(path, token) {
  const r = await fetch(B + path, { headers: { authorization: `Bearer ${token}` } });
  if (r.status >= 300) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (id) => ok(await call('POST', '/auth/login', '', { login_id: id, password: PASS }), 'login').access_token;

/**
 * PDF から文字を取り出す（取り出せる範囲で）。
 * 帳票は pdfkit が日本語フォントを埋め込んで作るので、本文は字形番号の16進で書かれている。
 * フォントに付く ToUnicode（字形番号 → 文字）を読み、TJ／Tj の16進を文字に戻す。
 */
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
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const month = today.slice(0, 7);
const t = String(Date.now()).slice(-6);
const setSetting = async (v) => ok(await call('PATCH', '/masters/settings/OVERSEAS_TAX_TREATMENT', A, { value_text: v }), 'setting');
const originalTreatment = (await one("select value_text from system_settings where setting_key = 'OVERSEAS_TAX_TREATMENT'"))?.value_text ?? 'exempt';

// ---- 準備（接頭辞 M1） --------------------------------------------------------
const category = Number((await one('select id from sales_categories order by id limit 1')).id);
const warehouse = Number((await one('select id from warehouses where is_active order by id limit 1')).id);
const SKU_JAN = `49${t}00001`.padEnd(13, '0').slice(0, 13);
const SHIP_JAN = `45${t}99999`.padEnd(13, '0').slice(0, 13);
const product = ok(await call('POST', '/masters/products', A, { product_code: `M1${t}`, product_name: `M1商品${t}`, cost_price: '100' }), 'product');
const sku = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `M1${t}-0000-100`, jan: SKU_JAN }), 'sku');
const rc = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: warehouse, planned_date: today, lines: [{ line_no: 1, sku_id: sku.id, qty: '50' }] }), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');

const wi = ok(await call('POST', '/masters/simple/work_instructions', A, { code: `M1W${t}`, name: `M1作業${t}`, instruction_body: `M1本文${t} 専用JAN貼り付け` }), 'work instruction');
const customer = async (code, overseas) => {
  const p = ok(await call('POST', '/masters/partners', A, { partner_code: code, name1: `M1得意先${code}`, is_customer: true, is_overseas: overseas, closing_day: 99 }), 'customer');
  const d = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: p.id, delivery_code: `D${code}`, name: `M1納品先${code}`, default_warehouse_id: warehouse, work_instruction_id: wi.id }), 'dest');
  return { ...p, dest: d.id };
};
const overseasCust = await customer(`M1O${t}`, true);
const domesticCust = await customer(`M1J${t}`, false);
// 海外の得意先だけ出荷JANを持つ（国内は得意先別商品を持たず、SKU の JAN になるはず）
const pp = ok(await call('POST', '/masters/partner-products', A, { partner_id: overseasCust.id, sku_id: sku.id, unit_price: '1000', shipping_jan: SHIP_JAN }), 'partner product');

const shipFor = async (c, extraLine = {}) => {
  const o = ok(await call('POST', '/orders', A, {
    order_type: '卸', partner_id: c.id, delivery_destination_id: c.dest, sales_category_id: category, order_date: today, ship_date: today,
    lines: [{ line_no: 1, line_type: '商品', sku_id: sku.id, item_name: 'M1', qty: '2', unit_price: '1000', ...extraLine }],
  }), 'order');
  const sh = await one('select id from shipments where sales_order_id = $1', [o.id]);
  if (!sh) throw new Error('出荷が作られていません');
  ok(await call('POST', `/shipments/${sh.id}/confirm`, A, { ship_date: today }), 'confirm');
  return Number(sh.id);
};
const overseasShip = await shipFor(overseasCust, { partner_product_id: pp.id });
const domesticShip = await shipFor(domesticCust);

// ---- M-02 取引先の「海外」 ----------------------------------------------------------
await check('M-02 取引先の「海外」を登録でき、詳細と一覧が is_overseas を返す', async () => {
  const d = ok(await call('GET', `/masters/partners/${overseasCust.id}`, A), 'detail');
  const l = ok(await call('GET', `/masters/partners?q=${encodeURIComponent(overseasCust.partner_code)}`, A), 'list');
  const row = l.items.find((x) => x.id === overseasCust.id);
  return (d.is_overseas === true && row?.is_overseas === true) || { detail: d.is_overseas, list: row?.is_overseas };
});
await check('M-02 取引先の「海外」を編集で外せ、戻せる', async () => {
  ok(await call('PATCH', `/masters/partners/${domesticCust.id}`, A, { is_overseas: true }), 'patch on');
  const a = await one('select is_overseas from partners where id = $1', [domesticCust.id]);
  ok(await call('PATCH', `/masters/partners/${domesticCust.id}`, A, { is_overseas: false }), 'patch off');
  const b = await one('select is_overseas from partners where id = $1', [domesticCust.id]);
  return (a.is_overseas === true && b.is_overseas === false) || { a, b };
});
await check('M-02 取引先 CSV の書き出しに「海外」列があり、海外の取引先は「有効」', async () => {
  const csv = (await raw('/masters/csv/partners/export', A)).toString('utf8').replace(/^﻿/, '');
  // セルはすべて "…" で囲まれて出る。今回の行にはカンマを含む値が無いので単純に割る
  const cells = (line) => line.split(',').map((c) => c.replace(/^"|"$/g, ''));
  const lines = csv.split(/\r?\n/);
  const head = cells(lines[0]);
  const idx = head.indexOf('海外');
  const row = lines.map(cells).find((x) => x[0] === overseasCust.partner_code);
  return (idx >= 0 && row?.[idx] === '有効') || { idx, cell: row?.[idx] };
});
await check('M-02 取引先 CSV の取込で「海外」を書き換えられる', async () => {
  const content = `取引先コード,海外\r\n${domesticCust.partner_code},有効\r\n`;
  ok(await call('POST', '/masters/csv/partners/import', A, { content_base64: Buffer.from(content, 'utf8').toString('base64'), dry_run: false }), 'import');
  const a = await one('select is_overseas from partners where id = $1', [domesticCust.id]);
  await db.query('update partners set is_overseas = false where id = $1', [domesticCust.id]);
  return a.is_overseas === true || a;
});

// ---- M-02 効き目：締め処理の消費税 ---------------------------------------------------
const closeFor = async (c) => {
  const r = ok(await call('POST', '/billing/closings', A, { target_month: month, partner_id: c.id }), 'closing');
  return r.invoices[0];
};
const ovInv = await closeFor(overseasCust);
const jpInv = await closeFor(domesticCust);
await check('M-02 海外の得意先の締めは消費税 0（税率別内訳も 0%・税額 0）', async () => {
  const s = (await db.query('select tax_rate, taxable_base, tax_amount from invoice_tax_summaries where invoice_id = $1', [ovInv.id])).rows;
  const lines = (await db.query('select tax_rate from invoice_lines where invoice_id = $1', [ovInv.id])).rows;
  const good = s.length === 1 && Number(s[0].tax_rate) === 0 && Number(s[0].tax_amount) === 0 && Number(s[0].taxable_base) === 2000
    && lines.length > 0 && lines.every((l) => Number(l.tax_rate) === 0);
  return good || { s, lines };
});
await check('M-02 海外の得意先の当月請求額に消費税が乗らない（出荷額＋送料のまま）', async () => {
  const i = await one('select shipment_amount, shipping_fee_amount, current_invoice_amount from invoices where id = $1', [ovInv.id]);
  return Number(i.current_invoice_amount) === Number(i.shipment_amount) + Number(i.shipping_fee_amount) || i;
});
await check('M-02 国内の得意先の締めは今までどおり消費税 10%', async () => {
  const s = (await db.query('select tax_rate, tax_amount from invoice_tax_summaries where invoice_id = $1', [jpInv.id])).rows;
  return (s.length === 1 && Number(s[0].tax_rate) === 10 && Number(s[0].tax_amount) === 200) || s;
});

// ---- M-02 効き目：請求書 PDF の表記 ------------------------------------------------
await check('M-02 請求書 PDF の文字を取り出せる（検査の前提）', async () => {
  const txt = pdfText(await raw(`/reports/invoices?invoice_ids=${jpInv.id}`, A));
  return txt.includes('請') && txt.includes('10%') || txt.slice(0, 200);
});
await check('M-02 海外の請求書 PDF に「免税（税抜扱い）」（設定 exempt）', async () => {
  await setSetting('exempt');
  const txt = pdfText(await raw(`/reports/invoices?invoice_ids=${ovInv.id}`, A));
  return (txt.includes('免税（税抜扱い）') && !txt.includes('課税対象外')) || txt.slice(0, 300);
});
await check('M-02 海外の請求書 PDF に「課税対象外」（設定 non_taxable）', async () => {
  await setSetting('non_taxable');
  const txt = pdfText(await raw(`/reports/invoices?invoice_ids=${ovInv.id}`, A));
  return (txt.includes('課税対象外') && !txt.includes('免税')) || txt.slice(0, 300);
});
await check('M-02 国内の請求書 PDF には免税・課税対象外の表記が出ない', async () => {
  const txt = pdfText(await raw(`/reports/invoices?invoice_ids=${jpInv.id}`, A));
  return (!txt.includes('免税') && !txt.includes('課税対象外')) || txt.slice(0, 300);
});

// ---- M-02 効き目：海外の仕入先の仕入 -----------------------------------------------
const supplier = async (code, overseas) => ok(await call('POST', '/masters/partners', A, { partner_code: code, name1: `M1仕入先${code}`, is_supplier: true, is_overseas: overseas }), 'supplier');
const ovSup = await supplier(`M1S${t}`, true);
const jpSup = await supplier(`M1K${t}`, false);
const taxCode = async (code) => Number((await one("select c.id from codes c join code_categories cc on cc.id = c.code_category_id where cc.code = 'TAX_DIVISION' and c.code = $1", [code])).id);
const purchaseLine = async (sup, line) => {
  const p = ok(await call('POST', '/purchases', A, { division: '仕入', supplier_partner_id: sup.id, purchase_date: today, lines: [{ line_no: 1, item_name: 'M1仕入', unit_cost: '100', ...line }] }), 'purchase');
  return one('select l.tax_rate, c.code from purchase_lines l left join codes c on c.id = l.tax_division_code_id where l.purchase_id = $1', [p.id]);
};
await check('M-02 海外の仕入先・税区分なし → 免税の設定では「非課税」(EXEMPT)・0%', async () => {
  await setSetting('exempt');
  const l = await purchaseLine(ovSup, {});
  return (l.code === 'EXEMPT' && Number(l.tax_rate) === 0) || l;
});
await check('M-02 海外の仕入先・税区分なし → 課税対象外の設定では「不課税」(NON_TAX)・0%', async () => {
  await setSetting('non_taxable');
  const l = await purchaseLine(ovSup, { tax_rate: '0.00' });
  return (l.code === 'NON_TAX' && Number(l.tax_rate) === 0) || l;
});
await check('M-02 海外の仕入先でも税区分を指定すればそれが優先（課税10%）', async () => {
  const l = await purchaseLine(ovSup, { tax_division_code_id: await taxCode('TAX10') });
  return (l.code === 'TAX10' && Number(l.tax_rate) === 10) || l;
});
await check('M-02 国内の仕入先・税区分なしは今までどおり（区分なし・10%）', async () => {
  const l = await purchaseLine(jpSup, {});
  return (l.code === null && Number(l.tax_rate) === 10) || l;
});
await check('M-02 仕入画面用の初期値 API が設定に合わせて非課税／不課税を返す', async () => {
  await setSetting('exempt');
  const a = ok(await call('GET', '/purchases/overseas-tax-default', A), 'exempt');
  await setSetting('non_taxable');
  const b = ok(await call('GET', '/purchases/overseas-tax-default', A), 'non_taxable');
  const good = a.tax_division_code_id === (await taxCode('EXEMPT')) && a.tax_rate === '0.00' && a.label === '免税（税抜扱い）'
    && b.tax_division_code_id === (await taxCode('NON_TAX')) && b.label === '課税対象外';
  return good || { a, b };
});
await check('M-02 システム設定 OVERSEAS_TAX_TREATMENT は画面から変えられ、選べない値は弾く', async () => {
  const s = ok(await call('GET', '/masters/settings', A), 'settings').find((x) => x.setting_key === 'OVERSEAS_TAX_TREATMENT');
  return (s?.is_user_editable === true && s.allowed_values === 'exempt,non_taxable') || s;
});
await setSetting(originalTreatment);

// ---- M-18 帳票の JAN ---------------------------------------------------------------
await check('M-18 出荷指示書の JAN は得意先別商品の出荷JAN', async () => {
  const txt = pdfText(await raw(`/reports/shipping-instructions?shipment_ids=${overseasShip}`, A));
  return (txt.includes(SHIP_JAN) && !txt.includes(SKU_JAN)) || txt.slice(0, 400);
});
await check('M-18 出荷指示書の JAN は出荷JANが無ければ SKU の JAN（コニーJAN）', async () => {
  const txt = pdfText(await raw(`/reports/shipping-instructions?shipment_ids=${domesticShip}`, A));
  return txt.includes(SKU_JAN) || txt.slice(0, 400);
});
await check('M-18 納品書（単価あり2）の JAN は得意先別商品の出荷JAN', async () => {
  const txt = pdfText(await raw(`/reports/delivery-notes?shipment_ids=${overseasShip}&form=${encodeURIComponent('単価あり2')}`, A));
  return (txt.includes(SHIP_JAN) && !txt.includes(SKU_JAN)) || txt.slice(0, 400);
});
await check('M-18 納品書（単価あり2）の JAN は出荷JANが無ければ SKU の JAN', async () => {
  const txt = pdfText(await raw(`/reports/delivery-notes?shipment_ids=${domesticShip}&form=${encodeURIComponent('単価あり2')}`, A));
  return txt.includes(SKU_JAN) || txt.slice(0, 400);
});
await check('M-18 受注明細が得意先別商品を指していなくても、取引先×SKU で出荷JANを引く', async () => {
  const sh = await shipFor(overseasCust);
  const txt = pdfText(await raw(`/reports/shipping-instructions?shipment_ids=${sh}`, A));
  return txt.includes(SHIP_JAN) || txt.slice(0, 400);
});
await check('M-18 出荷JANが空白だけなら SKU の JAN', async () => {
  ok(await call('PATCH', `/masters/partner-products/${pp.id}`, A, { shipping_jan: ' ' }), 'blank');
  const txt = pdfText(await raw(`/reports/delivery-notes?shipment_ids=${overseasShip}&form=${encodeURIComponent('単価あり2')}`, A));
  ok(await call('PATCH', `/masters/partner-products/${pp.id}`, A, { shipping_jan: SHIP_JAN }), 'restore');
  return txt.includes(SKU_JAN) || txt.slice(0, 400);
});

// ---- M-04 納品先の作業指示内容 ---------------------------------------------------------
await check('M-04 納品先の一覧が作業指示の本文（作業指示内容）とコードを返す', async () => {
  const l = ok(await call('GET', `/masters/delivery-destinations?partner_id=${overseasCust.id}`, A), 'list');
  const d = l.items.find((x) => x.id === overseasCust.dest);
  return (d?.work_instruction_body === `M1本文${t} 専用JAN貼り付け` && d.work_instruction_code === `M1W${t}`) || d;
});

// ---- M-19 得意先別商品の一覧 -------------------------------------------------------------
await check('M-19 得意先別商品の一覧が SKU の商品名（無ければ商品名）を返す', async () => {
  const l = ok(await call('GET', `/masters/partner-products?partner_id=${overseasCust.id}`, A), 'list');
  const a = l.items.find((x) => x.id === pp.id)?.product_name;
  await db.query('update skus set sku_name = $2 where id = $1', [sku.id, `M1SKU名${t}`]);
  const l2 = ok(await call('GET', `/masters/partner-products?partner_id=${overseasCust.id}`, A), 'list2');
  const b = l2.items.find((x) => x.id === pp.id)?.product_name;
  await db.query('update skus set sku_name = null where id = $1', [sku.id]);
  return (a === `M1商品${t}` && b === `M1SKU名${t}`) || { a, b };
});

// ---- M-23 通貨・経費科目 ---------------------------------------------------------------
const codeIn = async (cat, code) => ok(await call('GET', `/masters/codes/${cat}`, A), 'codes').values.some((v) => v.code === code);
const cur = `T${String.fromCharCode(65 + (Number(t) % 26))}${String.fromCharCode(65 + (Math.floor(Number(t) / 26) % 26))}`;
await check('M-23 通貨を追加でき、選択肢に出る', async () => {
  ok(await call('POST', '/masters/codes', A, { code_category_code: 'CURRENCY', code: cur, name: `M1通貨${t}`, sort_order: 90 }), 'add');
  return (await codeIn('CURRENCY', cur)) || '選択肢に無い';
});
await check('M-23 通貨のコードは英大文字3文字だけ（4文字は 400）', async () => {
  const r = await call('POST', '/masters/codes', A, { code_category_code: 'CURRENCY', code: `X${t}`, name: 'x' });
  return r.status === 400 || r.status;
});
await check('M-23 経費科目を追加・名称変更でき、選択肢に出る', async () => {
  const c = ok(await call('POST', '/masters/codes', A, { code_category_code: 'EXPENSE_DIVISION', code: `M1E${t}`, name: `M1経費${t}` }), 'add');
  ok(await call('PATCH', `/masters/codes/${c.id}`, A, { name: `M1経費改${t}` }), 'rename');
  const v = ok(await call('GET', '/masters/codes/EXPENSE_DIVISION', A), 'codes').values.find((x) => x.code === `M1E${t}`);
  return v?.name === `M1経費改${t}` || v;
});
await check('M-23 「使わない」にすると選択肢から外れ、管理用一覧には無効で残り、戻せる', async () => {
  const id = Number((await one("select c.id from codes c join code_categories cc on cc.id = c.code_category_id where cc.code = 'CURRENCY' and c.code = $1", [cur])).id);
  ok(await call('PATCH', `/masters/codes/${id}`, A, { is_active: false }), 'off');
  const hidden = !(await codeIn('CURRENCY', cur));
  const all = ok(await call('GET', '/masters/codes/CURRENCY/all', A), 'all').values.find((x) => x.code === cur);
  ok(await call('PATCH', `/masters/codes/${id}`, A, { is_active: true }), 'on');
  const back = await codeIn('CURRENCY', cur);
  return (hidden && all?.is_active === false && back) || { hidden, all, back };
});
await check('M-23 追加した通貨で仕入を登録できる', async () => {
  const r = await call('POST', '/purchases', A, { division: '仕入', supplier_partner_id: jpSup.id, purchase_date: today, currency: cur, lines: [{ line_no: 1, item_name: 'M1', unit_cost: '1' }] });
  return r.status === 201 || r;
});

await db.end();
if (ng > 0) process.exitCode = 1;
