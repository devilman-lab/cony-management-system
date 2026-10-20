import { sql, type RawBuilder } from 'kysely';

/**
 * 1つの受注の送料。請求の締め（billing.service.ts）と納品書の「送料」の行（reports.service.ts）が同じ額になるよう、
 * 決まりをここ1か所に置く（2026-10-13 受注処理編「送料の横にチェック。チェックありは納品書に送料を記載」）。
 *
 * 決まり（9/15 ご回答「1回の出荷が 30,000 円未満なら一律 750 円」）:
 *  - 受注明細に金額の入った「送料」の行があれば、その行が明細として請求に乗るので 0（二重に請求しない）
 *  - 送料調整欄に入れた額があればその額（直送はここに直接入力）
 *  - 直送・返品・委託・売上に計上しない受注（サンプル・社内移動）・外貨の受注は自動では付けない
 *  - 取引先マスタの送料区分が「請求しない」「直送のみ」なら付けない
 *  - それ以外は fn_shipping_fee（閾値・金額は取引先マスタ → 設定の順）。判定の金額は送料の行を除いた受注金額
 *
 * orderId には受注の id を指す式（sql.ref('o.id') など）か数値を渡す。
 */
export const orderShippingFeeSql = (orderId: unknown): RawBuilder<string> => sql<string>`(
  select case when t.fee_amount <> 0 then 0
              else coalesce(fo.shipping_fee_adjustment,
                     case when fo.order_type in ('直送', '返品') then 0
                          when fo.trade_type = '委託' then 0
                          when not fo.is_billable then 0
                          -- 自動の送料（3万円未満で 750 円）は円の決まり。外貨の受注には付けず、要るときは送料調整欄に入れる
                          when fo.currency <> 'JPY' then 0
                          when fr.code in ('NO_CHARGE', 'DIRECT_ONLY') then 0
                          else fn_shipping_fee(fo.partner_id, t.total) end) end
    from sales_orders fo
    left join partners fpa on fpa.id = fo.partner_id
    left join codes fr on fr.id = fpa.shipping_fee_rule_code_id
    join lateral (
      select coalesce(sum(sl.amount) filter (where sl.line_type <> '送料'), 0) as total,
             coalesce(sum(sl.amount) filter (where sl.line_type = '送料'), 0) as fee_amount
        from sales_order_lines sl
       where sl.sales_order_id = fo.id) t on true
   where fo.id = ${orderId})`;
