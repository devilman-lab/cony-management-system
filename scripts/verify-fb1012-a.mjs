// 2026-10-12 受入テスト T1（No.2・No.3・No.6・No.8）の回帰確認。担当 A（マスタの一覧で編集・CSV）。
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は FA（＋時刻）。
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
  return { status: r.status, text: await r.text() };
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (id, pass = PASS) => ok(await call('POST', '/auth/login', '', { login_id: id, password: pass }), 'login').access_token;
const A = await login('admin');
const V = await login('viewer1');
const t = String(Date.now()).slice(-6);
const P = `FA${t}`;

/** CSV を作って取り込む（dry=true で下見） */
const csvOf = (rows) => '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
const imp = (slug, rows, dry, token = A) =>
  call('POST', `/masters/csv/${slug}/import`, token, { content_base64: Buffer.from(csvOf(rows), 'utf8').toString('base64'), dry_run: dry });
const rowOf = (res, line) => res.body?.rows?.find((r) => r.line === line);

// ---- 準備 ------------------------------------------------------------------
const cat1 = ok(await call('POST', '/masters/simple/partner_categories', A, { code: `${P}C1`, name: `${P}テレビ` }), 'cat1');
const cat2 = ok(await call('POST', '/masters/simple/partner_categories', A, { code: `${P}C2`, name: `${P}カタログ` }), 'cat2');
const partner = ok(await call('POST', '/masters/partners', A, {
  partner_code: `${P}P1`, name1: `${P}取引先1`, is_customer: true, category_ids: [Number(cat1.id), Number(cat2.id)],
}), 'partner');
const linksOf = async (pid) => (await all(`select c.code from partner_category_links l join partner_categories c on c.id = l.partner_category_id where l.partner_id = $1 order by c.code`, [pid])).map((r) => r.code);

// ---- 1. 複数カテゴリー（No.8・No.2） ------------------------------------------
await check('No.8 一覧で編集の取引先カテゴリーコードに全カテゴリーが「、」区切りで出る', async () => {
  const r = ok(await call('GET', `/masters/csv/partners/rows?q=${P}P1`, A), 'rows');
  const it = r.items.find((x) => x.partner_code === `${P}P1`);
  const col = r.columns.find((c) => c.field === 'partner_category_id');
  return (it?.partner_category_id === `${P}C1、${P}C2` && col?.multi === true) || { it, col };
});
await check('No.8・D-7 CSV 書き出しでカテゴリーは全コードを1欄に、コードは ="..." で囲む', async () => {
  const r = await text('/masters/csv/partners/export', A);
  const line = r.text.split('\r\n').find((l) => l.includes(`${P}P1`)) ?? '';
  return (line.startsWith(`"=""${P}P1"""`) && line.includes(`"=""${P}C1、${P}C2"""`)) || line;
});
await check('No.8 CSV 取込（| 区切り）でカテゴリーを入れ替え、代表もそろう', async () => {
  ok(await imp('partners', [['取引先コード', '取引先カテゴリーコード'], [`${P}P1`, `${P}C2|${P}C1`]], false), 'import');
  const p = await one(`select partner_category_id from partners where id = $1`, [partner.id]);
  const links = await linksOf(partner.id);
  return (Number(p.partner_category_id) === Number(cat2.id) && links.join() === `${P}C1,${P}C2`) || { p, links };
});
await check('No.8 一覧で編集（取込の経路）で1つに減らすと links も1つになる', async () => {
  ok(await imp('partners', [['取引先コード', '取引先カテゴリーコード'], [`${P}P1`, `${P}C1`]], false), 'import');
  const p = await one(`select partner_category_id from partners where id = $1`, [partner.id]);
  const links = await linksOf(partner.id);
  return (Number(p.partner_category_id) === Number(cat1.id) && links.join() === `${P}C1`) || { p, links };
});
await check('No.8 CSV で新しく作った取引先も links に入る', async () => {
  ok(await imp('partners', [['取引先コード', '取引先名', '得意先', '取引先カテゴリーコード'], [`${P}P2`, `${P}取引先2`, '有効', `${P}C1、${P}C2`]], false), 'import');
  const p = await one(`select id, partner_category_id from partners where partner_code = $1`, [`${P}P2`]);
  const links = p ? await linksOf(p.id) : [];
  return (p && Number(p.partner_category_id) === Number(cat1.id) && links.join() === `${P}C1,${P}C2`) || { p, links };
});
await check('No.8 存在しないカテゴリーコードは下見で行・欄つきの誤り', async () => {
  const r = ok(await imp('partners', [['取引先コード', '取引先カテゴリーコード'], [`${P}P1`, `${P}C1、${P}XX`]], true), 'dry');
  const row = rowOf({ body: r }, 2);
  return (row?.action === 'エラー' && row.message.includes('取引先カテゴリーコード：') && row.message.includes(`${P}XX`)) || row;
});
await check('No.8 そのまま取り込むと「変更なし」（カテゴリー2つでも）', async () => {
  const r = ok(await imp('partners', [['取引先コード', '取引先カテゴリーコード'], [`${P}P2`, `${P}C1、${P}C2`]], true), 'dry');
  return (r.unchanged === 1 && r.updated === 0) || r.rows;
});
await check('No.8 API でカテゴリーだけ直すと代表も先頭にそろう', async () => {
  ok(await call('PATCH', `/masters/partners/${partner.id}`, A, { category_ids: [Number(cat2.id)] }), 'patch');
  const p = await one(`select partner_category_id from partners where id = $1`, [partner.id]);
  return Number(p.partner_category_id) === Number(cat2.id) || p;
});

// ---- 2. 範囲外の値（No.2・No.6） ---------------------------------------------
await check('No.6 一覧で編集・CSV：支払月 7・99、支払日 7、締め日 31 は下見で止まる', async () => {
  const r = ok(await imp('partners', [
    ['取引先コード', '支払月（何ヶ月後）', '支払日', '締め日'],
    [`${P}P1`, '7', '', ''],
    [`${P}P2`, '99', '7', '31'],
  ], true), 'dry');
  const a = rowOf({ body: r }, 2), b = rowOf({ body: r }, 3);
  return (a?.action === 'エラー' && a.message.includes('支払月（何ヶ月後）：') && b?.action === 'エラー' && b.message.includes('支払日：') && b.message.includes('締め日：')) || r.rows;
});
await check('No.6 一覧で編集の保存（確定）も 400 で行と欄が分かる', async () => {
  const r = await imp('partners', [['取引先コード', '支払月（何ヶ月後）'], [`${P}P1`, '99']], false);
  return (r.status === 400 && String(r.body.message).includes('2行目') && String(r.body.message).includes('支払月（何ヶ月後）')) || r;
});
await check('No.6 6か月後・末日（99）は CSV で入る', async () => {
  ok(await imp('partners', [['取引先コード', '支払月（何ヶ月後）', '支払日', '締め日'], [`${P}P1`, '6', '99', '20']], false), 'import');
  const p = await one(`select payment_month_offset, payment_day, closing_day from partners where id = $1`, [partner.id]);
  return (p.payment_month_offset === 6 && p.payment_day === 99 && p.closing_day === 20) || p;
});
await check('No.6 API も支払月 7・支払日 12・締め日 31 を 400 で断る', async () => {
  const a = await call('PATCH', `/masters/partners/${partner.id}`, A, { payment_month_offset: 7 });
  const b = await call('PATCH', `/masters/partners/${partner.id}`, A, { payment_day: 12 });
  const c = await call('PATCH', `/masters/partners/${partner.id}`, A, { closing_day: 31 });
  const d = await call('PATCH', `/masters/partners/${partner.id}`, A, { payment_month_offset: 0, payment_day: 5, closing_day: 99 });
  return (a.status === 400 && b.status === 400 && c.status === 400 && d.status === 200) || [a.status, b.status, c.status, d.status];
});
await check('No.2 取引区分「売上」・税率 5 は下見で止まる', async () => {
  const r = ok(await imp('partners', [['取引先コード', '取引区分'], [`${P}P1`, '売上']], true), 'dry');
  const row = rowOf({ body: r }, 2);
  return (row?.action === 'エラー' && row.message.includes('取引区分：')) || row;
});

// ---- 3. CSV の穴（D-2・D-3・D-4・D-7） -----------------------------------------
// D-2：更新・印刷だけの役割（作成・削除なし）
const role = await one(`insert into roles (code, name, sort_order) values ($1, $2, 999) returning id`, [`${P}R`, `${P}CSVだけ`]);
await db.query(
  `insert into role_permissions (role_id, permission_id)
   select $1, id from permissions where function_id in ('M-01', 'M-16') and action in ('view', 'print', 'update')`,
  [role.id],
);
const csvPass = `FaPass${t}xyz!`;
const user = ok(await call('POST', '/admin/users', A, { login_id: `${P}u`, name: `${P}利用者`, password: csvPass, role_ids: [Number(role.id)] }), 'user');
const U = await login(`${P}u`, csvPass);
await check('D-2 作成の権限が無いと、CSV の新しい行は下見で行ごとの誤り（確定も 400）', async () => {
  const rows = [['取引先コード', '取引先名', '得意先'], [`${P}P9`, `${P}作れない`, '有効'], [`${P}P1`, `${P}取引先1改`, '有効']];
  const d = ok(await imp('partners', rows, true, U), 'dry');
  const c = await imp('partners', rows, false, U);
  const made = await one(`select count(*)::int n from partners where partner_code = $1`, [`${P}P9`]);
  const row = rowOf({ body: d }, 2);
  return (row?.action === 'エラー' && row.message.includes('作成') && rowOf({ body: d }, 3)?.action === '変更' && c.status === 400 && made.n === 0) || { row, c: c.status, made };
});
await check('D-2 削除の権限が無いと、有効→無効は下見で誤り（DB は有効のまま）', async () => {
  const d = ok(await imp('partners', [['取引先コード', '有効'], [`${P}P2`, '無効']], true, U), 'dry');
  const c = await imp('partners', [['取引先コード', '有効'], [`${P}P2`, '無効']], false, U);
  const p = await one(`select is_active from partners where partner_code = $1`, [`${P}P2`]);
  const row = rowOf({ body: d }, 2);
  return (row?.action === 'エラー' && row.message.includes('使わない') && c.status === 400 && p.is_active === true) || { row, c: c.status, p };
});
await check('D-2 分類（作業指示）でも作成の権限が無いと追加できない', async () => {
  const d = ok(await imp('work-instructions', [['コード', '名称', '指示内容'], [`${P}W9`, `${P}作れない`, '']], true, U), 'dry');
  return (rowOf({ body: d }, 2)?.action === 'エラー') || d.rows;
});
await check('D-2 管理者なら追加・無効化できる', async () => {
  const d = ok(await imp('partners', [['取引先コード', '有効'], [`${P}P2`, '無効']], true), 'dry');
  return (d.errors === 0 && d.updated === 1) || d.rows;
});

// D-3：下見で通るものは確定でも通る
await check('D-3 取引先名 130 文字は下見で「取引先名：120文字まで」、確定は 400（500 にならない）', async () => {
  const long = 'あ'.repeat(130);
  const d = ok(await imp('partners', [['取引先コード', '取引先名'], [`${P}P1`, long]], true), 'dry');
  const c = await imp('partners', [['取引先コード', '取引先名'], [`${P}P1`, long]], false);
  const row = rowOf({ body: d }, 2);
  return (row?.action === 'エラー' && row.message.includes('取引先名：120文字まで') && c.status === 400) || { row, c };
});
await check('D-3 新しい行で得意先・仕入先が空欄なら下見で止まる（○×の欄の空は「無効」）', async () => {
  const d = ok(await imp('partners', [['取引先コード', '取引先名', '得意先', '仕入先', '海外'], [`${P}P3`, `${P}取引先3`, '', '', '']], true), 'dry');
  const d2 = ok(await imp('partners', [['取引先コード', '取引先名', '得意先', '仕入先', '海外'], [`${P}P3`, `${P}取引先3`, '', '○', '']], true), 'dry');
  const row = rowOf({ body: d }, 2);
  return (row?.action === 'エラー' && row.message.includes('得意先・仕入先') && d2.added === 1 && d2.errors === 0) || { row, d2: d2.rows };
});
await check('D-3 正しい行と誤りの行が混ざると確定は 400 で、正しい行も入らない', async () => {
  const before = await one(`select short_name from partners where id = $1`, [partner.id]);
  const c = await imp('partners', [['取引先コード', '略称', '取引区分'], [`${P}P1`, `${P}略`, ''], [`${P}P2`, '', '売上']], false);
  const after = await one(`select short_name from partners where id = $1`, [partner.id]);
  return (c.status === 400 && String(c.body.message).includes('3行目') && before.short_name === after.short_name) || { c, before, after };
});

await check('D-3 データベースが弾くもの（同じファイル内で JAN が重なる）も下見で分かり、確定は 400 で何も入らない', async () => {
  ok(await call('POST', '/masters/products', A, { product_code: `${P}J1`, product_name: `${P}JAN1` }), 'p1');
  ok(await call('POST', '/masters/products', A, { product_code: `FAZ${t}`, product_name: `${P}JAN2` }), 'p2');
  const jan = `49${t}12345`;
  const rows = [['SKUコード', '商品コード', 'JANコード'], [`${P}J1-1`, `${P}J1`, jan], [`FAZ${t}-1`, `FAZ${t}`, jan]];
  const d = ok(await imp('skus', rows, true), 'dry');
  const c = await imp('skus', rows, false);
  const n = await one(`select count(*)::int n from skus where sku_code in ($1, $2)`, [`${P}J1-1`, `FAZ${t}-1`]);
  return (d.added === 1 && rowOf({ body: d }, 3)?.action === 'エラー' && c.status === 400 && String(c.body.message).includes('3行目') && n.n === 0) || { d: d.rows, c, n };
});

// 得意先別商品の日付（2026-02-30）
const product = ok(await call('POST', '/masters/products', A, { product_code: `${P}PR`, product_name: `${P}商品` }), 'product');
const color = ok(await call('POST', '/masters/simple/colors', A, { code: `0${t}`, name: `${P}色` }), 'color');
const sku = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `${P}PR-01`, color_id: color.id }), 'sku');
ok(await call('POST', '/masters/partner-products', A, { partner_id: partner.id, sku_id: sku.id, unit_price: '100' }), 'pp');
await check('D-3 単価変更日 2026-02-30 は下見で「実在しない日付」、確定は 400', async () => {
  const rows = [['取引先コード', 'SKUコード', '単価変更日'], [`${P}P1`, `${P}PR-01`, '2026-02-30']];
  const d = ok(await imp('partner-products', rows, true), 'dry');
  const c = await imp('partner-products', rows, false);
  const row = rowOf({ body: d }, 2);
  return (row?.action === 'エラー' && row.message.includes('単価変更日：実在しない日付') && c.status === 400) || { row, c };
});
await check('D-3 Excel の 2026/10/7 の形は読める', async () => {
  ok(await imp('partner-products', [['取引先コード', 'SKUコード', '単価変更日'], [`${P}P1`, `${P}PR-01`, '2026/10/7']], false), 'import');
  const r = await one(`select price_changed_date::text d from partner_products where partner_id = $1 and sku_id = $2`, [partner.id, sku.id]);
  return r.d === '2026-10-07' || r;
});

// D-4：作業指示の本文が空
const wi = ok(await call('POST', '/masters/simple/work_instructions', A, { code: `${P}W1`, name: `${P}空本文`, instruction_body: '' }), 'wi');
await check('D-4 本文が空の作業指示を書き出してそのまま取り込むと「変更なし」', async () => {
  const exp = await text('/masters/csv/work-instructions/export', A);
  const lines = exp.text.replace(/^﻿/, '').split('\r\n');
  const mine = lines.find((l) => l.includes(`${P}W1`));
  const b64 = Buffer.from('﻿' + lines[0] + '\r\n' + mine + '\r\n', 'utf8').toString('base64');
  const r = ok(await call('POST', '/masters/csv/work-instructions/import', A, { content_base64: b64, dry_run: true }), 'dry');
  return (r.unchanged === 1 && r.updated === 0 && r.errors === 0) || r.rows;
});
await check('D-4 本文が空の行の備考だけ直して確定できる／本文が空の新しい行も作れる', async () => {
  const c = ok(await imp('work-instructions', [['コード', '名称', '指示内容', '備考'], [`${P}W1`, `${P}空本文`, '', '備考あり'], [`${P}W2`, `${P}新規`, '', '']], false), 'import');
  const a = await one(`select note, instruction_body from work_instructions where id = $1`, [wi.id]);
  const b = await one(`select instruction_body from work_instructions where code = $1`, [`${P}W2`]);
  return (c.updated === 1 && c.added === 1 && a.note === '備考あり' && a.instruction_body === '' && b?.instruction_body === '') || { c, a, b };
});
await check('D-4 指示内容の列が無い CSV でも作業指示を追加できる', async () => {
  const c = ok(await imp('work-instructions', [['コード', '名称'], [`${P}W3`, `${P}列なし`]], false), 'import');
  return c.added === 1 || c;
});

// D-7：先頭 0 のコード
await check('D-7 SKU の書き出しでカラーコード（0 始まり）・SKU・商品コードを ="..." で囲む', async () => {
  const r = await text('/masters/csv/skus/export', A);
  const line = r.text.split('\r\n').find((l) => l.includes(`${P}PR-01`)) ?? '';
  return (line.includes(`"=""0${t}"""`) && line.startsWith(`"=""${P}PR-01"""`) && line.includes(`"=""${P}PR"""`)) || line;
});
await check('D-7 書き出した SKU の行をそのまま取り込むと「変更なし」', async () => {
  const r = await text('/masters/csv/skus/export', A);
  const lines = r.text.replace(/^﻿/, '').split('\r\n');
  const mine = lines.find((l) => l.includes(`${P}PR-01`));
  const b64 = Buffer.from(lines[0] + '\r\n' + mine + '\r\n', 'utf8').toString('base64');
  const d = ok(await call('POST', '/masters/csv/skus/import', A, { content_base64: b64, dry_run: true }), 'dry');
  return (d.unchanged === 1 && d.errors === 0) || d.rows;
});

// ---- 4. 倉庫・仕入品目・区分値・書き出しだけのもの ------------------------------
await check('No.2 倉庫：CSV で追加→一覧で編集の行に出る→名前を直せる', async () => {
  ok(await imp('warehouses', [['倉庫コード', '倉庫名', '委託先', '取引先コード'], [`${P}WH`, `${P}倉庫`, '', `${P}P1`]], false), 'add');
  const g = ok(await call('GET', `/masters/csv/warehouses/rows?q=${P}WH`, A), 'rows');
  ok(await imp('warehouses', [['倉庫コード', '倉庫名'], [`${P}WH`, `${P}倉庫改`]], false), 'update');
  const w = await one(`select short_name, partner_id from warehouses where warehouse_code = $1`, [`${P}WH`]);
  return (g.items.length === 1 && g.items[0].partner_id === `${P}P1` && w.short_name === `${P}倉庫改` && Number(w.partner_id) === Number(partner.id)) || { g: g.items, w };
});
await check('No.2 仕入品目：CSV で追加・更新、税率 5 は下見で止まる', async () => {
  const c = ok(await imp('purchase-items', [['仕入コード', '品目名', '単価', '税率'], [`${P}PI`, `${P}資材`, '120', '10']], false), 'add');
  const d = ok(await imp('purchase-items', [['仕入コード', '税率'], [`${P}PI`, '5']], true), 'dry');
  const row = await one(`select unit_cost::text u, new_tax_rate::text r from purchase_items where purchase_code = $1`, [`${P}PI`]);
  return (c.added === 1 && rowOf({ body: d }, 2)?.action === 'エラー' && Number(row.u) === 120 && Number(row.r) === 10) || { c, d: d.rows, row };
});
await check('No.2 区分値：カテゴリーで絞って書き出し・一覧で編集できる（通貨タブ）', async () => {
  const e = await text('/masters/csv/codes/export?scope=CURRENCY', A);
  const body = e.text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
  const g = ok(await call('GET', '/masters/csv/codes/rows?scope=CURRENCY&include_inactive=true', A), 'rows');
  return (e.status === 200 && body.length > 1 && body.slice(1).every((l) => l.startsWith('"=""CURRENCY"""')) && g.items.length > 0 && g.items.every((x) => x.code_category_id === 'CURRENCY')) || { status: e.status, head: body.slice(0, 3), n: g.items.length };
});
await check('No.2 区分値：CSV で追加・使わないにできる。通貨のコードは英大文字3文字', async () => {
  const add = ok(await imp('codes', [['区分カテゴリー', 'コード', '名称'], ['ADJUSTMENT_REASON', `${P}AR`, `${P}調整理由`]], false), 'add');
  const off = ok(await imp('codes', [['区分カテゴリー', 'コード', '有効'], ['ADJUSTMENT_REASON', `${P}AR`, '無効']], false), 'off');
  const cur = ok(await imp('codes', [['区分カテゴリー', 'コード', '名称'], ['CURRENCY', 'fa1', `${P}通貨`]], true), 'dry');
  const c = await one(`select is_active from codes where code = $1`, [`${P}AR`]);
  return (add.added === 1 && off.updated === 1 && c.is_active === false && rowOf({ body: cur }, 2)?.message?.includes('英大文字3文字')) || { add, off, cur: cur.rows, c };
});
await check('No.3 ロイヤリティ規定・セット・ユーザーは CSV 書き出しができ、ユーザーにパスワードは出ない', async () => {
  const r = await text('/masters/csv/royalty-rules/export?include_inactive=true', A);
  const s = await text('/masters/csv/sets/export?include_inactive=true', A);
  const u = await text('/masters/csv/users/export?include_inactive=true', A);
  const uh = u.text.replace(/^﻿/, '').split('\r\n')[0];
  return (r.status === 200 && r.text.includes('支払先コード') && s.status === 200 && s.text.includes('構成品SKUコード') && u.status === 200 && uh.includes('ログインID') && !/パスワード|password|\$2[aby]\$/.test(u.text) && u.text.includes(`${P}u`)) || [r.status, s.status, u.status, uh];
});
await check('No.3 書き出しだけのマスタは取込できない（404）', async () => {
  const r = await imp('users', [['ログインID', '氏名'], ['x', 'y']], true);
  return r.status === 404 || r;
});
await check('No.2 閲覧者は一覧で編集の行・CSV 書き出しを読めない（403）', async () => {
  const a = await call('GET', '/masters/csv/warehouses/rows', V);
  const b = await call('GET', '/masters/csv/codes/rows?scope=CURRENCY', V);
  return (a.status === 403 && b.status === 403) || [a.status, b.status];
});
await check('No.2 CSV の一覧に倉庫・仕入品目・区分値と、書き出しだけの3つが載る', async () => {
  const r = ok(await call('GET', '/masters/csv', A), 'list');
  const slugs = Object.fromEntries(r.items.map((x) => [x.slug, x.export_only]));
  return (slugs.warehouses === false && slugs['purchase-items'] === false && slugs.codes === false && slugs['royalty-rules'] === true && slugs.sets === true && slugs.users === true) || slugs;
});

// ---- 再テスト（2026-10-13 R1）で見つかった点 -----------------------------------------
await check('R1 N1 CSV で足した行は「有効」欄が空でも「有効」で作られ、今ある行は空なら今のまま', async () => {
  ok(await imp('warehouses', [['倉庫コード', '倉庫名', '有効'], [`${P}WA`, `${P}倉庫A`, '']], false), 'add');
  const a = await one(`select is_active from warehouses where warehouse_code = $1`, [`${P}WA`]);
  ok(await imp('warehouses', [['倉庫コード', '有効'], [`${P}WA`, '無効']], false), 'deactivate');
  ok(await imp('warehouses', [['倉庫コード', '倉庫名', '有効'], [`${P}WA`, `${P}倉庫A改`, '']], false), 'rename');
  const b = await one(`select is_active, short_name from warehouses where warehouse_code = $1`, [`${P}WA`]);
  return (a.is_active === true && b.is_active === false && b.short_name === `${P}倉庫A改`) || { a, b };
});
await check('R1 N2 仕入品目の CSV で税区分と税率の食い違いは下見で誤り（非課税なのに10%）、合っていれば通る', async () => {
  const bad = ok(await imp('purchase-items', [['仕入コード', '品目名', '税率', '税区分'], [`${P}PX`, `${P}資材X`, '10', 'EXEMPT']], true), 'bad');
  const good = ok(await imp('purchase-items', [['仕入コード', '品目名', '税率', '税区分'], [`${P}PX`, `${P}資材X`, '0', 'EXEMPT']], true), 'good');
  const b = bad.rows?.[0];
  const g = good.rows?.[0];
  return (b?.action === 'エラー' && /税率/.test(b?.message ?? '') && g?.action !== 'エラー') || { b, g };
});
await check('R4 仕入品目で税率だけを直す CSV（税区分の列なし）・一覧で編集（全列）でも、税区分との食い違いは断る', async () => {
  ok(await imp('purchase-items', [['仕入コード', '品目名', '税率', '税区分'], [`${P}PY`, `${P}資材Y`, '10', 'TAX10']], false), 'add');
  const two = ok(await imp('purchase-items', [['仕入コード', '税率'], [`${P}PY`, '0']], true), 'two');
  const g = ok(await call('GET', `/masters/csv/purchase-items/rows?q=${P}PY`, A), 'rows');
  const hdr = g.columns.map((c) => c.label);
  const row = g.columns.map((c) => (c.field === 'new_tax_rate' ? '0' : c.field === 'is_active' ? (g.items[0][c.field] ? '有効' : '無効') : (g.items[0][c.field] ?? '')));
  const grid = await imp('purchase-items', [hdr, row], false);
  const db1 = await one(`select new_tax_rate from purchase_items where purchase_code = $1`, [`${P}PY`]);
  return (two.rows?.[0]?.action === 'エラー' && grid.status === 400 && Number(db1.new_tax_rate) === 10) || { two: two.rows, grid: grid.status, db1 };
});
await check('R4 仕入の一覧は、支払った額と残り（unpaid_amount）を返す', async () => {
  const r = ok(await call('GET', '/purchases?limit=5', A), 'purchases');
  const p = r.items[0];
  if (!p) return true; // 仕入が無い環境では見られない
  return (p.paid_amount !== undefined && Number(p.unpaid_amount) === Number(p.total_amount) - Number(p.paid_amount)) || p;
});
await check('R1 N3 請求の一覧は、消し込んだ入金の合計と残り（unapplied_balance）を返す', async () => {
  const r = ok(await call('GET', '/billing/invoices?limit=5', A), 'invoices');
  const i = r.items[0];
  if (!i) return true; // 請求が無い環境では見られない
  return (i.applied_amount !== undefined && Number(i.unapplied_balance) === Number(i.current_balance) - Number(i.applied_amount)) || i;
});

// ---- 後片付け（作った利用者は止める。役割は残す：消す画面・API が無い） ---------------------
await call('POST', `/admin/users/${user.id}/deactivate`, A);

await db.end();
process.exit(ng === 0 ? 0 : 1);
