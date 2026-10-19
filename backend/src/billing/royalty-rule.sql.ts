import { sql, type Expression, type RawBuilder } from 'kysely';

/**
 * ロイヤリティ規定の当て方。月次のロイヤリティ計算（royalty.service）と
 * 販売実績のロイヤリティ（analytics.service）で、この1か所を使う。
 * 以前は販売実績の側だけ媒体を見ておらず、月次の計算表と金額が合わなかった（2026-10-12 T3 No.35）。
 *
 *   ・支払先ごとに、有効で（使わないでない）、取引の日が適用期間に入る規定から1行を選ぶ
 *   ・ブランド・商品・販売先・媒体は「空欄＝すべて」。媒体は販売先（取引先マスタ）の媒体と突き合わせる
 *   ・媒体を指定した規定を先に、次に指定の細かい規定（scope_priority：販売先4／商品2／ブランド1）を先に当てる
 *   ・選んだ行が「対象外」なら、その明細にはロイヤリティが付かない（呼ぶ側で is_excluded を見る）
 *     規定の「対象外の商品」（M3-33）は、同じ規定の料率の行より優先度が高くなるよう
 *     商品（販売先を指定した規定なら販売先×商品）の対象外の行として持つ（masters/royalty-rule-group.ts）
 *
 * 取引の日は、受注明細なら出荷日、返品なら返品日。計算の基準（出荷／売上／入金）にかかわらず、
 * どの規定を当てるかは取引の日で決め、基準はその金額を「どの月に計上するか」だけを決める。
 * こうしておくと、基準の違う規定が同じ支払先に混ざっても、1つの明細が二重に数えられたり
 * どの月にも入らなかったりしない。
 *
 * 使い方: `join lateral ${royaltyRuleFor({...})} rule on true` のように、別名を付けて結合する。
 * 返す列は id・rate・fixed_amount・is_excluded・calc_base。
 */
export function royaltyRuleFor(p: {
  /** 支払先。数値ならその支払先だけ、式なら行ごとの支払先 */
  payee: number | Expression<unknown>;
  /** 取引の日（出荷日・返品日） */
  date: Expression<unknown>;
  brandId: Expression<unknown>;
  productId: Expression<unknown>;
  /** 販売先（受注・返品の取引先） */
  customerId: Expression<unknown>;
}): RawBuilder<unknown> {
  return sql`(
    select rr.id, rr.rate, rr.fixed_amount, rr.is_excluded, rr.calc_base
      from royalty_rules rr
     where rr.payee_partner_id = ${p.payee}
       and rr.is_active
       and rr.valid_from <= ${p.date}
       and (rr.valid_to is null or rr.valid_to >= ${p.date})
       and (rr.brand_id is null or rr.brand_id = ${p.brandId})
       and (rr.product_id is null or rr.product_id = ${p.productId})
       and (rr.customer_partner_id is null or rr.customer_partner_id = ${p.customerId})
       -- 媒体。取引先マスタの媒体と突き合わせる。空欄の規定はすべての媒体に当たる（1001 ご要望）
       and (rr.media_id is null
            or rr.media_id = (select pa.media_id from partners pa where pa.id = ${p.customerId}))
     -- 媒体を指定した規定を、指定していないものより先に当てる
     order by (rr.media_id is not null) desc, rr.scope_priority desc, rr.valid_from desc
     limit 1
  )`;
}

/**
 * ロイヤリティを数える明細（品物の行）。送料・値引・販促品・非商品には付けない。
 * 内訳商品は親のセット行があると二重になるので数えない。
 */
export const ROYALTY_GOODS_LINE = sql<boolean>`(sl.line_type in ('商品', 'セット商品')
  or (sl.line_type = '内訳商品' and sl.parent_line_no is null))`;

/**
 * 1つの明細のまとまり（販売先 × ブランド × SKU × 規定）のロイヤリティ。
 * 料率なら対象金額の合計に、定額なら数量の合計にかけ、まとまりごとに端数を処理する。
 * 計算表はこの単位で1行になるので、販売実績も同じ単位で端数を落とす。
 */
export function royaltyAmount(
  rate: Expression<unknown>,
  fixedAmount: Expression<unknown>,
  sumAmount: Expression<unknown>,
  sumQty: Expression<unknown>,
  roundingMode: string,
): RawBuilder<string> {
  return sql<string>`fn_round_amount(
    case when ${rate} is not null then ${sumAmount} * ${rate}
         else coalesce(${fixedAmount}, 0) * ${sumQty} end,
    ${roundingMode})`;
}
