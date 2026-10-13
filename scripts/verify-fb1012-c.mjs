// 2026-10-12 受入テスト T3 の指摘（No.30・32・33・35・37・38）の回帰確認。担当 C。
//   No.33 ロイヤリティの計算の基準（出荷／売上／入金）が効く
//   No.35 販売実績のロイヤリティが月次の計算表と同じ当て方（媒体・端数）になる
//   No.37 他の媒体の販売先は規定に入れられない（D2）／編集で「無効」の規定が増えない（D3）
//   No.32 仕入品目の税率と税区分の食い違いを断る（D10）
//   No.30・No.38 は画面だけの直し（API では確かめられない）
// smoke-backend.ps1 から呼ばれる想定（API・DB は smoke が立てた使い捨て環境）。
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は FC。ロイヤリティの計算に使う月は 2028-01〜2028-05（他の確認と重ならない月）。
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
const login = async (id) => ok(await call('POST', '/auth/login', '', { login_id: id, password: PASS }), 'login').access_token;
const A = await login('admin');
const t = String(Date.now()).slice(-6);
const P = `FC${t}`;

// ---- 準備（接頭辞 FC） --------------------------------------------------------
const brand = ok(await call('POST', '/masters/simple/brands', A, { code: `${P}B`, name: `${P}ブランド` }), 'brand');
const pclass = ok(await call('POST', '/masters/simple/product_classes', A, { code: `${P}C`, name: `${P}分類` }), 'class');
const tv = ok(await call('POST', '/masters/simple/media', A, { code: `${P}TV`, name: `${P}テレビ` }), 'media tv');
const cat = ok(await call('POST', '/masters/simple/media', A, { code: `${P}CT`, name: `${P}カタログ` }), 'media cat');
const partner = async (code, extra) =>
  ok(await call('POST', '/masters/partners', A, { partner_code: `${P}${code}`, name1: `${P}${code}社`, ...extra }), `partner ${code}`);
const PAY1 = await partner('Y1', { is_supplier: true, is_royalty_payee: true });
const PAY2 = await partner('Y2', { is_supplier: true, is_royalty_payee: true });
const PAY3 = await partner('Y3', { is_supplier: true, is_royalty_payee: true });
const T1 = await partner('T1', { is_customer: true, media_id: tv.id, closing_day: 99 });
const T2 = await partner('T2', { is_customer: true, media_id: tv.id, closing_day: 99 });
const T3 = await partner('T3', { is_customer: true, media_id: tv.id, closing_day: 20 });
const K1 = await partner('K1', { is_customer: true, media_id: cat.id, closing_day: 99 });
const K2 = await partner('K2', { is_customer: true, media_id: cat.id, closing_day: 99 });
const N1 = await partner('N1', { is_customer: true, closing_day: 99 }); // 媒体が未設定
const product = async (code) =>
  ok(await call('POST', '/masters/products', A, { product_code: `${P}${code}`, product_name: `${P}商品${code}`, product_class_id: pclass.id, brand_id: brand.id }), `product ${code}`);
const P1 = await product('P1');
const P2 = await product('P2');
const S1 = ok(await call('POST', '/masters/skus', A, { product_id: P1.id, sku_code: `${P}P1-0102-100` }), 'sku1');
const S2 = ok(await call('POST', '/masters/skus', A, { product_id: P2.id, sku_code: `${P}P2-0102-100` }), 'sku2');
const WH = Number((await one(`select id from warehouses where is_active order by id limit 1`)).id);
const SC = Number((await one(`select id from sales_categories where is_active order by id limit 1`)).id);

// 出荷済みの受注を直接作る（ロイヤリティ・締めが見るのは「出荷済の出荷」と受注明細だけ）
let seq = 0;
async function shipped(customer, shipDate, lines) {
  seq++;
  const o = await one(
    `insert into sales_orders (order_no, order_type, partner_id, sales_category_id, order_date, ship_date, status)
     values ($1, '通販', $2, $3, $4, $4, '出荷済') returning id`,
    [`${P}O${seq}`, customer.id, SC, shipDate],
  );
  let n = 0;
  for (const [sku, qty, price] of lines) {
    n++;
    await db.query(
      `insert into sales_order_lines (sales_order_id, line_no, line_type, sku_id, item_name, qty, unit_price, amount, tax_rate)
       values ($1, $2, '商品', $3, $4, $5::numeric, $6::numeric, $5::numeric * $6::numeric, 10)`,
      [o.id, n, sku.id, sku.sku_code, qty, price],
    );
  }
  await db.query(
    `insert into shipments (shipment_no, sales_order_id, warehouse_id, planned_ship_date, ship_date, status, confirmed_at)
     values ($1, $2, $3, $4, $4, '出荷済', now())`,
    [`${P}S${seq}`, o.id, WH, shipDate],
  );
  return o;
}
const rule = (body) => call('POST', '/masters/royalty-rules', A, { brand_id: brand.id, valid_from: '2028-01-01', ...body });
const calc = async (month) => ok(await call('POST', '/billing/royalties/calculate', A, { target_month: month }), `calc ${month}`);
const calcOf = async (month, payee) => {
  const list = ok(await call('GET', `/billing/royalties?target_month=${month}&payee_partner_id=${payee.id}`, A), 'royalties');
  if (list.length === 0) return null;
  return ok(await call('GET', `/billing/royalties/${list[0].id}`, A), 'royalty detail');
};
const n = (v) => Number(v ?? 0);

// ---- No.35 販売実績のロイヤリティ ＝ 月次の計算表（2028-01） --------------------------
// T3 の 2027-09 と同じ形。テレビ5%・カタログ3%（PAY1）、テレビの商品P2 10%＋テレビ3社 2%（PAY2）。
await shipped(T1, '2028-01-10', [[S1, 10, 1000], [S2, 3, 2000]]);
await shipped(T2, '2028-01-12', [[S1, 7, 1500]]);
await shipped(T3, '2028-01-15', [[S2, 3, 3333], [S1, 1, 1000]]);
await shipped(K1, '2028-01-17', [[S2, 4, 2500]]);
await shipped(K2, '2028-01-20', [[S1, 6, 1234]]);
const r1tv = ok(await rule({ payee_partner_id: PAY1.id, media_id: tv.id, rate: '0.0500' }), 'PAY1 tv');
ok(await rule({ payee_partner_id: PAY1.id, media_id: cat.id, rate: '0.0300' }), 'PAY1 cat');
ok(await rule({ payee_partner_id: PAY2.id, media_id: tv.id, product_id: P2.id, brand_id: null, rate: '0.1000' }), 'PAY2 tv P2');
ok(await rule({ payee_partner_id: PAY2.id, media_id: tv.id, rate: '0.0200', customer_mode: '対象', customer_partner_ids: [T1.id, T2.id, T3.id] }), 'PAY2 tv 3社');
await calc('2028-01');

await check('No.35 月次の計算表（2028-01）が媒体どおり: PAY1 2,396円・PAY2 749円', async () => {
  const c1 = await calcOf('2028-01', PAY1);
  const c2 = await calcOf('2028-01', PAY2);
  return (n(c1?.total_amount) === 2396 && n(c2?.total_amount) === 749) || { pay1: c1?.total_amount, pay2: c2?.total_amount };
});
const salesRoyalty = async () => {
  const r = ok(await call('POST', '/analytics/sales', A, {
    from: '2028-01-01', to: '2028-01-31', dimensions: ['取引先'], measures: ['金額', 'ロイヤリティ', '利益'], brand_id: brand.id, limit: 100,
  }), 'analytics');
  return r.rows;
};
await check('No.35 販売実績のロイヤリティが計算表と販売先ごとに一致（媒体を見る・行ごとに切捨て）', async () => {
  const rows = await salesRoyalty();
  const lines = await all(
    `select l.customer_partner_id as id, sum(l.royalty_amount)::numeric as amt
       from royalty_calculation_lines l join royalty_calculations c on c.id = l.royalty_calculation_id
      where c.target_month = '2028-01-01' and l.brand_id = $1 group by 1`, [brand.id]);
  const codeById = { [T1.id]: 'T1', [T2.id]: 'T2', [T3.id]: 'T3', [K1.id]: 'K1', [K2.id]: 'K2' };
  const want = Object.fromEntries(lines.map((l) => [`${P}${codeById[Number(l.id)]}社`, n(l.amt)]));
  const got = Object.fromEntries(rows.map((r) => [r['取引先'], n(r['ロイヤリティ'])]));
  const total = rows.reduce((s, r) => s + n(r['ロイヤリティ']), 0);
  // T1 800+320、T2 525+210、T3 549+219（まとめて切り捨てると 769 になる）、K1 300（PAY2 のテレビ規定は当たらない）、K2 222
  const expect = { T1: 1120, T2: 735, T3: 768, K1: 300, K2: 222 };
  const match = Object.entries(expect).every(([c, v]) => got[`${P}${c}社`] === v && want[`${P}${c}社`] === v);
  return (match && total === 3145) || { got, want, total };
});
await check('No.35 販売実績の利益＝金額−原価−ロイヤリティ（ロイヤリティだけ選んでも同じ値）', async () => {
  const rows = await salesRoyalty();
  const t1 = rows.find((r) => r['取引先'] === `${P}T1社`);
  // 原価は未設定（0）なので 利益 ＝ 金額 − ロイヤリティ
  return (t1 && n(t1['利益']) === n(t1['金額']) - n(t1['ロイヤリティ']) && n(t1['金額']) === 16000) || t1;
});

// ---- No.37 D2 他の媒体の販売先は入れられない ---------------------------------------------
await check('No.37 テレビの規定にカタログの販売先を入れると 400（媒体名つきの案内）', async () => {
  const r = await rule({ payee_partner_id: PAY2.id, media_id: tv.id, rate: '0.0400', customer_mode: '対象', customer_partner_ids: [K1.id], valid_from: '2028-01-02' });
  const msg = JSON.stringify(r.body);
  return (r.status === 400 && msg.includes(`${P}K1社 は媒体『${P}テレビ』の販売先ではありません`) && msg.includes('取引先マスタで媒体を直すか')) || r;
});
await check('No.37 媒体が未設定の販売先も 400', async () => {
  const r = await rule({ payee_partner_id: PAY2.id, media_id: tv.id, rate: '0.0400', customer_mode: '対象外', customer_partner_ids: [N1.id], valid_from: '2028-01-02' });
  return (r.status === 400 && JSON.stringify(r.body).includes(`${P}N1社 は媒体『${P}テレビ』の販売先ではありません`)) || r;
});
await check('No.37 規定の編集でも他の媒体の販売先は 400、同じ媒体なら通る', async () => {
  const list = ok(await call('GET', '/masters/royalty-rules?limit=200', A), 'list').items;
  const g = list.find((x) => x.payee_partner_id === PAY2.id && x.customer_mode === '対象');
  const bad = await call('PATCH', `/masters/royalty-rules/${g.id}`, A, { customer_mode: '対象', customer_partner_ids: [T1.id, K2.id] });
  const good = await call('PATCH', `/masters/royalty-rules/${g.id}`, A, { customer_mode: '対象', customer_partner_ids: [T1.id, T2.id, T3.id] });
  return (bad.status === 400 && good.status === 200) || { bad, good };
});

// ---- No.37 D3 編集で「無効」の規定が増えない --------------------------------------------
const listRules = async (inactive) =>
  ok(await call('GET', `/masters/royalty-rules?limit=200${inactive ? '&include_inactive=true' : ''}`, A), 'list').items.filter((x) => x.payee_partner_id === PAY1.id);
const edited = ok(await call('PATCH', `/masters/royalty-rules/${r1tv.id}`, A, { customer_mode: '対象', customer_partner_ids: [T1.id, T3.id] }), 'edit to 2社');
await check('No.37 計算後に「媒体全体」→「対象 2社」に直しても、一覧は1件のまま（元の行は別の規定として出ない）', async () => {
  const shown = await listRules(false);
  const shownAll = await listRules(true);
  const tvRules = shown.filter((x) => x.media_id === tv.id);
  const old = await one('select is_active, rule_group_id, superseded_at from royalty_rules where id = $1', [r1tv.id]);
  return (
    tvRules.length === 1 && tvRules[0].customer_mode === '対象' && tvRules[0].customer_count === 2 && tvRules[0].history_count === 1 &&
    !shownAll.some((x) => x.id === r1tv.id) && shownAll.filter((x) => x.media_id === tv.id).length === 1 &&
    old.is_active === false && Number(old.rule_group_id) === edited.id && old.superseded_at !== null
  ) || { tvRules, ids: shownAll.map((x) => x.id), old, edited };
});
await check('No.37 編集前の行は「有効に戻す」できない（400）', async () => {
  const r = await call('PATCH', `/masters/royalty-rules/${r1tv.id}`, A, { is_active: true });
  const old = await one('select is_active from royalty_rules where id = $1', [r1tv.id]);
  return (r.status === 400 && old.is_active === false) || { r, old };
});
await check('No.37 使わない → 一覧（使わないものも表示なし）に出ない／表示ありで出る → 有効に戻しても編集前の行は無効のまま', async () => {
  ok(await call('POST', `/masters/royalty-rules/${edited.id}/deactivate`, A), 'deactivate');
  const hidden = !(await listRules(false)).some((x) => x.id === edited.id);
  const inAll = (await listRules(true)).find((x) => x.id === edited.id);
  ok(await call('PATCH', `/masters/royalty-rules/${edited.id}`, A, { is_active: true }), 'reactivate');
  const rows = await all('select id, is_active from royalty_rules where id = $1 or rule_group_id = $1 order by id', [edited.id]);
  const old = rows.find((x) => Number(x.id) === r1tv.id);
  const others = rows.filter((x) => Number(x.id) !== r1tv.id);
  return (hidden && inAll?.is_active === false && old?.is_active === false && others.length === 2 && others.every((x) => x.is_active)) || { hidden, inAll, rows };
});
await check('No.37 直した規定で計算し直すと 2社だけに当たる（PAY1 1,871円）', async () => {
  await calc('2028-01');
  const c1 = await calcOf('2028-01', PAY1);
  return n(c1?.total_amount) === 800 + 549 + 300 + 222 || c1?.total_amount;
});
await check('No.37 「媒体全体」に戻すと元の行を使い直し、外した2社の行は編集前の版になる', async () => {
  const back = ok(await call('PATCH', `/masters/royalty-rules/${edited.id}`, A, { customer_mode: '媒体全体', customer_partner_ids: [] }), 'back');
  const tvRules = (await listRules(true)).filter((x) => x.media_id === tv.id);
  await calc('2028-01');
  const c1 = await calcOf('2028-01', PAY1);
  return (back.id === r1tv.id && tvRules.length === 1 && tvRules[0].id === r1tv.id && tvRules[0].customer_mode === '媒体全体' &&
    tvRules[0].is_active && tvRules[0].history_count === 2 && n(c1?.total_amount) === 2396) || { back, tvRules, total: c1?.total_amount };
});
await check('閲覧者の一覧にも編集前の行は出ない（一覧の件数 total も1件分）', async () => {
  const V = await login('viewer1');
  const r = await call('GET', '/masters/royalty-rules?limit=200&include_inactive=true', V);
  if (r.status === 403) return true; // 閲覧者に規定の閲覧権限が無い構成
  const mine = r.body.items.filter((x) => x.payee_partner_id === PAY1.id);
  return mine.length === 2 || mine;
});

// ---- No.33 計算の基準（出荷／売上／入金） ------------------------------------------------
// PAY3: テレビ 4%（売上）、カタログ 3%（入金）
ok(await rule({ payee_partner_id: PAY3.id, media_id: tv.id, rate: '0.0400', calc_base: '売上', valid_from: '2028-03-01' }), 'PAY3 tv 売上');
ok(await rule({ payee_partner_id: PAY3.id, media_id: cat.id, rate: '0.0300', calc_base: '入金', valid_from: '2028-03-01' }), 'PAY3 cat 入金');
await shipped(T1, '2028-03-10', [[S1, 5, 1000]]); // 末締め → 3月の請求
await shipped(T3, '2028-03-25', [[S1, 10, 1000]]); // 20日締め → 4/20 の請求
await shipped(K1, '2028-03-12', [[S2, 4, 2500]]); // 入金を2回に分けて
await shipped(K2, '2028-03-15', [[S1, 6, 1234]]); // 入金なし
// 返品（3月）。売上基準なら返品を載せた請求の月に差し引く
const ret = await one(
  `insert into returns (return_no, return_type, partner_id, warehouse_id, return_date, return_amount, status)
   values ($1, '販社返品', $2, $3, '2028-03-20', 1000, '受付') returning id`, [`${P}R1`, T1.id, WH]);
await db.query(`insert into return_lines (return_id, line_no, sku_id, qty, unit_price, tax_rate) values ($1, 1, $2, 1, 1000, 10)`, [ret.id, S1.id]);
const close = async (month, p) => ok(await call('POST', '/billing/closings', A, { target_month: month, partner_id: p.id }), `close ${month}`);
const invT1 = (await close('2028-03', T1)).invoices[0];
await close('2028-03', K1);
await close('2028-03', K2);
await close('2028-04', T3);
const invK1 = await one(`select id, current_invoice_amount::numeric as total from invoices where partner_id = $1 and status <> '取消' order by id desc limit 1`, [K1.id]);
const half = (n(invK1.total) / 2).toFixed(2);
ok(await call('POST', '/billing/cash-receipts', A, { partner_id: K1.id, receipt_date: '2028-04-05', amount: half, invoice_id: Number(invK1.id) }), 'receipt 1');
ok(await call('POST', '/billing/cash-receipts', A, { partner_id: K1.id, receipt_date: '2028-05-10', amount: half, invoice_id: Number(invK1.id) }), 'receipt 2');
ok(await call('POST', '/billing/cash-receipts', A, { partner_id: K1.id, receipt_date: '2028-05-20', amount: '1000', invoice_id: Number(invK1.id) }), 'receipt 3 過入金');

await calc('2028-03');
await calc('2028-04');
await calc('2028-05');
await check('No.33 売上基準: 3月に締めた請求の分だけ（T1 5,000×4%−返品 1,000×4% ＝ 160円）。20日締めの T3（3/25 出荷）は入らない', async () => {
  const c = await calcOf('2028-03', PAY3);
  const t1 = c?.lines.filter((l) => l.customer_name === `${P}T1社`) ?? [];
  return (invT1 && n(c?.total_amount) === 160 && t1.length === 2 && c.lines.every((l) => l.calc_base === '売上') &&
    !c.lines.some((l) => l.customer_name === `${P}T3社`) && c.calc_base === '売上') || c;
});
await check('No.33 入金基準: 入金の無い月・入金の無い販売先には付かない（3月に K1・K2 は 0 円）', async () => {
  const c = await calcOf('2028-03', PAY3);
  return !(c?.lines ?? []).some((l) => l.customer_name === `${P}K1社` || l.customer_name === `${P}K2社`) || c.lines;
});
await check('No.33 4月: 売上（T3 4/20 締め 400円）＋入金（K1 半額入金 → 5,000×3% ＝ 150円）を合算して 550円。基準は「売上・入金」', async () => {
  const c = await calcOf('2028-04', PAY3);
  const t3 = c?.lines.find((l) => l.customer_name === `${P}T3社`);
  const k1 = c?.lines.find((l) => l.customer_name === `${P}K1社`);
  return (n(c?.total_amount) === 550 && n(t3?.royalty_amount) === 400 && t3.calc_base === '売上' &&
    n(k1?.royalty_amount) === 150 && n(k1?.base_amount) === 5000 && k1.calc_base === '入金' && c.calc_base === '売上・入金') || c;
});
await check('No.33 5月: 残りの半額の入金で 150円。請求額を超えた入金（過入金）は数えない', async () => {
  const c = await calcOf('2028-05', PAY3);
  const list = ok(await call('GET', `/billing/royalties?target_month=2028-05&payee_partner_id=${PAY3.id}`, A), 'list');
  return (n(c?.total_amount) === 150 && n(c?.total_base_amount) === 5000 && list[0]?.calc_base === '入金') || { c, list };
});
await check('No.33 出荷基準は今までどおり（PAY1 の 3月 = 出荷日が3月の分。返品はマイナス）', async () => {
  const c = await calcOf('2028-03', PAY1);
  // テレビ5%: T1 5,000→250、T3 10,000→500、返品 −50／カタログ3%: K1 300、K2 222
  return (n(c?.total_amount) === 250 + 500 - 50 + 300 + 222 && c.calc_base === '出荷') || c;
});

// ---- No.32 D10 仕入品目の税率と税区分 ------------------------------------------------------
const div = Object.fromEntries((await all(`select c.code, c.id from codes c join code_categories cc on cc.id = c.code_category_id where cc.code = 'TAX_DIVISION'`)).map((r) => [r.code, Number(r.id)]));
await check('No.32 「税率 10%・税区分 非課税」は 400', async () => {
  const r = await call('POST', '/masters/purchase-items', A, { purchase_code: `${P}-PI1`, item_name: `${P}品目1`, new_tax_rate: '10.00', new_tax_class_code_id: div.EXEMPT });
  return (r.status === 400 && JSON.stringify(r.body).includes('税区分「非課税」の税率は 0%')) || r;
});
await check('No.32 税区分だけ選べば税率が決まる（軽減8% → 8.00）', async () => {
  const r = ok(await call('POST', '/masters/purchase-items', A, { purchase_code: `${P}-PI2`, item_name: `${P}品目2`, new_tax_class_code_id: div.TAX8 }), 'create');
  const row = await one('select new_tax_rate::text as rate from purchase_items where id = $1', [r.id]);
  return row.rate === '8.00' || row;
});
await check('No.32 前に食い違って登録したもの: 備考だけの更新は通り、税区分を送ると税率が合う。税率だけ食い違えて送ると 400', async () => {
  const bad = await one(`insert into purchase_items (purchase_code, item_name, new_tax_rate, new_tax_class_code_id) values ($1, $2, 10, $3) returning id`, [`${P}-PI3`, `${P}品目3`, div.NON_TAX]);
  const noteOnly = await call('PATCH', `/masters/purchase-items/${bad.id}`, A, { note: 'メモ' });
  const rateOnly = await call('PATCH', `/masters/purchase-items/${bad.id}`, A, { new_tax_rate: '10.00' });
  const fix = await call('PATCH', `/masters/purchase-items/${bad.id}`, A, { new_tax_rate: '0.00', new_tax_class_code_id: div.NON_TAX });
  const row = await one('select new_tax_rate::text as rate from purchase_items where id = $1', [bad.id]);
  return (noteOnly.status === 200 && rateOnly.status === 400 && fix.status === 200 && row.rate === '0.00') || { noteOnly, rateOnly, fix, row };
});

// 後片付け: 規定は使わないにする（このあと 2028 の月を計算し直したときに、FC の規定が効き続けないように）
for (const p of [PAY1, PAY2, PAY3]) {
  const items = ok(await call('GET', '/masters/royalty-rules?limit=200', A), 'list').items.filter((x) => x.payee_partner_id === p.id);
  for (const it of items) await call('POST', `/masters/royalty-rules/${it.id}/deactivate`, A);
}

await db.end();
process.exit(ng > 0 ? 1 : 0);
