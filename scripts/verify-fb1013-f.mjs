// 2026-10-13 顧客フィードバック（受注処理編）のうち、取込（O-34・O-36〜O-39）・入出荷履歴（O-40〜O-43）・
// 在庫調整の理由「返品」（O-45）・品名のそろえ（O-01）の回帰確認（担当 F）。使い捨ての API・DB に対して流す。
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は HF。取込テンプレートは初期データ（ビックカメラ・ラベルヴィ・白鳩）をそのまま使う
// （CSV の列の並び・見出しは実際のサンプル CSV と同じ。取引先・納品先・商品のコードだけを HF のものにする）。
// 「+」の列の確かめに作る取込先は、ふだんは使わないにしておく。
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = nodeModule.createRequire(join(here, '..', 'backend', 'package.json'));
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
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (id) => ok(await call('POST', '/auth/login', '', { login_id: id, password: PASS }), 'login').access_token;
const N = (v) => Number(v);

/**
 * 画面の品名の決まり（frontend/src/lib/item-name.ts の composeItemName）を読み込む。
 * TypeScript の型を外して読む（node の型はずしは試験中の注意を出すので、その間だけ黙らせる。出力は OK/NG の行だけにする）。
 */
async function loadComposeItemName() {
  const src = readFileSync(join(here, '..', 'frontend', 'src', 'lib', 'item-name.ts'), 'utf8');
  let js = null;
  const warn = process.emitWarning;
  process.emitWarning = () => {};
  try {
    if (typeof nodeModule.stripTypeScriptTypes === 'function') js = nodeModule.stripTypeScriptTypes(src);
  } catch { js = null; } finally { process.emitWarning = warn; }
  if (!js) {
    js = src
      .replace(/:\s*string\s*\|\s*null\s*\|\s*undefined/g, '')
      .replace(/:\s*string\s*\|\s*null/g, '')
      .replace(/\):\s*string\s*\{/g, ') {');
  }
  return (await import('data:text/javascript,' + encodeURIComponent(js))).composeItemName;
}

/** Shift-JIS（CP932）にする。ビックカメラ・ラベルヴィ・白鳩の取込先は CP932 で読む。表は復号器から逆に作る */
let SJIS = null;
function sjis(text) {
  if (!SJIS) {
    SJIS = new Map();
    const dec = new TextDecoder('shift_jis');
    const add = (bytes) => {
      const ch = dec.decode(Uint8Array.from(bytes));
      if (ch.length === 1 && ch !== '�' && !SJIS.has(ch)) SJIS.set(ch, bytes);
    };
    for (let b = 0xa1; b <= 0xdf; b++) add([b]);
    for (let lead = 0x81; lead <= 0xfc; lead++) {
      if (lead > 0x9f && lead < 0xe0) continue;
      for (let trail = 0x40; trail <= 0xfc; trail++) if (trail !== 0x7f) add([lead, trail]);
    }
  }
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else {
      const b = SJIS.get(ch);
      if (!b) throw new Error(`Shift-JIS にできない文字「${ch}」`);
      out.push(...b);
    }
  }
  return Buffer.from(out);
}
const csvText = (rows) => rows.map((r) => r.map((v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\r\n') + '\r\n';

const A = await login('admin');
const V = await login('viewer1');
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const month = today.slice(0, 7);
const t = String(Date.now()).slice(-6);
const P = `HF${t}`;
const warehouse = Number((await one('select id from warehouses where is_active order by id limit 1')).id);
const timing = (await one("select value_text from system_settings where setting_key = 'ALLOCATION_TIMING'"))?.value_text;
const adminName = (await one("select name from users where login_id = 'admin'")).name;
const freshJan = async () => {
  for (;;) {
    const j = '49' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0');
    if (!(await one('select 1 from skus where jan = $1 or fba_jan = $1 union all select 1 from partner_products where partner_jan = $1', [j]))) return j;
  }
};

// ---- 準備（接頭辞 HF） ----------------------------------------------------------------
const black = ok(await call('POST', '/masters/simple/colors', A, { code: `${P}C1`, name: `${P}ブラック` }), 'color');
const sizeS = ok(await call('POST', '/masters/simple/sizes', A, { code: `${P}Z1`, name: `${P}S` }), 'size S');
const sizeM = ok(await call('POST', '/masters/simple/sizes', A, { code: `${P}Z2`, name: `${P}M` }), 'size M');
const J1 = await freshJan();
const JS1 = await freshJan();
const JS2 = await freshJan();
const p1 = ok(await call('POST', '/masters/products', A, { product_code: `${P}P1`, product_name: `${P}骨盤ショーツ07`, cost_price: '100' }), 'product');
const sku1 = ok(await call('POST', '/masters/skus', A, { product_id: p1.id, sku_code: `${P}P1-0101-100`, color_id: black.id, size_id: sizeS.id, jan: J1 }), 'sku1');
const sku1m = ok(await call('POST', '/masters/skus', A, { product_id: p1.id, sku_code: `${P}P1-0102-100`, color_id: black.id, size_id: sizeM.id }), 'sku1m');
const pSet = ok(await call('POST', '/masters/products', A, { product_code: `${P}PS`, product_name: `${P}骨盤ショーツ07 2枚組`, is_set: true }), 'set product');
const skuSet = ok(await call('POST', '/masters/skus', A, { product_id: pSet.id, sku_code: `${P}PS-0101-200`, color_id: black.id, size_id: sizeS.id }), 'set sku');
const p2 = ok(await call('POST', '/masters/products', A, { product_code: `${P}P2`, product_name: `${P}LUXCEAR Fornez PRO`, cost_price: '100' }), 'product2');
const sku2 = ok(await call('POST', '/masters/skus', A, { product_id: p2.id, sku_code: `${P}P2-0000-100` }), 'sku2');
// 品名（O-01）: 名前＋カラー＋サイズ。セット（2枚組）は組数をカラー・サイズのあとに
const NAME1 = `${P}骨盤ショーツ07 ${P}ブラック ${P}S`;
const NAME1M = `${P}骨盤ショーツ07 ${P}ブラック ${P}M`;
const NAME_SET = `${P}骨盤ショーツ07 ${P}ブラック ${P}S 2枚組`;

const partner = async (k, name) => ok(await call('POST', '/masters/partners', A, { partner_code: `${P}${k}`, name1: `${name}${t}`, is_customer: true }), `partner ${k}`);
const dest = async (p, k) => ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: p.id, delivery_code: `${P}D${k}`, name: `HF納品先${k}${t}`, default_warehouse_id: warehouse }), `dest ${k}`);
const bic = await partner('B', 'HFビックカメラ');
const lbv = await partner('L', 'HFラベルヴィ');
const shr = await partner('S', 'HF白鳩');
const gen = await partner('G', 'HF取込先');
await dest(bic, 'B');
await dest(lbv, 'L');
await dest(shr, 'S');
await dest(gen, 'G');
// 得意先別商品の販売名があれば販売名（＋カラー＋サイズ）が品名になる
ok(await call('POST', '/masters/partner-products', A, { partner_id: bic.id, sku_id: sku2.id, unit_price: '3700', sales_name: `${P}販売名PRO` }), 'pp bic');
// 白鳩は先方の JAN で引く
ok(await call('POST', '/masters/partner-products', A, { partner_id: shr.id, sku_id: skuSet.id, unit_price: '1', partner_jan: JS1 }), 'pp shr1');
ok(await call('POST', '/masters/partner-products', A, { partner_id: shr.id, sku_id: sku1m.id, unit_price: '1', partner_jan: JS2, sales_name: `${P}白鳩販売名 2枚組` }), 'pp shr2');

const importCsv = (template, no, buf, dry = false) =>
  call('POST', '/imports/partner-orders', A, { template_code: template, file_name: `${P}-${no}.csv`, content_base64: buf.toString('base64'), dry_run: dry });
const orderOf = (channel, no) =>
  one(
    `select o.id, o.order_no, o.status, o.po_no, o.shipping_remarks from sales_orders o join external_orders eo on eo.id = o.external_order_id
      where eo.channel = $1 and eo.external_order_no = $2`, [channel, `${P}${no}`]);
const linesOf = (orderId) =>
  all(
    `select l.line_no, l.line_type, l.parent_line_no, l.sku_id, l.item_name, l.qty::text, l.unit_price::text, l.shipping_note, l.delivery_slip_note
       from sales_order_lines l where l.sales_order_id = $1 order by l.line_no`, [orderId]);
const csvNames = (channel, no) =>
  all(
    `select el.line_no, el.item_name from external_order_lines el join external_orders eo on eo.id = el.external_order_id
      where eo.channel = $1 and eo.external_order_no = $2 order by el.line_no`, [channel, `${P}${no}`]);

// ---- O-38・O-39 取込テンプレートの列（⑫で変更済み） ------------------------------------------
await check('O-38・O-39 取込テンプレート：ビックカメラは S列＝先方発注番号＋出荷依頼書適用・Z列＝単価・AA列＝数量・AB列は使わない、ラベルヴィは Q列＝数量・T列＝単価', async () => {
  const cols = await all(
    `select t.template_code, c.column_index, c.target_field from import_template_columns c join import_templates t on t.id = c.import_template_id
      where (t.template_code = 'BIC' and c.column_index in (19, 26, 27, 28)) or (t.template_code = 'LABELLEVIE' and c.column_index in (17, 18, 20))
      order by 1, 2`);
  const m = Object.fromEntries(cols.map((c) => [`${c.template_code}${c.column_index}`, c.target_field]));
  return (m.BIC19 === 'po_no+shipping_note' && m.BIC26 === 'unit_price' && m.BIC27 === 'qty' && m.BIC28 === 'ignore' &&
    m.LABELLEVIE17 === 'qty' && m.LABELLEVIE18 === 'ignore' && m.LABELLEVIE20 === 'unit_price') || m;
});

// ---- O-38 ビックカメラ（36列。実際のサンプル CSV と同じ並び） ----------------------------------
const BIC_HEAD = ['No.', '得意先ID', '得意先名', '納品先ID', '納品先名', '商品コード', '出荷日', '納品日', 'データ種別', '取消フラグ', '法人コード', '発注場所コード', '納品場所コード', 'フロアコード', '発注年月日', '送信年月日', '有効期限年月日', '取引先コード', '発注No', '発注行No', '分納No', 'JANコード', '型番/商品名', '色・規格', '発注数量', '発注時単価', '出荷数量', '出荷時単価', 'お客様着日', '弊社指定納品日', '法人区分', '伝票No', '入荷予定区分／納期回答区分', 'コメント欄', '倉庫出荷日付', '納品予定日'];
const bicRow = (no, sku, po, orderPrice, shipQty, shipPrice, name) => [
  `${P}${no}`, `${P}B`, 'ビックカメラ', `${P}DB`, '船橋TC(850)', sku.sku_code, '20261021', '20261022', '2', '0', '1', '7', '850', '0', '20261020', '', '20261031', '1678',
  po, '1', '1', '4.57349E+12', name, '', String(shipQty), orderPrice, String(shipQty), shipPrice, '', '', '1', '0', '1', '', '', '261022',
];
const bicCsv = sjis(csvText([
  BIC_HEAD,
  bicRow('B1', sku1, '9798538', '5000', 2, '4991', 'CS2426-0000-100 Fornez　AURA'),
  bicRow('B1', sku2, '9798538', '3800', 1, '3773', 'CS2420-0000-100 FornezPRO'),
  bicRow('B2', skuSet, '1680941', '4950', 3, '4900', 'CS2421-0000-100 LUXCEAR　Myuxe'),
]));
await check('O-38 ビックカメラ：試し取込（dry_run）で全行読める（JAN の指数表記は注意だけ）', async () => {
  const r = ok(await importCsv('BIC', 'B-dry', bicCsv, true), 'dry');
  return (r.total_rows === 3 && r.success_rows === 3 && r.error_rows === 0 && r.created_orders === 0 && r.warnings.every((w) => w.includes('指数表記'))) || r;
});
let bicResult = null;
await check('O-38 ビックカメラ：取込で受注になる（manual では引当待ち＝登録だけ。O-06）', async () => {
  bicResult = ok(await importCsv('BIC', 'B', bicCsv), 'import');
  const o1 = await orderOf('BIC', 'B1');
  const o2 = await orderOf('BIC', 'B2');
  const want = timing === 'manual' ? '引当待ち' : null;
  return (bicResult.created_orders === 2 && !!o1 && !!o2 && (!want || (o1.status === want && o2.status === want && bicResult.orders.every((x) => x.status === want)))) || { bicResult, o1, o2, timing };
});
await check('O-38 ビックカメラ：単価は Z列（発注時単価）、数量は AA列（出荷数量）。AB列（出荷時単価）は使わない', async () => {
  const l1 = await linesOf((await orderOf('BIC', 'B1')).id);
  const l2 = await linesOf((await orderOf('BIC', 'B2')).id);
  return (l1.length === 2 && N(l1[0].unit_price) === 5000 && N(l1[0].qty) === 2 && N(l1[1].unit_price) === 3800 && N(l1[1].qty) === 1 &&
    N(l2[0].unit_price) === 4950 && N(l2[0].qty) === 3) || { l1, l2 };
});
await check('O-38 ビックカメラ：S列（発注No）が先方発注番号と、各明細の出荷依頼書適用の両方に入る（「+」の列）', async () => {
  const o1 = await orderOf('BIC', 'B1');
  const o2 = await orderOf('BIC', 'B2');
  const l1 = await linesOf(o1.id);
  const l2 = await linesOf(o2.id);
  return (o1.po_no === '9798538' && o2.po_no === '1680941' && l1.every((l) => l.shipping_note === '9798538') && l2[0].shipping_note === '1680941' &&
    l1.every((l) => l.delivery_slip_note === null)) || { o1, o2, l1, l2 };
});
await check('O-34・O-38 ビックカメラ：品名はマスタの品名（CSV の型番/商品名ではない）。販売名があれば販売名、セットは「名前 カラー サイズ 2枚組」', async () => {
  const l1 = await linesOf((await orderOf('BIC', 'B1')).id);
  const l2 = await linesOf((await orderOf('BIC', 'B2')).id);
  return (l1[0].item_name === NAME1 && l1[1].item_name === `${P}販売名PRO` && l2[0].item_name === NAME_SET) || { l1: l1.map((l) => l.item_name), l2: l2.map((l) => l.item_name) };
});
await check('O-34 CSV の品名は取込の元データ（external_order_lines）にそのまま残る', async () => {
  const n = await csvNames('BIC', 'B1');
  return (n.length === 2 && n[0].item_name === 'CS2426-0000-100 Fornez　AURA' && n[1].item_name === 'CS2420-0000-100 FornezPRO') || n;
});

// ---- O-39 ラベルヴィ（26列） ------------------------------------------------------------
const LBV_HEAD = ['№', '得意先ID', '得意先名', '納品先ID', '納品先名', '', '入荷予定日', '発注番号', '明細番号', 'ブランド名', 'ブランドライン', '商品品番', 'JANCODE', 'アイテム', 'カラー', 'サイズ', '発注セット数', '発注バラ数', '掛率', '卸値(税抜)', 'セール単価(税抜)', 'GLS単価(税込)', '発注金額(税抜)', 'GLSコード', 'メーカーコード', '備考'];
const lbvRow = (lineNo, sku, setQty, baraQty, price, amount) => [
  `${P}L1`, `${P}L`, 'la belle vie', `${P}DL`, '東京ﾍﾞｲ･ﾌｧｯｼｮﾝｱﾘｰﾅ', '2026/10/21', '2026/10/22', '1000547061', String(lineNo), 'ファンクショナリー', 'WOMEN', sku.sku_code,
  '2.00E+12', 'シールドクールパーカー', 'ブラック', 'M', String(setQty), String(baraQty), '60', price, '3564', '4000', amount, '1.76E+13', '4000766253-002', '',
];
const lbvCsv = sjis(csvText([LBV_HEAD, lbvRow(1, sku1, 3, 6, '2100', '6300'), lbvRow(2, sku1m, 1, 2, '600', '600')]));
await check('O-39 ラベルヴィ：試し取込（dry_run）で全行読める', async () => {
  const r = ok(await importCsv('LABELLEVIE', 'L-dry', lbvCsv, true), 'dry');
  return (r.total_rows === 2 && r.success_rows === 2 && r.error_rows === 0) || r;
});
await check('O-39 ラベルヴィ：数量は Q列（発注セット数。R列の発注バラ数ではない）、単価は T列（卸値(税抜)）、先方発注番号は H列', async () => {
  const r = ok(await importCsv('LABELLEVIE', 'L', lbvCsv), 'import');
  const o = await orderOf('LABELLEVIE', 'L1');
  const l = o ? await linesOf(o.id) : [];
  return (r.created_orders === 1 && o.po_no === '1000547061' && l.length === 2 && N(l[0].qty) === 3 && N(l[0].unit_price) === 2100 && N(l[1].qty) === 1 && N(l[1].unit_price) === 600) || { r, o, l };
});
await check('O-34・O-39 ラベルヴィ：品名はマスタの品名（CSV のアイテム「シールドクールパーカー」ではない）', async () => {
  const l = await linesOf((await orderOf('LABELLEVIE', 'L1')).id);
  return (l[0].item_name === NAME1 && l[1].item_name === NAME1M) || l.map((x) => x.item_name);
});

// ---- O-37 白鳩（29列。JAN で引く） --------------------------------------------------------
const SHR_HEAD = ['伝票No', '得意先ID', '得意先名', '納品先CD', '出荷日', '発注区分', '発注番号', '発注日', '発注先CD', '発注担当者名', '入荷依頼日', '摘要', '発注数合計', '発注金額合計', 'JANCD有無', 'JANCD', 'メーカー品番', '白鳩品番', 'カラー名', 'サイズ名', '上代', '下代', '発注数', '発注金額', '備考', '納品有無', '納品数', '納品予定日', 'JANCD'];
const shrRow = (jan, maker, price, qty) => [
  `${P}S1`, `${P}S`, '(株)白鳩', `${P}DS`, '2026/10/21', '2', '2607000395', '2026/10/20', '371', '高柳美乃', '2026/10/22', '', '7', '20970', '1', `${jan} `, maker, 'C71FT1151W', '01ﾌﾞﾗｯｸ', 'L', '6500', price, String(qty), String(N(price) * qty), '', '', '', '2026/10/22', '',
];
await check('O-34・O-37 白鳩：JAN で引いた明細の品名はマスタの品名（メーカー品番「FT1151*2」ではない）。販売名は販売名＋カラー＋サイズ（組数は最後）', async () => {
  const r = ok(await importCsv('SHIRAHATO', 'S', sjis(csvText([SHR_HEAD, shrRow(JS1, 'FT1151*2', '2345', 2), shrRow(JS2, 'FT1181*2', '3456', 5)]))), 'import');
  const o = await orderOf('SHIRAHATO', 'S1');
  const l = o ? await linesOf(o.id) : [];
  return (r.created_orders === 1 && o.po_no === '2607000395' && l.length === 2 && l[0].item_name === NAME_SET && N(l[0].unit_price) === 2345 && N(l[0].qty) === 2 &&
    l[1].item_name === `${P}白鳩販売名 ${P}ブラック ${P}M 2枚組` && N(l[1].unit_price) === 3456 && N(l[1].qty) === 5) || { r, o, l };
});

// ---- 「+」の列（明細の出荷依頼書適用・納品書適用。確かめ用の取込先、ふだんは使わない） ------------------
const tpl = await one(
  `insert into import_templates (template_code, name, import_type, file_encoding, has_header, order_no_source, sku_match_key, default_order_type, is_active, note)
   values ($1, $2, 'PARTNER_ORDER', 'UTF8', true, 'csv', 'sku_code', '卸', false, '回帰確認用（担当F）') returning id`,
  [`${P}T`, `${P}適用の列`],
);
await db.query(
  `insert into import_template_columns (import_template_id, column_index, source_header, target_field, transform, is_required)
   select $1, v.idx, v.hdr, v.fld, v.tr, v.req from (values
     (1, '伝票番号', 'order_no', null, true), (2, '取引先コード', 'partner_code', 'trim', true), (3, '納品先コード', 'delivery_code', 'trim', true),
     (4, '商品コード', 'sku_code', 'trim', true), (5, '数量', 'qty', 'number', true), (6, '単価', 'unit_price', 'number', true),
     (7, '発注番号', 'po_no+shipping_note', 'trim', false), (8, '備考', 'delivery_slip_note+remarks', null, false), (9, '品名', 'ignore', null, false)
   ) as v(idx, hdr, fld, tr, req)`,
  [tpl.id],
);
await check('O-38 取込先の項目を「+」でつなげた列は、同じ値をそれぞれの項目に入れる（先方発注番号＋出荷依頼書適用、納品書適用＋出荷備考。適用は 200 字まで）', async () => {
  await db.query('update import_templates set is_active = true where id = $1', [tpl.id]);
  const long = 'あ'.repeat(210);
  const csv = csvText([
    ['伝票番号', '取引先コード', '納品先コード', '商品コード', '数量', '単価', '発注番号', '備考', '品名'],
    [`${P}G1`, `${P}G`, `${P}DG`, sku1.sku_code, '1', '1000', 'PO-A', 'BIKO-1', 'CSVの品名1'],
    [`${P}G1`, `${P}G`, `${P}DG`, sku2.sku_code, '2', '2000', 'PO-B', long, 'CSVの品名2'],
  ]);
  const r = await importCsv(`${P}T`, 'G', Buffer.from(csv, 'utf8'));
  await db.query('update import_templates set is_active = false where id = $1', [tpl.id]);
  if (r.status >= 300) return `${r.status} ${JSON.stringify(r.body)}`;
  const o = await orderOf(`${P}T`, 'G1');
  const l = o ? await linesOf(o.id) : [];
  return (r.body.created_orders === 1 && o.po_no === 'PO-A' && o.shipping_remarks === 'BIKO-1' && l.length === 2 &&
    l[0].shipping_note === 'PO-A' && l[0].delivery_slip_note === 'BIKO-1' && l[1].shipping_note === 'PO-B' && l[1].delivery_slip_note === long.slice(0, 200) &&
    l[0].item_name === NAME1 && l[1].item_name === `${P}LUXCEAR Fornez PRO`) || { body: r.body, o, l };
});

// ---- O-01・O-34 通販（OMS）CSV：SKU が決まった明細の品名もマスタの品名。セットの親子・送料はそのまま ----------
await check('O-01 通販CSV：商品・セット商品・内訳商品の品名はマスタの品名、セットの親子はそのまま、送料の行は CSV の名前のまま', async () => {
  const route = `${P}通販`;
  const head = ['受注ルート', '受注番号', '注文日', '商品種別', '自社商品コード', '商品コード（助ネコ）', '商品名', '個数', '単価'];
  const day = today.replace(/-/g, '/');
  const csv = '﻿' + csvText([
    head,
    [route, `${P}OMS1`, day, '商品', sku1.sku_code, 'FT1151', `${P}ショップの名前（サイズ:S、カラー:ブラック）`, '1', '1000'],
    [route, `${P}OMS1`, day, 'セット商品', skuSet.sku_code, 'FT1151-200', `${P}ショップのセット 2枚組（カラー:ブラック）`, '1', '2000'],
    [route, `${P}OMS1`, day, '内訳商品', sku1.sku_code, 'FT1151', `${P}ショップの内訳`, '2', '0'],
    [route, `${P}OMS1`, day, '送料', '', '', '送料', '1', '500'],
  ]);
  const r = ok(await call('POST', '/imports/oms-orders', A, { file_name: `${P}-oms.csv`, content_base64: Buffer.from(csv, 'utf8').toString('base64') }), 'oms');
  const o = await one(
    `select o.id from sales_orders o join external_orders eo on eo.id = o.external_order_id where eo.channel = $1 and eo.external_order_no = $2`,
    [route, `${P}OMS1`]);
  const l = o ? await linesOf(o.id) : [];
  const src = await csvNames(route, 'OMS1');
  return (r.created_orders === 1 && l.length === 4 &&
    l[0].line_type === '商品' && l[0].item_name === NAME1 &&
    l[1].line_type === 'セット商品' && l[1].item_name === NAME_SET && l[1].parent_line_no === null &&
    l[2].line_type === '内訳商品' && l[2].item_name === NAME1 && N(l[2].parent_line_no) === 2 &&
    l[3].line_type === '送料' && l[3].item_name === '送料' &&
    src[0]?.item_name === `${P}ショップの名前（サイズ:S、カラー:ブラック）`) || { r, l, src };
});
await check('O-06 通販CSV（これから出荷する受注として取り込む設定）：manual では受注は「引当待ち」（手入力・販社CSVと同じ）。出荷済みの実績として取り込む設定は「出荷済」のまま', async () => {
  // 取込の設定（OMS_IMPORT_MODE）をこの確認の間だけ order にし、終わったら元に戻す
  const prev = (await one("select value_text from system_settings where setting_key = 'OMS_IMPORT_MODE'")).value_text;
  const route = `${P}通販`;
  const csv = '﻿' + csvText([
    ['受注ルート', '受注番号', '注文日', '商品種別', '自社商品コード', '商品名', '個数', '単価'],
    [route, `${P}OMS2`, today.replace(/-/g, '/'), '商品', sku1m.sku_code, `${P}これから出荷`, '1', '1000'],
  ]);
  let r;
  try {
    ok(await call('PATCH', '/masters/settings/OMS_IMPORT_MODE', A, { value_text: 'order' }), 'mode order');
    r = ok(await call('POST', '/imports/oms-orders', A, { file_name: `${P}-oms2.csv`, content_base64: Buffer.from(csv, 'utf8').toString('base64') }), 'oms order');
  } finally {
    await call('PATCH', '/masters/settings/OMS_IMPORT_MODE', A, { value_text: prev });
  }
  const statusOf = async (no) =>
    (await one(`select o.status from sales_orders o join external_orders eo on eo.id = o.external_order_id where eo.channel = $1 and eo.external_order_no = $2`, [route, `${P}${no}`]))?.status;
  const ordered = await statusOf('OMS2');
  const shipped = await statusOf('OMS1');
  const want = timing === 'manual' ? '引当待ち' : null;
  return (r.created_orders === 1 && (!want || ordered === want) && (prev !== 'shipped_result' || shipped === '出荷済')) || { r, ordered, shipped, prev, timing };
});

// ---- O-45 在庫調整の理由「返品」 ----------------------------------------------------------------
await check('O-45 在庫調整の理由の選択肢に「返品」がある（区分値の使うもの）', async () => {
  const r = ok(await call('GET', '/masters/codes/ADJUSTMENT_REASON', A), 'codes');
  return r.values.some((v) => v.code === 'RETURN' && v.name === '返品') || r.values.map((v) => v.code);
});
const rc = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: warehouse, planned_date: today, lines: [{ line_no: 1, sku_id: sku1.id, qty: '10' }] }), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');
const receiptNo = (await one('select receipt_no from receipts where id = $1', [rc.id])).receipt_no;
let adjReturn = null;
await check('O-45 在庫調整：理由「返品」で登録・調整（良品をプラス）できる', async () => {
  adjReturn = ok(await call('POST', '/inventory/adjustments', A, { warehouse_id: warehouse, adjustment_date: today, reason_code: 'RETURN', note: `${P}返品の戻し`, lines: [{ line_no: 1, sku_id: sku1.id, qty: '2' }] }), 'adjust');
  ok(await call('POST', `/inventory/adjustments/${adjReturn.id}/confirm`, A), 'confirm');
  const d = ok(await call('GET', `/inventory/adjustments/${adjReturn.id}`, A), 'detail');
  return (d.reason_code === 'RETURN' && d.reason_name === '返品' && d.status === '確定') || d;
});
const adjOther = ok(await call('POST', '/inventory/adjustments', A, { warehouse_id: warehouse, adjustment_date: today, reason_code: 'OTHER', lines: [{ line_no: 1, sku_id: sku1.id, qty: '-1' }] }), 'adjust other');
ok(await call('POST', `/inventory/adjustments/${adjOther.id}/confirm`, A), 'confirm other');
await check('O-45 在庫調整の CSV 取込：理由「返品」（名前）で読める。下見の品名はマスタの品名', async () => {
  const wh = await one('select short_name from warehouses where id = $1', [warehouse]);
  const csv = '﻿' + csvText([['調整日', '倉庫', '理由', '商品コード', '増減', 'メモ', '備考'], [today.replace(/-/g, '/'), wh.short_name, '返品', sku1.sku_code, '1', '', `${P}CSV`]]);
  const r = ok(await call('POST', '/inventory/adjustments/import', A, { content_base64: Buffer.from(csv, 'utf8').toString('base64'), dry_run: true }), 'import');
  return (r.errors.length === 0 && r.adjustments.length === 1 && r.adjustments[0].reason_name === '返品' && r.adjustments[0].lines[0].item_name === NAME1) || r;
});

// ---- O-40〜O-43 入出荷履歴 ------------------------------------------------------------------
const moves = async (query, token = A) => ok(await call('GET', `/inventory/stocks/movements?${query}`, token), `movements ${query}`);
const enc = encodeURIComponent;
await check('O-41 入出荷履歴：種別を複数で絞れる（movement_types はカンマ区切り）', async () => {
  const both = await moves(`sku_id=${sku1.id}&movement_types=${enc('入荷,棚卸調整')}`);
  const only = await moves(`sku_id=${sku1.id}&movement_types=${enc('入荷')}`);
  const legacy = await moves(`sku_id=${sku1.id}&movement_type=${enc('棚卸調整')}`);
  const types = [...new Set(both.items.map((x) => x.movement_type))].sort();
  return (both.total === 3 && types.join() === ['入荷', '棚卸調整'].sort().join() && only.total === 1 && only.items[0].movement_type === '入荷' && legacy.total === 2) ||
    { both: both.items.map((x) => x.movement_type), only: only.total, legacy: legacy.total };
});
await check('O-41 入出荷履歴：決まっていない種別を渡すと 400', async () => {
  const r = await call('GET', `/inventory/stocks/movements?movement_types=${enc('入荷,ほげ')}`, A);
  return r.status === 400 || r.status;
});
await check('O-40・O-01 入出荷履歴：商品の欄は品名（商品名＋カラー＋サイズ）。カラー・サイズも返す', async () => {
  const r = await moves(`sku_id=${sku1.id}`);
  return (r.total === 3 && r.items.every((x) => x.product_name === NAME1 && x.color_name === `${P}ブラック` && x.size_name === `${P}S`)) || r.items.map((x) => [x.product_name, x.color_name, x.size_name]);
});
await check('O-45 入出荷履歴：理由「返品」の在庫調整は「在庫調整（返品）」と出て、元伝票は調整番号', async () => {
  const r = await moves(`sku_id=${sku1.id}&movement_types=${enc('棚卸調整')}`);
  const ret = r.items.find((x) => x.ref_no === adjReturn.adjustment_no);
  const oth = r.items.find((x) => x.ref_no === adjOther.adjustment_no);
  return (ret?.movement_label === '在庫調整（返品）' && N(ret.qty) === 2 && oth?.movement_label === '在庫調整（その他）') || r.items;
});
await check('O-42 入出荷履歴のキーワード：品名（カラーまで続けて）・商品コード・JAN で引ける', async () => {
  const byName = await moves(`q=${enc(`${P}骨盤ショーツ07 ${P}ブラック ${P}S`)}`);
  const byCode = await moves(`q=${enc(sku1.sku_code)}`);
  const byJan = await moves(`q=${enc(J1)}`);
  return (byName.total === 3 && byCode.total === 3 && byJan.total === 3 && byJan.items.every((x) => x.sku_code === sku1.sku_code)) || { byName: byName.total, byCode: byCode.total, byJan: byJan.total };
});
await check('O-42 入出荷履歴のキーワード：元伝票の番号（入荷番号・調整番号）・担当で引ける', async () => {
  const byReceipt = await moves(`q=${enc(receiptNo)}`);
  const byAdj = await moves(`q=${enc(adjReturn.adjustment_no)}`);
  const byUser = await moves(`sku_id=${sku1.id}&q=${enc(adminName)}`);
  const none = await moves(`sku_id=${sku1.id}&q=${enc(`${P}どれにも当たらない`)}`);
  return (byReceipt.total === 1 && byReceipt.items[0].ref_no === receiptNo && byReceipt.items[0].ref_table === 'receipts' &&
    byAdj.total === 1 && byAdj.items[0].movement_label === '在庫調整（返品）' && byUser.total === 3 && none.total === 0) ||
    { receipt: byReceipt.items, adj: byAdj.total, user: byUser.total, none: none.total };
});
await check('O-41・O-42 入出荷履歴：種別とキーワードを一緒に使える。閲覧者には前・後を返さないまま品名は返す', async () => {
  const r = await moves(`q=${enc(sku1.sku_code)}&movement_types=${enc('入荷,出荷')}`);
  const v = await moves(`sku_id=${sku1.id}`, V);
  return (r.total === 1 && r.items[0].movement_type === '入荷' && v.total === 3 && v.items.every((x) => !('qty_before' in x) && !('qty_after' in x) && x.product_name === NAME1)) ||
    { r: r.items, v: v.items };
});

// ---- O-01 各一覧の品名 ----------------------------------------------------------------------
await check('O-01 在庫表：一覧の品名（item_name）と CSV の商品名は品名', async () => {
  const r = ok(await call('GET', `/inventory/stocks?q=${enc(sku1.sku_code)}&available_only=false`, A), 'stocks');
  const csv = (await raw(`/inventory/stocks/export?q=${enc(sku1.sku_code)}&available_only=false`, A)).toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  const head = csv[0].split(',').map((h) => h.replace(/"/g, ''));
  const row = csv[1]?.split('","').map((v) => v.replace(/^"|"$/g, ''));
  return (r.items.length >= 1 && r.items.every((x) => x.item_name === NAME1) && row?.[head.indexOf('商品名')] === NAME1) || { items: r.items.map((x) => x.item_name), head, row };
});
await check('O-01 在庫表のキーワード：品名（カラー・サイズまで続けて）でも引ける', async () => {
  const r = ok(await call('GET', `/inventory/stocks?q=${enc(NAME1)}&available_only=false`, A), 'stocks');
  return (r.items.length >= 1 && r.items.every((x) => x.sku_id === sku1.id)) || r.items.map((x) => x.sku_code);
});
await check('O-01 入荷・在庫調整の明細の品名', async () => {
  const d1 = ok(await call('GET', `/inventory/receipts/${rc.id}`, A), 'receipt');
  const d2 = ok(await call('GET', `/inventory/adjustments/${adjReturn.id}`, A), 'adjustment');
  const list = ok(await call('GET', '/inventory/adjustments?limit=200', A), 'adjustments').items.find((x) => x.id === adjReturn.id);
  return (d1.lines[0].item_name === NAME1 && d2.lines[0].item_name === NAME1 && list?.lines[0].item_name === NAME1) || { r: d1.lines, a: d2.lines };
});
await check('O-01 返品・再生の明細（検品の画面）の品名', async () => {
  const r = ok(await call('POST', '/returns', A, { return_type: '販社返品', partner_id: bic.id, warehouse_id: warehouse, return_date: today, lines: [{ line_no: 1, sku_id: sku1m.id, qty: '1', unit_price: '1000' }] }), 'return');
  const d = ok(await call('GET', `/returns/${r.id}`, A), 'detail');
  return (d.lines[0].item_name === NAME1M && d.lines[0].color_name === `${P}ブラック` && d.lines[0].size_name === `${P}M`) || d.lines;
});
await check('O-01 引当在庫：明細・CSV・商品の候補の品名（セットは「名前 カラー サイズ 2枚組」）', async () => {
  const g = ok(await call('POST', '/inventory/reservation-groups', A, { period_from: `${month}-01`, period_to: `${month}-28`, partner_id: lbv.id, item_label: `${P}確保`, lines: [{ sku_id: skuSet.id, reserved_qty: '5' }, { sku_id: sku1.id, reserved_qty: '2' }] }), 'group');
  const d = ok(await call('GET', `/inventory/reservation-groups/${g.id}`, A), 'group detail');
  const opt = ok(await call('GET', `/inventory/reservation-groups/sku-options?q=${enc(skuSet.sku_code)}`, A), 'options');
  const csv = (await raw(`/inventory/reservation-groups/export?q=${enc(`${P}確保`)}`, A)).toString('utf8');
  const names = d.lines.map((l) => l.item_name);
  return (names.includes(NAME_SET) && names.includes(NAME1) && opt[0]?.item_name === NAME_SET && csv.includes(`"${NAME_SET}"`) && csv.includes(`"${NAME1}"`)) || { names, opt };
});
await check('O-01 セット登録：一覧の商品名・CSV のセットの商品名と構成品の商品名は品名', async () => {
  ok(await call('POST', '/masters/sets', A, { sku_id: skuSet.id, components: [{ component_sku_id: sku1.id, qty: '2' }] }), 'set');
  const l = ok(await call('GET', `/masters/sets?q=${enc(skuSet.sku_code)}`, A), 'sets').items.find((x) => x.sku_id === skuSet.id);
  const csv = (await raw('/masters/csv/sets/export?include_inactive=true', A)).toString('utf8').split(/\r?\n/).find((x) => x.includes(skuSet.sku_code)) ?? '';
  return (l?.display_name === NAME_SET && csv.includes(`"${NAME_SET}"`) && csv.includes(`"${NAME1}"`)) || { l, csv };
});
await check('O-01 商品マスタの一覧（品番ごとの SKU）の品名', async () => {
  const r = ok(await call('GET', `/masters/products?q=${enc(`${P}P`)}&include_inactive=true`, A), 'products');
  const k = r.items.flatMap((x) => x.skus ?? []);
  const by = Object.fromEntries(k.map((x) => [x.sku_code, x.item_name]));
  return (by[sku1.sku_code] === NAME1 && by[sku1m.sku_code] === NAME1M && by[skuSet.sku_code] === NAME_SET && by[sku2.sku_code] === `${P}LUXCEAR Fornez PRO`) || by;
});
await check('O-01 販売予定の一覧の品名', async () => {
  ok(await call('POST', '/sales-schedules', A, { sku_id: sku1m.id, planned_sales_month: month, planned_qty: '3', note: `${P}予定` }), 'schedule');
  const r = ok(await call('GET', `/sales-schedules?sku_id=${sku1m.id}`, A), 'schedules');
  return (r.items.length === 1 && r.items[0].item_name === NAME1M) || r.items;
});

// ---- O-01 品名の決まりは、データベース（fn_item_name）と画面（composeItemName）で同じ ----------------
await check('O-01 品名の決まり：fn_item_name と composeItemName が同じ結果になる', async () => {
  const compose = await loadComposeItemName();
  const cases = [
    ['骨盤ショーツ07', 'ﾌﾞﾗｯｸ', 'S'],
    ['骨盤ショーツ07 2枚組', 'ﾌﾞﾗｯｸ', 'S'],
    ['骨盤ショーツ07　3個セット', 'ブラック', 'M'],
    ['骨盤ショーツ07 ２枚組', 'ブラック', 'LL'],
    ['骨盤スリムショーツ イージーストレッチ 3枚組', 'アッシュグレー', 'LL'],
    ['販売名 ブラック S', 'ブラック', 'S'],
    ['販売名 ブラック S 2枚組', 'ブラック', 'S'],
    ['LUXCEAR Fornez (ﾙｸｾｱ ﾌｫｰﾈｽ) PRO', null, null],
    ['セット2枚組', 'ブラック', 'S'],
    ['ショーツ 10入り', 'ブラック', null],
    ['  前後に空白  ', ' ブラック ', ' S '],
    ['', 'ブラック', 'S'],
    [null, null, null],
  ];
  const diff = [];
  for (const [b, c, s] of cases) {
    const sqlName = (await one('select fn_item_name($1, $2, $3) as n', [b, c, s])).n;
    const jsName = compose(b, c, s);
    if (sqlName !== jsName) diff.push({ base: b, color: c, size: s, sql: sqlName, js: jsName });
  }
  const sample = compose('骨盤ショーツ07 2枚組', 'ﾌﾞﾗｯｸ', 'S');
  return (diff.length === 0 && sample === '骨盤ショーツ07 ﾌﾞﾗｯｸ S 2枚組') || { diff, sample };
});

await db.end();
process.exit(ng > 0 ? 1 : 0);
