-- 移行SQLが当たっているかを一目で確かめる（2026-09-25）
--
-- このファイルは **何も変更しません**。読むだけなので、いつ何度流しても安全です。
-- 4本すべてに「済」が並べば、そのデータベースは docs/02-schema.sql からの
-- 新規構築と同じ形になっています。
--
-- 使い方（本番の Render に対して、手元の PowerShell から）:
--   $env:PGPASSWORD = "（パスワード）"
--   & "C:\Program Files\PostgreSQL\17\bin\psql.exe" "（External Database URL）?sslmode=require" `
--       -f docs\migrations\00-適用状況の確認.sql

-- このファイルは UTF-8 です。日本語のコメントと、'取消' のような日本語の値を含みます。
-- 日本語版 Windows の psql は、コンソールの既定（Shift-JIS）でファイルを読もうとして
-- 「invalid byte sequence for encoding "SJIS"」で止まります。先にこれを宣言して防ぎます。
SET client_encoding = 'UTF8';
SET search_path = cony, public;

SELECT '① JANの重複を禁止' AS 移行,
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_indexes
               WHERE schemaname = 'cony' AND tablename = 'skus'
                 AND indexname = 'ux_skus_jan' AND indexdef LIKE '%UNIQUE%'
            ) THEN '済' ELSE '未' END AS 状態,
       '2026-09-25_jan_unique.sql' AS ファイル
UNION ALL
SELECT '② Amazonの二重登録を止める',
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_indexes
               WHERE schemaname = 'cony' AND tablename = 'platform_transactions'
                 AND indexname = 'ux_platform_tx_natural'
            ) THEN '済' ELSE '未' END,
       '2026-09-25_amazon_unique.sql'
UNION ALL
SELECT '③ 郵便番号を取込履歴に残す',
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_constraint
               WHERE conrelid = 'import_batches'::regclass AND conname = 'ck_import_type'
                 AND pg_get_constraintdef(oid) LIKE '%POSTAL_CODE%'
            ) THEN '済' ELSE '未' END,
       '2026-09-25_import_type_postal.sql'
UNION ALL
SELECT '④ 取消した請求を履歴として残す',
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_indexes
               WHERE schemaname = 'cony' AND tablename = 'invoices'
                 AND indexname = 'invoices_partner_id_period_to_key'
                 AND indexdef LIKE '%WHERE%'
            ) THEN '済' ELSE '未' END,
       '2026-09-25_invoice_cancel_history.sql'
ORDER BY 1;

-- 念のため：④ を途中で止めてしまうと、一意の決まりが**ひとつも無い**状態になり得ます。
-- ここが 0 なら、同じ取引先・同じ締め期間の請求が二重に作られる恐れがあります。
SELECT count(*) AS 請求の一意の決まりの数_1なら正常
  FROM (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'cony' AND tablename = 'invoices'
       AND indexname = 'invoices_partner_id_period_to_key'
    UNION ALL
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'invoices'::regclass AND conname = 'invoices_partner_id_period_to_key'
  ) t;

-- 同じく、① を途中で止めると JAN の索引が消えます。ここも 1 なら正常。
SELECT count(*) AS JANの索引の数_1なら正常
  FROM pg_indexes
 WHERE schemaname = 'cony' AND tablename = 'skus' AND indexdef LIKE '%(jan)%';
