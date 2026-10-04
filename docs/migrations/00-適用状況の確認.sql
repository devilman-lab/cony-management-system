-- 移行SQLが当たっているかを一目で確かめる（2026-09-25）
--
-- このファイルは **何も変更しません**。読むだけなので、いつ何度流しても安全です。
-- 7本すべてに「済」が並べば、そのデータベースは docs/02-schema.sql からの
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

-- ① は ⑦ で決まりが変わりました（全体で1つ → 品番の左6桁が同じならOK）。
-- ⑦ を当てたあとは一意索引が無くなり、代わりに引き金が守ります。どちらかがあれば「済」。
SELECT '① JANの重複を禁止' AS 移行,
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_indexes
               WHERE schemaname = 'cony' AND tablename = 'skus'
                 AND indexname = 'ux_skus_jan' AND indexdef LIKE '%UNIQUE%'
            ) OR EXISTS (
              SELECT 1 FROM pg_trigger
               WHERE tgrelid = 'cony.skus'::regclass AND tgname = 'trg_skus_jan'
            ) THEN '済' ELSE '未' END AS 状態,
       '2026-09-25_jan_unique.sql（⑦で決まりが変わります）' AS ファイル
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
UNION ALL
SELECT '⑤ マスタへのご要望（1001）',
       -- 列を1つずつ見る。どれか欠けていたら「一部」と出す。
       CASE
         WHEN (SELECT count(*) FROM information_schema.columns
                WHERE table_schema = 'cony'
                  AND ((table_name = 'products'         AND column_name = 'old_cost_price')
                    OR (table_name = 'skus'             AND column_name IN ('fba_jan', 'shop_product_code'))
                    OR (table_name = 'partner_products' AND column_name = 'shipping_jan')
                    OR (table_name = 'partners'         AND column_name IN ('invoice_addressee', 'invoice_contact_name'))
                    OR (table_name = 'royalty_rules'    AND column_name = 'media_id'))) = 7
          AND (SELECT count(*) FROM information_schema.tables
                WHERE table_schema = 'cony' AND table_name = 'partner_category_links') = 1
          AND (SELECT count(*) FROM code_categories WHERE code = 'CURRENCY') = 1
         THEN '済'
         WHEN (SELECT count(*) FROM information_schema.columns
                WHERE table_schema = 'cony' AND table_name = 'products' AND column_name = 'old_cost_price') = 0
         THEN '未'
         ELSE '一部'
       END,
       '2026-10-02_master_feedback.sql'
UNION ALL
SELECT '⑥ ロイヤリティを1枚のフォームで',
       CASE
         WHEN (SELECT count(*) FROM information_schema.columns
                WHERE table_schema = 'cony' AND table_name = 'royalty_rules'
                  AND column_name = 'rule_group_id') = 1
          AND (SELECT count(*) FROM pg_constraint
                WHERE conrelid = 'cony.royalty_rules'::regclass
                  AND conname = 'fk_royalty_rules_group') = 1
          AND (SELECT count(*) FROM pg_indexes
                WHERE schemaname = 'cony' AND indexname = 'ux_royalty_rules_scope'
                  AND indexdef LIKE '%media_id%') = 1
         THEN '済'
         WHEN (SELECT count(*) FROM information_schema.columns
                WHERE table_schema = 'cony' AND table_name = 'royalty_rules'
                  AND column_name = 'rule_group_id') = 0
         THEN '未'
         ELSE '一部'
       END,
       '2026-10-03_royalty_group.sql'
UNION ALL
SELECT '⑦ マスタご要望の残り（仕入区分・支払先・SKU原価・JAN）',
       CASE
         WHEN (SELECT count(*) FROM information_schema.columns
                WHERE table_schema = 'cony'
                  AND ((table_name = 'partners' AND column_name = 'is_royalty_payee')
                    OR (table_name = 'skus'     AND column_name = 'cost_price'))) = 2
          AND (SELECT count(*) FROM pg_trigger
                WHERE tgrelid = 'cony.skus'::regclass AND tgname = 'trg_skus_jan') = 1
          AND (SELECT count(*) FROM pg_constraint
                WHERE conrelid = 'cony.partners'::regclass AND conname = 'ck_partners_trade'
                  AND pg_get_constraintdef(oid) LIKE '%仕入%') = 1
         THEN '済'
         WHEN (SELECT count(*) FROM information_schema.columns
                WHERE table_schema = 'cony' AND table_name = 'partners'
                  AND column_name = 'is_royalty_payee') = 0
         THEN '未'
         ELSE '一部'
       END,
       '2026-10-04_master_feedback2.sql'
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

-- テーブルの数。⑤を当てたあとは 71（partner_category_links が増える）。
SELECT count(*) AS テーブル数_71なら最新
  FROM information_schema.tables
 WHERE table_schema = 'cony' AND table_type = 'BASE TABLE';

-- JAN の索引。⑦ のあとは一意ではなくなりますが（左6桁が同じなら重複OK）、
-- 引き当てに使うので索引そのものは残ります。ここも 1 なら正常。
SELECT count(*) AS JANの索引の数_1なら正常
  FROM pg_indexes
 WHERE schemaname = 'cony' AND tablename = 'skus' AND indexdef LIKE '%(jan)%';

-- ⑥ も索引を張り替えます。ここが 0 なら、同じ範囲のロイヤリティ規定が
-- 二重に登録できてしまう状態です（⑥ をもう一度流せば直ります）。
SELECT count(*) AS ロイヤリティの一意の索引_1なら正常
  FROM pg_indexes
 WHERE schemaname = 'cony' AND indexname = 'ux_royalty_rules_scope';
