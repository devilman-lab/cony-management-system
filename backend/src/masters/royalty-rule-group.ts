/**
 * ロイヤリティ規定の「まとまり」（rule_group_id）の中身の読み方と作り方。
 * 規定の画面の1件は、中では royalty_rules の複数の行でできている。
 * 一覧・編集（masters-write.controller.ts）と CSV 書き出し（masters-csv.service.ts）で、この1か所を使う。
 *
 * 2026-10-16 マスター編_3 M3-33 で、1つの規定に「対象の商品」と「対象外の商品」をそれぞれ複数選べるようにした。
 * 例: 媒体ネット・ブランド芦屋美整体は全て対象、ただし商品 A・B は対象外。
 *
 * 計算の当て方（billing/royalty-rule.sql.ts の royaltyRuleFor）は、当てはまる行のうち
 * 指定の細かい行（scope_priority：販売先4／商品2／ブランド1）を選ぶ。対象外の商品の行が、
 * その商品について同じまとまりの料率の行に必ず勝つよう、行を次のように作る。
 *
 *   販売先の指定  料率の行                     対象外の販売先の行     対象外の商品の行
 *   媒体全体      (すべて, 商品)               ―                      (すべて, 対象外の商品)   … 優先度 0 < 2
 *   対象          (販売先, 商品) を社ごと      ―                      (販売先, 対象外の商品)   … 優先度 4 < 6
 *   対象外        (すべて, 商品)               (販売先, 商品)         (すべて, 対象外の商品)   … 優先度 0 < 2、外した社は 4 以上
 *   （商品は「対象の商品」。空欄なら すべて の1行。ブランドはまとまりで共通）
 *
 * 「対象の商品」を選んだときは、選んだ商品だけが対象なので「対象外の商品」は選ばない（両方は API で断る）。
 * 料率を入れずに「対象外の商品」だけを選ぶと、その商品を媒体全体（または販売先の指定どおり）で対象外にする規定になる
 * （「全て対象」の別の規定より優先される。M3-34）。
 */

/**
 * 販売先の指定のしかた（1001 ご要望）。
 *   媒体全体 … 販売先を選ばない。媒体の全販売先が対象
 *   対象     … 選んだ販売先だけが対象
 *   対象外   … 選んだ販売先だけが対象から外れ、残りが対象
 * 「どちらかを入力して反映させる」形にする。対象と対象外を同時には入れない。
 */
export const CUSTOMER_MODES = ['媒体全体', '対象', '対象外'] as const;
export type CustomerMode = (typeof CUSTOMER_MODES)[number];

/** まとまりの中身。画面の1件の「販売先の指定」「対象の商品」「対象外の商品」 */
export interface RuleGroupSpec {
  mode: CustomerMode;
  /** 対象（または対象外）にする販売先 */
  customerIds: number[];
  /** 対象の商品。空ならブランド配下（ブランドも空なら支払先の）すべて */
  productIds: number[];
  /** 対象外の商品 */
  excludedProductIds: number[];
}

/** まとまりの1行（読むのに要る列だけ） */
export interface RuleGroupRow {
  customer_partner_id: number | string | null;
  product_id: number | string | null;
  is_excluded: boolean;
}

/** 作る行。customer・product の null は「すべて」 */
export interface RuleGroupWant {
  customer: number | null;
  product: number | null;
  excluded: boolean;
}

const uniqueIds = (values: (number | string | null)[]) => {
  const out: number[] = [];
  for (const v of values) {
    if (v === null) continue;
    const n = Number(v);
    if (!out.includes(n)) out.push(n);
  }
  return out;
};

/**
 * 行のまとまりから、画面の1件の中身を読む（planRuleGroupRows の逆）。編集前の版の行は渡さない。
 *
 *   料率の行に販売先がある              → 対象（料率の行の販売先・商品、対象外の行の商品＝対象外の商品）
 *   対象外の行に販売先がある            → 対象外（その販売先、その商品＝対象の商品、販売先なしの対象外の行＝対象外の商品）
 *   それ以外                            → 媒体全体（料率の行の商品、対象外の行の商品＝対象外の商品）
 * 料率なしの「販売先×商品の対象外」だけの規定は、対象外（販売先・対象の商品）として読む
 * （料率なしで「対象」は選べないので、読み方は1つに決まる）。
 */
export function readRuleGroup(rows: RuleGroupRow[]): RuleGroupSpec {
  const rated = rows.filter((r) => !r.is_excluded);
  const excluded = rows.filter((r) => r.is_excluded);
  if (rated.some((r) => r.customer_partner_id !== null)) {
    return {
      mode: '対象',
      customerIds: uniqueIds(rated.map((r) => r.customer_partner_id)),
      productIds: uniqueIds(rated.map((r) => r.product_id)),
      excludedProductIds: uniqueIds(excluded.map((r) => r.product_id)),
    };
  }
  const exclCustomers = excluded.filter((r) => r.customer_partner_id !== null);
  const exclProducts = excluded.filter((r) => r.customer_partner_id === null);
  const productIds = uniqueIds((rated.length > 0 ? rated : exclCustomers).map((r) => r.product_id));
  return {
    mode: exclCustomers.length > 0 ? '対象外' : '媒体全体',
    customerIds: uniqueIds(exclCustomers.map((r) => r.customer_partner_id)),
    productIds,
    excludedProductIds: uniqueIds(exclProducts.map((r) => r.product_id)),
  };
}

/**
 * 画面の1件の中身から、作る行の並びを決める。先頭がまとまりの代表になる（料率があれば料率の行）。
 * hasAmount は料率か定額が入っているか。
 */
export function planRuleGroupRows(spec: RuleGroupSpec, hasAmount: boolean): RuleGroupWant[] {
  const products: (number | null)[] = spec.productIds.length > 0 ? spec.productIds : [null];
  const wants: RuleGroupWant[] = [];
  const push = (customer: number | null, product: number | null, excluded: boolean) =>
    wants.push({ customer, product, excluded });

  if (spec.mode === '対象') {
    for (const c of spec.customerIds) for (const p of products) push(c, p, false);
    // 販売先を指定した料率の行（優先度4）に勝つよう、販売先×商品（優先度6）で対象外にする
    for (const c of spec.customerIds) for (const e of spec.excludedProductIds) push(c, e, true);
    return wants;
  }
  if (hasAmount) for (const p of products) push(null, p, false);
  if (spec.mode === '対象外') {
    for (const c of spec.customerIds) for (const p of products) push(c, p, true);
  }
  // 販売先すべての料率の行（優先度0）に勝つよう、商品（優先度2）で対象外にする
  for (const e of spec.excludedProductIds) push(null, e, true);
  return wants;
}

/**
 * 中身の検査。登録・更新の両方で使う。問題があれば利用者向けの文言を返す。
 */
export function checkRuleGroup(spec: RuleGroupSpec, hasAmount: boolean, limits: { customers: number; products: number }): string | null {
  const { mode, customerIds, productIds, excludedProductIds } = spec;
  if (mode !== '媒体全体' && customerIds.length === 0) {
    return '販売先を1社以上選んでください。媒体の全販売先を対象にするときは「媒体全体」を選びます';
  }
  if (mode === '媒体全体' && customerIds.length > 0) return '「媒体全体」を選んだときは販売先を選びません';
  if (customerIds.length > limits.customers) return `販売先は${limits.customers}社までです`;
  if (new Set(customerIds).size !== customerIds.length) return '同じ販売先が重なっています';
  if (productIds.length > limits.products) return `対象の商品は${limits.products}件までです`;
  if (excludedProductIds.length > limits.products) return `対象外の商品は${limits.products}件までです`;
  if (new Set(productIds).size !== productIds.length) return '対象の商品に同じ商品が重なっています';
  if (new Set(excludedProductIds).size !== excludedProductIds.length) return '対象外の商品に同じ商品が重なっています';
  if (productIds.length > 0 && excludedProductIds.length > 0) {
    return '「対象の商品」を選んだときは、選んだ商品だけが対象になるので「対象外の商品」は選びません';
  }
  // 料率なしで作れるのは「対象外」だけの規定（販売先の対象外・商品の対象外）
  if (!hasAmount) {
    if (mode === '対象') return '料率か定額を入力してください（「対象」の販売先には料率が要ります）';
    if (mode === '媒体全体' && excludedProductIds.length === 0) return '料率か定額のどちらかを入力してください';
  }
  return null;
}
