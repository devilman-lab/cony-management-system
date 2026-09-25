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
-- ★このファイルは行を消します。消す前に必ず 1) を流して件数を見てください。
--   1) は読むだけなので何度流しても安全です。2) が実際に消す部分です。
--   2) は退避（控え）を作ってから消し、まるごと1つのトランザクションにしてあります。
--   途中で失敗したら何も起きなかったことになります。
--
-- docs/02-schema.sql からの新規構築では、この索引は最初から入っている。

-- このファイルは UTF-8 です。日本語のコメントを含みます。
-- 日本語版 Windows の psql は、コンソールの既定（Shift-JIS）でファイルを読もうとして
-- 「invalid byte sequence for encoding "SJIS"」で止まります。先にこれを宣言して防ぎます。
SET client_encoding = 'UTF8';
SET search_path = cony, public;

-- 本番のバックエンドを動かしたまま流すと、ロック待ちで画面が固まることがあります。
-- 10秒で諦めて自分から降りるようにしておきます（諦めても何も変わりません。空いてから流し直す）。
SET lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 1) 確認（読むだけ。何度流しても安全）
-- ---------------------------------------------------------------------------
--
-- ここが 2) と食い違わないように、**2-a の整形を先に当てた姿**で数えています。
-- 　・2-a は「(決済番号)-行番号」という作り物の注文番号を空欄に戻します。
-- 　　戻すと、それまで別々だった行が同じ行と見なされるようになります。
-- 　・索引と DELETE は COALESCE で空欄どうしを揃えます。ここでも同じ式を使います。
-- この2つを揃えていないと、「0件」と出たのに 2-b が行を消す、ということが起きます。

-- 1-a) 行番号から作られてしまった注文番号の件数（2-a で空欄に戻る行）
SELECT count(*) AS 行番号から作った注文番号の件数
  FROM platform_transactions
 WHERE external_order_no ~ '^\(.+\)-[0-9]+$';

-- 1-b) 2-b で実際に消える行数。**この数だけ消えます。**
WITH normalized AS (
  SELECT id,
         platform,
         COALESCE(settlement_no, '')                                    AS s,
         COALESCE(CASE WHEN external_order_no ~ '^\(.+\)-[0-9]+$'
                       THEN NULL ELSE external_order_no END, '')        AS o,
         transaction_type,
         COALESCE(external_sku_code, '')                                AS sku,
         COALESCE(transaction_at, '-infinity'::TIMESTAMPTZ)             AS ts,
         COALESCE(total_amount, 0)                                      AS amt
    FROM platform_transactions
),
ranked AS (
  SELECT id, row_number() OVER (PARTITION BY platform, s, o, transaction_type, sku, ts, amt
                                ORDER BY id) AS n
    FROM normalized
)
SELECT count(*) AS これから消える行数 FROM ranked WHERE n > 1;

-- 1-c) 消える行の中身（何が重なっているのかを目で見るため。多いときは上から20件）
WITH normalized AS (
  SELECT id,
         platform,
         COALESCE(settlement_no, '')                                    AS 決済番号,
         COALESCE(CASE WHEN external_order_no ~ '^\(.+\)-[0-9]+$'
                       THEN NULL ELSE external_order_no END, '')        AS 注文番号,
         transaction_type                                               AS 種類,
         COALESCE(external_sku_code, '')                                AS sku,
         COALESCE(transaction_at, '-infinity'::TIMESTAMPTZ)             AS 日時,
         COALESCE(total_amount, 0)                                      AS 合計
    FROM platform_transactions
)
SELECT 決済番号, 注文番号, 種類, sku, 日時, 合計, count(*) AS 重なり
  FROM normalized
 GROUP BY platform, 決済番号, 注文番号, 種類, sku, 日時, 合計
HAVING count(*) > 1
 ORDER BY 重なり DESC, 日時
 LIMIT 20;

-- ---------------------------------------------------------------------------
-- 2) 整理と索引の作成（ここから実際に変わります）
-- ---------------------------------------------------------------------------
-- まるごと1つのトランザクションにしてあります。
-- 途中で失敗したら、退避テーブルの作成も UPDATE も DELETE も索引もすべて無かったことになります。
BEGIN;

-- 2-a) 消す前の控えを取る。
--   「元のレポートから取り込み直せばよい」は成り立ちません。取込プログラム自身が
--   同じキーの行を1件にまとめるため、ここで消した行のうち「レポート上は別行だが
--   取込キーが同じ」ものは、取り込み直しても戻らないからです。
--   画面で売上・手数料の集計を確かめたあとで、この表を DROP TABLE してください。
CREATE TABLE platform_transactions_bk_20260925 AS
SELECT * FROM platform_transactions;

-- 2-b) 行番号から作った注文番号を空欄に戻す。
--   これをやらないと、同じレポートを取り込み直したときに新しい行（注文番号は空欄）と
--   一致せず、重複として弾けない。
UPDATE platform_transactions
   SET external_order_no = NULL
 WHERE external_order_no ~ '^\(.+\)-[0-9]+$';

-- 2-c) 重複した行のうち、最初に取り込んだ1件だけ残す。
--   消えた行は 2-a の platform_transactions_bk_20260925 に残っています。
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

-- 2-d) 索引の作成
CREATE UNIQUE INDEX ux_platform_tx_natural ON platform_transactions
  (platform, COALESCE(settlement_no, ''), COALESCE(external_order_no, ''),
   transaction_type, COALESCE(external_sku_code, ''),
   COALESCE(transaction_at, '-infinity'::TIMESTAMPTZ), COALESCE(total_amount, 0));

COMMIT;

-- ---------------------------------------------------------------------------
-- 3) 確認
-- ---------------------------------------------------------------------------
SELECT indexname AS 付いた索引
  FROM pg_indexes
 WHERE schemaname = 'cony' AND tablename = 'platform_transactions'
   AND indexname = 'ux_platform_tx_natural';

-- 控えが無いときにエラーにならないよう to_regclass で有無を見てから数えます
-- （2) が失敗して巻き戻ったときは控えも作られていないため）。
SELECT CASE WHEN to_regclass('cony.platform_transactions_bk_20260925') IS NULL
            THEN '（控えなし。2) は実行されていません）'
            ELSE (SELECT count(*) FROM platform_transactions_bk_20260925)::text
       END AS 控えの行数,
       (SELECT count(*) FROM platform_transactions) AS 残った行数;

-- 画面で Amazon の売上・手数料の集計を確かめたら、控えを片付けてください：
--   DROP TABLE cony.platform_transactions_bk_20260925;
