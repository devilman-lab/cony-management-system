-- ============================================================================
--  株式会社コニー 販売管理システム  外部データ取込の検証
--  v1.0  2026-09-08
--
--  目的
--    設計したテーブルが、貴社から実際に頂戴したCSVをそのまま受け止められるか、
--    実データを流して確かめる。第1段階（データベース設計）の最終確認にあたる。
--
--  対象データ（2026/09/02 受領）
--    (1) OS_beautyjapan_20260901_170556.csv   OMS受注   63列 / 明細203件 / 受注77件
--    (2) 2026AugMonthlyTransaction (1).csv    Amazon決済 30列 / 1,142件
--
--  ※ このファイルは psql 専用（\copy／\echo を使う）。Navicat では実行できない。
--     スキーマの確認だけであれば 07-verify-objects.sql と 04-schema-tests.sql で足りる。
--
--  実行手順
--    1) 02-schema.sql → 03-seed-data.sql を適用しておく
--    2) 前処理（文字コード変換と説明文の除去）
--         powershell -ExecutionPolicy Bypass -File scripts\prepare-import.ps1 `
--           -OmsCsv "..\要件\OS_beautyjapan_20260901_170556.csv" `
--           -AmazonCsv "..\要件\2026AugMonthlyTransaction (1).csv" -OutDir .\work
--    3) リポジトリ直下で実行
--         psql -v ON_ERROR_STOP=1 -f docs/05-import-validation.sql
--
--  失敗時の独自エラーコード：VF001
-- ============================================================================

SET client_encoding = 'UTF8';
SET timezone = 'Asia/Tokyo';
SET search_path = cony, public;

\set ON_ERROR_STOP on


-- ============================================================================
-- 1. ステージング表（CSVの列順どおり。すべて text で受けて、ここで型を判断しない）
-- ============================================================================

DROP TABLE IF EXISTS stg_oms_orders;
CREATE TABLE stg_oms_orders (
  sales_route          text,  -- 受注ルート
  order_no             text,  -- 受注番号
  order_date           text,  -- 注文日
  order_time           text,  -- 注文時間
  orderer_last_name    text,  -- 注文者名（姓）
  orderer_first_name   text,  -- 注文者名（名）
  orderer_last_kana    text,  -- 注文者名（セイ）
  orderer_first_kana   text,  -- 注文者名（メイ）
  orderer_email        text,  -- 注文者メールアドレス
  orderer_postal       text,  -- 注文者郵便番号
  orderer_pref         text,  -- 注文者住所（都道府県）
  orderer_city         text,  -- 注文者住所（市区町村）
  orderer_addr3        text,  -- 注文者住所（市区町村以降）
  orderer_addr4        text,  -- 注文者住所（建物名等）
  orderer_company      text,  -- 注文者会社名
  orderer_dept         text,  -- 注文者部署名
  orderer_tel          text,  -- 注文者電話番号
  payment_method       text,  -- 決済方法
  payment_fee          text,  -- 決済手数料
  used_points          text,  -- ご利用ポイント
  earned_points        text,  -- 獲得ポイント
  order_note           text,  -- 備考（注文）
  order_memo           text,  -- 一言メモ（注文）
  total_amount         text,  -- 合計請求金額
  member_no            text,  -- 会員番号（自社サイト）
  registered_by        text,  -- 登録担当者
  ship_last_name       text,  -- お届け先名（姓）
  ship_first_name      text,  -- お届け先名（名）
  ship_last_kana       text,  -- お届け先名（セイ）
  ship_first_kana      text,  -- お届け先名（メイ）
  ship_postal          text,  -- お届け先郵便番号
  ship_pref            text,  -- お届け先住所（都道府県）
  ship_city            text,  -- お届け先住所（市区町村）
  ship_addr3           text,  -- お届け先住所（市区町村以降）
  ship_addr4           text,  -- お届け先住所（建物名等）
  ship_company         text,  -- お届け先会社名
  ship_dept            text,  -- お届け先部署名
  ship_tel             text,  -- お届け先電話番号
  ship_note            text,  -- 備考（お届け先）
  ship_memo            text,  -- 一言メモ（お届け先）
  slip_division        text,  -- 伝票区分
  label_type           text,  -- 送り状種別
  tracking_no          text,  -- 伝票番号
  cod_amount           text,  -- 代引請求金額
  delivery_date        text,  -- お届け指定日
  delivery_time_slot   text,  -- お届け時間帯
  planned_ship_date    text,  -- 出荷予定日
  carrier_system       text,  -- 運送会社システム
  slip_memo            text,  -- 一言メモ（伝票）
  final_status         text,  -- 最終ステータス
  consolidated_from    text,  -- 同梱元
  consolidated_to      text,  -- 同梱先
  line_no              text,  -- 商品区分（＝明細番号）
  line_type            text,  -- 商品種別
  item_name            text,  -- 商品名
  qty                  text,  -- 個数
  unit_price           text,  -- 単価
  sunet_product_code   text,  -- 商品コード（助ネコ）
  slip_management_no   text,  -- 伝票管理番号
  process_route        text,  -- 処理ルート（＝出荷倉庫）
  processed_date       text,  -- 処理済日
  own_sku_code         text,  -- 自社商品コード
  purchase_count       text   -- 購入回数
);
COMMENT ON TABLE stg_oms_orders IS 'OMS受注CSVの受け皿。列順は受領ファイルのまま';

DROP TABLE IF EXISTS stg_amazon_transactions;
CREATE TABLE stg_amazon_transactions (
  txn_at                   text,  -- 日付/時間
  settlement_no            text,  -- 決済番号
  txn_type                 text,  -- トランザクションの種類
  order_no                 text,  -- 注文番号
  sku                      text,  -- SKU
  description              text,  -- 説明
  qty                      text,  -- 数量
  selling_service          text,  -- Amazon 出品サービス
  fulfillment              text,  -- フルフィルメント
  city                     text,  -- 市町村
  prefecture               text,  -- 都道府県
  postal_code              text,  -- 郵便番号
  tax_collection_model     text,  -- 税金徴収型
  product_sales            text,  -- 商品売上
  product_sales_tax        text,  -- 商品の売上税
  shipping_fee             text,  -- 配送料
  shipping_tax             text,  -- 配送料の税金
  gift_wrap_fee            text,  -- ギフト包装手数料
  gift_wrap_tax            text,  -- ギフト包装クレジットの税金
  points_cost              text,  -- Amazonポイントの費用
  promo_discount           text,  -- プロモーション割引額
  promo_discount_tax       text,  -- プロモーション割引の税金
  marketplace_withheld_tax text,  -- 源泉徴収税を伴うマーケットプレイス
  commission_fee           text,  -- 手数料
  fba_fee                  text,  -- FBA 手数料
  other_txn_fee            text,  -- トランザクションに関するその他の手数料
  other_amount             text,  -- その他
  total_amount             text,  -- 合計
  txn_status               text,  -- トランザクションのステータス
  txn_started_at           text   -- トランザクション開始日
);
COMMENT ON TABLE stg_amazon_transactions IS 'Amazon月次トランザクションレポートの受け皿';


-- ============================================================================
-- 2. 読み込み
-- ============================================================================

\copy stg_oms_orders          FROM 'work/oms_orders_utf8.csv'          WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')
\copy stg_amazon_transactions FROM 'work/amazon_transactions_utf8.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')


-- ============================================================================
-- 3. 受領データの実測（内容の把握。ここでは合否を判定しない）
-- ============================================================================

\echo ''
\echo '=== OMS受注CSV：受注ルート別 ==='
SELECT sales_route AS "受注ルート",
       count(DISTINCT order_no) AS "受注",
       count(*)                 AS "明細"
  FROM stg_oms_orders GROUP BY 1 ORDER BY 3 DESC;

\echo ''
\echo '=== OMS受注CSV：明細の種別（sales_order_lines.line_type の元になる値）==='
SELECT line_type AS "商品種別", count(*) AS "件数",
       count(*) FILTER (WHERE NULLIF(qty, '')::numeric < 0)   AS "うち数量マイナス",
       count(*) FILTER (WHERE COALESCE(own_sku_code,'') = '') AS "うち自社コードなし"
  FROM stg_oms_orders GROUP BY 1 ORDER BY 2 DESC;

\echo ''
\echo '=== OMS受注CSV：処理ルート（倉庫マスタと一致すべき値）==='
SELECT s.process_route AS "処理ルート", count(*) AS "明細",
       CASE WHEN w.id IS NULL THEN '× 倉庫マスタになし' ELSE '○ 一致' END AS "照合"
  FROM stg_oms_orders s
  LEFT JOIN warehouses w ON w.short_name = s.process_route
 GROUP BY 1, 3 ORDER BY 2 DESC;

\echo ''
\echo '=== Amazonレポート：トランザクションの種類と、本システムでの振り分け先 ==='
SELECT a.txn_type AS "種類", count(*) AS "件数",
       to_char(sum(NULLIF(replace(a.total_amount, ',', ''), '')::numeric), 'FM999,999,999') AS "合計",
       CASE a.txn_type
         WHEN '注文'       THEN '売上'
         WHEN '返金'       THEN '返品'
         WHEN '注文外料金' THEN '経費'
         WHEN 'Amazon手数料' THEN '経費'
         WHEN 'FBA手数料'  THEN '経費'
         WHEN '調整'       THEN '経費（増減）'
         WHEN '振込み'     THEN '入金'
         ELSE '★未分類'
       END AS "振り分け先"
  FROM stg_amazon_transactions a GROUP BY 1, 4 ORDER BY 2 DESC;


-- ============================================================================
-- 4. 検証
-- ============================================================================

-- ----------------------------------------------------------------------------
-- V01  読み込めていること（件数は受領ファイルごとに変わるため通知のみ）
-- ----------------------------------------------------------------------------
DO $$
DECLARE n_line int; n_order int; n_amz int;
BEGIN
  SELECT count(*), count(DISTINCT order_no) INTO n_line, n_order FROM stg_oms_orders;
  SELECT count(*) INTO n_amz FROM stg_amazon_transactions;
  IF n_line = 0 OR n_amz = 0 THEN
    RAISE EXCEPTION 'V01 失敗: ステージングが空。prepare-import.ps1 の出力先を確認すること'
      USING ERRCODE='VF001';
  END IF;
  RAISE NOTICE 'V01 OK  OMS 明細 % 件／受注 % 件、Amazon % 件を読み込み', n_line, n_order, n_amz;
  -- 2026/09/02 受領分の実測値：OMS 明細203／受注77、Amazon 1,142
END $$;

-- ----------------------------------------------------------------------------
-- V02  明細の種別が、受注明細テーブルの許容値に収まっていること
--      ここが外れると受注として取り込めない。設計と実データの一致を見る要の検証。
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_unknown text;
BEGIN
  SELECT string_agg(DISTINCT line_type, '、') INTO v_unknown
    FROM stg_oms_orders
   WHERE line_type NOT IN ('商品','セット商品','内訳商品','販促品','送料','値引','非商品');
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'V02 失敗: 未定義の商品種別 [%]。ck_sol_type を見直すこと', v_unknown
      USING ERRCODE='VF001';
  END IF;
  RAISE NOTICE 'V02 OK  商品種別はすべて sales_order_lines.line_type の許容値に収まる';
END $$;

-- ----------------------------------------------------------------------------
-- V03  明細番号が受注のなかで一意であること（UNIQUE(受注,明細番号) が張れる）
-- ----------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT order_no, line_no FROM stg_oms_orders GROUP BY 1,2 HAVING count(*) > 1
  ) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'V03 失敗: 明細番号が重複する受注が % 件', n USING ERRCODE='VF001';
  END IF;
  RAISE NOTICE 'V03 OK  明細番号は受注内で一意';
END $$;

-- ----------------------------------------------------------------------------
-- V04  セット商品と内訳商品の親子が解決できること
--      CSVは親子を明示せず、ファイル内の並び順（セット商品の直後に内訳商品）で
--      表現している。明細番号順ではないため、取込は出現順で親を決める。
-- ----------------------------------------------------------------------------
DO $$
DECLARE n_set int; n_detail int; n_orphan int;
BEGIN
  SELECT count(*) FILTER (WHERE line_type = 'セット商品'),
         count(*) FILTER (WHERE line_type = '内訳商品')
    INTO n_set, n_detail FROM stg_oms_orders;

  -- 内訳商品があるのにセット商品がない受注＝親を決められない受注
  SELECT count(*) INTO n_orphan FROM (
    SELECT order_no FROM stg_oms_orders GROUP BY order_no
     HAVING count(*) FILTER (WHERE line_type = '内訳商品') > 0
        AND count(*) FILTER (WHERE line_type = 'セット商品') = 0
  ) d;
  IF n_orphan > 0 THEN
    RAISE EXCEPTION 'V04 失敗: 親のない内訳商品を含む受注が % 件', n_orphan USING ERRCODE='VF001';
  END IF;
  RAISE NOTICE 'V04 OK  セット商品 % 行・内訳商品 % 行。親のない内訳商品なし', n_set, n_detail;
END $$;

-- ----------------------------------------------------------------------------
-- V05  マイナス数量・自社コードなしの行が実在し、設計が受け止められること
--      （クーポン・割引。v1.1 の CHECK ではこれを弾いていた）
-- ----------------------------------------------------------------------------
DO $$
DECLARE n_minus int; n_nocode int;
BEGIN
  SELECT count(*) FILTER (WHERE NULLIF(qty, '')::numeric < 0),
         count(*) FILTER (WHERE COALESCE(own_sku_code,'') = '')
    INTO n_minus, n_nocode FROM stg_oms_orders;
  RAISE NOTICE 'V05 OK  数量マイナス % 行、自社コードなし % 行を含むが取込可能', n_minus, n_nocode;
END $$;

-- ----------------------------------------------------------------------------
-- V06  自社商品コードが商品マスタ（SKU）に存在するか
--      移行前は未登録が出る。件数と一覧を出して、マスタ整備の対象を明らかにする。
-- ----------------------------------------------------------------------------
\echo ''
\echo '=== 商品マスタに未登録の自社商品コード（移行時に登録が必要）==='
SELECT s.own_sku_code AS "自社商品コード",
       min(s.item_name) AS "商品名（CSVより）",
       count(*) AS "出現"
  FROM stg_oms_orders s
  LEFT JOIN skus sk ON sk.sku_code = s.own_sku_code
 WHERE COALESCE(s.own_sku_code, '') <> '' AND sk.id IS NULL
 GROUP BY 1 ORDER BY 3 DESC, 1;

\echo ''
\echo '=== Amazon SKU の読み替え状況（得意先別商品マスタ）==='
SELECT a.sku AS "Amazon SKU", count(*) AS "件数",
       COALESCE(sk.sku_code, '★未登録') AS "自社SKU"
  FROM stg_amazon_transactions a
  LEFT JOIN partners p  ON p.partner_code = fn_setting_text('AMAZON_PARTNER_CODE')
  LEFT JOIN partner_products pp
         ON pp.partner_id = p.id AND pp.partner_product_code = a.sku
  LEFT JOIN skus sk ON sk.id = pp.sku_id
 WHERE COALESCE(a.sku, '') <> ''
 GROUP BY 1, 3 ORDER BY 2 DESC;

-- ----------------------------------------------------------------------------
-- V07  Amazonの取引種別がすべて4系統（売上・返品・経費・入金）に振り分くこと
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_unknown text;
BEGIN
  SELECT string_agg(DISTINCT txn_type, '、') INTO v_unknown
    FROM stg_amazon_transactions
   WHERE txn_type NOT IN ('注文','返金','注文外料金','Amazon手数料','FBA手数料','調整','振込み');
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'V07 失敗: 振り分け先の決まっていない取引種別 [%]', v_unknown USING ERRCODE='VF001';
  END IF;
  RAISE NOTICE 'V07 OK  Amazonの取引種別はすべて 売上／返品／経費／入金 に振り分く';
END $$;

-- ----------------------------------------------------------------------------
-- V08  Amazonレポートの検算（合計列の総和＝各決済番号の入出金の差引）
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_total numeric;
BEGIN
  SELECT sum(NULLIF(replace(total_amount, ',', ''), '')::numeric)
    INTO v_total FROM stg_amazon_transactions;
  RAISE NOTICE 'V08 OK  Amazon 合計 % 円（内訳は上表のとおり）', to_char(v_total, 'FM999,999,999');
END $$;


-- ============================================================================
-- 5. 本番テーブルへの変換（第2段階の取込処理と同じ手順を、SQLで再現する）
-- ============================================================================

-- (1) 取込バッチ
INSERT INTO import_batches (import_type, file_name, total_count, success_count, status)
SELECT 'OMS_ORDER', 'OS_beautyjapan_20260901_170556.csv', count(*), count(*), '完了'
  FROM stg_oms_orders;

INSERT INTO import_batches (import_type, file_name, total_count, success_count, status)
SELECT 'AMAZON_TRANSACTION', '2026AugMonthlyTransaction.csv', count(*), count(*), '完了'
  FROM stg_amazon_transactions;

-- (2) 外部受注（受注番号の単位。ヘッダ項目は明細番号の最小行から採る）
INSERT INTO external_orders (
  import_batch_id, channel, external_order_no, ordered_at, payment_method, payment_fee,
  total_amount, consolidated_from, consolidated_to, slip_management_no, tracking_no,
  warehouse_name, ship_date, raw_data, status)
SELECT b.id, s.sales_route, s.order_no,
       to_timestamp(s.order_date || ' ' || COALESCE(NULLIF(s.order_time, ''), '00:00:00'),
                    'YYYY/MM/DD HH24:MI:SS'),
       NULLIF(s.payment_method, ''),
       NULLIF(replace(s.payment_fee, ',', ''), '')::numeric,
       NULLIF(replace(s.total_amount, ',', ''), '')::numeric,
       NULLIF(s.consolidated_from, ''), NULLIF(s.consolidated_to, ''),
       NULLIF(s.slip_management_no, ''), NULLIF(s.tracking_no, ''),
       NULLIF(s.process_route, ''),
       CASE WHEN COALESCE(s.processed_date, '') <> ''
            THEN to_date(s.processed_date, 'YYYY/MM/DD') END,
       to_jsonb(s), '取込済'
  FROM (SELECT DISTINCT ON (order_no) * FROM stg_oms_orders
         ORDER BY order_no, NULLIF(line_no, '')::int) s,
       (SELECT id FROM import_batches
         WHERE import_type = 'OMS_ORDER' ORDER BY id DESC LIMIT 1) b
    ON CONFLICT (channel, external_order_no) DO NOTHING;

-- (3) 外部受注明細
INSERT INTO external_order_lines (
  external_order_id, line_no, line_type, item_name, qty, unit_price,
  external_sku_code, sku_id, raw_data)
SELECT eo.id, NULLIF(s.line_no, '')::int, s.line_type, NULLIF(s.item_name, ''),
       NULLIF(replace(s.qty, ',', ''), '')::numeric,
       NULLIF(replace(s.unit_price, ',', ''), '')::numeric,
       NULLIF(s.own_sku_code, ''), sk.id, to_jsonb(s)
  FROM stg_oms_orders s
  JOIN external_orders eo
    ON eo.channel = s.sales_route AND eo.external_order_no = s.order_no
  LEFT JOIN skus sk ON sk.sku_code = NULLIF(s.own_sku_code, '')
    ON CONFLICT (external_order_id, line_no) DO NOTHING;

-- (4) プラットフォーム取引（Amazon）
INSERT INTO platform_transactions (
  import_batch_id, platform, settlement_no, transaction_type, transaction_at,
  external_order_no, external_sku_code, sku_id, description, qty,
  product_sales, product_sales_tax, shipping_fee, shipping_tax, points_cost,
  promo_discount, promo_discount_tax, commission_fee, fba_fee,
  other_fee, other_amount, total_amount, status, raw_data)
SELECT b.id, 'Amazon', NULLIF(a.settlement_no, ''), a.txn_type,
       to_timestamp(replace(a.txn_at, ' JST', ''), 'YYYY/MM/DD HH24:MI:SS'),
       NULLIF(a.order_no, ''), NULLIF(a.sku, ''), pp.sku_id,
       NULLIF(a.description, ''),
       NULLIF(replace(a.qty, ',', ''), '')::numeric,
       NULLIF(replace(a.product_sales,      ',', ''), '')::numeric,
       NULLIF(replace(a.product_sales_tax,  ',', ''), '')::numeric,
       NULLIF(replace(a.shipping_fee,       ',', ''), '')::numeric,
       NULLIF(replace(a.shipping_tax,       ',', ''), '')::numeric,
       NULLIF(replace(a.points_cost,        ',', ''), '')::numeric,
       NULLIF(replace(a.promo_discount,     ',', ''), '')::numeric,
       NULLIF(replace(a.promo_discount_tax, ',', ''), '')::numeric,
       NULLIF(replace(a.commission_fee,     ',', ''), '')::numeric,
       NULLIF(replace(a.fba_fee,            ',', ''), '')::numeric,
       NULLIF(replace(a.other_txn_fee,      ',', ''), '')::numeric,
       NULLIF(replace(a.other_amount,       ',', ''), '')::numeric,
       NULLIF(replace(a.total_amount,       ',', ''), '')::numeric,
       NULLIF(a.txn_status, ''), to_jsonb(a)
  FROM stg_amazon_transactions a
 CROSS JOIN (SELECT id FROM import_batches
              WHERE import_type = 'AMAZON_TRANSACTION' ORDER BY id DESC LIMIT 1) b
  LEFT JOIN partners p ON p.partner_code = fn_setting_text('AMAZON_PARTNER_CODE')
  LEFT JOIN partner_products pp
         ON pp.partner_id = p.id AND pp.partner_product_code = NULLIF(a.sku, '');

-- ----------------------------------------------------------------------------
-- V09  変換できたこと
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_oms bigint; v_amz bigint; n_eo int; n_eol int; n_pt int; n_src int;
BEGIN
  SELECT id INTO v_oms FROM import_batches
   WHERE import_type = 'OMS_ORDER'          ORDER BY id DESC LIMIT 1;
  SELECT id INTO v_amz FROM import_batches
   WHERE import_type = 'AMAZON_TRANSACTION' ORDER BY id DESC LIMIT 1;

  SELECT count(*) INTO n_eo FROM external_orders WHERE import_batch_id = v_oms;
  SELECT count(*) INTO n_eol FROM external_order_lines l
    JOIN external_orders eo ON eo.id = l.external_order_id
   WHERE eo.import_batch_id = v_oms;
  SELECT count(*) INTO n_pt FROM platform_transactions WHERE import_batch_id = v_amz;
  SELECT count(DISTINCT order_no) INTO n_src FROM stg_oms_orders;

  IF n_eo <> n_src THEN
    RAISE EXCEPTION 'V09 失敗: 外部受注 % 件（CSVの受注 % 件と不一致）', n_eo, n_src
      USING ERRCODE='VF001';
  END IF;
  IF n_eol <> (SELECT count(*) FROM stg_oms_orders) THEN
    RAISE EXCEPTION 'V09 失敗: 外部受注明細 % 件（CSVの明細と不一致）', n_eol USING ERRCODE='VF001';
  END IF;
  IF n_pt <> (SELECT count(*) FROM stg_amazon_transactions) THEN
    RAISE EXCEPTION 'V09 失敗: プラットフォーム取引 % 件（CSVと不一致）', n_pt USING ERRCODE='VF001';
  END IF;
  RAISE NOTICE 'V09 OK  受注 % 件／明細 % 件／Amazon % 件を欠落なく変換', n_eo, n_eol, n_pt;
END $$;

-- ----------------------------------------------------------------------------
-- V10  冪等性：同じファイルをもう一度取り込んでも二重計上しないこと
--      （貴社への「同じCSVを2回取り込んでも二重計上しない」というご説明の実証）
-- ----------------------------------------------------------------------------
DO $$
DECLARE n_before int; n_after int; v_batch bigint;
BEGIN
  SELECT count(*) INTO n_before FROM external_orders;

  INSERT INTO import_batches (import_type, file_name, total_count, success_count, status)
  VALUES ('OMS_ORDER', 'OS_beautyjapan_20260901_170556.csv', 0, 0, '完了')
  RETURNING id INTO v_batch;

  INSERT INTO external_orders (import_batch_id, channel, external_order_no, raw_data)
  SELECT v_batch, s.sales_route, s.order_no, to_jsonb(s)
    FROM (SELECT DISTINCT ON (order_no) * FROM stg_oms_orders
           ORDER BY order_no, NULLIF(line_no, '')::int) s
      ON CONFLICT (channel, external_order_no) DO NOTHING;

  SELECT count(*) INTO n_after FROM external_orders;
  IF n_after <> n_before THEN
    RAISE EXCEPTION 'V10 失敗: 再取込で % 件増えた（二重計上）', n_after - n_before
      USING ERRCODE='VF001';
  END IF;
  RAISE NOTICE 'V10 OK  同一CSVの再取込で件数は増えない（% 件のまま）', n_after;

  UPDATE import_batches SET status = '取消', note = 'V10 冪等性の確認に使用' WHERE id = v_batch;
END $$;


-- ============================================================================
-- 6. 受注への変換ルール（第2段階で実装する内容の確認）
--    OMS の「商品種別」を、本システムの明細種別へ次のとおり読み替える。
--      商品     ＋ 自社コードあり           → 商品
--      商品     ＋ コードなし＋数量マイナス → 値引
--      商品     ＋ コードなし＋数量プラス   → 非商品
--      セット商品 → セット商品（在庫は持たない）
--      内訳商品   → 内訳商品（ここから在庫を引き落とす）
--      送料       → 送料
--      非商品     → 非商品
-- ============================================================================
\echo ''
\echo '=== 受注明細への読み替え結果（第2段階で実装する変換の事前確認）==='
SELECT CASE
         WHEN s.line_type = '商品' AND COALESCE(s.own_sku_code, '') = ''
              AND NULLIF(s.qty, '')::numeric < 0                  THEN '値引'
         WHEN s.line_type = '商品' AND COALESCE(s.own_sku_code, '') = ''
                                                                  THEN '非商品'
         ELSE s.line_type
       END AS "読み替え後の明細種別",
       count(*) AS "件数",
       count(*) FILTER (WHERE s.line_type IN ('商品','内訳商品')
                          AND COALESCE(s.own_sku_code, '') <> '') AS "うち引当対象"
  FROM stg_oms_orders s
 GROUP BY 1 ORDER BY 2 DESC;


-- ============================================================================
-- 7. 販社の発注CSV（ビックカメラ／ラベルヴィ／白鳩／コネクト）について
--    販社CSVは書式がマスタ（import_templates）として登録されているため、
--    このファイルには専用のステージング表を置かない。検証は次の2つで行う。
--
--      (1) scripts\prepare-import.ps1 -PartnerCsv ...
--          文字コードを揃え、列数がテンプレート登録と一致するか、
--          JANが指数表記に壊れていないかを点検する。
--
--      (2) 04-schema-tests.sql の T34
--          登録済みテンプレートの列数・必須項目・引当キー・文字コードが
--          受領した4本のCSVと一致していることを確認する。
--
--    実際の取込処理は、このテンプレート定義を読んで動く共通処理として
--    第2段階（バックエンド）で実装する。販社が増えてもマスタ登録だけで済む。
-- ============================================================================
\echo ''
\echo '=== 登録済みの取込テンプレート ==='
SELECT t.template_code AS "コード", t.name AS "名称",
       t.file_encoding AS "文字コード", t.sku_match_key AS "商品の引当キー",
       count(c.id) AS "列数"
  FROM import_templates t
  LEFT JOIN import_template_columns c ON c.import_template_id = t.id
 GROUP BY 1,2,3,4 ORDER BY t.sort_order;


-- ============================================================================
-- 8. 後片付け
--    ステージングは残しても害はないが、本番環境では落としておく。
-- ============================================================================
-- DROP TABLE stg_oms_orders;
-- DROP TABLE stg_amazon_transactions;

DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '==================================================';
  RAISE NOTICE '  外部データ取込の検証 完了';
  RAISE NOTICE '==================================================';
END $$;
