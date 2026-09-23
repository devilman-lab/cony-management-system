-- ============================================================================
--  株式会社コニー 販売管理システム  構築結果の確認
--  v1.0  2026-09-08
--
--  02-schema.sql → 03-seed-data.sql を適用したあとに実行し、
--  意図したオブジェクトがすべて作られているかを1つの表で確認する。
--
--  Navicat / pgAdmin / psql のいずれでもそのまま実行できる。
--  「判定」列がすべて OK であれば、スキーマは正しく構築されている。
--
--  04-schema-tests.sql（業務ルールの受入テスト）を実行したあとに流すと、
--  テストデータの分だけ件数が増えるため、必ず 03 の直後に実行すること。
-- ============================================================================

-- Windows の psql は既定で SJIS として読むため、このファイル（UTF-8）を正しく扱わせる
SET client_encoding = 'UTF8';
SET search_path = cony, public;

WITH expected(sort_key, category, item, actual, expect) AS (
  -- 1. スキーマの骨格
  SELECT 110, '構造', 'テーブル',
         (SELECT count(*) FROM information_schema.tables
           WHERE table_schema = 'cony' AND table_type = 'BASE TABLE'), 70
  UNION ALL
  SELECT 120, '構造', 'ドメイン（money_amt／qty_num／tax_rate）',
         (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'cony' AND t.typtype = 'd'), 3
  UNION ALL
  SELECT 130, '構造', '関数',
         (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'cony'), 8
  UNION ALL
  SELECT 140, '構造', '生成列（有効在庫・引当対象・ロイヤリティ適用優先度）',
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema = 'cony' AND is_generated = 'ALWAYS'), 3

  -- 2. 整合性のしくみ
  UNION ALL
  -- 更新日時トリガは DO ブロックで一括付与している。
  -- ツールが $$ を正しく解釈できないと 0 件になるため、必ず確認すること。
  SELECT 210, '整合性', '更新日時トリガ（期待値＝updated_at を持つテーブル数）',
         (SELECT count(*) FROM pg_trigger tg JOIN pg_class cl ON cl.oid = tg.tgrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
           WHERE n.nspname = 'cony' AND tg.tgname LIKE 'trg\_%\_updated' AND NOT tg.tgisinternal),
         (SELECT count(DISTINCT c.table_name) FROM information_schema.columns c
           WHERE c.table_schema = 'cony' AND c.column_name = 'updated_at')
  UNION ALL
  SELECT 220, '整合性', '追記専用トリガ（在庫移動履歴・監査ログ）',
         (SELECT count(*) FROM pg_trigger tg JOIN pg_class cl ON cl.oid = tg.tgrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
           WHERE n.nspname = 'cony' AND tg.tgname LIKE '%immutable' AND NOT tg.tgisinternal), 2

  -- 3. 初期データ
  UNION ALL
  SELECT 310, '初期データ', '区分カテゴリー',       (SELECT count(*) FROM code_categories), 23
  UNION ALL
  SELECT 320, '初期データ', '区分値',               (SELECT count(*) FROM codes), 55
  UNION ALL
  SELECT 330, '初期データ', '販売カテゴリー',       (SELECT count(*) FROM sales_categories), 3
  UNION ALL
  SELECT 340, '初期データ', 'ロール',               (SELECT count(*) FROM roles), 4
  UNION ALL
  -- 権限は 機能30 × 操作5（参照・登録・更新・削除・印刷）
  SELECT 350, '初期データ', '権限（機能30×操作5＋機微項目1）', (SELECT count(*) FROM permissions), 151
  UNION ALL
  SELECT 360, '初期データ', '倉庫',                 (SELECT count(*) FROM warehouses), 4
  UNION ALL
  SELECT 370, '初期データ', '採番ルール',           (SELECT count(*) FROM numbering_rules), 11
  UNION ALL
  SELECT 380, '初期データ', 'システム設定',         (SELECT count(*) FROM system_settings), 24
  UNION ALL
  SELECT 390, '初期データ', '取込テンプレート（販社4社）',
                                                    (SELECT count(*) FROM import_templates), 4
  UNION ALL
  SELECT 400, '初期データ', '取込テンプレート列定義（36+26+29+10）',
                                                    (SELECT count(*) FROM import_template_columns), 101
),
counted(sort_key, category, item, actual, expect) AS (
  SELECT * FROM expected
  UNION ALL
  -- 4. 件数は環境で増えうるため、下限のみを見る
  SELECT 510, '規模', '外部キー',
         (SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
           WHERE n.nspname = 'cony' AND c.contype = 'f'), 200
  UNION ALL
  SELECT 520, '規模', 'CHECK 制約',
         (SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
           WHERE n.nspname = 'cony' AND c.contype = 'c'), 40
  UNION ALL
  SELECT 530, '規模', 'インデックス',
         (SELECT count(*) FROM pg_indexes WHERE schemaname = 'cony'), 130
)
SELECT category AS "区分",
       item     AS "項目",
       actual   AS "実測",
       CASE WHEN sort_key >= 500 THEN expect::text || ' 以上' ELSE expect::text END AS "期待",
       CASE WHEN sort_key >= 500 THEN CASE WHEN actual >= expect THEN 'OK' ELSE '★NG' END
            ELSE CASE WHEN actual  = expect THEN 'OK' ELSE '★NG' END END AS "判定"
  FROM counted
 ORDER BY sort_key;


-- ----------------------------------------------------------------------------
-- 業務ルールが制約として入っているかの確認
--   ここに挙げた制約は、貴社にご説明した「壊れないための作り」の実体である。
-- ----------------------------------------------------------------------------
WITH must_exist(sort_key, rule, conname) AS (
  VALUES
    (10, '有効在庫を超える引当はできない',           'ck_stocks_available'),
    (20, '実在庫はマイナスにならない',               'ck_stocks_on_hand'),
    (30, '卸受注は納品先が必須',                     'ck_so_dest'),
    (40, 'サンプル出荷は売上計上にできない',         'ck_so_sample'),
    (50, '明細の種別は実CSVの値に限る',              'ck_sol_type'),
    (60, '商品行はSKUが必須',                        'ck_sol_sku'),
    (70, '取引条件は委託／買取のみ',                 'ck_partners_trade'),
    (80, '送料・閾値にマイナスは入れられない',       'ck_partners_shipfee'),
    (90, '在庫調整の増減は0にできない',              'ck_stkadjline_qty'),
    (100,'郵便番号は7桁の数字',                      'ck_postal_code'),
    (110,'数値設定に数値以外は入れられない',         'ck_setting_number'),
    (120,'取込先の項目は定義済みのものだけ',         'ck_imptplcol_field'),
    (130,'ロイヤリティ対象外の規定に料率は入れられない','ck_royalty_excl'),
    (140,'ロイヤリティは料率か定額のどちらかが必要', 'ck_royalty_amount')
)
SELECT m.rule AS "業務ルール",
       m.conname AS "制約名",
       CASE WHEN c.oid IS NULL THEN '★NG（見つかりません）' ELSE 'OK' END AS "判定"
  FROM must_exist m
  LEFT JOIN pg_constraint c
         ON c.conname = m.conname
        AND c.connamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'cony')
 ORDER BY m.sort_key;


-- ----------------------------------------------------------------------------
-- 一意制約の確認（二重登録を防いでいる箇所）
-- ----------------------------------------------------------------------------
WITH must_unique(sort_key, rule, tbl, conname) AS (
  VALUES
    (10, '同じCSVを2回取り込んでも二重計上しない', 'external_orders', 'external_orders_channel_external_order_no_key'),
    (20, '同じ締め期間で二重に請求できない',       'invoices',        'invoices_partner_id_period_to_key'),
    (30, '取引先ごとの専用コードは重複しない',     'partner_products','ux_partner_products_code'),
    (40, '1つの郵便番号に同じ町域は登録できない',  'postal_codes',    'postal_codes_postal_code_town_key'),
    (50, '同じ範囲のロイヤリティ規定は二重登録できない', 'royalty_rules', 'ux_royalty_rules_scope'),
    (60, '同じ支払先・同じ月の計算表は1枚だけ',   'royalty_calculations', 'royalty_calculations_target_month_payee_partner_id_key')
)
SELECT u.rule AS "業務ルール",
       u.tbl  AS "テーブル",
       CASE WHEN c.oid IS NOT NULL OR i.indexname IS NOT NULL THEN 'OK'
            ELSE '★NG（見つかりません）' END AS "判定"
  FROM must_unique u
  LEFT JOIN pg_constraint c
         ON c.conname = u.conname
        AND c.connamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'cony')
  LEFT JOIN pg_indexes i
         ON i.schemaname = 'cony' AND i.indexname = u.conname
 ORDER BY u.sort_key;


-- ----------------------------------------------------------------------------
-- テーブル一覧（Navicat の一覧と突き合わせる用）
-- ----------------------------------------------------------------------------
SELECT c.relname AS "テーブル",
       obj_description(c.oid) AS "説明",
       (SELECT count(*) FROM information_schema.columns col
         WHERE col.table_schema = 'cony' AND col.table_name = c.relname) AS "列数"
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'cony' AND c.relkind = 'r'
 ORDER BY c.relname;
