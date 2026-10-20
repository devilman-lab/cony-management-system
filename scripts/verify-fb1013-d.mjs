// 2026-10-13 顧客フィードバック（受注処理編）のうち、帳票と出荷確定・印刷（担当 D）の回帰確認。使い捨ての API・DB に対して流す。
//   O-26 出荷依頼書／O-27 ピッキングリスト／O-28〜O-32 納品書（単価なし・単価あり2・上代あり）／O-10 送料の記載／
//   O-12 委託は単価なし／O-25 出荷確定・印刷の項目と呼び名／O-44 返品／請求書の差出人は会社名だけ
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は HD＋時刻。システム設定は変えない（差出人・既定の様式・端数処理は今の値を読んで確かめる）。
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
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (id) => ok(await call('POST', '/auth/login', '', { login_id: id, password: PASS }), 'login').access_token;

/**
 * PDF の文字をページごとに取り出す。帳票は pdfkit が日本語フォントを埋め込んで作るので、本文は字形番号の16進で書かれている。
 * フォントに付く ToUnicode（字形番号 → 文字）を読み、TJ／Tj の16進を文字に戻す。帳票は欄ごとに文字を置くので、1つの TJ が1つの欄（の1行）。
 * ページの中身（content stream）はページの順に並ぶ。
 */
function pdfPages(buf) {
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
  const pages = [];
  for (const st of streams.filter((x) => !x.includes('begincmap') && /\bBT\b/.test(x) && /\bTf\b/.test(x))) {
    const lines = [];
    for (const t of st.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g)) {
      const hexes = t[1] !== undefined ? [...t[1].matchAll(/<([0-9a-fA-F]+)>/g)].map((y) => y[1]) : [t[2]];
      let out = '';
      for (const h of hexes) for (let i = 0; i + 4 <= h.length; i += 4) out += map.get(parseInt(h.slice(i, i + 4), 16)) ?? '';
      lines.push(out);
    }
    pages.push(lines);
  }
  return pages;
}
const pageCount = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;

const A = await login('admin');
const jst = (days = 0) => new Date(Date.now() + 9 * 3600e3 + days * 864e5).toISOString().slice(0, 10);
const today = jst();
const deliveryDate = jst(2);
const month = today.slice(0, 7);
const slash = (d) => d.replace(/-/g, '/');
const shortDate = (d) => d.split('-').map(Number).join('/');
const yen = (n) => Number(n).toLocaleString('ja-JP', { maximumFractionDigits: 0 });
const t = String(Date.now()).slice(-6);
const P = `HD${t}`;

const timing = (await one("select value_text from system_settings where setting_key = 'ALLOCATION_TIMING'"))?.value_text;
if (timing !== 'manual') {
  console.log(`NG\t引当のタイミングが manual（登録だけ）で流す\t今の設定は ${timing}`);
  await db.end();
  process.exit(1);
}

// ---- 今の設定（変えない） --------------------------------------------------------
const setting = async (key) => ((await one('select value_text from system_settings where setting_key = $1', [key]))?.value_text ?? '').trim();
const S = {
  name: await setting('COMPANY_NAME'),
  postal: await setting('COMPANY_POSTAL_CODE'),
  address: await setting('COMPANY_ADDRESS'),
  address2: await setting('COMPANY_ADDRESS2'),
  tel: await setting('COMPANY_TEL'),
  fax: await setting('COMPANY_FAX'),
  contact: await setting('COMPANY_CONTACT'),
  form: await setting('DELIVERY_NOTE_DEFAULT_FORM'),
  rounding: (await setting('TAX_ROUNDING_MODE')) || 'floor',
};
const round = (v) => (S.rounding === 'ceil' ? Math.ceil(v) : S.rounding === 'round' ? Math.round(v) : Math.floor(v));
const LABEL = { exempt: '免税（税抜扱い）', non_taxable: '課税対象外' };

// ---- 準備（接頭辞 HD） --------------------------------------------------------
const codeId = async (cat, code) =>
  Number((await one('select c.id from codes c join code_categories cc on cc.id = c.code_category_id where cc.code = $1 and c.code = $2', [cat, code])).id);
const DT1416 = await codeId('DELIVERY_TIME', '1416');
const dtName = (await one('select name from codes where id = $1', [DT1416])).name;
const NO_PRICE = await codeId('SLIP_ISSUE_CLASS', 'NO_PRICE');
const category = Number((await one('select id from sales_categories where is_active order by id limit 1')).id);
const [c1, c2] = (await db.query('select id, name from colors where is_active order by id limit 2')).rows;
const [s1, s2] = (await db.query('select id, name from sizes where is_active order by id limit 2')).rows;
const freshJan = async () => {
  for (;;) {
    const j = '49' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0');
    if (!(await one('select 1 from skus where jan = $1 or fba_jan = $1 union all select 1 from partner_products where partner_jan = $1 or shipping_jan = $1', [j]))) return j;
  }
};
const J1 = await freshJan();
const J2 = await freshJan();
const J3 = await freshJan();

const wh = ok(await call('POST', '/masters/warehouses', A, { warehouse_code: `${P}W1`, short_name: `HD出荷倉庫${t}` }), 'warehouse');
const wh2 = ok(await call('POST', '/masters/warehouses', A, { warehouse_code: `${P}W2`, short_name: `HD委託先${t}`, is_consignment: true }), 'consignment warehouse');
const partner = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}C`, name1: `HD得意先${t}`, is_customer: true, closing_day: 99, tel: '06-1111-2222' }), 'partner');
const wi = ok(await call('POST', '/masters/simple/work_instructions', A, { code: `${P}WI`, name: `HD作業指示${t}`, instruction_body: `HD本文${t} 箱に品番を書く` }), 'work instruction');
const d1 = ok(await call('POST', '/masters/delivery-destinations', A, {
  partner_id: partner.id, delivery_code: `${P}D1`, name: `HD納品先${t}`, default_warehouse_id: wh.id, work_instruction_id: wi.id,
  delivery_note_print1: `HD印字1${t}`, delivery_note_print2: `HD印字2${t}`,
  postal_code: '530-0001', address1: '大阪府大阪市北区梅田1-1-1', address2: `HDビル${t}`, tel: '06-3333-4444',
}), 'destination 1');
// 印字1・印字2 が空で、伝票発行分類が「単価なし」の納品先
const d2 = ok(await call('POST', '/masters/delivery-destinations', A, {
  partner_id: partner.id, delivery_code: `${P}D2`, name: `HD納品先2${t}`, default_warehouse_id: wh.id, slip_issue_class_code_id: NO_PRICE,
}), 'destination 2');
const product = ok(await call('POST', '/masters/products', A, { product_code: P, product_name: `HD商品${t}`, cost_price: '300' }), 'product');
const sku1 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}-01`, jan: J1, color_id: Number(c1.id), size_id: Number(s1.id) }), 'sku1');
const sku2 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}-02`, jan: J2, color_id: Number(c2.id), size_id: Number(s2.id) }), 'sku2');
const setProduct = ok(await call('POST', '/masters/products', A, { product_code: `${P}S`, product_name: `HDセット${t}`, is_set: true }), 'set product');
const setSku = ok(await call('POST', '/masters/skus', A, { product_id: setProduct.id, sku_code: `${P}-S1` }), 'set sku');
ok(await call('POST', '/masters/sets', A, { sku_id: setSku.id, components: [{ component_sku_id: sku2.id, qty: '2' }] }), 'set');
// SKU1 の得意先別商品：出荷JAN（J3）と上代 2,400。SKU2 は登録しない（JAN はコニーJAN の J2）
const pp1 = ok(await call('POST', '/masters/partner-products', A, {
  partner_id: partner.id, sku_id: sku1.id, partner_product_code: `${P}A`, unit_price: '1000', retail_price: '2400', shipping_jan: J3,
}), 'partner product');
// 2枚目に続くことの確かめ用（出荷依頼書・納品書は 11 行、ピッキングリストは 20 行の枠）
const many = [];
for (let i = 1; i <= 22; i++) many.push(ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}-M${String(i).padStart(2, '0')}` }), `sku m${i}`));
const rc = ok(await call('POST', '/inventory/receipts', A, {
  warehouse_id: wh.id, planned_date: today, lines: [sku1, sku2, ...many].map((s, i) => ({ line_no: i + 1, sku_id: s.id, qty: '50' })),
}), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');

// 海外の得意先（消費税免税区分あり）と、米ドルの得意先（海外の印なし）
const overseas = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}O`, name1: `HD海外${t}`, is_customer: true, closing_day: 99, overseas_tax_treatment: 'exempt' }), 'overseas');
const dOv = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: overseas.id, delivery_code: `${P}DO`, name: `HD海外納品先${t}`, default_warehouse_id: wh.id }), 'overseas destination');
const usd = ok(await call('POST', '/masters/partners', A, { partner_code: `${P}U`, name1: `HD米ドル${t}`, is_customer: true, closing_day: 99, currency: 'USD' }), 'usd');
const dUsd = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: usd.id, delivery_code: `${P}DU`, name: `HD米ドル納品先${t}`, default_warehouse_id: wh.id }), 'usd destination');

const create = async (body, what) => ok(await call('POST', '/orders', A, body), what);
const shipmentOf = async (orderId) => one(`select id, shipment_no from shipments where sales_order_id = $1 and status <> '削除'`, [orderId]);
/** 登録して引き当て（manual）、出荷の行を返す */
const ready = async (body, what) => {
  const o = await create(body, what);
  const r = ok(await call('POST', `/orders/${o.id}/allocate`, A), `allocate ${what}`);
  const sh = await shipmentOf(o.id);
  if (!sh) throw new Error(`${what}: 引当済にならず出荷ができていません（${JSON.stringify(r)}）`);
  return { order: o, id: Number(sh.id), no: sh.shipment_no };
};
const wholesale = (o) => ({ order_type: '卸', partner_id: partner.id, delivery_destination_id: d1.id, sales_category_id: category, order_date: today, ship_date: today, ...o });
const item = (o) => ({ line_type: '商品', qty: '1', unit_price: '1000', tax_rate: '10.00', ...o });

const getPdf = async (path) => {
  const r = await fetch(B + path, { headers: { authorization: `Bearer ${A}` } });
  const buf = Buffer.from(await r.arrayBuffer());
  if (r.status !== 200) throw new Error(`${path}: ${r.status} ${buf.toString('utf8').slice(0, 300)}`);
  return buf;
};
// 出荷確定して印刷の PDF（pdf-lib でまとめたもの）はページの定義が圧縮されているので、文字のあるページの数で数える
const read = (buf) => { const pages = pdfPages(buf); return { pages, lines: pages.flat().map((l) => l.trim()), count: pageCount(buf) || pages.length }; };
const doc = async (path) => read(await getPdf(path));
const si = (ids) => doc(`/reports/shipping-instructions?shipment_ids=${ids}`);
const pk = (ids) => doc(`/reports/picking-list?shipment_ids=${ids}`);
const dn = (ids, form) => doc(`/reports/delivery-notes?shipment_ids=${ids}${form ? `&form=${encodeURIComponent(form)}` : ''}`);
const missing = (d, texts) => texts.filter((x) => !d.lines.some((l) => l.includes(x)));
const exact = (d, text) => d.lines.includes(text);
/** text の行の次の行（欄は 商品コード → 数量 のように左から順に置く） */
const after = (d, text, n = 1) => { const i = d.lines.indexOf(text); return i < 0 ? undefined : d.lines[i + n]; };
const itemName = async (skuId) => (await one(
  `select fn_item_name(coalesce(nullif(btrim(s.sku_name), ''), p.product_name), cl.name, sz.name) as n
     from skus s join products p on p.id = s.product_id left join colors cl on cl.id = s.color_id left join sizes sz on sz.id = s.size_id
    where s.id = $1`, [skuId])).n;

try {
  // ---- 受注 ------------------------------------------------------------------------
  // S1: 10% と 8% が混ざる・セット（内訳の行つき）・非商品・適用・納品時間・送料の記載（送料調整 800）
  const s1Order = await ready(wholesale({
    delivery_date: deliveryDate, delivery_time_code_id: DT1416, po_no: `HDPO${t}`,
    shipping_remarks: `HD出荷備考${t}`, delivery_note_remarks: `HD納品書備考${t}`,
    print_shipping_fee: true, shipping_fee_adjustment: '800',
    lines: [
      item({ line_no: 1, sku_id: sku1.id, partner_product_id: pp1.id, item_name: `HD品名1${t}`, qty: '2', shipping_note: `HD出荷適用1${t}`, delivery_slip_note: `HD納品適用1${t}` }),
      item({ line_no: 2, sku_id: sku2.id, item_name: `HD品名2${t}`, qty: '3', unit_price: '500', tax_rate: '8.00', shipping_note: `HD出荷適用2${t}` }),
      item({ line_no: 3, line_type: 'セット商品', sku_id: setSku.id, item_name: `HDセット品${t}`, unit_price: '3000' }),
      item({ line_no: 4, line_type: '内訳商品', parent_line_no: 3, sku_id: sku2.id, item_name: `HD内訳${t}`, qty: '2', unit_price: '0' }),
      item({ line_no: 5, line_type: '非商品', item_name: `HD販促チラシ${t}`, unit_price: '0' }),
    ],
  }), 'order 1');
  const S1 = s1Order.id;
  // S2: 直送（お届け先）
  const S2 = (await ready({
    order_type: '直送', partner_id: partner.id, sales_category_id: category, order_date: today, ship_date: today, ship_from_warehouse_id: wh.id,
    direct_name: `HD直送様${t}`, direct_postal_code: '100-0001', direct_address1: '東京都千代田区千代田1-1', direct_tel: '03-0000-0000',
    lines: [item({ line_no: 1, sku_id: sku1.id, item_name: `HD直送品${t}` })],
  }, 'order 2 direct')).id;
  // S3: サンプル（取引先・販売カテゴリーなし）
  const S3 = (await ready({
    order_type: 'サンプル', order_date: today, ship_date: today, ship_from_warehouse_id: wh.id, direct_name: `HDサンプル様${t}`,
    lines: [item({ line_no: 1, sku_id: sku2.id, item_name: `HDサンプル品${t}`, unit_price: '0' })],
  }, 'order 3 sample')).id;
  // S4: 印字1・印字2 が空、伝票発行分類が単価なしの納品先。送料は記載しない（既定）
  const S4 = (await ready(wholesale({ delivery_destination_id: d2.id, lines: [item({ line_no: 1, sku_id: sku1.id, item_name: `HD品名4${t}` })] }), 'order 4')).id;
  // S5: 委託
  const S5 = (await ready(wholesale({ trade_type: '委託', consignment_warehouse_id: wh2.id, lines: [item({ line_no: 1, sku_id: sku1.id, item_name: `HD委託品${t}`, unit_price: '0' })] }), 'order 5 consignment')).id;
  // S6: 返品（正の数で入れるとマイナスで登録される）
  const S6 = (await ready(wholesale({ order_type: '返品', lines: [item({ line_no: 1, sku_id: sku1.id, item_name: `HD返品${t}` })] }), 'order 6 return')).id;
  // S7: 海外の得意先、S8: 米ドルの得意先
  const S7 = (await ready(wholesale({ partner_id: overseas.id, delivery_destination_id: dOv.id, lines: [item({ line_no: 1, sku_id: sku1.id, item_name: `HD海外品${t}`, qty: '2' })] }), 'order 7 overseas')).id;
  const S8 = (await ready(wholesale({ partner_id: usd.id, delivery_destination_id: dUsd.id, lines: [item({ line_no: 1, sku_id: sku1.id, item_name: `HD米ドル品${t}`, qty: '2', unit_price: '12.50' })] }), 'order 8 usd')).id;
  // S9: 送料の記載（送料調整なし＝自動の送料）
  const s9Order = await ready(wholesale({ print_shipping_fee: true, lines: [item({ line_no: 1, sku_id: sku1.id, item_name: `HD送料自動${t}` })] }), 'order 9 auto fee');
  const S9 = s9Order.id;
  // S10: 明細 22 行（2枚目に続く）
  const s10Order = await ready(wholesale({ lines: many.map((s, i) => item({ line_no: i + 1, sku_id: s.id, item_name: `HD多数${t}-${String(i + 1).padStart(2, '0')}`, unit_price: '100' })) }), 'order 10 many');
  const S10 = s10Order.id;

  // ---- O-26 出荷依頼書 ---------------------------------------------------------------
  const r1 = await si(S1);
  await check('O-26 出荷依頼書：題・No.（出荷番号）・依頼日（印刷した日）・押印欄・発注先（出荷倉庫）御中。「出荷指示書」とは書かない', async () => {
    const miss = missing(r1, [s1Order.no, '依頼日', shortDate(today), '梱包', 'セットアップ', 'ピッキング', '発注先', `HD出荷倉庫${t}`, '御中']);
    return (exact(r1, '出荷依頼書') && miss.length === 0 && !r1.lines.some((l) => l.includes('出荷指示書'))) || { miss, title: exact(r1, '出荷依頼書') };
  });
  await check('O-26 出荷依頼書：物品内容の見出し（商品コード・商品名・カラー・サイズ・数量・適用・JAN）と 1〜11 の行番号', async () => {
    const heads = ['【物品内容】', '商品コード', '商品名', 'カラー', 'サイズ', '数量', '適用', 'JAN', '11'].filter((h) => !exact(r1, h));
    return heads.length === 0 || { heads };
  });
  await check('O-26 出荷依頼書：明細は品名・SKU のカラー/サイズ・数量・出荷依頼書適用・JAN（得意先別商品の出荷JAN、無ければコニーJAN）', async () => {
    const miss = missing(r1, [`${P}-01`, `HD品名1${t}`, c1.name, s1.name, `HD出荷適用1${t}`, J3, `${P}-02`, `HD品名2${t}`, c2.name, s2.name, `HD出荷適用2${t}`, J2]);
    const qty = after(r1, `${P}-01`, 4); // 商品コード → 商品名 → カラー → サイズ → 数量
    return (miss.length === 0 && qty === '2' && !r1.lines.includes(J1)) || { miss, qty, j1: r1.lines.includes(J1) };
  });
  await check('O-26 出荷依頼書：セットはセットのまま1行（内訳商品の行は出さない）、非商品の行は出す', async () => {
    return (exact(r1, `HDセット品${t}`) && !r1.lines.some((l) => l.includes(`HD内訳${t}`)) && exact(r1, `HD販促チラシ${t}`)) || r1.lines.filter((l) => l.includes(t));
  });
  await check('O-26 出荷依頼書：出荷先（出庫日・納期と納品時間・入出荷先の納品先コード／得意先名・〒・住所・納品先名・TEL）', async () => {
    const miss = missing(r1, ['【出荷先】', '出庫日', '納期', '入出荷先', slash(today), slash(deliveryDate), dtName, `${P}D1`, `HD得意先${t}`, '〒530-0001', '大阪府大阪市北区梅田1-1-1', `HD納品先${t}`, 'TEL 06-3333-4444']);
    return miss.length === 0 || { miss };
  });
  await check('O-26 出荷依頼書：連絡事項＝納品先の作業指示（名称と本文）、備考＝出荷依頼書備考', async () => {
    const miss = missing(r1, ['連絡事項', `HD作業指示${t}`, `HD本文${t}`, '備考', `HD出荷備考${t}`]);
    return miss.length === 0 || { miss };
  });
  await check('O-26 出荷依頼書：1出荷1枚（2件選ぶと2ページ、それぞれの出荷番号）', async () => {
    const r = await si(`${S1},${S2}`);
    return (r1.count === 1 && r.count === 2 && r.pages[0].includes(s1Order.no) && r.pages[1].some((l) => l.includes(`HD直送様${t}`))) || { one: r1.count, two: r.count };
  });
  await check('O-26 出荷依頼書：12行目からは次の紙に同じ見出しで続く（22行→2ページ）', async () => {
    const r = await si(S10);
    const [p1, p2] = r.pages;
    const good = r.count === 2 && p1.includes('1 / 2') && p2.includes('2 / 2') && p1.includes('商品コード') && p2.includes('商品コード')
      && p2.includes(s10Order.no) && p1.includes(`${P}-M11`) && !p1.includes(`${P}-M12`) && p2.includes(`${P}-M12`) && p2.includes(`${P}-M22`) && p2.includes('22');
    return good || { count: r.count, p1: p1?.filter((l) => l.startsWith(P)).length, p2: p2?.filter((l) => l.startsWith(P)).length };
  });
  await check('O-26 出荷依頼書：直送はお届け先の〒・住所・お名前・電話', async () => {
    const r = await si(S2);
    const miss = missing(r, ['〒100-0001', '東京都千代田区千代田1-1', `HD直送様${t}`, 'TEL 03-0000-0000', `HD得意先${t}`]);
    return miss.length === 0 || { miss };
  });

  // ---- O-27 ピッキングリスト ---------------------------------------------------------
  const p1 = await pk(S1);
  await check('O-27 ピッキングリスト：左上の表（No.・出庫・納期と時間・得意先コード/名/電話・納品先コード/名・住所）と依頼日時', async () => {
    const miss = missing(p1, ['ピッキングリスト', 'No.', '出庫', '納期', '得意先', '電話', '納品先', '住所', s1Order.no, `HD出荷倉庫${t}`, slash(deliveryDate), dtName,
      `${P}C`, `HD得意先${t}`, '06-1111-2222', `${P}D1`, `HD納品先${t}`, '〒530-0001 大阪府大阪市北区梅田1-1-1', '依頼日']);
    const at = p1.lines.some((l) => new RegExp(`^${today} \\d{2}:\\d{2}:\\d{2}$`).test(l));
    return (miss.length === 0 && at) || { miss, at };
  });
  await check('O-27 ピッキングリスト：送り状No.・カートン数の枠は出さない', async () =>
    (!p1.lines.some((l) => l.includes('送り状') || l.includes('カートン'))) || '送り状No.／カートン数が出ている');
  await check('O-27 ピッキングリスト：表（商品名・カラー・サイズ・商品コード・数量・チェック）。セットは構成品に展開して同じ商品を合算（3＋2＝5）、品名は品名の決まり', async () => {
    const heads = ['商品名', 'カラー', 'サイズ', '商品コード', '数量', 'チェック', '20'].filter((h) => !exact(p1, h));
    const n1 = await itemName(sku1.id);
    const n2 = await itemName(sku2.id);
    const q1 = after(p1, `${P}-01`);
    const q2 = after(p1, `${P}-02`);
    const good = heads.length === 0 && exact(p1, n1) && exact(p1, n2) && q1 === '2' && q2 === '5' && !p1.lines.includes(`${P}-S1`);
    return good || { heads, n1: exact(p1, n1), n2: exact(p1, n2), q1, q2 };
  });
  await check('O-27 ピッキングリスト：別途連絡事項＝出荷依頼書備考', async () => {
    const miss = missing(p1, ['別途連絡事項', `HD出荷備考${t}`]);
    return miss.length === 0 || { miss };
  });
  await check('O-27 ピッキングリスト：1出荷1枚（2件選ぶと2ページ）、21行目からは次の紙（22 SKU→2ページ）', async () => {
    const two = await pk(`${S1},${S4}`);
    const r = await pk(S10);
    const [a, b] = r.pages;
    const good = two.count === 2 && r.count === 2 && a.includes(`${P}-M20`) && !a.includes(`${P}-M21`) && b.includes(`${P}-M21`) && b.includes(`${P}-M22`) && b.includes('2 / 2');
    return good || { two: two.count, many: r.count };
  });

  // ---- O-28 納品書（単価なし） --------------------------------------------------------
  const n1 = await dn(S1, '単価なし');
  await check('O-28 納品書：題・作成年月日（印刷した日）・当社納品書No.（出荷番号）・「下記の通り、納品いたします。」', async () => {
    const miss = missing(n1, ['作成年月日', shortDate(today), '当社納品書No.', s1Order.no, '下記の通り、納品いたします。']);
    return (exact(n1, '納品書') && miss.length === 0) || { miss };
  });
  await check('O-32 納品書：宛名は納品書印字1＋御中、納品日｜納品場所は納品書印字2', async () => {
    const miss = missing(n1, ['納品日', slash(deliveryDate), '納品場所']);
    return (exact(n1, `HD印字1${t}　御中`) && exact(n1, `HD印字2${t}`) && miss.length === 0) || { miss, lines: n1.lines.filter((l) => l.includes('印字')) };
  });
  await check('O-28 納品書：差出人の枠はシステム設定（会社名・〒・住所・担当・TEL・FAX）', async () => {
    const want = [S.name, S.postal ? `住所：〒${S.postal}` : `住所：${S.address}`, S.address, S.address2, `担当：${S.contact}`, S.tel ? `TEL：${S.tel}` : '', S.fax ? `FAX：${S.fax}` : ''].filter(Boolean);
    const miss = missing(n1, want);
    return miss.length === 0 || { miss };
  });
  await check('O-28 納品書（単価なし）：列（備考・コード・商品コード・商品名・数量・サイズ・カラー）。備考の列は納品書適用、コードは JAN', async () => {
    const heads = ['備考', 'コード', '商品コード', '商品名', '数量', 'サイズ', 'カラー'].filter((h) => !exact(n1, h));
    const miss = missing(n1, [`HD納品適用1${t}`, J3, `${P}-01`, `HD品名1${t}`, c1.name, s1.name]);
    return (heads.length === 0 && miss.length === 0 && after(n1, `HD品名1${t}`) === '2') || { heads, miss };
  });
  await check('O-28 納品書（単価なし）：合計・単価・送料の行は出さない。セットは1行', async () => {
    const bad = n1.lines.filter((l) => l.includes('合計金額') || l === '送料' || l === '1,000' || l.includes(`HD内訳${t}`));
    return (bad.length === 0 && exact(n1, `HDセット品${t}`)) || { bad };
  });
  await check('O-28 納品書：下の「備考：」の枠＝納品書備考', async () => (exact(n1, '備考：') && exact(n1, `HD納品書備考${t}`)) || n1.lines.slice(-6));

  // ---- O-29 納品書（単価あり2）・O-10 送料 ---------------------------------------------
  const n2 = await dn(S1, '単価あり2');
  // 10%：2,000＋3,000＋0（非商品）＋800（送料）＝5,800、8%：1,500
  // 送料（800）は請求と同じく消費税をかけず、税率ごとの段には入れずに合計へそのまま足す（2026-10-20 受入テスト T4）
  const fee = 800;
  const ex10 = 5000, ex8 = 1500;
  const in10 = ex10 + round(ex10 * 0.1), in8 = ex8 + round(ex8 * 0.08);
  await check('O-29 納品書（単価あり2）：列（先方発注番号・JANコード・商品コード・商品名・数量・単価・金額（税抜））、先方発注番号は受注の先方発注番号', async () => {
    const heads = ['先方発注番号', 'JANコード', '商品コード', '商品名', '数量', '単価', '金額（税抜）'].filter((h) => !exact(n2, h));
    const row = [after(n2, `${P}-01`), after(n2, `${P}-01`, 3), after(n2, `${P}-01`, 4), after(n2, `${P}-01`, 5)];
    return (heads.length === 0 && exact(n2, `HDPO${t}`) && exact(n2, J3) && JSON.stringify(row) === JSON.stringify([`HD品名1${t}`, '2', '1,000', '2,000'])) || { heads, row };
  });
  await check('O-29 納品書（単価あり2）：納品書適用は商品名の下に添える', async () => exact(n2, `HD納品適用1${t}`) || '納品書適用が無い');
  await check('O-29 納品書（単価あり2）：10% と 8% が混ざると 10%対象・8%対象・合計 の段に分けて税抜・税込を出す', async () => {
    const want = ['10%対象', '8%対象', '合計', '合計金額(税抜)', '合計金額(税込)', yen(ex10), yen(in10), yen(ex8), yen(in8), yen(ex10 + ex8 + fee), yen(in10 + in8 + fee)];
    const miss = want.filter((w) => !exact(n2, w));
    return miss.length === 0 || { miss };
  });
  await check('O-10 送料の記載：送料の行（送料調整 800）を足し、合計にも含める', async () => {
    const i = n2.lines.indexOf('送料');
    return (i >= 0 && n2.lines.slice(i + 1, i + 4).join('|') === '1|800|800') || n2.lines.slice(Math.max(0, i - 2), i + 5);
  });
  await check('O-10 送料の記載：送料調整が空なら請求と同じ自動の送料', async () => {
    const fee = (await one('select fn_shipping_fee($1, $2::numeric)::text as f', [partner.id, '1000'])).f;
    const r = await dn(S9, '単価あり2');
    const i = r.lines.indexOf('送料');
    return (i >= 0 && r.lines[i + 2] === yen(fee) && exact(r, yen(1000 + Number(fee)))) || { fee, row: r.lines.slice(i, i + 4) };
  });
  const n4 = await dn(S4, '単価あり2');
  await check('O-29 納品書：税率が1つなら合計は1段、送料の記載なしは送料の行を出さない', async () => {
    const good = exact(n4, '合計金額(税抜)') && exact(n4, '1,000') && exact(n4, yen(1000 + round(100))) && !exact(n4, '10%対象') && !exact(n4, '送料');
    return good || n4.lines.filter((l) => /合計|送料|対象|,/.test(l));
  });
  await check('O-32 納品書：印字1・印字2 が空なら宛名は取引先名＋御中、納品場所は納品先名', async () =>
    (exact(n4, `HD得意先${t}　御中`) && exact(n4, `HD納品先2${t}`)) || n4.lines.filter((l) => l.includes('HD')));

  // ---- O-30 納品書（上代あり） -------------------------------------------------------
  await check('O-30 納品書（上代あり）：列（商品コード・商品名・サイズ・カラー・数量・単価・金額（税抜））、単価は上代、金額は上代×数量、合計は出さない', async () => {
    const r = await dn(S1, '上代あり');
    const heads = ['商品コード', '商品名', 'サイズ', 'カラー', '数量', '単価', '金額（税抜）'].filter((h) => !exact(r, h));
    // 商品コード → 商品名 → 納品書適用（商品名の下）→ サイズ → カラー → 数量 → 単価 → 金額
    const row = [after(r, `${P}-01`), after(r, `${P}-01`, 5), after(r, `${P}-01`, 6), after(r, `${P}-01`, 7)];
    const bad = r.lines.filter((l) => l.includes('合計') || l === '送料' || l === '先方発注番号');
    return (heads.length === 0 && JSON.stringify(row) === JSON.stringify([`HD品名1${t}`, '2', '2,400', '4,800']) && bad.length === 0 && exact(r, `HD納品適用1${t}`)) || { heads, row, bad };
  });

  // ---- O-31 様式 -------------------------------------------------------------------
  await check('O-31 様式に「単価あり」を渡すと単価あり2 で出す', async () => {
    const r = await dn(S1, '単価あり');
    return (exact(r, '先方発注番号') && exact(r, '10%対象') && exact(r, '送料')) || r.lines.slice(0, 30);
  });
  await check('O-31 知らない様式は断る（400）', async () => {
    const r = await fetch(`${B}/reports/delivery-notes?shipment_ids=${S1}&form=xxx`, { headers: { authorization: `Bearer ${A}` } });
    return r.status === 400 || r.status;
  });
  await check('O-31 様式を指定しないときは納品先の伝票発行分類（単価なし）', async () => {
    const r = await dn(S4);
    return (exact(r, 'コード') && exact(r, '備考') && !exact(r, '先方発注番号') && !exact(r, '合計金額(税抜)')) || r.lines.slice(0, 40);
  });

  // ---- O-12 委託 --------------------------------------------------------------------
  await check('O-12 委託の受注は様式を指定しなければ単価なし（指定すればその様式）', async () => {
    const a = await dn(S5);
    const b = await dn(S5, '単価あり2');
    const good = exact(a, 'コード') && !exact(a, '先方発注番号') && exact(b, '先方発注番号');
    return good || { form: S.form, a: a.lines.slice(20, 40), b: exact(b, '先方発注番号') };
  });

  // ---- O-44 返品 --------------------------------------------------------------------
  await check('O-44 返品の納品書は題の横に（返品）、数量・金額はマイナスのまま', async () => {
    const r = await dn(S6, '単価あり2');
    // 数量・金額はマイナス、単価はそのまま
    const row = [after(r, `HD返品${t}`), after(r, `HD返品${t}`, 2), after(r, `HD返品${t}`, 3)];
    const good = exact(r, '（返品）') && JSON.stringify(row) === JSON.stringify(['-1', '1,000', '-1,000']) && exact(r, yen(-1000 + round(-100)));
    return good || { row, lines: r.lines.filter((l) => l.startsWith('-') || l.includes('返品')) };
  });
  await check('O-44 返品の出荷依頼書にも（返品）', async () => exact(await si(S6), '（返品）') || '（返品）が無い');

  // ---- 直送・サンプル（お届け先・取引先なし） -------------------------------------------
  await check('O-32 直送の納品書：宛名はお届け先のお名前＋様、納品場所もお届け先', async () => {
    const r = await dn(S2, '単価あり2');
    return (exact(r, `HD直送様${t}　様`) && exact(r, `HD直送様${t}`)) || r.lines.filter((l) => l.includes('HD'));
  });
  await check('O-14 サンプル（取引先なし）でも出荷依頼書・ピッキングリスト・納品書が出る（宛名はお届け先＋様）', async () => {
    const a = await si(S3);
    const b = await pk(S3);
    const c = await dn(S3, '単価なし');
    return (exact(a, `HDサンプル様${t}`) && exact(b, `HDサンプル様${t}`) && exact(c, `HDサンプル様${t}　様`) && exact(c, `HDサンプル品${t}`)) || { a: exact(a, `HDサンプル様${t}`), b: exact(b, `HDサンプル様${t}`), c: c.lines.filter((l) => l.includes('HD')) };
  });

  // ---- 海外・外貨（今の決まりを残す） ----------------------------------------------------
  await check('O-29 海外の得意先：「合計金額(税込)」は「合計金額」、消費税の扱いを書き、税込＝税抜', async () => {
    const r = await dn(S7, '単価あり2');
    const good = exact(r, '合計金額') && !exact(r, '合計金額(税込)') && exact(r, `消費税　${LABEL.exempt}`) && r.lines.filter((l) => l === '2,000').length >= 3;
    return good || r.lines.filter((l) => /合計|消費税|2,000/.test(l));
  });
  await check('O-29 外貨の受注：金額は小数2桁、合計に通貨を添え、通貨を書く', async () => {
    const r = await dn(S8, '単価あり2');
    const good = exact(r, '12.50') && exact(r, '25.00') && exact(r, 'USD 25.00') && exact(r, 'USD 27.50') && exact(r, '通貨　USD');
    return good || r.lines.filter((l) => /USD|\.\d\d/.test(l));
  });

  // ---- O-25 出荷確定・印刷 ------------------------------------------------------------
  await check('O-25 出荷確定・印刷の一覧：納品日・納品先No.・納品先名・納品時間（取引先が空の行は納品先名にお届け先）', async () => {
    const r = ok(await call('GET', `/shipments?status=${encodeURIComponent('確定済')}&warehouse_id=${wh.id}&limit=100`, A), 'shipments');
    const a = r.items.find((x) => Number(x.id) === S1);
    const b = r.items.find((x) => Number(x.id) === S3);
    const good = a && String(a.delivery_date).slice(0, 10) === deliveryDate && a.delivery_code === `${P}D1` && a.destination_name === `HD納品先${t}` && a.delivery_time_name === dtName
      && b && b.partner_name === null && b.destination_name === `HDサンプル様${t}`;
    return good || { a, b };
  });
  const s11 = await ready(wholesale({ lines: [item({ line_no: 1, sku_id: sku1.id, item_name: `HD同時${t}` })] }), 'order 11');
  const s12 = await ready(wholesale({ lines: [item({ line_no: 1, sku_id: sku1.id, item_name: `HD旧名${t}` })] }), 'order 12');
  await check('O-25 出荷確定して印刷：出荷依頼書・ピッキングリスト・納品書（様式「単価あり」は単価あり2）を1つの PDF で出し、確定する', async () => {
    const r = await fetch(`${B}/reports/confirm-and-print`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${A}` },
      body: JSON.stringify({ shipment_ids: [s11.id], documents: ['出荷依頼書', 'ピッキングリスト', '納品書'], form: '単価あり', include_attachments: false }),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.status !== 200) return `${r.status} ${buf.toString('utf8').slice(0, 300)}`;
    // まとめた PDF は帳票ごとに別の書体の部分集合を持つので、文字は最後の帳票（納品書）だけで見る。3つ出したことは帳票発行履歴で見る
    const d = read(buf);
    const st = await one('select status from shipments where id = $1', [s11.id]);
    const kinds = (await one(`select string_agg(document_type, ',' order by document_type) as k from shipment_documents where shipment_id = $1`, [s11.id])).k;
    const last = d.pages[d.pages.length - 1] ?? [];
    const good = d.count === 3 && st.status === '出荷済' && kinds === ['ピッキングリスト', '出荷指示書', '納品書'].sort().join(',')
      && last.includes('納品書') && last.includes('先方発注番号');
    return good || { count: d.count, st, kinds, last: last.slice(0, 12) };
  });
  await check('O-25 出荷確定して印刷：古い呼び名「出荷指示書」を頼まれても出荷依頼書を出す', async () => {
    const r = await fetch(`${B}/reports/confirm-and-print`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${A}` },
      body: JSON.stringify({ shipment_ids: [s12.id], documents: ['出荷指示書'], include_attachments: false }),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.status !== 200) return `${r.status} ${buf.toString('utf8').slice(0, 300)}`;
    const d = read(buf);
    return (exact(d, '出荷依頼書') && d.count === 1) || d.lines.slice(0, 10);
  });

  // ---- 納品書の繰り越し ----------------------------------------------------------------
  await check('O-28 納品書：12行目からは次の紙に同じ見出しで続く（22行→2ページ）', async () => {
    const r = await dn(S10, '単価なし');
    const [a, b] = r.pages;
    const good = r.count === 2 && a.includes(`${P}-M11`) && !a.includes(`${P}-M12`) && b.includes(`${P}-M12`) && b.includes(`${P}-M22`)
      && b.includes('商品コード') && b.includes('当社納品書No.') && b.includes('2 / 2');
    return good || { count: r.count };
  });

  // ---- 請求書の差出人（9/15 ご回答：会社名だけ） -------------------------------------------
  await check('請求書の差出人は会社名だけ（住所・電話・FAX は出さず、「TEL」だけの行も出ない）', async () => {
    ok(await call('POST', `/shipments/${S4}/confirm`, A, { ship_date: today }), 'confirm S4');
    const inv = ok(await call('POST', '/billing/closings', A, { target_month: month, partner_id: partner.id }), 'closing').invoices?.[0];
    if (!inv) return '請求書ができていません';
    const r = await doc(`/reports/invoices?invoice_ids=${inv.id}`);
    const bad = r.lines.filter((l) => (S.address && l.includes(S.address)) || (S.tel && l.includes(S.tel)) || (S.fax && l.includes(S.fax)) || /^TEL/.test(l));
    return (exact(r, S.name) && bad.length === 0) || { name: exact(r, S.name), bad };
  });
} catch (e) {
  ng++;
  console.log(`NG\t準備（受注の登録・引当）\t${e.message}`);
}

await db.end();
process.exit(ng > 0 ? 1 : 0);
