-- ============================================================================
-- 2026-10-12 売上側の通貨（受入テスト No.39「売上仕入用の通貨」）
--
--   1. 取引先に取引通貨（partners.currency）
--   2. 受注に通貨（sales_orders.currency）。取引先の通貨で固定する引き金 trg_sales_orders_currency
--   3. 請求に通貨（invoices.currency）
--   4. 入金に通貨（cash_receipts.currency）
--   5. 取引先の通貨を直したら、まだ請求していない受注もそろえる引き金 trg_partners_currency
--   6. ロイヤリティ規定の「編集前の版」の印（royalty_rules.superseded_at。受入テスト No.37）
--   7. 支払に通貨（cash_payments.currency）。外貨の仕入に消し込んだ支払はその仕入の通貨にする（2026-10-13 再テスト N5）
--   8. 入出金の合計（cash_transactions.amount）を、その行の通貨の分だけにする（2026-10-13 再テスト）。
--      これまでは円の行にも「海外送金 (USD)(CNY)」を換算せずに足していた。海外送金は、行の通貨と同じときだけ合計に入る
--
-- 今あるデータは円（JPY）として扱う。列は既定値 'JPY' つきで足すだけで、行の増減は無い。
-- 値が変わるのは、7 の外貨の仕入に消し込んだ支払の通貨と、8 の海外送金を入れた入出金の合計だけ。
-- 何度流しても同じ結果になる（IF NOT EXISTS / CREATE OR REPLACE / 引き金は有無を見てから作る）。
--
-- 流し方（PowerShell）:
--   & $PSQL $URL -v ON_ERROR_STOP=1 -f docs\migrations\2026-10-12_sales_currency.sql
-- 流したあと docs\migrations\00-適用状況の確認.sql で ⑨ が「済」になることを確かめる。
-- 本番に出すときは「この SQL を先、push を後」（新しいコードはこれらの列を読むため）。
-- ============================================================================
SET client_encoding = 'UTF8';
SET lock_timeout = '10s';
BEGIN;
SET LOCAL search_path = cony;

-- 1〜4. 通貨の列（既存の行は JPY になる）
ALTER TABLE partners      ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'JPY';
ALTER TABLE sales_orders  ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'JPY';
ALTER TABLE invoices      ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'JPY';
ALTER TABLE cash_receipts ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'JPY';
ALTER TABLE cash_payments ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'JPY';

-- 2. 受注の通貨は取引先の通貨で固定する（02-schema.sql と同じ中身）
CREATE OR REPLACE FUNCTION cony.fn_sales_order_currency() RETURNS trigger AS $$
BEGIN
  SELECT p.currency INTO NEW.currency FROM cony.partners p WHERE p.id = NEW.partner_id;
  NEW.currency := COALESCE(NEW.currency, 'JPY');
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- 5. 取引先の通貨を直したら、まだ請求していない受注もそろえる（02-schema.sql と同じ中身）
CREATE OR REPLACE FUNCTION cony.fn_partner_currency_follow() RETURNS trigger AS $$
BEGIN
  IF NEW.currency IS DISTINCT FROM OLD.currency THEN
    UPDATE cony.sales_orders o
       SET currency = NEW.currency
     WHERE o.partner_id = NEW.id
       AND o.currency <> NEW.currency
       AND NOT EXISTS (
             SELECT 1
               FROM cony.shipments sh
               JOIN cony.invoice_lines il ON il.shipment_id = sh.id
               JOIN cony.invoices i ON i.id = il.invoice_id
              WHERE sh.sales_order_id = o.id
                AND i.status <> '取消');
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DO $m1$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'cony.sales_orders'::regclass AND tgname = 'trg_sales_orders_currency') THEN
    CREATE TRIGGER trg_sales_orders_currency
      BEFORE INSERT OR UPDATE OF partner_id, currency ON cony.sales_orders
      FOR EACH ROW EXECUTE FUNCTION cony.fn_sales_order_currency();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'cony.partners'::regclass AND tgname = 'trg_partners_currency') THEN
    CREATE TRIGGER trg_partners_currency
      AFTER UPDATE OF currency ON cony.partners
      FOR EACH ROW EXECUTE FUNCTION cony.fn_partner_currency_follow();
  END IF;
END
$m1$;

-- 6. ロイヤリティ規定の「編集前の版」の印（受入テスト No.37）。
--    計算に使った規定を販売先の指定を変えて直したとき、外れた行を消さずに残す。その日時を入れる。
ALTER TABLE royalty_rules ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- 7. 外貨の仕入に消し込んだ支払は、その仕入の通貨（もう一度流しても変わらない）
UPDATE cash_payments cp
   SET currency = pu.currency
  FROM purchases pu
 WHERE pu.id = cp.purchase_id
   AND cp.currency <> pu.currency;

-- 8. 入出金の合計を、その行の通貨の分だけにする（backend の purchasing.service.ts CASH_TOTAL と同じ式。もう一度流しても変わらない）
UPDATE cash_transactions
   SET amount = coalesce(cash_amount,0) + coalesce(transfer_amount,0) + coalesce(card_amount,0) + coalesce(bill_amount1,0)
              + coalesce(bill_amount2,0) + coalesce(offset_amount,0) + coalesce(check_amount,0) + coalesce(collection_amount,0)
              + CASE WHEN currency = 'USD' THEN coalesce(overseas_usd,0) ELSE 0 END
              + CASE WHEN currency = 'CNY' THEN coalesce(overseas_cny,0) ELSE 0 END
 WHERE ((coalesce(overseas_usd,0) <> 0 AND currency <> 'USD')
     OR (coalesce(overseas_cny,0) <> 0 AND currency <> 'CNY'))
   -- 合計がもう新しい式のとおりなら触らない（2回目に流したとき、更新日時まで変えないため）
   AND amount IS DISTINCT FROM (coalesce(cash_amount,0) + coalesce(transfer_amount,0) + coalesce(card_amount,0) + coalesce(bill_amount1,0)
              + coalesce(bill_amount2,0) + coalesce(offset_amount,0) + coalesce(check_amount,0) + coalesce(collection_amount,0)
              + CASE WHEN currency = 'USD' THEN coalesce(overseas_usd,0) ELSE 0 END
              + CASE WHEN currency = 'CNY' THEN coalesce(overseas_cny,0) ELSE 0 END);

COMMIT;

-- 確認（どれも上の行が 1、下の行が 0 なら正しい）
SET search_path = cony;
SELECT '通貨の列（5 なら正しい）' AS 項目, count(*) AS 件数
  FROM information_schema.columns
 WHERE table_schema = 'cony' AND column_name = 'currency'
   AND table_name IN ('partners', 'sales_orders', 'invoices', 'cash_receipts', 'cash_payments')
UNION ALL SELECT '受注の通貨の引き金', count(*) FROM pg_trigger WHERE tgrelid = 'cony.sales_orders'::regclass AND tgname = 'trg_sales_orders_currency'
UNION ALL SELECT '取引先の通貨の引き金', count(*) FROM pg_trigger WHERE tgrelid = 'cony.partners'::regclass AND tgname = 'trg_partners_currency'
UNION ALL SELECT '取引先と通貨が違う受注（流した直後は 0。取引先の通貨を変えたあとは請求済みの受注が前の通貨のまま残る）', count(*)
  FROM sales_orders o JOIN partners p ON p.id = o.partner_id WHERE o.currency <> p.currency
UNION ALL SELECT 'ロイヤリティ規定の編集前の版の列（1 なら正しい）', count(*) FROM information_schema.columns WHERE table_schema = 'cony' AND table_name = 'royalty_rules' AND column_name = 'superseded_at'
UNION ALL SELECT '仕入と通貨が違う支払（0 なら正しい）', count(*)
  FROM cash_payments cp JOIN purchases pu ON pu.id = cp.purchase_id WHERE cp.currency <> pu.currency
UNION ALL SELECT '円でない取引先', count(*) FROM partners WHERE currency <> 'JPY';
