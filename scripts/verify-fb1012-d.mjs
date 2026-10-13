// 2026-10-12 受入テストの修正（担当 D：帳票の折り返し・海外の消費税・販社CSVの取引条件・作業指示の本文）の回帰確認。
// smoke-backend.ps1 から呼ばれる想定（API・DB は smoke が立てた使い捨て環境）。
//
//  M-10  帳票の長い品名が次の行・合計欄に重ならない（行の高さを文字の高さで決め、はみ出せば改ページして見出しを出し直す）
//  T3-6-1 見出し部の長い得意先名が「出荷倉庫」「納品先No」に重ならない
//  M-02  海外の得意先の受注明細は税率 0、納品書は消費税 0 で「免税（税抜扱い）」／「課税対象外」
//  No.5  販社CSV取込で既定の取引区分が「仕入」の得意先も取り込める（取引条件は買取）
//  No.12 出荷指示書に作業指示の本文を印字する
//
// 環境変数: CONY_API（例 http://localhost:3011/api）、CONY_PASS（admin / viewer1 のパスワード）、DATABASE_URL
// 出力: 1行に1項目、「OK<TAB>項目名」または「NG<TAB>項目名<TAB>詳細」。NG が1つでもあれば終了コード 1。
// データの接頭辞は FD。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'package.json'));
const { Client } = require('pg');

const B = process.env.CONY_API ?? 'http://localhost:3011/api';
const PASS = process.env.CONY_PASS ?? 'SmokeTest123456';
/** 指定すると、取った PDF をこのフォルダに書き出す（画像にして目で確かめるため） */
const PDF_DIR = process.env.CONY_PDF_DIR ?? '';
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
async function getPdf(path, token, save) {
  const r = await fetch(B + path, { headers: { authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await r.arrayBuffer());
  if (r.status !== 200) throw new Error(`${path}: ${r.status} ${buf.toString('utf8').slice(0, 200)}`);
  if (PDF_DIR && save) writeFileSync(join(PDF_DIR, save), buf);
  return buf;
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (id) => ok(await call('POST', '/auth/login', '', { login_id: id, password: PASS }), 'login').access_token;
const A = await login('admin');
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const t = String(Date.now()).slice(-6);

/**
 * PDF の文字を、ページ・位置・文字の大きさつきで取り出す。
 * pdfkit は1行ごとに「BT … x y Tm /F 9 Tf [<字形番号>] TJ ET」を書き、ToUnicode の対応表を付ける。
 * 圧縮された中身を展開して対応表を作り、字形番号を文字に戻す（verify-fb1009-masters2.mjs の pdfText と同じ考え方）。
 */
function pdfRuns(buf) {
  const src = buf.toString('latin1');
  const streams = [];
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const len = Number((/\/Length (\d+)(?!\s+\d+\s+R)/.exec(m[1]) ?? [])[1]);
    const end = Number.isFinite(len) ? start + len : src.indexOf('endstream', start);
    if (end < start) break;
    const body = Buffer.from(src.slice(start, end), 'latin1');
    try { streams.push(inflateSync(body).toString('latin1')); } catch { streams.push(body.toString('latin1')); }
    re.lastIndex = end;
  }
  const map = new Map();
  const u16 = (hex) => Buffer.from(hex, 'hex').swap16().toString('utf16le');
  for (const s of streams) {
    if (!s.includes('beginbfrange') && !s.includes('beginbfchar')) continue;
    for (const b of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(p[1], 16), u16(p[2]));
    }
    for (const b of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
        const lo = parseInt(p[1], 16);
        const hi = parseInt(p[2], 16);
        if (p[3].startsWith('[')) {
          [...p[3].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((d, i) => map.set(lo + i, u16(d[1])));
        } else {
          const base = parseInt(p[3].slice(1, -1), 16);
          for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(base + c - lo));
        }
      }
    }
  }
  const runs = [];
  let page = 0;
  for (const s of streams) {
    if (!/\bBT\b/.test(s) || !/T[Jj]/.test(s)) continue;
    page += 1;
    for (const bt of s.matchAll(/BT([\s\S]*?)ET/g)) {
      const tm = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) Tm/.exec(bt[1]);
      const tf = /\/\S+ ([\d.]+) Tf/.exec(bt[1]);
      let text = '';
      for (const op of bt[1].matchAll(/\[((?:[^\]])*)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g)) {
        const hexes = op[1] !== undefined ? [...op[1].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]) : [op[2]];
        for (const h of hexes) for (let i = 0; i + 4 <= h.length; i += 4) text += map.get(parseInt(h.slice(i, i + 4), 16)) ?? '';
      }
      if (!tm || text.trim() === '') continue;
      runs.push({ page, x: Number(tm[5]), y: Number(tm[6]), size: tf ? Number(tf[1]) : 9, text });
    }
  }
  return runs;
}
const squash = (s) => s.replace(/\s+/g, '');
const textOf = (runs) => runs.map((r) => r.text).join('\n');
/** 文字の幅のおおよそ（全角 1em、半角英数・半角カナ 0.55em）。重なりの判定に使う。 */
const isHalf = (c) => c.charCodeAt(0) <= 0xff || (c.charCodeAt(0) >= 0xff61 && c.charCodeAt(0) <= 0xff9f);
const widthOf = (r) => [...r.text].reduce((a, c) => a + (isHalf(c) ? 0.55 : 1), 0) * r.size;
/** 同じページで、縦に文字の高さの 0.8 倍より近く、横にも重なっている2行を探す */
function overlaps(runs) {
  const out = [];
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i], b = runs[j];
      if (a.page !== b.page) continue;
      if (Math.abs(a.y - b.y) >= Math.min(a.size, b.size) * 0.8) continue;
      const ax2 = a.x + widthOf(a) - 1, bx2 = b.x + widthOf(b) - 1;
      if (a.x < bx2 && b.x < ax2) out.push(`p${a.page} 「${a.text}」と「${b.text}」`);
    }
  }
  return out;
}
const pages = (runs) => runs.reduce((a, r) => Math.max(a, r.page), 0);

// ---- 準備（接頭辞 FD） --------------------------------------------------------
const category = Number((await one('select id from sales_categories order by sort_order nulls last, code limit 1')).id);
const warehouse = Number((await one('select id from warehouses where is_active order by id limit 1')).id);
const treatment = (await one(`select value_text from system_settings where setting_key = 'OVERSEAS_TAX_TREATMENT'`))?.value_text ?? 'exempt';
const overseasLabel = treatment === 'non_taxable' ? '課税対象外' : '免税（税抜扱い）';

// 顧客の例（CS2426）と同じ長さの品名。SKU の商品名＋カラー＋サイズで受注の品名になる
const LONG_ITEM = 'LUXCEAR Fornez (ﾙｸｾｱ ﾌｫｰﾈｽ) AURA  (W) キャップ付 ベージュ M';
// 32字程度の得意先名（T3 6章1 の Q3T01 と同じ長さ）
const LONG_PARTNER = `FD株式会社テレビショッピング・ロングネーム流通サービス東日本${t}`;
const WI_BODY =
  `FD${t} 検品後、外箱に専用JANラベルを貼ってから出荷する。のし紙は不要。` +
  '同梱の納品書は先方指定の様式を使い、賞味期限の古い順に並べる。破損品が見つかったときは出荷を止めて営業担当へ連絡すること。';

const wi = ok(await call('POST', '/masters/simple/work_instructions', A, { code: `FD${t}`, name: `FD専用JAN${t}`, instruction_body: WI_BODY }), 'work instruction');
// 既定の取引区分＝仕入（得意先＋仕入先）。No.5 の形
const domestic = ok(await call('POST', '/masters/partners', A, { partner_code: `FDC${t}`, name1: LONG_PARTNER, is_customer: true, is_supplier: true, default_trade_type: '仕入' }), 'domestic partner');
const overseas = ok(await call('POST', '/masters/partners', A, { partner_code: `FDF${t}`, name1: `FD Overseas Buyer ${t}`, is_customer: true, is_overseas: true }), 'overseas partner');
const dDest = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: domestic.id, delivery_code: `FDD${t}`, name: 'FD東日本センター第3倉庫', partner_delivery_no: `FDNO${t}`, work_instruction_id: wi.id, default_warehouse_id: warehouse }), 'domestic dest');
const oDest = ok(await call('POST', '/masters/delivery-destinations', A, { partner_id: overseas.id, delivery_code: `FDE${t}`, name: 'FD Overseas DC', default_warehouse_id: warehouse }), 'overseas dest');
const product = ok(await call('POST', '/masters/products', A, { product_code: `FD${t}`, product_name: 'FDLUXCEAR Fornez (ﾙｸｾｱ ﾌｫｰﾈｽ) AURA', cost_price: '2050' }), 'product');
const sku1 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `FD${t}-0000-100` }), 'sku1');
const sku2 = ok(await call('POST', '/masters/skus', A, { product_id: product.id, sku_code: `FD${t}-0000-114`, sku_name: 'FDLUXCEAR Fornez (ﾙｸｾｱ ﾌｫｰﾈｽ) AURA  (W) キャップ付' }), 'sku2');
const rc = ok(await call('POST', '/inventory/receipts', A, { warehouse_id: warehouse, planned_date: today, note: 'FD検証', lines: [sku1, sku2].map((s, i) => ({ line_no: i + 1, sku_id: s.id, qty: '200' })) }), 'receipt');
ok(await call('POST', `/inventory/receipts/${rc.id}/receive`, A, { received_date: today }), 'receive');

const instruct = async (orderId) => {
  const r = ok(await call('POST', `/orders/${orderId}/shipping-instruction`, A), 'shipping instruction');
  if (!r.shipment_id) throw new Error(`出荷が作られない: ${JSON.stringify(r)}`);
  return r.shipment_id;
};

// ---- M-10・T3-6-1・No.12 長い品名・長い得意先名・作業指示の本文 -------------------
// 24行。1行が2〜3行に折り返すので、出荷指示書・納品書は2ページ以上になる
const longLines = Array.from({ length: 24 }, (_, i) => ({
  line_no: i + 1, line_type: '商品', sku_id: (i % 2 ? sku2 : sku1).id, item_name: LONG_ITEM, qty: '1', unit_price: '5000',
}));
const longOrder = ok(await call('POST', '/orders', A, { order_type: '卸', partner_id: domestic.id, delivery_destination_id: dDest.id, sales_category_id: category, order_date: today, ship_from_warehouse_id: warehouse, lines: longLines }), 'long order');
const longShipment = await instruct(longOrder.id);

const reports = [
  ['出荷指示書', `/reports/shipping-instructions?shipment_ids=${longShipment}`, 'FD-shipping-instruction.pdf'],
  ['ピッキングリスト', `/reports/picking-list?shipment_ids=${longShipment}`, 'FD-picking.pdf'],
  ...['単価あり', '単価あり2', '上代あり', '単価なし'].map((f) => [`納品書（${f}）`, `/reports/delivery-notes?shipment_ids=${longShipment}&form=${encodeURIComponent(f)}`, `FD-delivery-${f}.pdf`]),
];
const runsOf = {};
for (const [name, path, file] of reports) runsOf[name] = pdfRuns(await getPdf(path, A, file));

for (const [name] of reports) {
  await check(`M-10 ${name}：文字どうしが重ならない（長い品名・長い得意先名）`, async () => {
    const o = overlaps(runsOf[name]);
    return o.length === 0 ? true : `${o.length}か所 ${o.slice(0, 3).join(' / ')}`;
  });
  await check(`M-10 ${name}：長い品名が全文読める（折り返して欄に収まる）`, async () => {
    const txt = squash(textOf(runsOf[name]));
    // ピッキングリストの品名は SKU の商品名（カラー・サイズは付かない）
    const want = name === 'ピッキングリスト' ? squash('FDLUXCEAR Fornez (ﾙｸｾｱ ﾌｫｰﾈｽ) AURA  (W) キャップ付') : squash(LONG_ITEM);
    return txt.includes(want) || `品名が見つからない: ${txt.slice(0, 300)}`;
  });
}
for (const name of ['出荷指示書', '納品書（単価あり）', '納品書（単価なし）']) {
  await check(`M-10 ${name}：入りきらない行は次のページに送り、見出しを出し直す`, async () => {
    const runs = runsOf[name];
    const heads = runs.filter((r) => r.text.trim() === '品名');
    const lastPage = pages(runs);
    return (lastPage >= 2 && heads.length >= 2 && new Set(heads.map((h) => h.page)).size === heads.length)
      || `ページ ${lastPage}、見出し「品名」${heads.map((h) => `p${h.page}`).join(',')}`;
  });
  await check(`M-10 ${name}：最後のページで合計欄が明細の行より下にある`, async () => {
    const runs = runsOf[name];
    const last = pages(runs);
    const total = runs.find((r) => r.page === last && r.text.includes('合計数量'));
    const items = runs.filter((r) => r.page === last && squash(r.text).length > 0 && squash(LONG_ITEM).includes(squash(r.text)) && /[A-Za-zｦ-ﾟァ-ヶ]/.test(r.text));
    if (!total) return '合計数量が無い';
    const lowest = Math.min(...items.map((r) => r.y));
    return (items.length > 0 && total.y < lowest - 4) || `合計 y=${total.y}、品名の最下段 y=${lowest}`;
  });
}
await check('T3-6-1 出荷指示書：長い得意先名が全文出て、「出荷倉庫」と重ならない', async () => {
  const runs = runsOf['出荷指示書'];
  const txt = squash(textOf(runs));
  const wh = runs.find((r) => r.text.startsWith('出荷倉庫'));
  const partnerRuns = runs.filter((r) => r.page === 1 && r.x < 100 && r.y > (wh?.y ?? 0) - 1 && (r.text.startsWith('得意先') || squash(LONG_PARTNER).includes(squash(r.text))));
  if (!txt.includes(squash(`得意先：FDC${t} ${LONG_PARTNER}`))) return '得意先名が全文出ない';
  if (!wh) return '出荷倉庫が無い';
  // 折り返した得意先名の最後の行より、出荷倉庫の行が下にある
  const lowest = Math.min(...partnerRuns.map((r) => r.y));
  return wh.y < lowest - 4 || `出荷倉庫 y=${wh.y}、得意先の最下段 y=${lowest}`;
});
await check('T3-6-1 納品書（4様式）：長い得意先名が全文出て、「納品先No」と重ならない', async () => {
  for (const f of ['単価あり', '単価あり2', '上代あり', '単価なし']) {
    const runs = runsOf[`納品書（${f}）`];
    if (!squash(textOf(runs)).includes(squash(`得意先：FDC${t} ${LONG_PARTNER} 御中`))) return `${f}：得意先名が全文出ない`;
    const no = runs.find((r) => r.text.startsWith('納品先No'));
    if (!no || !no.text.includes(`FDNO${t}`)) return `${f}：納品先No が無い`;
    const partnerRuns = runs.filter((r) => r.page === 1 && r.x < 100 && r.y > no.y - 1 && !r.text.startsWith('納品先No'));
    const lowest = Math.min(...partnerRuns.map((r) => r.y));
    if (!(no.y < lowest - 4)) return `${f}：納品先No y=${no.y}、上の段の最下段 y=${lowest}`;
  }
  return true;
});
await check('No.12 出荷指示書に作業指示の名称と本文（全文）が出る', async () => {
  const txt = squash(textOf(runsOf['出荷指示書']));
  return (txt.includes(squash(`作業指示FD専用JAN${t}`)) && txt.includes(squash(WI_BODY))) || '本文が全文出ない';
});
await check('No.12 作業指示の本文は折り返して、次の行（表の見出し）と重ならない', async () => {
  const runs = runsOf['出荷指示書'].filter((r) => r.page === 1);
  const bodyRuns = runs.filter((r) => squash(WI_BODY).includes(squash(r.text)) && squash(r.text).length >= 4);
  const head = runs.find((r) => r.text.trim() === '品名');
  if (bodyRuns.length < 2) return `本文が折り返していない（${bodyRuns.length} 行）`;
  const lowest = Math.min(...bodyRuns.map((r) => r.y));
  // 本文の2行目以降は本文の1行目と同じ左端（見出しの右）にそろう
  const xs = new Set(bodyRuns.map((r) => Math.round(r.x)));
  return (head && head.y < lowest - 4 && xs.size === 1) || `見出し y=${head?.y}、本文の最下段 y=${lowest}、左端 ${[...xs].join(',')}`;
});
ok(await call('DELETE', `/orders/${longOrder.id}/shipping-instruction`, A), 'release long');

// ---- M-02 海外の得意先の消費税 -------------------------------------------------
const oLines = [{ line_no: 1, line_type: '商品', sku_id: sku1.id, item_name: 'FD海外向け', qty: '1', unit_price: '1000', tax_rate: '10.00' }];
const oOrder = ok(await call('POST', '/orders', A, { order_type: '卸', partner_id: overseas.id, delivery_destination_id: oDest.id, sales_category_id: category, order_date: today, ship_from_warehouse_id: warehouse, lines: oLines }), 'overseas order');
await check('M-02 受注入力：海外の得意先は 10% を選んでも明細の税率 0 で登録される', async () => {
  const rows = await all('select tax_rate::text from sales_order_lines l join sales_orders o on o.id = l.sales_order_id where o.order_no = $1', [oOrder.order_no]);
  return (rows.length === 1 && Number(rows[0].tax_rate) === 0) || rows;
});
await check('M-02 受注の修正：海外の得意先は修正しても税率 0 のまま', async () => {
  ok(await call('PATCH', `/orders/${oOrder.id}`, A, { lines: [{ ...oLines[0], tax_rate: '8.00' }] }), 'patch');
  const rows = await all('select tax_rate::text from sales_order_lines where sales_order_id = $1', [oOrder.id]);
  return (rows.length === 1 && Number(rows[0].tax_rate) === 0) || rows;
});
await check('M-02 受注の詳細：海外の印と消費税の表記（システム設定どおり）を返す', async () => {
  const d = ok(await call('GET', `/orders/${oOrder.id}`, A), 'detail');
  const dd = ok(await call('GET', `/orders/${longOrder.id}`, A), 'detail domestic');
  return (d.partner_is_overseas === true && d.overseas_tax_label === overseasLabel && dd.partner_is_overseas === false && dd.overseas_tax_label === null)
    || { overseas: [d.partner_is_overseas, d.overseas_tax_label], domestic: [dd.partner_is_overseas, dd.overseas_tax_label] };
});
await check('M-02 受注入力の表記 GET /orders/overseas-tax（閲覧者でも読める）', async () => {
  const V = await login('viewer1');
  const r = await call('GET', '/orders/overseas-tax', V);
  return (r.status === 200 && r.body.label === overseasLabel && Number(r.body.tax_rate) === 0) || r;
});
await check('M-02 国内の得意先の受注は今までどおり 10%', async () => {
  const rows = await all('select distinct tax_rate::text as r from sales_order_lines where sales_order_id = $1', [longOrder.id]);
  return (rows.length === 1 && Number(rows[0].r) === 10) || rows;
});
const oShipment = await instruct(oOrder.id);
await check('M-02 納品書：海外の得意先は消費税 0、合計＝小計、請求書と同じ表記', async () => {
  for (const f of ['単価あり', '単価あり2', '上代あり']) {
    const txt = textOf(pdfRuns(await getPdf(`/reports/delivery-notes?shipment_ids=${oShipment}&form=${encodeURIComponent(f)}`, A, `FD-overseas-${f}.pdf`)));
    const lines = txt.split('\n').map((s) => s.trim());
    const after = (label) => lines[lines.indexOf(label) + 1];
    if (!lines.includes(`消費税　${overseasLabel}`)) return `${f}：「消費税　${overseasLabel}」が無い`;
    if (after('消費税') !== '0') return `${f}：消費税 ${after('消費税')}`;
    if (after('小計（税抜）') !== '1,000' || after('合計') !== '1,000') return `${f}：小計 ${after('小計（税抜）')} 合計 ${after('合計')}`;
    if (lines.includes('合計（税込）') || lines.includes('1,100')) return `${f}：税込の合計が出ている`;
  }
  return true;
});
await check('M-02 国内の得意先の納品書は今までどおり消費税 10%・合計（税込）', async () => {
  const s = ok(await call('POST', `/orders/${longOrder.id}/shipping-instruction`, A), 'reinstruct').shipment_id;
  const txt = textOf(pdfRuns(await getPdf(`/reports/delivery-notes?shipment_ids=${s}&form=${encodeURIComponent('単価あり')}`, A)));
  ok(await call('DELETE', `/orders/${longOrder.id}/shipping-instruction`, A), 'release long');
  const lines = txt.split('\n').map((x) => x.trim());
  return (lines.includes('合計（税込）') && lines[lines.indexOf('消費税') + 1] === '12,000' && !txt.includes('免税')) || lines.slice(-12).join(' / ');
});
ok(await call('DELETE', `/orders/${oOrder.id}/shipping-instruction`, A), 'release overseas');

// ---- No.5・M-02 販社CSV取込 -----------------------------------------------------
const connectCsv = (rows) =>
  Buffer.from('﻿,注文ID,取引先コード,お届け先コード,出荷日,納品予定日,納品希望日,商品コード,数量,発注単価\r\n' + rows.map((r) => `${r.join(',')}\r\n`).join('')).toString('base64');
await check('No.5 販社CSV取込：既定の取引区分が「仕入」の得意先も取り込め、取引条件は買取', async () => {
  const r = await call('POST', '/imports/partner-orders', A, {
    template_code: 'CONNECT', file_name: `FD${t}-a.csv`,
    content_base64: connectCsv([[`FDX${t}A`, `FDPO${t}A`, `FDC${t}`, `FDD${t}`, today, '', '', sku1.sku_code, '1', '1000']]),
  });
  if (r.status !== 200 && r.status !== 201) return `${r.status} ${JSON.stringify(r.body)}`;
  const o = await one(`select o.trade_type, o.id from sales_orders o join partners p on p.id = o.partner_id where p.partner_code = $1 and o.channel = 'CONNECT'`, [`FDC${t}`]);
  return o?.trade_type === '買取' || o;
});
await check('M-02 販社CSV取込：海外の得意先の明細は税率 0', async () => {
  const r = await call('POST', '/imports/partner-orders', A, {
    template_code: 'CONNECT', file_name: `FD${t}-b.csv`,
    content_base64: connectCsv([[`FDX${t}B`, `FDPO${t}B`, `FDF${t}`, `FDE${t}`, today, '', '', sku1.sku_code, '1', '1000']]),
  });
  if (r.status !== 200 && r.status !== 201) return `${r.status} ${JSON.stringify(r.body)}`;
  const rows = await all(`select l.tax_rate::text as r from sales_order_lines l join sales_orders o on o.id = l.sales_order_id join partners p on p.id = o.partner_id where p.partner_code = $1 and o.channel = 'CONNECT'`, [`FDF${t}`]);
  return (rows.length === 1 && Number(rows[0].r) === 0) || rows;
});

await db.end();
process.exit(ng > 0 ? 1 : 0);
