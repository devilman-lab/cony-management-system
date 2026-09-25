-- Amazon 決済レポートの二重登録を止める（2026-09-25）
--
-- 背景：platform_transactions に一意制約が無く、取込の ON CONFLICT DO NOTHING が
-- 何も守っていなかった。同じ月のレポートを2回取り込むと明細がそのまま倍になり、
-- 売上・手数料の集計が二重になる。
--
-- 同一行の見分け方（レポートの列から決めた）：
--   プラットフォーム＋決済番号＋注文番号＋トランザクションの種類＋SKU＋日付/時間＋合計
--   ・注文番号は広告費用・振込み・一部の調整の行では空欄。決済番号と日時で見分ける。
--   ・同じ注文番号・同じ日時・同じSKUで「手数料あり」「手数料なし」の2行が並ぶことがある
--     （Amazonの手数料訂正）。これは別の行として残す必要があるので合計金額まで含める。
--     2026年8月の実データ 1,142 行では、この7項目で全行が別の行になることを確認した。
--   ・空欄同士も同じ値として扱いたいので COALESCE で揃える（UNIQUE 制約では NULL 同士が
--     重複にならず、二重登録を止められないため）。
--
-- 使い方：1) で件数を確かめ、2) を実行してから 3) を実行する。
-- docs/02-schema.sql からの新規構築では、この索引は最初から入っている。
SET search_path = cony, public;

-- ---------------------------------------------------------------------------
-- 1) 確認
-- ---------------------------------------------------------------------------

-- 1-a) 行番号から作られてしまった注文番号の件数。
--   注文番号が空の行に「(決済番号)-行番号」を入れていたため、レポートの行の並びが
--   変わるだけで別の行になり、二重登録の元になっていた。2-a で空欄に戻す。
SELECT count(*) AS 行番号から作った注文番号の件数
  FROM platform_transactions
 WHERE external_order_no ~ '^\(.+\)-[0-9]+$';

-- 1-b) 重複の確認（この件数だけ 2-b で消える）
SELECT platform,
       settlement_no,
       external_order_no,
       transaction_type,
       external_sku_code,
       transaction_at,
       total_amount,
       count(*) AS 件数
  FROM platform_transactions
 GROUP BY 1, 2, 3, 4, 5, 6, 7
HAVING count(*) > 1
 ORDER BY 件数 DESC, transaction_at;

-- ---------------------------------------------------------------------------
-- 2) 整理
-- ---------------------------------------------------------------------------

-- 2-a) 行番号から作った注文番号を空欄に戻す。
--   これをやらないと、同じレポートを取り込み直したときに新しい行（注文番号は空欄）と
--   一致せず、重複として弾けない。
UPDATE platform_transactions
   SET external_order_no = NULL
 WHERE external_order_no ~ '^\(.+\)-[0-9]+$';

-- 2-b) 重複した行のうち、最初に取り込んだ1件だけ残す。
--   元のレポートは残っているので、消し過ぎても取り込み直せる。
WITH dup AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY platform,
                        COALESCE(settlement_no, ''),
                        COALESCE(external_order_no, ''),
                        transaction_type,
                        COALESCE(external_sku_code, ''),
                        COALESCE(transaction_at, '-infinity'::TIMESTAMPTZ),
                        COALESCE(total_amount, 0)
           ORDER BY id
         ) AS n
    FROM platform_transactions
)
DELETE FROM platform_transactions
 WHERE id IN (SELECT id FROM dup WHERE n > 1);

-- ---------------------------------------------------------------------------
-- 3) 索引の作成
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX ux_platform_tx_natural ON platform_transactions
  (platform, COALESCE(settlement_no, ''), COALESCE(external_order_no, ''),
   transaction_type, COALESCE(external_sku_code, ''),
   COALESCE(transaction_at, '-infinity'::TIMESTAMPTZ), COALESCE(total_amount, 0));

-- 4) 確認（1-b がもう1件も出ないこと、索引が付いていること）
SELECT indexname FROM pg_indexes
 WHERE schemaname = 'cony' AND tablename = 'platform_transactions';
