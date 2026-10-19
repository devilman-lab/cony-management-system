// 2026-10-16 顧客フィードバック（マスター編_3）のうち、取引先マスタ・納品先マスタ（M3-03〜M3-14）と
// 販社CSV取込の JAN の引き当て（M3-27 の後半）の回帰確認（担当 A）。使い捨ての API・DB に対して流す。
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は GA。システム設定 OVERSEAS_TAX_TREATMENT は変えない（今の値と逆の区分を取引先に付けて確かめる）。
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
const V = await login('viewer1');
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const month = today.slice(0, 7);
const t = String(Date.now()).slice(-6);
const P = `GA${t}`;

// ---- 準備（接頭辞 GA） --------------------------------------------------------
const LABEL = { exempt: '免税（税抜扱い）', non_taxable: '課税対象外' };
const DIVISION = { exempt: 'EXEMPT', non_taxable: 'NON_TAX' };
const setting = (await one("select value_text from system_settings where setting_key = 'OVERSEAS_TAX_TREATMENT'"))?.value_text === 'non_taxable' ? 'non_taxable' : 'exempt';
// 取引先には、システム設定と逆の区分を付ける（取引先の区分が効いていることを見分けるため）
const other = setting === 'exempt' ? 'non_taxable' : 'exempt';
const codeId = async (cat, code) =>
  Number((await one('select c.id from codes c join code_categories cc on cc.id = c.code_category_id where cc.code = $1 and c.code = $2', [cat, code])).id);
const TARGET = await codeId('GROSS_MARGIN_ADJUST', 'TARGET');
const TRANSFER = await codeId('RECEIPT_METHOD', 'TRANSFER');
const E_REC = await codeId('RECEIPT_METHOD', 'E_RECEIVABLE');
const MAIL = await codeId('INVOICE_SEND_METHOD', 'MAIL');
const category = Number((await one('select id from sales_categories order by id limit 1')).id);
const warehouse = Number((await one('select id from warehouses where is_active order by id limit 1')).id);

const ov = ok(await call('POST', '/masters/partners', A, {
  partner_code: `${P}O`, name1: `GA海外${t}`, short_name: `GA略O${t}`, is_customer: true, is_supplier: true,
  // is_overseas は送らない（消費税免税区分から決まる）
  overseas_tax_treatment: other, closing_day: 99, payment_month_offset: 1, payment_day: 99,
  gross_margin_adjust_code_id: TARGET, payment_month_offset2: 2, payment_day2: 10,
  receipt_method1_code_id: TRANSFER, receipt_method2_code_id: E_REC, invoice_send_method_code_id: MAIL, invoice_email: 'ga-bill@example.com',
}), 'overseas partner');
// 消費税免税区分を選ぶ前から「海外」だった取引先（区分は空＝システム設定）
const legacy = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}L`, name1: `GA旧海外${t}`, is_customer: true, is_overseas: true }), 'legacy partner');
const listRow = async (id, code) => ok(await call('GET', `/masters/partners?q=${encodeURIComponent(code)}&include_inactive=true`, A), 'list').items.find((x) => x.id === id);

// ---- M3-07 消費税免税区分 --------------------------------------------------------
await check('M3-07 消費税免税区分だけを送ると「海外」がそろい、取引先に区分が入る', async () => {
  const r = await one('select is_overseas, overseas_tax_treatment from partners where id = $1', [ov.id]);
  return (r.is_overseas === true && r.overseas_tax_treatment === other) || r;
});
await check('M3-07 詳細の overseas_tax_class：取引先の区分／区分が空の海外はシステム設定の値', async () => {
  const a = ok(await call('GET', `/masters/partners/${ov.id}`, A), 'detail');
  const b = ok(await call('GET', `/masters/partners/${legacy.id}`, A), 'detail legacy');
  return (a.overseas_tax_class === other && b.overseas_tax_class === setting) || { a: a.overseas_tax_class, b: b.overseas_tax_class };
});
await check('M3-07 「なし」（null）にすると国内に、選び直すと海外に戻る', async () => {
  ok(await call('PATCH', `/masters/partners/${legacy.id}`, A, { overseas_tax_treatment: null }), 'patch none');
  const a = await one('select is_overseas, overseas_tax_treatment from partners where id = $1', [legacy.id]);
  ok(await call('PATCH', `/masters/partners/${legacy.id}`, A, { overseas_tax_treatment: other }), 'patch other');
  const b = await one('select is_overseas, overseas_tax_treatment from partners where id = $1', [legacy.id]);
  ok(await call('PATCH', `/masters/partners/${legacy.id}`, A, { is_overseas: false }), 'patch is_overseas false');
  const c = await one('select is_overseas, overseas_tax_treatment from partners where id = $1', [legacy.id]);
  // 元に戻す（区分が空の海外）
  await db.query('update partners set is_overseas = true, overseas_tax_treatment = null where id = $1', [legacy.id]);
  const good = a.is_overseas === false && a.overseas_tax_treatment === null && b.is_overseas === true && b.overseas_tax_treatment === other
    && c.is_overseas === false && c.overseas_tax_treatment === null;
  return good || { a, b, c };
});
await check('M3-07 消費税免税区分に無い値は 400', async () => {
  const r = await call('PATCH', `/masters/partners/${ov.id}`, A, { overseas_tax_treatment: 'zero' });
  return (r.status === 400 && JSON.stringify(r.body).includes('消費税免税区分')) || r;
});

// ---- M3-04 一覧の列 ----------------------------------------------------------------
await check('M3-04 一覧が粗利調整販社・支払①・消費税免税区分の呼び名を返す', async () => {
  const r = await listRow(ov.id, `${P}O`);
  const good = r?.gross_margin_adjust_name === '対象' && r.payment_month_offset === 1 && r.payment_day === 99 && r.overseas_tax_label === LABEL[other] && r.overseas_tax_treatment === other;
  return good || r;
});
await check('M3-04 区分が空の海外の取引先はシステム設定の呼び名、国内は null', async () => {
  const a = await listRow(legacy.id, `${P}L`);
  const dom = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}J`, name1: `GA国内${t}`, is_customer: true }), 'domestic');
  const b = await listRow(dom.id, `${P}J`);
  return (a?.overseas_tax_label === LABEL[setting] && b?.overseas_tax_label === null && b?.is_overseas === false) || { a: a?.overseas_tax_label, b: b?.overseas_tax_label };
});

// ---- M3-10・M3-11 追加の項目 -------------------------------------------------------
await check('M3-10・M3-11 粗利調整販社・支払②・入金方法①②・請求書送付方法・メールアドレスが保存され、詳細で返る', async () => {
  const d = ok(await call('GET', `/masters/partners/${ov.id}`, A), 'detail');
  const good = Number(d.gross_margin_adjust_code_id) === TARGET && d.payment_month_offset2 === 2 && d.payment_day2 === 10
    && Number(d.receipt_method1_code_id) === TRANSFER && Number(d.receipt_method2_code_id) === E_REC
    && Number(d.invoice_send_method_code_id) === MAIL && d.invoice_email === 'ga-bill@example.com';
  return good || d;
});
await check('M3-11 支払②は支払①と同じ選択肢だけ（月 0〜6、日 5〜25・99）', async () => {
  const a = await call('PATCH', `/masters/partners/${ov.id}`, A, { payment_day2: 7 });
  const b = await call('PATCH', `/masters/partners/${ov.id}`, A, { payment_month_offset2: 9 });
  const c = await call('PATCH', `/masters/partners/${ov.id}`, A, { payment_month_offset2: 0, payment_day2: 99 });
  const d = await one('select payment_month_offset2, payment_day2 from partners where id = $1', [ov.id]);
  await db.query('update partners set payment_month_offset2 = 2, payment_day2 = 10 where id = $1', [ov.id]);
  return (a.status === 400 && b.status === 400 && c.status === 200 && d.payment_month_offset2 === 0 && d.payment_day2 === 99) || { a: a.status, b: b.status, c: c.status, d };
});
await check('M3-10・M3-11 区分値は決まったカテゴリーの値だけ（入金方法に粗利調整の値は入れられない）', async () => {
  const a = await call('PATCH', `/masters/partners/${ov.id}`, A, { receipt_method1_code_id: TARGET });
  const b = await call('PATCH', `/masters/partners/${ov.id}`, A, { gross_margin_adjust_code_id: MAIL });
  return (a.status === 400 && b.status === 400 && JSON.stringify(a.body).includes('入金方法①')) || { a, b };
});
await check('M3-11 請求書送付先メールアドレスの形を確かめる', async () => {
  const r = await call('PATCH', `/masters/partners/${ov.id}`, A, { invoice_email: 'not-mail' });
  return (r.status === 400 && JSON.stringify(r.body).includes('メールアドレス')) || r;
});
await check('閲覧のみの人は取引先を直せない', async () => {
  const r = await call('PATCH', `/masters/partners/${ov.id}`, V, { invoice_email: 'x@example.com' });
  return r.status === 403 || r.status;
});

// ---- M3-08・M3-09・M3-12 CSV・一覧で編集 -------------------------------------------
const cells = (line) => line.split(',').map((c) => c.replace(/^"|"$/g, '').replace(/^=""(.*)""$/, '$1'));
const exportCsv = async () => {
  const lines = (await raw('/masters/csv/partners/export?include_inactive=true', A)).toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  return { lines, head: cells(lines[0]) };
};
const csvOf = (rows) => '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
const imp = (rows, dry) => call('POST', '/masters/csv/partners/import', A, { content_base64: Buffer.from(csvOf(rows), 'utf8').toString('base64'), dry_run: dry });
await check('M3-08・M3-09 取引先 CSV から通貨・取引先カテゴリー・海外の列を外し、追加の項目の列がある', async () => {
  const { head } = await exportCsv();
  const want = ['消費税免税区分', '粗利調整販社', '支払②の月（何ヶ月後）', '支払②の日', '入金方法①', '入金方法②', '請求書送付方法', '請求書送付先メールアドレス'];
  const gone = ['通貨', '取引先カテゴリーコード', '海外'];
  const missing = want.filter((w) => !head.includes(w));
  const left = gone.filter((g) => head.includes(g));
  return (missing.length === 0 && left.length === 0) || { missing, left };
});
await check('M3-07 CSV の消費税免税区分は呼び名で出し、区分値の欄はコードで出す', async () => {
  const { lines, head } = await exportCsv();
  const row = lines.map(cells).find((x) => x[0] === `${P}O`);
  const v = (h) => row?.[head.indexOf(h)];
  const good = v('消費税免税区分') === LABEL[other] && v('粗利調整販社') === 'TARGET' && v('入金方法①') === 'TRANSFER' && v('請求書送付方法') === 'MAIL' && v('支払②の日') === '10';
  return good || { tax: v('消費税免税区分'), gm: v('粗利調整販社'), rm: v('入金方法①'), sm: v('請求書送付方法') };
});
await check('M3-07 書き出した取引先の行をそのまま取り込むと「変更なし」（往復できる）', async () => {
  const { lines } = await exportCsv();
  const mine = lines.filter((l) => cells(l)[0]?.startsWith(P));
  const r = ok(await call('POST', '/masters/csv/partners/import', A, { content_base64: Buffer.from('﻿' + [lines[0], ...mine].join('\r\n') + '\r\n', 'utf8').toString('base64'), dry_run: true }), 'dry');
  return (r.errors === 0 && r.updated === 0 && r.unchanged === mine.length) || { errors: r.errors, updated: r.updated, rows: r.rows.filter((x) => x.action !== '変更なし') };
});
await check('M3-07 一覧で編集の行は消費税免税区分を呼び名で返し、選べる値も呼び名', async () => {
  const g = ok(await call('GET', `/masters/csv/partners/rows?q=${P}O`, A), 'rows');
  const r = g.items.find((x) => x.partner_code === `${P}O`);
  const col = g.columns.find((c) => c.field === 'overseas_tax_treatment');
  return (r?.overseas_tax_treatment === LABEL[other] && JSON.stringify(col?.options) === JSON.stringify([LABEL.exempt, LABEL.non_taxable])) || { cell: r?.overseas_tax_treatment, col };
});
await check('M3-07・M3-11 CSV 取込：消費税免税区分を呼び名で入れると海外になり、追加の項目も書ける', async () => {
  ok(await imp([['取引先コード', '消費税免税区分', '入金方法②', '支払②の日', '請求書送付先メールアドレス'], [`${P}J`, LABEL[other], 'OTHER', '25', 'ga-j@example.com']], false), 'import');
  const r = await one(
    `select p.is_overseas, p.overseas_tax_treatment, c.code as rm2, p.payment_day2, p.invoice_email
       from partners p left join codes c on c.id = p.receipt_method2_code_id where p.partner_code = $1`, [`${P}J`]);
  return (r.is_overseas === true && r.overseas_tax_treatment === other && r.rm2 === 'OTHER' && r.payment_day2 === 25 && r.invoice_email === 'ga-j@example.com') || r;
});
await check('M3-07 CSV 取込：消費税免税区分を空にすると国内に戻る', async () => {
  ok(await imp([['取引先コード', '消費税免税区分'], [`${P}J`, '']], false), 'import');
  const r = await one('select is_overseas, overseas_tax_treatment from partners where partner_code = $1', [`${P}J`]);
  return (r.is_overseas === false && r.overseas_tax_treatment === null) || r;
});
await check('M3-07 CSV 取込：区分が空の海外の取引先は、ほかの欄だけ直しても海外のまま', async () => {
  ok(await imp([['取引先コード', '消費税免税区分', '略称'], [`${P}L`, '', `GA略L${t}`]], false), 'import');
  const r = await one('select is_overseas, overseas_tax_treatment, short_name from partners where partner_code = $1', [`${P}L`]);
  return (r.is_overseas === true && r.overseas_tax_treatment === null && r.short_name === `GA略L${t}`) || r;
});
await check('M3-07・M3-11 CSV 取込：決まりに合わない消費税免税区分・メールアドレス・支払②は下見で止まる', async () => {
  const r = ok(await imp([['取引先コード', '消費税免税区分', '請求書送付先メールアドレス', '支払②の月（何ヶ月後）'], [`${P}J`, '免税だよ', 'bad', '9']], true), 'dry');
  const msg = r.rows[0]?.message ?? '';
  return (r.errors === 1 && msg.includes('消費税免税区分') && msg.includes('メールアドレス') && msg.includes('支払②の月')) || r.rows;
});

// ---- M3-13 納品先の一覧 ------------------------------------------------------------
const dest = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: ov.id, delivery_code: `${P}D`, name: `GA納品先${t}`, default_warehouse_id: warehouse }), 'dest');
await check('M3-13 納品先の一覧が取引先コードと略称を返し、略称でも探せる', async () => {
  const a = ok(await call('GET', `/masters/delivery-destinations?partner_id=${ov.id}`, A), 'list');
  const b = ok(await call('GET', `/masters/delivery-destinations?q=${encodeURIComponent(`GA略O${t}`)}`, A), 'search');
  const r = a.items.find((x) => x.id === dest.id);
  return (r?.partner_code === `${P}O` && r?.partner_short_name === `GA略O${t}` && b.items.some((x) => x.id === dest.id)) || { r, found: b.items.length };
});

// ---- M3-07 効き目：受注・納品書・請求書・仕入 -----------------------------------------
const freshJan = async () => {
  for (;;) {
    const j = '49' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0');
    if (!(await one('select 1 from skus where jan = $1 or fba_jan = $1 union all select 1 from partner_products where partner_jan = $1', [j]))) return j;
  }
};
const J1 = await freshJan();
const J2 = await freshJan();
const J3 = await freshJan();
const product = ok(await call('POST', '/masters/products', A, { product_code: `${P}`, product_name: `GA商品${t}`, cost_price: '100' }), 'product');
const sku1 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}-0101-100`, jan: J1 }), 'sku1');
const sku2 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}-0102-100`, jan: J2 }), 'sku2');
const rc = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: warehouse, planned_date: today, lines: [{ line_no: 1, sku_id: sku1.id, qty: '20' }] }), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');
const order = ok(await call('POST', '/orders', A, {
  order_type: '卸', partner_id: ov.id, delivery_destination_id: dest.id, sales_category_id: category, order_date: today, ship_date: today,
  lines: [{ line_no: 1, line_type: '商品', sku_id: sku1.id, item_name: 'GA', qty: '2', unit_price: '1000' }],
}), 'order');
await check('M3-07 受注：明細は税率 0、詳細の表記は取引先の消費税免税区分', async () => {
  const d = ok(await call('GET', `/orders/${order.id}`, A), 'order detail');
  return (d.overseas_tax_label === LABEL[other] && d.lines.every((l) => Number(l.tax_rate) === 0)) || { label: d.overseas_tax_label, rates: d.lines.map((l) => l.tax_rate) };
});
await check('M3-07 受注入力：得意先の検索結果に消費税免税区分の呼び名が載る（合計の横の表記に使う）', async () => {
  const r = ok(await call('GET', `/masters/partners?role=customer&q=${encodeURIComponent(`${P}O`)}`, A), 'search');
  return r.items[0]?.overseas_tax_label === LABEL[other] || r.items[0];
});
const sh = await one('select id from shipments where sales_order_id = $1', [order.id]);
await check('M3-07 納品書：消費税の表記は取引先の消費税免税区分（システム設定ではない）', async () => {
  if (!sh) return '出荷が作られていません';
  const txt = pdfText(await raw(`/reports/delivery-notes?shipment_ids=${sh.id}&form=${encodeURIComponent('単価あり')}`, A));
  return (txt.includes(`消費税　${LABEL[other]}`) && !txt.includes(LABEL[setting])) || txt.slice(-300);
});
await check('M3-07 請求書：税率の欄・消費税の表記は取引先の消費税免税区分、消費税 0', async () => {
  if (!sh) return '出荷が作られていません';
  ok(await call('POST', `/shipments/${sh.id}/confirm`, A, { ship_date: today }), 'confirm');
  const inv = ok(await call('POST', '/billing/closings', A, { target_month: month, partner_id: ov.id }), 'closing').invoices[0];
  const s = await one('select sum(tax_amount)::text as tax from invoice_tax_summaries where invoice_id = $1', [inv.id]);
  const txt = pdfText(await raw(`/reports/invoices?invoice_ids=${inv.id}`, A));
  return (txt.includes(LABEL[other]) && !txt.includes(LABEL[setting]) && Number(s.tax) === 0) || { tax: s.tax, txt: txt.slice(0, 300) };
});
await check('M3-07 仕入：海外の仕入先の明細の税区分は、仕入先の消費税免税区分に合う区分（0%）', async () => {
  const p = ok(await call('POST', '/purchases', A, { division: '仕入', supplier_partner_id: ov.id, purchase_date: today, lines: [{ line_no: 1, item_name: 'GA仕入', unit_cost: '100' }] }), 'purchase');
  const l = await one('select l.tax_rate, c.code from purchase_lines l left join codes c on c.id = l.tax_division_code_id where l.purchase_id = $1', [p.id]);
  return (l.code === DIVISION[other] && Number(l.tax_rate) === 0) || l;
});
await check('M3-07 仕入入力の初期値：両方の区分の税区分を返す（画面が仕入先ごとに選ぶ）', async () => {
  const r = ok(await call('GET', '/purchases/overseas-tax-default', A), 'default');
  return (r.treatment === setting && r.by_treatment?.exempt?.tax_division_code === 'EXEMPT' && r.by_treatment?.non_taxable?.tax_division_code === 'NON_TAX') || r;
});

// ---- M3-27 販社CSV取込：照合が JAN の取込先は先方の JAN でも引く ---------------------------
// 先方の JAN（J3）は SKU2 の得意先別商品に登録。J1 はコニーの JAN（SKU1）
ok(await call('POST', '/masters/partner-products', A, { partner_id: ov.id, sku_id: sku2.id, unit_price: '900', partner_jan: J3 }), 'partner product');
const shirahato = (rows) => {
  // 白鳩の書式（29列、列の位置で読む）。1 伝票№ 2 得意先ID 4 納品先CD 16 JANCD 22 下代 23 発注数
  const line = (r) => { const c = Array(29).fill(''); c[0] = r.no; c[1] = r.partner; c[3] = r.dest; c[15] = r.jan; c[21] = r.price; c[22] = r.qty; return c.join(','); };
  return Buffer.from([Array(29).fill('h').join(','), ...rows.map(line)].join('\r\n') + '\r\n', 'utf8').toString('base64');
};
await check('M3-27 白鳩（照合が JAN）：先方の JAN で得意先別商品の SKU、無ければコニーの JAN の SKU', async () => {
  const r = await call('POST', '/imports/partner-orders', A, {
    template_code: 'SHIRAHATO', file_name: `${P}-shirahato.csv`,
    content_base64: shirahato([
      { no: `${P}X1`, partner: `${P}O`, dest: `${P}D`, jan: J3, price: '900', qty: '1' },
      { no: `${P}X1`, partner: `${P}O`, dest: `${P}D`, jan: J1, price: '1000', qty: '1' },
    ]),
  });
  if (r.status >= 300) return `${r.status} ${JSON.stringify(r.body)}`;
  const lines = (await db.query(
    `select el.external_jan, el.sku_id from external_order_lines el join external_orders eo on eo.id = el.external_order_id
      where eo.external_order_no = $1 order by el.line_no`, [`${P}X1`])).rows;
  return (lines.length === 2 && Number(lines[0].sku_id) === Number(sku2.id) && Number(lines[1].sku_id) === Number(sku1.id)) || { lines, sku1: sku1.id, sku2: sku2.id };
});
await check('M3-27 ほかの取引先の先方の JAN では引かない', async () => {
  const r = await call('POST', '/imports/partner-orders', A, {
    template_code: 'SHIRAHATO', file_name: `${P}-shirahato2.csv`,
    content_base64: shirahato([{ no: `${P}X2`, partner: `${P}L`, dest: `${P}D`, jan: J3, price: '900', qty: '1' }]),
  });
  if (r.status >= 300) return `${r.status} ${JSON.stringify(r.body)}`;
  const l = await one(
    `select el.sku_id from external_order_lines el join external_orders eo on eo.id = el.external_order_id where eo.external_order_no = $1`, [`${P}X2`]);
  return (l && l.sku_id === null) || l;
});

await db.end();
process.exit(ng > 0 ? 1 : 0);
