// 2026-10-16 フィードバック（マスター編_3）ロイヤリティ規定 M3-32〜M3-37 の回帰確認。担当 D。
//   M3-32 計算の基準は請求月（中の値は売上）に統一。新しい規定の既定は売上、計算表・一覧の表示は「請求月」
//   M3-33 1つの規定で「対象の商品」「対象外の商品」を複数選べる。対象外の商品はその商品について必ず勝つ
//   M3-34 「全て対象」の規定と「この商品は対象外」だけの規定を両方作ると、商品の対象外が優先される
//   M3-36 一覧は販売先の指定・対象・対象外の商品を返す（画面で短く出し、押すと明細）
//   M3-37 コピー（同じ中身の新しい規定を登録できる。同じ範囲・同じ開始日は 409）
//   計算後の編集（編集前の版）・使わない・確定後の編集・販売実績との一致
//   M3-35 は画面の文言だけ（API では確かめられない）
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は GD＋時刻。ロイヤリティの計算・確定に使う月は 2029-07〜2029-12 だけ（ここでは 2029-07・2029-08）。
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
async function text(path, token) {
  const r = await fetch(B + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, text: Buffer.from(await r.arrayBuffer()).toString('utf8') };
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (id) => ok(await call('POST', '/auth/login', '', { login_id: id, password: PASS }), 'login').access_token;
const A = await login('admin');
const t = String(Date.now()).slice(-6);
const P = `GD${t}`;
const n = (v) => Number(v ?? 0);
const MONTH = '2029-07';

// ---- 準備（接頭辞 GD） --------------------------------------------------------
const brand = ok(await call('POST', '/masters/simple/brands', A, { code: `${P}B`, name: `${P}芦屋` }), 'brand');
const brand2 = ok(await call('POST', '/masters/simple/brands', A, { code: `${P}B2`, name: `${P}別ブランド` }), 'brand2');
const pclass = ok(await call('POST', '/masters/simple/product_classes', A, { code: `${P}C`, name: `${P}分類` }), 'class');
const net = ok(await call('POST', '/masters/simple/media', A, { code: `${P}N`, name: `${P}ネット` }), 'media');
const partner = async (code, extra) =>
  ok(await call('POST', '/masters/partners', A, { partner_code: `${P}${code}`, name1: `${P}${code}社`, ...extra }), `partner ${code}`);
const payee = (code) => partner(code, { is_supplier: true, is_royalty_payee: true });
const PAY = {};
for (const k of ['Y1', 'Y2', 'Y3', 'Y4', 'Y5', 'Y6', 'Y7']) PAY[k] = await payee(k);
const C1 = await partner('C1', { is_customer: true, media_id: net.id, closing_day: 99 });
const C2 = await partner('C2', { is_customer: true, media_id: net.id, closing_day: 99 });
const C3 = await partner('C3', { is_customer: true, media_id: net.id, closing_day: 99 });
const product = async (code, brandId = brand.id) =>
  ok(await call('POST', '/masters/products', A, { product_code: `${P}${code}`, product_name: `${P}商品${code}`, product_class_id: pclass.id, brand_id: brandId }), `product ${code}`);
const PA = await product('A');
const PB = await product('B');
const PC = await product('C');
const PX = await product('X', brand2.id);
const sku = async (p, code) => ok(await call('POST', '/masters/skus', A, { product_id: p.id, sku_code: `${P}${code}-0102-100` }), `sku ${code}`);
const SA = await sku(PA, 'A');
const SB = await sku(PB, 'B');
const SC = await sku(PC, 'C');
const WH = Number((await one(`select id from warehouses where is_active order by id limit 1`)).id);
const SCAT = Number((await one(`select id from sales_categories where is_active order by id limit 1`)).id);

// 出荷済みの受注を直接作る（ロイヤリティ・締めが見るのは「出荷済の出荷」と受注明細だけ）
let seq = 0;
async function shipped(customer, shipDate, lines) {
  seq++;
  const o = await one(
    `insert into sales_orders (order_no, order_type, partner_id, sales_category_id, order_date, ship_date, status)
     values ($1, '通販', $2, $3, $4, $4, '出荷済') returning id`,
    [`${P}O${seq}`, customer.id, SCAT, shipDate],
  );
  let ln = 0;
  for (const [s, qty, price] of lines) {
    ln++;
    await db.query(
      `insert into sales_order_lines (sales_order_id, line_no, line_type, sku_id, item_name, qty, unit_price, amount, tax_rate)
       values ($1, $2, '商品', $3, $4, $5::numeric, $6::numeric, $5::numeric * $6::numeric, 10)`,
      [o.id, ln, s.id, s.sku_code, qty, price],
    );
  }
  await db.query(
    `insert into shipments (shipment_no, sales_order_id, warehouse_id, planned_ship_date, ship_date, status, confirmed_at)
     values ($1, $2, $3, $4, $4, '出荷済', now())`,
    [`${P}S${seq}`, o.id, WH, shipDate],
  );
  return o;
}
// 規定。媒体ネット・ブランド芦屋。計算の基準は送らない（既定が請求月＝売上であることも確かめる）
const rule = (body) => call('POST', '/masters/royalty-rules', A, { media_id: net.id, brand_id: brand.id, valid_from: '2029-01-01', ...body });
const calc = async (month) => ok(await call('POST', '/billing/royalties/calculate', A, { target_month: month }), `calc ${month}`);
const calcOf = async (month, p) => {
  const list = ok(await call('GET', `/billing/royalties?target_month=${month}&payee_partner_id=${p.id}`, A), 'royalties');
  if (list.length === 0) return null;
  return ok(await call('GET', `/billing/royalties/${list[0].id}`, A), 'royalty detail');
};
const listRules = async (p, inactive = false) =>
  ok(await call('GET', `/masters/royalty-rules?limit=200${inactive ? '&include_inactive=true' : ''}`, A), 'list').items.filter((x) => x.payee_partner_id === p.id);
/** 計算表の明細を「販売先:商品 → 金額」に */
const byCustSku = (c) => {
  const m = {};
  for (const l of c?.lines ?? []) {
    const k = `${l.customer_name.replace(P, '').replace('社', '')}:${l.sku_code.replace(P, '').replace('-0102-100', '')}`;
    m[k] = (m[k] ?? 0) + n(l.royalty_amount);
  }
  return m;
};
const same = (got, want) => {
  const keys = new Set([...Object.keys(got), ...Object.keys(want)]);
  return [...keys].every((k) => (got[k] ?? 0) === (want[k] ?? 0));
};

// 7月の出荷（すべて末締め → 7月の請求に載る）
//   C1: A 10×1,000=10,000　B 5×2,000=10,000　C 2×3,000=6,000
//   C2: A 4×1,500=6,000　　C 1×5,000=5,000
//   C3: A 2×2,500=5,000　　B 1×4,000=4,000　C 3×1,000=3,000
await shipped(C1, `${MONTH}-05`, [[SA, 10, 1000], [SB, 5, 2000], [SC, 2, 3000]]);
await shipped(C2, `${MONTH}-10`, [[SA, 4, 1500], [SC, 1, 5000]]);
await shipped(C3, `${MONTH}-15`, [[SA, 2, 2500], [SB, 1, 4000], [SC, 3, 1000]]);

// ---- 規定 ----------------------------------------------------------------------------
// Y1: 媒体全体 5%、対象外の商品 A
const r1 = ok(await rule({ payee_partner_id: PAY.Y1.id, rate: '0.0500', excluded_product_ids: [PA.id] }), 'Y1');
// Y2: 媒体全体 5%（別の規定）＋ 販売先 C1・C2 を対象 6%、対象外の商品 A
ok(await rule({ payee_partner_id: PAY.Y2.id, rate: '0.0500' }), 'Y2 all');
const r2 = ok(await rule({ payee_partner_id: PAY.Y2.id, rate: '0.0600', customer_mode: '対象', customer_partner_ids: [C1.id, C2.id], excluded_product_ids: [PA.id] }), 'Y2 2社');
// Y3: C3 を対象外にして 4%、対象外の商品 B
const r3 = ok(await rule({ payee_partner_id: PAY.Y3.id, rate: '0.0400', customer_mode: '対象外', customer_partner_ids: [C3.id], excluded_product_ids: [PB.id] }), 'Y3');
// Y4: 対象の商品 A・B（複数）3%
const r4 = ok(await rule({ payee_partner_id: PAY.Y4.id, rate: '0.0300', product_ids: [PA.id, PB.id] }), 'Y4');
// Y5: ①全て対象 2% ②商品 C は対象外（料率なし。媒体全体を対象外にする商品。M3-34）
ok(await rule({ payee_partner_id: PAY.Y5.id, rate: '0.0200' }), 'Y5 all');
const r5b = ok(await rule({ payee_partner_id: PAY.Y5.id, excluded_product_ids: [PC.id] }), 'Y5 excl C');

const closeMonth = async (p) => ok(await call('POST', '/billing/closings', A, { target_month: MONTH, partner_id: p.id }), `close ${p.partner_code}`);
for (const c of [C1, C2, C3]) await closeMonth(c);
await calc(MONTH);

// ---- M3-32 計算の基準 ----------------------------------------------------------------
await check('M3-32 計算の基準を送らずに作った規定は「売上」（請求月）。まとまりの全行も売上', async () => {
  const rows = await all(`select calc_base from royalty_rules where payee_partner_id = any($1::bigint[])`, [[PAY.Y1.id, PAY.Y2.id, PAY.Y3.id, PAY.Y4.id, PAY.Y5.id]]);
  return (rows.length >= 10 && rows.every((r) => r.calc_base === '売上')) || rows;
});
await check('M3-32 計算表の一覧・明細の「基準」は「請求月」', async () => {
  const list = ok(await call('GET', `/billing/royalties?target_month=${MONTH}&payee_partner_id=${PAY.Y1.id}`, A), 'list');
  const c = await calcOf(MONTH, PAY.Y1);
  return (list[0]?.calc_base === '請求月' && c.calc_base === '請求月' && c.lines.length > 0 && c.lines.every((l) => l.calc_base === '請求月')) || { list, c };
});
await check('M3-32 規定の一覧の基準は「売上」（画面で「請求月」と出す）', async () => {
  const it = (await listRules(PAY.Y1))[0];
  return it?.calc_base === '売上' || it;
});

// ---- M3-33 対象外の商品・対象の商品（手計算） ------------------------------------------
await check('M3-33 Y1 媒体全体 5%・対象外の商品 A: A は 0、B・C は 5%（合計 1,400円）', async () => {
  const c = await calcOf(MONTH, PAY.Y1);
  const want = { 'C1:B': 500, 'C1:C': 300, 'C2:C': 250, 'C3:B': 200, 'C3:C': 150 };
  return (same(byCustSku(c), want) && n(c.total_amount) === 1400) || byCustSku(c);
});
await check('M3-33 Y2 販売先2社を対象 6%＋対象外の商品 A: 2社の A は 0、ほかは 6%。C3 は別の規定の 5%（合計 1,860円）', async () => {
  const c = await calcOf(MONTH, PAY.Y2);
  const want = { 'C1:B': 600, 'C1:C': 360, 'C2:C': 300, 'C3:A': 250, 'C3:B': 200, 'C3:C': 150 };
  return (same(byCustSku(c), want) && n(c.total_amount) === 1860) || byCustSku(c);
});
await check('M3-33 Y3 C3 を対象外 4%＋対象外の商品 B: C3 は 0、B は 0（合計 1,080円）', async () => {
  const c = await calcOf(MONTH, PAY.Y3);
  const want = { 'C1:A': 400, 'C1:C': 240, 'C2:A': 240, 'C2:C': 200 };
  return (same(byCustSku(c), want) && n(c.total_amount) === 1080) || byCustSku(c);
});
await check('M3-33 Y4 対象の商品 A・B（複数選択）3%: C は 0（合計 1,050円）', async () => {
  const c = await calcOf(MONTH, PAY.Y4);
  const want = { 'C1:A': 300, 'C1:B': 300, 'C2:A': 180, 'C3:A': 150, 'C3:B': 120 };
  return (same(byCustSku(c), want) && n(c.total_amount) === 1050) || byCustSku(c);
});
await check('M3-34 Y5 ①全て対象 2% ②商品 C だけ対象外（料率なし）: C は 0、ほかは 2%（合計 700円）', async () => {
  const c = await calcOf(MONTH, PAY.Y5);
  const want = { 'C1:A': 200, 'C1:B': 200, 'C2:A': 120, 'C3:A': 100, 'C3:B': 80 };
  return (same(byCustSku(c), want) && n(c.total_amount) === 700) || byCustSku(c);
});
await check('M3-33 行の作り方: Y2 の2社は「販売先×商品」の対象外の行（優先度 1+4+2=7）、Y1 は「商品」の対象外の行（1+2=3）', async () => {
  const g2 = await all(`select customer_partner_id::int c, product_id::int p, is_excluded e, scope_priority s from royalty_rules where id = $1 or rule_group_id = $1 order by id`, [r2.id]);
  const g1 = await all(`select customer_partner_id::int c, product_id::int p, is_excluded e, scope_priority s from royalty_rules where id = $1 or rule_group_id = $1 order by id`, [r1.id]);
  const ex2 = g2.filter((r) => r.e);
  const ex1 = g1.filter((r) => r.e);
  return (ex2.length === 2 && ex2.every((r) => r.p === Number(PA.id) && r.s === 7) && g2.filter((r) => !r.e).every((r) => r.s === 5) &&
    ex1.length === 1 && ex1[0].c === null && ex1[0].p === Number(PA.id) && ex1[0].s === 3) || { g1, g2 };
});

// ---- 販売実績（analytics）と一致 -----------------------------------------------------
await check('M3-33 販売実績のロイヤリティが計算表と販売先ごとに一致（同じ当て方）', async () => {
  const r = ok(await call('POST', '/analytics/sales', A, {
    from: `${MONTH}-01`, to: `${MONTH}-31`, dimensions: ['取引先'], measures: ['金額', 'ロイヤリティ'], brand_id: brand.id, limit: 100,
  }), 'analytics');
  const got = Object.fromEntries(r.rows.map((x) => [x['取引先'], n(x['ロイヤリティ'])]));
  // ほかの支払先の規定（媒体が空欄の古い規定など）も当たり得るので、この月の計算表の全支払先の明細と比べる
  const lines = await all(
    `select cp.name1 as name, sum(l.royalty_amount)::numeric as amt
       from royalty_calculation_lines l join royalty_calculations c on c.id = l.royalty_calculation_id
       join partners cp on cp.id = l.customer_partner_id
      where c.target_month = $1::date and l.brand_id = $2 group by 1`, [`${MONTH}-01`, brand.id]);
  const want = Object.fromEntries(lines.map((l) => [l.name, n(l.amt)]));
  // GD の支払先の分だけなら C1 3,400・C2 1,290・C3 1,400
  const mine = await all(
    `select cp.name1 as name, sum(l.royalty_amount)::numeric as amt
       from royalty_calculation_lines l join royalty_calculations c on c.id = l.royalty_calculation_id
       join partners cp on cp.id = l.customer_partner_id
      where c.target_month = $1::date and c.payee_partner_id = any($2::bigint[]) group by 1`,
    [`${MONTH}-01`, [PAY.Y1.id, PAY.Y2.id, PAY.Y3.id, PAY.Y4.id, PAY.Y5.id]]);
  const m = Object.fromEntries(mine.map((l) => [l.name, n(l.amt)]));
  return (same(got, want) && m[`${P}C1社`] === 3400 && m[`${P}C2社`] === 1290 && m[`${P}C3社`] === 1400) || { got, want, m };
});

// ---- M3-36 一覧 -----------------------------------------------------------------------
await check('M3-36 一覧は1件にまとめ、販売先の指定・対象の販売先・対象／対象外の商品を返す', async () => {
  const y1 = (await listRules(PAY.Y1))[0];
  const y2 = (await listRules(PAY.Y2)).find((x) => x.id === r2.id);
  const y3 = (await listRules(PAY.Y3))[0];
  const y4 = (await listRules(PAY.Y4))[0];
  const y5 = (await listRules(PAY.Y5)).find((x) => x.id === r5b.id);
  const ids = (xs) => xs.map((x) => x.id).sort().join(',');
  return (
    (await listRules(PAY.Y1)).length === 1 &&
    y1.customer_mode === '媒体全体' && ids(y1.excluded_products) === String(PA.id) && y1.products.length === 0 && y1.excluded_products[0].code === `${P}A` &&
    y2.customer_mode === '対象' && y2.customer_count === 2 && ids(y2.customers) === [C1.id, C2.id].sort().join(',') && ids(y2.excluded_products) === String(PA.id) &&
    y3.customer_mode === '対象外' && ids(y3.customers) === String(C3.id) && ids(y3.excluded_products) === String(PB.id) &&
    y4.customer_mode === '媒体全体' && ids(y4.products) === [PA.id, PB.id].sort().join(',') && y4.excluded_products.length === 0 &&
    y5.customer_mode === '媒体全体' && y5.rate === null && ids(y5.excluded_products) === String(PC.id)
  ) || { y1, y2, y3, y4, y5 };
});
await check('M3-33 CSV 書き出しに「対象外の商品コード」が出る', async () => {
  const r = await text('/masters/csv/royalty-rules/export?include_inactive=true', A);
  const head = r.text.replace(/^﻿/, '').split('\r\n')[0];
  const row = r.text.split('\r\n').find((l) => l.includes(`${P}Y1`));
  return (r.status === 200 && head.includes('対象外の商品コード') && row?.includes(`${P}A`) && row?.includes('請求月')) || { head, row };
});

// ---- 検査 ---------------------------------------------------------------------------
await check('M3-33 対象の商品と対象外の商品を両方選ぶと 400', async () => {
  const r = await rule({ payee_partner_id: PAY.Y6.id, rate: '0.0100', product_ids: [PA.id], excluded_product_ids: [PB.id] });
  return (r.status === 400 && JSON.stringify(r.body).includes('対象外の商品')) || r;
});
await check('M3-33 ブランドの違う商品を選ぶと 400（計算で当たらないため）', async () => {
  const r = await rule({ payee_partner_id: PAY.Y6.id, rate: '0.0100', excluded_product_ids: [PX.id] });
  return (r.status === 400 && JSON.stringify(r.body).includes(`${P}商品X はブランド『${P}芦屋』の商品ではありません`)) || r;
});
await check('M3-33 料率なしで「対象」の販売先は 400、料率も対象外の商品もない媒体全体も 400', async () => {
  const a = await rule({ payee_partner_id: PAY.Y6.id, customer_mode: '対象', customer_partner_ids: [C1.id], excluded_product_ids: [PA.id] });
  const b = await rule({ payee_partner_id: PAY.Y6.id });
  return (a.status === 400 && b.status === 400) || { a, b };
});
await check('M3-33 同じ商品を対象外に2回入れると 400', async () => {
  const r = await rule({ payee_partner_id: PAY.Y6.id, rate: '0.0100', excluded_product_ids: [PA.id, PA.id] });
  return r.status === 400 || r;
});
await check('昔の API の使い方（商品1件の product_id）はそのまま1行で作れる', async () => {
  const r = ok(await rule({ payee_partner_id: PAY.Y6.id, rate: '0.0100', product_id: PC.id, valid_from: '2029-12-01' }), 'legacy');
  const it = (await listRules(PAY.Y6)).find((x) => x.id === r.id);
  return (r.product_id === PC.id && r.calc_base === '売上' && it?.products?.[0]?.id === PC.id && it.row_count === 1) || { r, it };
});
await check('料率なしの「対象外」（販売先 C3 と商品 B を対象外）は対象外の行だけで作り、読み戻しても同じ', async () => {
  const r = ok(await rule({ payee_partner_id: PAY.Y7.id, customer_mode: '対象外', customer_partner_ids: [C3.id], excluded_product_ids: [PB.id], valid_from: '2029-12-01' }), 'Y7');
  const rows = await all(`select is_excluded, rate from royalty_rules where id = $1 or rule_group_id = $1`, [r.id]);
  const it = (await listRules(PAY.Y7)).find((x) => x.id === r.id);
  return (rows.length === 2 && rows.every((x) => x.is_excluded && x.rate === null) && it.customer_mode === '対象外' &&
    it.customers[0]?.id === C3.id && it.excluded_products[0]?.id === PB.id) || { rows, it };
});

// ---- M3-37 コピー -------------------------------------------------------------------
await check('M3-37 コピー: 同じ中身・同じ適用開始日は 409、適用開始日を変えれば対象外の商品ごと新しい規定になる', async () => {
  const src = (await listRules(PAY.Y1))[0];
  const body = {
    payee_partner_id: src.payee_partner_id, media_id: src.media_id, brand_id: src.brand_id, rate: src.rate,
    customer_mode: src.customer_mode, customer_partner_ids: src.customers.map((c) => c.id),
    product_ids: src.products.map((p) => p.id), excluded_product_ids: src.excluded_products.map((p) => p.id), calc_base: '売上',
  };
  const dup = await call('POST', '/masters/royalty-rules', A, { ...body, valid_from: src.valid_from.slice(0, 10) });
  const cp = ok(await call('POST', '/masters/royalty-rules', A, { ...body, valid_from: '2029-12-01', rate: '0.0700' }), 'copy');
  const items = await listRules(PAY.Y1);
  const copied = items.find((x) => x.id === cp.id);
  return (dup.status === 409 && items.length === 2 && copied.excluded_products[0]?.id === PA.id && copied.rate === '0.0700' && cp.id !== src.id) || { dup, items };
});

// ---- 計算後の編集・使わない・確定 ------------------------------------------------------
await check('計算後の編集: Y2 の2社を C1 だけにすると、計算に使った C2 の行は編集前の版で残り、対象外の行は消える', async () => {
  const r = ok(await call('PATCH', `/masters/royalty-rules/${r2.id}`, A, { customer_mode: '対象', customer_partner_ids: [C1.id] }), 'edit');
  const it = (await listRules(PAY.Y2)).find((x) => x.id === r2.id);
  const rows = await all(`select customer_partner_id::int c, product_id::int p, is_excluded e, is_active a, superseded_at is not null h from royalty_rules where id = $1 or rule_group_id = $1 order by id`, [r2.id]);
  const hist = rows.filter((x) => x.h);
  return (r.id === r2.id && it.customer_count === 1 && it.customers[0].id === C1.id && it.history_count === 1 && ids1(it.excluded_products) === String(PA.id) &&
    hist.length === 1 && hist[0].c === Number(C2.id) && !hist[0].a && !rows.some((x) => x.c === Number(C2.id) && x.e) && (await listRules(PAY.Y2)).length === 2) || { it, rows };
});
function ids1(xs) { return xs.map((x) => x.id).join(','); }
await check('計算後の編集: 計算し直すと C2 は別の規定の 5%（A 300・C 250）、C1 の A は対象外のまま', async () => {
  await calc(MONTH);
  const c = await calcOf(MONTH, PAY.Y2);
  const want = { 'C1:B': 600, 'C1:C': 360, 'C2:A': 300, 'C2:C': 250, 'C3:A': 250, 'C3:B': 200, 'C3:C': 150 };
  return same(byCustSku(c), want) || byCustSku(c);
});
await check('計算後の編集: 2社に戻すと編集前の版の行を使い直す（旧版 0、C2 の A は対象外に戻る）', async () => {
  ok(await call('PATCH', `/masters/royalty-rules/${r2.id}`, A, { customer_mode: '対象', customer_partner_ids: [C1.id, C2.id] }), 'back');
  const it = (await listRules(PAY.Y2)).find((x) => x.id === r2.id);
  await calc(MONTH);
  const c = await calcOf(MONTH, PAY.Y2);
  return (it.customer_count === 2 && (it.history_count ?? 0) === 0 && n(c.total_amount) === 1860) || { it, m: byCustSku(c) };
});
await check('計算後の編集: Y1 の対象外の商品を A → B に替えると、A は 5%・B は 0 になる（合計 1,750円）', async () => {
  ok(await call('PATCH', `/masters/royalty-rules/${r1.id}`, A, { excluded_product_ids: [PB.id] }), 'edit');
  const it = (await listRules(PAY.Y1)).find((x) => x.id === r1.id);
  await calc(MONTH);
  const c = await calcOf(MONTH, PAY.Y1);
  const want = { 'C1:A': 500, 'C1:C': 300, 'C2:A': 300, 'C2:C': 250, 'C3:A': 250, 'C3:C': 150 };
  return (ids1(it.excluded_products) === String(PB.id) && same(byCustSku(c), want) && n(c.total_amount) === 1750) || { it, m: byCustSku(c) };
});
await check('使わない: 編集画面の「非表示」（中身と is_active=false を一緒に送る）でまとまりの全行が止まり、計算に入らない', async () => {
  const src = (await listRules(PAY.Y3))[0];
  ok(await call('PATCH', `/masters/royalty-rules/${r3.id}`, A, {
    payee_partner_id: src.payee_partner_id, media_id: src.media_id, brand_id: src.brand_id, rate: src.rate, valid_from: src.valid_from.slice(0, 10),
    customer_mode: src.customer_mode, customer_partner_ids: src.customers.map((c) => c.id), product_ids: [], excluded_product_ids: [PB.id], calc_base: '売上', is_active: false,
  }), 'hide');
  const rows = await all(`select is_active from royalty_rules where id = $1 or rule_group_id = $1`, [r3.id]);
  await calc(MONTH);
  const c = await calcOf(MONTH, PAY.Y3);
  return (rows.length === 3 && rows.every((x) => !x.is_active) && n(c?.total_amount) === 0 && (await listRules(PAY.Y3)).length === 0) || { rows, c };
});
await check('使わない: 非表示の規定を中身だけ直しても（is_active を送らない）非表示のまま。表示に戻すと元の金額', async () => {
  ok(await call('PATCH', `/masters/royalty-rules/${r3.id}`, A, { note: `${P}メモ` }), 'note');
  const rows = await all(`select is_active from royalty_rules where id = $1 or rule_group_id = $1`, [r3.id]);
  ok(await call('PATCH', `/masters/royalty-rules/${r3.id}`, A, { is_active: true }), 'show');
  await calc(MONTH);
  const c = await calcOf(MONTH, PAY.Y3);
  return (rows.every((x) => !x.is_active) && n(c.total_amount) === 1080) || { rows, c };
});
await check('確定した月は、あとで規定を直しても金額が動かない（Y4 を確定 → 料率 10% に直して計算し直す）', async () => {
  const c0 = await calcOf(MONTH, PAY.Y4);
  ok(await call('POST', `/billing/royalties/${c0.id}/confirm`, A), 'confirm');
  ok(await call('PATCH', `/masters/royalty-rules/${r4.id}`, A, { rate: '0.1000' }), 'edit rate');
  const res = await calc(MONTH);
  const c1 = await calcOf(MONTH, PAY.Y4);
  return (n(c1.total_amount) === 1050 && c1.status === '確定' && res.skipped_confirmed.includes(`${P}Y4社`)) || { c1, res };
});
await check('閲覧者は規定を作れない（403）', async () => {
  const V = await login('viewer1');
  const r = await call('POST', '/masters/royalty-rules', V, { payee_partner_id: PAY.Y6.id, media_id: net.id, rate: '0.0100', valid_from: '2029-11-01' });
  return r.status === 403 || r;
});

// 後片付け: 規定は使わないにする（このあと 2029 の月を計算し直したときに、GD の規定が効き続けないように）
for (const p of Object.values(PAY)) {
  for (const it of await listRules(p)) await call('POST', `/masters/royalty-rules/${it.id}/deactivate`, A);
}

await db.end();
if (ng > 0) process.exitCode = 1;
