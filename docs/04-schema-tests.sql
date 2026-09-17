-- ============================================================================
--  株式会社コニー 販売管理システム  スキーマ受入テスト
--  v1.6  2026-09-10
--  02-schema.sql → 03-seed-data.sql を適用した直後の空データベースで実行する。
--  1件でも失敗すると ERROR で停止する（成功時のみ最後まで到達する）。
--  失敗時の独自エラーコード：TF001
--
--  ※ 本ファイルはテスト用のデータを投入する。続けて2回実行することはできない。
--    もう一度実行する場合は 02-schema.sql から流し直すこと（冒頭の T00 で検知する）。
--
--  v1.4 の追加
--    T00      2回実行の検知
--    T39/T39b/T39c  ロイヤリティ規定（販売先ごとの発生／対象外、二重登録の防止）
--    T40/T40b       ロイヤリティ計算表（支払先ごと月1枚、販売先別の内訳）
--
--  psql / Navicat / pgAdmin のいずれでも実行できる（psql 専用コマンドは使わない）。
--  各ブロックの区切りは $b01$ … $b27$ のように名前を付けている。素の $$ だと、
--  ツールによっては対応関係を取り違えてブロックの途中で文を切ってしまうため。
--  psql の場合は -v ON_ERROR_STOP=1 を付けること。
--    psql -v ON_ERROR_STOP=1 -f docs/04-schema-tests.sql
-- ============================================================================

SET client_encoding = 'UTF8';
SET search_path = cony, public;

-- ----------------------------------------------------------------------------
-- T00  前回のテストデータが残っていないこと
--   本ファイルはテスト用のデータを投入するため、2回続けて実行すると
--   一意制約に弾かれる。原因が分かりにくいので、先に検知して止める。
-- ----------------------------------------------------------------------------
DO $b01$
DECLARE n int;
BEGIN
  SELECT (SELECT count(*) FROM media    WHERE code IN ('TV'))
       + (SELECT count(*) FROM brands   WHERE code IN ('LX','AS'))
       + (SELECT count(*) FROM partners WHERE partner_code IN
            ('P001','P002','AMZN','S001','LIC1'))
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION E'前回のテストデータが残っています（該当 % 件）。\n02-schema.sql から順に流し直してから、もう一度このファイルを実行してください。\n  02-schema.sql → 03-seed-data.sql → 07-verify-objects.sql → 04-schema-tests.sql\n02 の冒頭でスキーマを作り直すため、前回の内容はすべて消えてから作り直されます。', n
      USING ERRCODE='TF002';
  END IF;
  RAISE NOTICE 'T00 OK  空のデータベースであることを確認';
END $b01$;

-- ----------------------------------------------------------------------------
-- T01〜T04  スキーマ・初期データの整合
-- ----------------------------------------------------------------------------
DO $b02$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
   WHERE table_schema='cony' AND table_type='BASE TABLE';
  IF n <> 70 THEN
    RAISE EXCEPTION 'T01 失敗: テーブル数が % 件（期待 70 件）', n USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T01 OK  テーブル数 70';

  SELECT count(*) INTO n FROM pg_type t JOIN pg_namespace ns ON ns.oid=t.typnamespace
   WHERE ns.nspname='cony' AND t.typtype='d' AND t.typname IN ('money_amt','qty_num','tax_rate');
  IF n <> 3 THEN
    RAISE EXCEPTION 'T02 失敗: ドメイン数が % 件（期待 3 件）', n USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T02 OK  ドメイン money_amt / qty_num / tax_rate';

  SELECT count(*) INTO n FROM code_categories;
  IF n <> 23 THEN RAISE EXCEPTION 'T03 失敗: 区分カテゴリー % 件（期待 23 件）', n USING ERRCODE='TF001'; END IF;
  SELECT count(*) INTO n FROM sales_categories;
  IF n <> 3  THEN RAISE EXCEPTION 'T03 失敗: 販売カテゴリー % 件（期待 3 件）', n USING ERRCODE='TF001'; END IF;
  SELECT count(*) INTO n FROM roles;
  IF n <> 4  THEN RAISE EXCEPTION 'T03 失敗: ロール % 件（期待 4 件）', n USING ERRCODE='TF001'; END IF;
  SELECT count(*) INTO n FROM warehouses;
  IF n <> 4  THEN RAISE EXCEPTION 'T03 失敗: 倉庫 % 件（期待 4 件）', n USING ERRCODE='TF001'; END IF;
  SELECT count(*) INTO n FROM numbering_rules;
  IF n <> 11 THEN RAISE EXCEPTION 'T03 失敗: 採番ルール % 件（期待 11 件）', n USING ERRCODE='TF001'; END IF;
  RAISE NOTICE 'T03 OK  初期データ（区分23／販売カテゴリー3／ロール4／倉庫4／採番11）';

  SELECT count(*) INTO n FROM codes c JOIN code_categories cc ON cc.id=c.code_category_id
   WHERE cc.code='QUALITY_DIVISION';
  IF n <> 3 THEN RAISE EXCEPTION 'T04 失敗: 品質区分 % 件（期待 3 件）', n USING ERRCODE='TF001'; END IF;
  RAISE NOTICE 'T04 OK  品質区分 良品／不良／返品検品待ち';

  SELECT count(*) INTO n FROM warehouses
   WHERE short_name IN ('コニー倉庫(EC)','コニー倉庫(交換・修理)',
                        'コニー倉庫(美整体直販)','コニー倉庫(コニーストア)');
  IF n <> 4 THEN
    RAISE EXCEPTION 'T04b 失敗: 倉庫名が実データと一致しない（% 件一致）', n USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T04b OK  倉庫名が OMS 受注CSV の「処理ルート」4値と一致';
END $b02$;

-- ----------------------------------------------------------------------------
-- テスト用データの投入
-- ----------------------------------------------------------------------------
INSERT INTO media (code, name) VALUES ('TV', 'テレビ');
INSERT INTO brands (code, name) VALUES ('LX', 'LUXCEAR'), ('AS', '芦屋美整体');
INSERT INTO colors (code, name) VALUES ('03', 'シフォンピンク'), ('02', 'ベージュ');
INSERT INTO sizes  (code, name) VALUES ('06', 'L'), ('04', 'M');

INSERT INTO partners (partner_code, name1, is_customer, is_supplier, closing_day) VALUES
  ('P001', 'テスト販社',   true,  false, 99),
  ('AMZN', 'Amazon',       true,  false, 99),
  ('S001', 'テスト仕入先', false, true,  99);

INSERT INTO delivery_destinations (partner_id, delivery_code, name, partner_delivery_no, default_warehouse_id)
SELECT p.id, 'D001', 'テスト納品先', 'CL-0001', w.id
  FROM partners p, warehouses w
 WHERE p.partner_code='P001' AND w.warehouse_code='0001';

INSERT INTO products (product_code, product_name, brand_id, cost_price, tax_rate, is_set)
SELECT 'FT1196', '滑らかシームレスエアーHOT', b.id, 1200, 10.00, false FROM brands b WHERE b.code='LX';
INSERT INTO products (product_code, product_name, brand_id, cost_price, tax_rate, is_set)
SELECT 'FT1198', '滑らかシームレスエアー10', b.id, 1500, 10.00, false FROM brands b WHERE b.code='LX';
INSERT INTO products (product_code, product_name, brand_id, cost_price, tax_rate, is_set)
SELECT 'FT1198-1', '滑らかシームレスエアー10 2枚組', b.id, 0, 10.00, true FROM brands b WHERE b.code='LX';
INSERT INTO products (product_code, product_name, brand_id, cost_price, tax_rate, is_set)
SELECT 'CS2420', 'LUXCEAR Fornez PRO', b.id, 3000, 10.00, false FROM brands b WHERE b.code='LX';

INSERT INTO skus (product_id, sku_code, color_id, size_id, pack_division, jan)
SELECT p.id, 'FT1196-0306-100', c.id, s.id, '100', '4900000000011'
  FROM products p, colors c, sizes s WHERE p.product_code='FT1196' AND c.code='03' AND s.code='06';
INSERT INTO skus (product_id, sku_code, color_id, size_id, pack_division, jan)
SELECT p.id, 'FT1198-0204-100', c.id, s.id, '100', '4900000000028'
  FROM products p, colors c, sizes s WHERE p.product_code='FT1198' AND c.code='02' AND s.code='04';
INSERT INTO skus (product_id, sku_code, pack_division)
SELECT p.id, 'FT1198-11606-200', '200' FROM products p WHERE p.product_code='FT1198-1';
INSERT INTO skus (product_id, sku_code, pack_division)
SELECT p.id, 'CS2420-0000-100', '100' FROM products p WHERE p.product_code='CS2420';

-- セット構成：2枚組 ＝ FT1198 単品 × 2
INSERT INTO set_headers (sku_id) SELECT id FROM skus WHERE sku_code='FT1198-11606-200';
INSERT INTO set_components (set_header_id, component_sku_id, qty)
SELECT h.id, s.id, 2 FROM set_headers h, skus s
 WHERE h.sku_id=(SELECT id FROM skus WHERE sku_code='FT1198-11606-200')
   AND s.sku_code='FT1198-0204-100';

-- 取引先別商品（Amazon 専用コードの読み替え）
INSERT INTO partner_products (partner_id, sku_id, partner_product_code, sales_name, unit_price)
SELECT p.id, s.id, 'TO-GXZN-60W8', 'LUXCEAR Fornez PRO（Amazon）', 7255
  FROM partners p, skus s WHERE p.partner_code='AMZN' AND s.sku_code='CS2420-0000-100';
INSERT INTO partner_products (partner_id, sku_id, partner_product_code, sales_name, unit_price)
SELECT p.id, s.id, 'CL-A-001', '販社向け商品名', 3500
  FROM partners p, skus s WHERE p.partner_code='P001' AND s.sku_code='FT1196-0306-100';

-- 在庫（良品 100個）
INSERT INTO stocks (sku_id, warehouse_id, quality_code_id, qty_on_hand)
SELECT s.id, w.id, q.id, 100
  FROM skus s, warehouses w,
       (SELECT c.id FROM codes c JOIN code_categories cc ON cc.id=c.code_category_id
         WHERE cc.code='QUALITY_DIVISION' AND c.code='GOOD') q
 WHERE s.sku_code='FT1196-0306-100' AND w.warehouse_code='0001';
INSERT INTO stocks (sku_id, warehouse_id, quality_code_id, qty_on_hand)
SELECT s.id, w.id, q.id, 50
  FROM skus s, warehouses w,
       (SELECT c.id FROM codes c JOIN code_categories cc ON cc.id=c.code_category_id
         WHERE cc.code='QUALITY_DIVISION' AND c.code='GOOD') q
 WHERE s.sku_code='FT1198-0204-100' AND w.warehouse_code='0001';

-- ----------------------------------------------------------------------------
-- T05  有効在庫の生成列
-- ----------------------------------------------------------------------------
DO $b03$
DECLARE av numeric;
BEGIN
  UPDATE stocks SET qty_allocated = 30
   WHERE sku_id = (SELECT id FROM skus WHERE sku_code='FT1196-0306-100');
  SELECT qty_available INTO av FROM stocks
   WHERE sku_id = (SELECT id FROM skus WHERE sku_code='FT1196-0306-100');
  IF av <> 70 THEN
    RAISE EXCEPTION 'T05 失敗: 有効在庫が %（期待 70）', av USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T05 OK  有効在庫＝実在庫−引当済（100−30＝70）';
  UPDATE stocks SET qty_allocated = 0
   WHERE sku_id = (SELECT id FROM skus WHERE sku_code='FT1196-0306-100');
END $b03$;

-- ----------------------------------------------------------------------------
-- T06〜T08  在庫の整合性制約
-- ----------------------------------------------------------------------------
DO $b04$
BEGIN
  BEGIN
    UPDATE stocks SET qty_allocated = 999
     WHERE sku_id = (SELECT id FROM skus WHERE sku_code='FT1196-0306-100');
    RAISE EXCEPTION 'T06 失敗: 引当済＞実在庫が通ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T06 OK  引当済＞実在庫を拒否';
  END;

  BEGIN
    UPDATE stocks SET qty_on_hand = -1
     WHERE sku_id = (SELECT id FROM skus WHERE sku_code='FT1196-0306-100');
    RAISE EXCEPTION 'T07 失敗: 実在庫の負数が通ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T07 OK  実在庫の負数を拒否';
  END;

  BEGIN
    INSERT INTO stocks (sku_id, warehouse_id, quality_code_id, qty_on_hand)
    SELECT s.id, w.id, q.id, 10
      FROM skus s, warehouses w,
           (SELECT c.id FROM codes c JOIN code_categories cc ON cc.id=c.code_category_id
             WHERE cc.code='QUALITY_DIVISION' AND c.code='GOOD') q
     WHERE s.sku_code='FT1196-0306-100' AND w.warehouse_code='0001';
    RAISE EXCEPTION 'T08 失敗: 在庫の重複行が作れてしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T08 OK  (SKU×倉庫×ロット×品質区分) の一意性';
  END;
END $b04$;

-- ----------------------------------------------------------------------------
-- T09  引当 → 引当解除で有効在庫が戻り、実在庫は不変
-- ----------------------------------------------------------------------------
DO $b05$
DECLARE
  v_order_id bigint; v_line_id bigint; v_stock_id bigint; v_alloc_id bigint;
  on_hand0 numeric; avail0 numeric; on_hand1 numeric; avail1 numeric;
  on_hand2 numeric; avail2 numeric;
BEGIN
  SELECT id, qty_on_hand, qty_available INTO v_stock_id, on_hand0, avail0
    FROM stocks WHERE sku_id=(SELECT id FROM skus WHERE sku_code='FT1196-0306-100');

  INSERT INTO sales_orders (order_no, order_type, partner_id, delivery_destination_id,
                            sales_category_id, order_date, status)
  SELECT 'SO-TEST-001', '卸', p.id, d.id, sc.id, CURRENT_DATE, '未確定'
    FROM partners p, delivery_destinations d, sales_categories sc
   WHERE p.partner_code='P001' AND d.delivery_code='D001' AND sc.code='OA'
  RETURNING id INTO v_order_id;

  INSERT INTO sales_order_lines (sales_order_id, line_no, line_type, sku_id, item_name, qty, unit_price, tax_rate, amount)
  SELECT v_order_id, 1, '商品', s.id, '販社向け商品名', 20, 3500, 10.00, 70000
    FROM skus s WHERE s.sku_code='FT1196-0306-100'
  RETURNING id INTO v_line_id;

  -- 引当
  UPDATE stocks SET qty_allocated = qty_allocated + 20 WHERE id = v_stock_id;
  INSERT INTO allocations (sales_order_line_id, stock_id, sku_id, qty, status)
  SELECT v_line_id, v_stock_id, s.id, 20, '引当中' FROM skus s WHERE s.sku_code='FT1196-0306-100'
  RETURNING id INTO v_alloc_id;
  INSERT INTO stock_movements (stock_id, movement_type, ref_table, ref_id, qty, qty_before, qty_after)
  VALUES (v_stock_id, '引当', 'sales_order_lines', v_line_id, 20, avail0, avail0 - 20);

  SELECT qty_on_hand, qty_available INTO on_hand1, avail1 FROM stocks WHERE id = v_stock_id;
  IF on_hand1 <> on_hand0 THEN
    RAISE EXCEPTION 'T09 失敗: 引当で実在庫が変動した（% → %）', on_hand0, on_hand1 USING ERRCODE='TF001';
  END IF;
  IF avail1 <> avail0 - 20 THEN
    RAISE EXCEPTION 'T09 失敗: 引当後の有効在庫が %（期待 %）', avail1, avail0-20 USING ERRCODE='TF001';
  END IF;

  -- 引当解除（出荷一覧からの削除）
  UPDATE allocations SET status='解除', released_at=now() WHERE id = v_alloc_id;
  UPDATE stocks SET qty_allocated = qty_allocated - 20 WHERE id = v_stock_id;
  INSERT INTO stock_movements (stock_id, movement_type, ref_table, ref_id, qty, qty_before, qty_after)
  VALUES (v_stock_id, '引当解除', 'sales_order_lines', v_line_id, -20, avail1, avail1 + 20);

  SELECT qty_on_hand, qty_available INTO on_hand2, avail2 FROM stocks WHERE id = v_stock_id;
  IF on_hand2 <> on_hand0 THEN
    RAISE EXCEPTION 'T09 失敗: 引当解除で実在庫が変動した' USING ERRCODE='TF001';
  END IF;
  IF avail2 <> avail0 THEN
    RAISE EXCEPTION 'T09 失敗: 引当解除後の有効在庫が %（期待 %）', avail2, avail0 USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T09 OK  引当解除で有効在庫が戻り、実在庫は不変（実在庫 % のまま）', on_hand0;
END $b05$;

-- ----------------------------------------------------------------------------
-- T10  セット商品は在庫を持たず、構成商品から引き落とす
-- ----------------------------------------------------------------------------
DO $b06$
DECLARE n int; comp_avail numeric;
BEGIN
  SELECT count(*) INTO n FROM stocks st
    JOIN skus s ON s.id = st.sku_id JOIN products p ON p.id = s.product_id
   WHERE p.is_set = true;
  IF n <> 0 THEN
    RAISE EXCEPTION 'T10 失敗: セット商品に在庫行が % 件存在する', n USING ERRCODE='TF001';
  END IF;

  -- セット2個の受注 → 構成品を 2×2＝4 個引き当てる
  SELECT sc.component_sku_id, 0 INTO n, comp_avail
    FROM set_components sc JOIN set_headers h ON h.id = sc.set_header_id
    JOIN skus s ON s.id = h.sku_id WHERE s.sku_code='FT1198-11606-200';

  UPDATE stocks SET qty_allocated = qty_allocated + 4
   WHERE sku_id = (SELECT sc.component_sku_id FROM set_components sc
                     JOIN set_headers h ON h.id = sc.set_header_id
                     JOIN skus s ON s.id = h.sku_id
                    WHERE s.sku_code='FT1198-11606-200');
  SELECT qty_available INTO comp_avail FROM stocks
   WHERE sku_id = (SELECT id FROM skus WHERE sku_code='FT1198-0204-100');
  IF comp_avail <> 46 THEN
    RAISE EXCEPTION 'T10 失敗: 構成品の有効在庫が %（期待 46）', comp_avail USING ERRCODE='TF001';
  END IF;
  UPDATE stocks SET qty_allocated = 0
   WHERE sku_id = (SELECT id FROM skus WHERE sku_code='FT1198-0204-100');
  RAISE NOTICE 'T10 OK  セットは在庫を持たず、構成品から引き落とし（50−4＝46）';
END $b06$;

-- ----------------------------------------------------------------------------
-- T11〜T13  受注の業務ルール
-- ----------------------------------------------------------------------------
DO $b07$
DECLARE v_order_id bigint;
BEGIN
  BEGIN
    INSERT INTO sales_orders (order_no, order_type, partner_id, sales_category_id, order_date)
    SELECT 'SO-TEST-NG', '卸', p.id, sc.id, CURRENT_DATE
      FROM partners p, sales_categories sc WHERE p.partner_code='P001' AND sc.code='OA';
    RAISE EXCEPTION 'T11 失敗: 卸受注で納品先なしが通ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T11 OK  卸受注は納品先が必須';
  END;

  -- 通販受注（直送）：個人宛のみ、納品先なしで登録できる
  INSERT INTO sales_orders (order_no, order_type, partner_id, sales_category_id, order_date,
                            direct_name, direct_postal_code, direct_address1, channel)
  SELECT 'SO-TEST-002', '通販', p.id, sc.id, CURRENT_DATE,
         'テスト 太郎', '1000001', '東京都千代田区', '自社サイト'
    FROM partners p, sales_categories sc WHERE p.partner_code='P001' AND sc.code='WEB'
  RETURNING id INTO v_order_id;

  -- 商品行
  INSERT INTO sales_order_lines (sales_order_id, line_no, line_type, sku_id, item_name, qty, unit_price, tax_rate, amount)
  SELECT v_order_id, 1, '商品', s.id, '滑らかシームレスエアーHOT', 1, 7255, 10.00, 7255
    FROM skus s WHERE s.sku_code='FT1196-0306-100';

  -- 販促品行（個数 −1）
  INSERT INTO sales_order_lines (sales_order_id, line_no, line_type, sku_id, item_name, qty, unit_price, tax_rate, amount)
  SELECT v_order_id, 2, '販促品', s.id, '2026年夏の粗品特別値引', -1, 0, 10.00, 0
    FROM skus s WHERE s.sku_code='FT1196-0306-100';

  -- 送料行（sku_id なし）
  INSERT INTO sales_order_lines (sales_order_id, line_no, line_type, item_name, qty, unit_price, tax_rate, amount)
  VALUES (v_order_id, 3, '送料', '送料', 1, 500, 10.00, 500);

  -- 値引行（sku_id なし・負数）
  INSERT INTO sales_order_lines (sales_order_id, line_no, line_type, item_name, qty, unit_price, tax_rate, amount)
  VALUES (v_order_id, 4, '値引', 'クーポン分(店舗発行)：500円OFF', -1, 500, 10.00, -500);
  RAISE NOTICE 'T12 OK  販促品（数量 −1）・送料行・値引行を登録できる';

  BEGIN
    INSERT INTO sales_order_lines (sales_order_id, line_no, line_type, item_name, qty, unit_price, tax_rate, amount)
    VALUES (v_order_id, 5, '商品', 'SKUなし商品行', 1, 100, 10.00, 100);
    RAISE EXCEPTION 'T13 失敗: 商品行で SKU なしが通ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T13 OK  商品行は SKU 必須／送料・値引行は SKU 不要';
  END;
END $b07$;

-- ----------------------------------------------------------------------------
-- T14  CSV 取込の冪等性
-- ----------------------------------------------------------------------------
DO $b08$
DECLARE v_batch bigint;
BEGIN
  INSERT INTO import_batches (import_type, file_name, total_count, success_count)
  VALUES ('OMS_ORDER', 'OS_beautyjapan_20260901_170556.csv', 1, 1) RETURNING id INTO v_batch;

  INSERT INTO external_orders (import_batch_id, channel, external_order_no, raw_data)
  VALUES (v_batch, '自社サイト', 'JSb2472e28e8', '{"受注番号":"JSb2472e28e8"}'::jsonb);

  BEGIN
    INSERT INTO external_orders (import_batch_id, channel, external_order_no, raw_data)
    VALUES (v_batch, '自社サイト', 'JSb2472e28e8', '{"受注番号":"JSb2472e28e8"}'::jsonb);
    RAISE EXCEPTION 'T14 失敗: 同一受注番号の二重取込が通ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T14 OK  (チャネル×外部受注番号) の二重取込を拒否';
  END;

  -- 別チャネルの同一番号は登録できる
  INSERT INTO external_orders (import_batch_id, channel, external_order_no, raw_data)
  VALUES (v_batch, '楽天通常購入', 'JSb2472e28e8', '{}'::jsonb);
  RAISE NOTICE 'T14b OK  チャネルが異なれば同一番号を登録できる';
END $b08$;

-- ----------------------------------------------------------------------------
-- T15〜T16  取引先専用コードの一意性
-- ----------------------------------------------------------------------------
DO $b09$
BEGIN
  BEGIN
    INSERT INTO partner_products (partner_id, sku_id, partner_product_code, unit_price)
    SELECT p.id, s.id, 'TO-GXZN-60W8', 1
      FROM partners p, skus s WHERE p.partner_code='AMZN' AND s.sku_code='FT1196-0306-100';
    RAISE EXCEPTION 'T15 失敗: 同一取引先で専用コードが重複できてしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T15 OK  (取引先×専用コード) の一意性';
  END;

  INSERT INTO partner_products (partner_id, sku_id, unit_price)
  SELECT p.id, s.id, 1 FROM partners p, skus s
   WHERE p.partner_code='S001' AND s.sku_code='FT1196-0306-100';
  INSERT INTO partner_products (partner_id, sku_id, unit_price)
  SELECT p.id, s.id, 1 FROM partners p, skus s
   WHERE p.partner_code='S001' AND s.sku_code='FT1198-0204-100';
  RAISE NOTICE 'T16 OK  専用コード未設定（NULL）は同一取引先で複数登録できる';
END $b09$;

-- ----------------------------------------------------------------------------
-- T17  Amazon SKU → 自社 SKU の読み替え
-- ----------------------------------------------------------------------------
DO $b10$
DECLARE v_sku text;
BEGIN
  SELECT s.sku_code INTO v_sku
    FROM partner_products pp
    JOIN partners p ON p.id = pp.partner_id
    JOIN skus s     ON s.id = pp.sku_id
   WHERE p.partner_code = 'AMZN' AND pp.partner_product_code = 'TO-GXZN-60W8';
  IF v_sku IS DISTINCT FROM 'CS2420-0000-100' THEN
    RAISE EXCEPTION 'T17 失敗: Amazon SKU の読み替え結果が %（期待 CS2420-0000-100）', v_sku USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T17 OK  Amazon SKU「TO-GXZN-60W8」→ 自社 SKU「%」', v_sku;
END $b10$;

-- ----------------------------------------------------------------------------
-- T18〜T19  追記専用テーブル
-- ----------------------------------------------------------------------------
DO $b11$
BEGIN
  BEGIN
    UPDATE stock_movements SET qty = 0 WHERE id = (SELECT min(id) FROM stock_movements);
    RAISE EXCEPTION 'T18 失敗: 在庫移動履歴を更新できてしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'T18 OK  在庫移動履歴の UPDATE を拒否';
  END;

  BEGIN
    DELETE FROM stock_movements WHERE id = (SELECT min(id) FROM stock_movements);
    RAISE EXCEPTION 'T19 失敗: 在庫移動履歴を削除できてしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'T19 OK  在庫移動履歴の DELETE を拒否';
  END;
END $b11$;

-- ----------------------------------------------------------------------------
-- T20〜T23  その他の業務制約
-- ----------------------------------------------------------------------------
DO $b12$
DECLARE v_inv bigint; t0 timestamptz; t1 timestamptz;
BEGIN
  INSERT INTO invoices (invoice_no, partner_id, closing_date, period_from, period_to)
  SELECT 'IV-TEST-001', p.id, DATE '2026-08-31', DATE '2026-08-01', DATE '2026-08-31'
    FROM partners p WHERE p.partner_code='P001' RETURNING id INTO v_inv;
  BEGIN
    INSERT INTO invoices (invoice_no, partner_id, closing_date, period_from, period_to)
    SELECT 'IV-TEST-002', p.id, DATE '2026-08-31', DATE '2026-08-01', DATE '2026-08-31'
      FROM partners p WHERE p.partner_code='P001';
    RAISE EXCEPTION 'T20 失敗: 同一締め期間の二重請求が通ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T20 OK  (取引先×締め期間) の二重請求を拒否';
  END;

  BEGIN
    INSERT INTO reservations (partner_id, sales_category_id, sku_id, period_from, period_to, reserved_qty)
    SELECT p.id, sc.id, s.id, DATE '2026-09-30', DATE '2026-09-01', 10
      FROM partners p, sales_categories sc, skus s
     WHERE p.partner_code='P001' AND sc.code='OA' AND s.sku_code='FT1196-0306-100';
    RAISE EXCEPTION 'T21 失敗: 確保数の期間が逆転しても通ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T21 OK  確保数の期間逆転を拒否';
  END;

  BEGIN
    INSERT INTO partners (partner_code, name1, is_customer, is_supplier)
    VALUES ('P999', '役割なし取引先', false, false);
    RAISE EXCEPTION 'T22 失敗: 得意先でも仕入先でもない取引先が作れてしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T22 OK  得意先／仕入先のいずれでもない取引先を拒否';
  END;

  SELECT updated_at INTO t0 FROM partners WHERE partner_code='P001';
  PERFORM pg_sleep(0.05);
  UPDATE partners SET short_name='更新テスト' WHERE partner_code='P001';
  SELECT updated_at INTO t1 FROM partners WHERE partner_code='P001';
  IF t1 <= t0 THEN
    RAISE EXCEPTION 'T23 失敗: updated_at が更新されていない' USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T23 OK  updated_at トリガが動作';
END $b12$;

-- ----------------------------------------------------------------------------
-- T24  同梱（出荷の自己参照）
-- ----------------------------------------------------------------------------
DO $b13$
DECLARE v_parent bigint; v_child bigint;
BEGIN
  INSERT INTO shipments (shipment_no, warehouse_id, status)
  SELECT 'D0209475', w.id, '確定済' FROM warehouses w WHERE w.warehouse_code='0001'
  RETURNING id INTO v_parent;
  INSERT INTO shipments (shipment_no, warehouse_id, status, consolidated_to_shipment_id)
  SELECT 'D0209476', w.id, '確定済', v_parent FROM warehouses w WHERE w.warehouse_code='0001'
  RETURNING id INTO v_child;
  IF (SELECT consolidated_to_shipment_id FROM shipments WHERE id=v_child) <> v_parent THEN
    RAISE EXCEPTION 'T24 失敗: 同梱先の参照が張れていない' USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T24 OK  同梱（複数出荷を1つにまとめる自己参照）';
END $b13$;

-- ----------------------------------------------------------------------------
-- T25  外部キーの網羅性（孤立参照が存在しないこと）
-- ----------------------------------------------------------------------------
DO $b14$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint c
    JOIN pg_class t  ON t.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
   WHERE ns.nspname='cony' AND c.contype='f';
  IF n < 90 THEN
    RAISE EXCEPTION 'T25 失敗: 外部キーが % 件しかない（90 件以上を期待）', n USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T25 OK  外部キー % 件', n;

  SELECT count(*) INTO n FROM pg_constraint c
    JOIN pg_class t  ON t.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
   WHERE ns.nspname='cony' AND c.contype='c';
  RAISE NOTICE 'T26 OK  CHECK 制約 % 件', n;

  SELECT count(*) INTO n FROM pg_indexes WHERE schemaname='cony';
  RAISE NOTICE 'T27 OK  インデックス % 件', n;
END $b14$;

-- ----------------------------------------------------------------------------
-- T28  システム設定（「設定で変更できる」とご説明した項目が実際に外に出ているか）
-- ----------------------------------------------------------------------------
DO $b15$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM system_settings;
  IF n <> 24 THEN
    RAISE EXCEPTION 'T28 失敗: システム設定が % 件（期待 24 件）', n USING ERRCODE='TF001';
  END IF;

  -- 貴社にご説明した項目が、いずれもコードではなく設定として存在すること
  SELECT count(*) INTO n FROM system_settings WHERE setting_key IN
    ('TAX_ROUNDING_UNIT','TAX_ROUNDING_MODE','SHIPPING_FEE_THRESHOLD',
     'OMS_IMPORT_MODE','ROYALTY_CALC_BASE','INVOICE_PRINT_ISSUE_DATE');
  IF n <> 6 THEN
    RAISE EXCEPTION 'T28 失敗: 必須の設定キーが % 件しかない（期待 6 件）', n USING ERRCODE='TF001';
  END IF;

  IF fn_setting_num('SHIPPING_FEE_THRESHOLD') <> 30000 THEN
    RAISE EXCEPTION 'T28 失敗: 送料閾値が %（期待 30000）',
      fn_setting_num('SHIPPING_FEE_THRESHOLD') USING ERRCODE='TF001';
  END IF;
  IF fn_setting_text('OMS_IMPORT_MODE') <> 'shipped_result' THEN
    RAISE EXCEPTION 'T28 失敗: 通販CSV取込モードが %', fn_setting_text('OMS_IMPORT_MODE')
      USING ERRCODE='TF001';
  END IF;
  IF fn_setting_bool('INVOICE_PRINT_ISSUE_DATE') <> false THEN
    RAISE EXCEPTION 'T28 失敗: 請求書の発行日が印刷される設定になっている' USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T28 OK  端数処理・送料閾値・取込モード・発行日印刷を設定から取得できる';

  -- ロイヤリティの計算方法（貴社ご回答により確定した3点）
  IF fn_setting_text('ROYALTY_CALC_BASE') <> 'shipment_amount' THEN
    RAISE EXCEPTION 'T28c 失敗: ロイヤリティの計算基準が %（期待 shipment_amount）',
      fn_setting_text('ROYALTY_CALC_BASE') USING ERRCODE='TF001';
  END IF;
  IF fn_setting_text('ROYALTY_PRICE_BASE') <> 'wholesale' THEN
    RAISE EXCEPTION 'T28c 失敗: 料率をかける金額が %（期待 wholesale）',
      fn_setting_text('ROYALTY_PRICE_BASE') USING ERRCODE='TF001';
  END IF;
  IF fn_setting_bool('ROYALTY_INCLUDE_RETURNS') <> true THEN
    RAISE EXCEPTION 'T28c 失敗: 返品がロイヤリティに反映されない設定になっている' USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T28c OK  ロイヤリティは出荷金額・卸金額基準・返品反映';

  -- 数値型のキーに数値以外を入れられないこと
  BEGIN
    UPDATE system_settings SET value_text = 'あいうえお'
     WHERE setting_key = 'SHIPPING_FEE_THRESHOLD';
    RAISE EXCEPTION 'T28b 失敗: 数値設定に文字列が入ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T28b OK  数値設定に数値以外を入れられない';
  END;
END $b15$;

-- ----------------------------------------------------------------------------
-- T29  端数処理（切捨て／四捨五入／切上げ。返品などの負数でも対称に働くこと）
-- ----------------------------------------------------------------------------
DO $b16$
BEGIN
  IF fn_round_amount(1234.9, 'floor') <> 1234 THEN
    RAISE EXCEPTION 'T29 失敗: 切捨てが %', fn_round_amount(1234.9,'floor') USING ERRCODE='TF001';
  END IF;
  IF fn_round_amount(1234.5, 'round') <> 1235 THEN
    RAISE EXCEPTION 'T29 失敗: 四捨五入が %', fn_round_amount(1234.5,'round') USING ERRCODE='TF001';
  END IF;
  IF fn_round_amount(1234.1, 'ceil') <> 1235 THEN
    RAISE EXCEPTION 'T29 失敗: 切上げが %', fn_round_amount(1234.1,'ceil') USING ERRCODE='TF001';
  END IF;
  IF fn_round_amount(1235.0, 'ceil') <> 1235 THEN
    RAISE EXCEPTION 'T29 失敗: 端数なしを切り上げてしまった' USING ERRCODE='TF001';
  END IF;
  -- 返品（負数）は絶対値に対して処理する。−1234.9 の切捨ては −1234
  IF fn_round_amount(-1234.9, 'floor') <> -1234 THEN
    RAISE EXCEPTION 'T29 失敗: 負数の切捨てが %', fn_round_amount(-1234.9,'floor')
      USING ERRCODE='TF001';
  END IF;
  -- 引数を省略すると system_settings の設定（floor）が使われる
  IF fn_round_amount(1234.9) <> 1234 THEN
    RAISE EXCEPTION 'T29 失敗: 既定の端数処理が設定を見ていない' USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T29 OK  端数処理 切捨て／四捨五入／切上げ、負数対称、既定値は設定から';
END $b16$;

-- ----------------------------------------------------------------------------
-- T30  送料の判定（1回の出荷が30,000円未満のとき請求。取引先の個別設定が優先。9/15 ご回答）
-- ----------------------------------------------------------------------------
DO $b17$
DECLARE v_p bigint; v numeric;
BEGIN
  SELECT id INTO v_p FROM partners WHERE partner_code='P001';

  -- 既定値のみ（9/15 ご回答：30,000円未満は一律 750 円）
  IF fn_shipping_fee(v_p, 29999) <> 750 THEN
    RAISE EXCEPTION 'T30 失敗: 既定送料額が %（期待 750）', fn_shipping_fee(v_p, 29999) USING ERRCODE='TF001';
  END IF;
  IF fn_shipping_fee(v_p, 30000) <> 0 THEN
    RAISE EXCEPTION 'T30 失敗: 30,000円ちょうどで送料が %（期待 0。「未満」のため）', fn_shipping_fee(v_p, 30000) USING ERRCODE='TF001';
  END IF;

  -- 取引先ごとに上書きできる
  UPDATE partners SET shipping_fee_threshold = 50000, shipping_fee_amount = 800 WHERE id = v_p;
  v := fn_shipping_fee(v_p, 49999);
  IF v <> 800 THEN
    RAISE EXCEPTION 'T30 失敗: 個別設定 49,999円で送料が %（期待 800）', v USING ERRCODE='TF001';
  END IF;
  v := fn_shipping_fee(v_p, 50000);
  IF v <> 0 THEN
    RAISE EXCEPTION 'T30 失敗: 個別設定 50,000円ちょうどで送料が %（期待 0）', v USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T30 OK  送料は閾値未満のとき請求、取引先の個別設定が既定値に優先';

  BEGIN
    UPDATE partners SET shipping_fee_amount = -1 WHERE id = v_p;
    RAISE EXCEPTION 'T30b 失敗: 送料にマイナスを入れられてしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T30b OK  送料・閾値にマイナスを入れられない';
  END;
END $b17$;

-- ----------------------------------------------------------------------------
-- T31  郵便番号マスタ（1つの郵便番号に複数町域があること／重複と桁誤りの拒否）
-- ----------------------------------------------------------------------------
DO $b18$
DECLARE n int;
BEGIN
  INSERT INTO postal_codes (postal_code, prefecture, city, town, is_multi_town, data_version) VALUES
    ('1000001', '東京都', '千代田区', '千代田',   false, '202609'),
    ('2610012', '千葉県', '千葉市美浜区', '磯辺', false, '202609'),
    ('4980000', '愛知県', '弥富市',   '',         false, '202609'),
    ('5000000', '岐阜県', '岐阜市',   '天神町',   true,  '202609'),
    ('5000000', '岐阜県', '岐阜市',   '玉宮町',   true,  '202609');

  SELECT count(*) INTO n FROM postal_codes WHERE postal_code = '5000000';
  IF n <> 2 THEN
    RAISE EXCEPTION 'T31 失敗: 同一郵便番号の複数町域が % 件', n USING ERRCODE='TF001';
  END IF;

  BEGIN
    INSERT INTO postal_codes (postal_code, prefecture, city, town)
    VALUES ('5000000', '岐阜県', '岐阜市', '天神町');
    RAISE EXCEPTION 'T31b 失敗: (郵便番号×町域) の重複が通ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T31b OK  (郵便番号×町域) の重複を拒否';
  END;

  BEGIN
    INSERT INTO postal_codes (postal_code, prefecture, city) VALUES ('100-000', '東京都', '千代田区');
    RAISE EXCEPTION 'T31c 失敗: 7桁でない郵便番号が通ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T31c OK  7桁の数字以外を拒否';
  END;

  -- 画面からの入力ゆれ（ハイフン・全角）を吸収して引き当てられること
  IF fn_normalize_postal('２６１-００１２') <> '2610012' THEN
    RAISE EXCEPTION 'T31d 失敗: 郵便番号の正規化に失敗（%）',
      fn_normalize_postal('２６１-００１２') USING ERRCODE='TF001';
  END IF;
  SELECT count(*) INTO n FROM postal_codes WHERE postal_code = fn_normalize_postal('261-0012');
  IF n <> 1 THEN
    RAISE EXCEPTION 'T31d 失敗: 正規化した郵便番号で引き当てられない' USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T31 OK  郵便番号から住所を引き当てられる（ハイフン・全角を吸収）';
END $b18$;

-- ----------------------------------------------------------------------------
-- T32〜T33  受注明細の種別が受領CSVの実値と一致していること
--   OMS 受注CSV 203行の「商品種別」実測値：商品／セット商品／内訳商品／送料／非商品
-- ----------------------------------------------------------------------------
DO $b19$
DECLARE v_order_id bigint; n int;
BEGIN
  INSERT INTO sales_orders (order_no, order_type, partner_id, sales_category_id, order_date,
                            direct_name, channel)
  SELECT 'SO-TEST-003', '通販', p.id, sc.id, CURRENT_DATE, 'テスト 花子', '自社サイト'
    FROM partners p, sales_categories sc WHERE p.partner_code='P001' AND sc.code='WEB'
  RETURNING id INTO v_order_id;

  -- セット商品行（在庫は持たない）＋ 内訳商品行（ここから在庫を引き落とす）
  INSERT INTO sales_order_lines
    (sales_order_id, line_no, line_type, sku_id, item_name, qty, unit_price, tax_rate, amount)
  SELECT v_order_id, 1, 'セット商品', s.id,
         '骨盤スリムショーツエアリー10(S-3L)　2枚組', 1, 0, 10.00, 0
    FROM skus s WHERE s.sku_code='FT1198-11606-200';
  INSERT INTO sales_order_lines
    (sales_order_id, line_no, parent_line_no, line_type, sku_id, item_name, qty,
     unit_price, tax_rate, amount)
  SELECT v_order_id, 2, 1, '内訳商品', s.id,
         '骨盤スリムショーツエアリー10(S-3L)（サイズ:L カラー:ベージュ）', 2, 0, 10.00, 0
    FROM skus s WHERE s.sku_code='FT1198-0204-100';

  -- 非商品行（クーポン。自社商品コードがなく、数量 −1 で届く）
  INSERT INTO sales_order_lines
    (sales_order_id, line_no, line_type, item_name, qty, unit_price, tax_rate, amount)
  VALUES (v_order_id, 3, '非商品',
          'クーポン利用（店舗発行）：芦屋美整体 公式 Online Shopで次回使える500円OFFクーポン',
          -1, 500, 10.00, -500);

  -- 送料行（商品名も空で届く）
  INSERT INTO sales_order_lines
    (sales_order_id, line_no, line_type, item_name, qty, unit_price, tax_rate, amount)
  VALUES (v_order_id, 4, '送料', '送料', 1, 0, 10.00, 0);

  -- 引当対象は「内訳商品」だけ。セット商品行・非商品行・送料行は対象外
  SELECT count(*) INTO n FROM sales_order_lines
   WHERE sales_order_id = v_order_id AND is_stock_target;
  IF n <> 1 THEN
    RAISE EXCEPTION 'T32 失敗: 引当対象が % 行（期待 1 行＝内訳商品のみ）', n USING ERRCODE='TF001';
  END IF;
  SELECT count(*) INTO n FROM sales_order_lines
   WHERE sales_order_id = v_order_id AND line_type = 'セット商品' AND is_stock_target;
  IF n <> 0 THEN
    RAISE EXCEPTION 'T32 失敗: セット商品行が引当対象になっている' USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T32 OK  内訳商品のみ引当対象。セット商品・非商品・送料は対象外';

  BEGIN
    INSERT INTO sales_order_lines
      (sales_order_id, line_no, line_type, item_name, qty, unit_price, tax_rate, amount)
    VALUES (v_order_id, 5, '同梱商品', '旧称の種別', 1, 0, 10.00, 0);
    RAISE EXCEPTION 'T33 失敗: 定義外の明細種別が通ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T33 OK  定義外の明細種別を拒否（現場用語は「内訳商品」）';
  END;
END $b19$;

-- ----------------------------------------------------------------------------
-- T34  販社の発注CSV取込テンプレート（2026/09/08 確認事項⑦）
--      4社それぞれの書式が、プログラムではなくマスタとして登録されていること
-- ----------------------------------------------------------------------------
DO $b20$
DECLARE n int; v_missing text;
BEGIN
  SELECT count(*) INTO n FROM import_templates WHERE import_type = 'PARTNER_ORDER';
  IF n <> 4 THEN
    RAISE EXCEPTION 'T34 失敗: 販社の取込テンプレートが % 件（期待 4 件）', n USING ERRCODE='TF001';
  END IF;

  -- 受領した4本のCSVと列数が一致すること
  SELECT string_agg(x.template_code || '＝' || x.cnt::text, '、') INTO v_missing FROM (
    SELECT t.template_code, count(c.id) AS cnt
      FROM import_templates t
      LEFT JOIN import_template_columns c ON c.import_template_id = t.id
     GROUP BY t.template_code
  ) x
  WHERE (x.template_code, x.cnt) NOT IN
        (('BIC',36), ('LABELLEVIE',26), ('SHIRAHATO',29), ('CONNECT',10));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'T34 失敗: 列数が受領CSVと一致しない [%]', v_missing USING ERRCODE='TF001';
  END IF;

  -- どのテンプレートにも、受注番号・取引先・納品先・数量が定義されていること
  SELECT string_agg(t.template_code, '、') INTO v_missing
    FROM import_templates t
   WHERE NOT EXISTS (SELECT 1 FROM import_template_columns c
                      WHERE c.import_template_id = t.id AND c.target_field = 'order_no')
      OR NOT EXISTS (SELECT 1 FROM import_template_columns c
                      WHERE c.import_template_id = t.id AND c.target_field = 'partner_code')
      OR NOT EXISTS (SELECT 1 FROM import_template_columns c
                      WHERE c.import_template_id = t.id AND c.target_field = 'delivery_code')
      OR NOT EXISTS (SELECT 1 FROM import_template_columns c
                      WHERE c.import_template_id = t.id AND c.target_field = 'qty');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'T34 失敗: 必須項目が欠けているテンプレート [%]', v_missing USING ERRCODE='TF001';
  END IF;

  -- 商品の引き当て方が販社ごとに違うこと（白鳩は自社コードがないためJAN）
  IF (SELECT sku_match_key FROM import_templates WHERE template_code='SHIRAHATO') <> 'jan' THEN
    RAISE EXCEPTION 'T34 失敗: 白鳩はJANで引き当てる設定になっていない' USING ERRCODE='TF001';
  END IF;
  IF (SELECT file_encoding FROM import_templates WHERE template_code='CONNECT') <> 'UTF8' THEN
    RAISE EXCEPTION 'T34 失敗: コネクトのファイル文字コードが UTF8 でない' USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T34 OK  販社4社の書式をマスタとして保持（列数・必須項目・引当キー・文字コード）';

  -- 同じ列を二重に定義できないこと
  BEGIN
    INSERT INTO import_template_columns (import_template_id, column_index, target_field)
    SELECT id, 1, 'qty' FROM import_templates WHERE template_code = 'CONNECT';
    RAISE EXCEPTION 'T34b 失敗: 同一列番号を二重に定義できてしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T34b OK  1つの列に2つの意味を割り当てられない';
  END;

  BEGIN
    INSERT INTO import_template_columns (import_template_id, column_index, target_field)
    SELECT id, 99, '存在しない項目' FROM import_templates WHERE template_code = 'CONNECT';
    RAISE EXCEPTION 'T34c 失敗: 定義外の取込先項目が通ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T34c OK  定義外の取込先項目を拒否';
  END;
END $b20$;

-- ----------------------------------------------------------------------------
-- T35  サンプル出荷（確認事項④）
--      在庫は落ちるが売上・請求には計上しない
-- ----------------------------------------------------------------------------
DO $b21$
DECLARE v_order_id bigint; v_billable boolean;
BEGIN
  INSERT INTO sales_orders (order_no, order_type, partner_id, sales_category_id, order_date,
                            is_billable, direct_name)
  SELECT 'SO-TEST-SMP', 'サンプル', p.id, sc.id, CURRENT_DATE, false, 'サンプル送付先'
    FROM partners p, sales_categories sc WHERE p.partner_code='P001' AND sc.code='WEB'
  RETURNING id, is_billable INTO v_order_id, v_billable;

  IF v_billable <> false THEN
    RAISE EXCEPTION 'T35 失敗: サンプル出荷が売上計上対象になっている' USING ERRCODE='TF001';
  END IF;

  -- サンプル出荷でも在庫は落とす（引当対象の明細を持てる）
  INSERT INTO sales_order_lines
    (sales_order_id, line_no, line_type, sku_id, item_name, qty, unit_price, tax_rate, amount)
  SELECT v_order_id, 1, '商品', s.id, 'サンプル品', 1, 0, 10.00, 0
    FROM skus s WHERE s.sku_code='FT1196-0306-100';
  IF NOT (SELECT is_stock_target FROM sales_order_lines
           WHERE sales_order_id = v_order_id AND line_no = 1) THEN
    RAISE EXCEPTION 'T35 失敗: サンプル出荷の明細が引当対象になっていない' USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T35 OK  サンプル出荷は在庫を落とすが売上・請求には計上しない';

  BEGIN
    UPDATE sales_orders SET is_billable = true WHERE id = v_order_id;
    RAISE EXCEPTION 'T35b 失敗: サンプル出荷を売上計上対象にできてしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T35b OK  サンプル出荷を売上計上対象に変更できない';
  END;
END $b21$;

-- ----------------------------------------------------------------------------
-- T36  取引条件の既定値（確認事項③）と送料調整欄（確認事項⑤）
-- ----------------------------------------------------------------------------
DO $b22$
DECLARE v_default text; v_order_id bigint;
BEGIN
  UPDATE partners SET default_trade_type = '委託' WHERE partner_code = 'P001';
  SELECT default_trade_type INTO v_default FROM partners WHERE partner_code = 'P001';
  IF v_default <> '委託' THEN
    RAISE EXCEPTION 'T36 失敗: 取引先の既定取引条件が保持されない' USING ERRCODE='TF001';
  END IF;

  -- 受注では既定値を表示したうえで、個別に変更できる
  INSERT INTO sales_orders (order_no, order_type, partner_id, sales_category_id, order_date,
                            trade_type, shipping_fee_adjustment, ship_date, delivery_date,
                            direct_name)
  SELECT 'SO-TEST-004', '通販', p.id, sc.id, CURRENT_DATE,
         '買取', 1200, DATE '2026-09-10', DATE '2026-09-11', 'テスト 次郎'
    FROM partners p, sales_categories sc WHERE p.partner_code='P001' AND sc.code='WEB'
  RETURNING id INTO v_order_id;

  IF (SELECT trade_type FROM sales_orders WHERE id = v_order_id) <> '買取' THEN
    RAISE EXCEPTION 'T36 失敗: 受注で取引条件を変更できない' USING ERRCODE='TF001';
  END IF;
  IF (SELECT shipping_fee_adjustment FROM sales_orders WHERE id = v_order_id) <> 1200 THEN
    RAISE EXCEPTION 'T36 失敗: 送料調整額が保持されない' USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T36 OK  取引条件の既定値・受注での変更・送料調整・出荷日／納品日';

  BEGIN
    UPDATE partners SET default_trade_type = '請負' WHERE partner_code = 'P001';
    RAISE EXCEPTION 'T36b 失敗: 定義外の取引条件が通ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T36b OK  取引条件は委託／買取のみ';
  END;
END $b22$;

-- ----------------------------------------------------------------------------
-- T37  在庫調整（確認事項⑫）
-- ----------------------------------------------------------------------------
DO $b23$
DECLARE v_adj bigint; n int;
BEGIN
  INSERT INTO stock_adjustments (adjustment_no, warehouse_id, adjustment_date, reason_code_id)
  SELECT 'AJ-TEST-001', w.id, CURRENT_DATE, c.id
    FROM warehouses w,
         (SELECT c.id FROM codes c JOIN code_categories cc ON cc.id = c.code_category_id
           WHERE cc.code = 'ADJUSTMENT_REASON' AND c.code = 'STOCKTAKE') c
   WHERE w.warehouse_code = '0001'
  RETURNING id INTO v_adj;

  -- 増加・減少の両方を1伝票に持てる
  INSERT INTO stock_adjustment_lines (stock_adjustment_id, line_no, sku_id, qty)
  SELECT v_adj, 1, s.id,  3 FROM skus s WHERE s.sku_code = 'FT1196-0306-100';
  INSERT INTO stock_adjustment_lines (stock_adjustment_id, line_no, sku_id, qty)
  SELECT v_adj, 2, s.id, -2 FROM skus s WHERE s.sku_code = 'FT1198-0204-100';

  -- 良品から不良への振替も表現できる
  INSERT INTO stock_adjustment_lines
    (stock_adjustment_id, line_no, sku_id, from_quality_code_id, to_quality_code_id, qty)
  SELECT v_adj, 3, s.id, g.id, d.id, 1
    FROM skus s,
         (SELECT c.id FROM codes c JOIN code_categories cc ON cc.id = c.code_category_id
           WHERE cc.code = 'QUALITY_DIVISION' AND c.code = 'GOOD') g,
         (SELECT c.id FROM codes c JOIN code_categories cc ON cc.id = c.code_category_id
           WHERE cc.code = 'QUALITY_DIVISION' AND c.code = 'DEFECTIVE') d
   WHERE s.sku_code = 'FT1196-0306-100';

  SELECT count(*) INTO n FROM stock_adjustment_lines WHERE stock_adjustment_id = v_adj;
  IF n <> 3 THEN
    RAISE EXCEPTION 'T37 失敗: 在庫調整明細が % 行（期待 3 行）', n USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T37 OK  在庫調整（増加・減少・良品／不良の振替）を伝票として残せる';

  BEGIN
    INSERT INTO stock_adjustment_lines (stock_adjustment_id, line_no, sku_id, qty)
    SELECT v_adj, 4, s.id, 0 FROM skus s WHERE s.sku_code = 'FT1196-0306-100';
    RAISE EXCEPTION 'T37b 失敗: 増減 0 の調整明細が通ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T37b OK  増減 0 の調整明細を拒否';
  END;
END $b23$;

-- ----------------------------------------------------------------------------
-- T38  運用の切り替え設定（確認事項⑧⑪→9/15 見直し、9/8 にご回答いただいた通販CSVの位置づけ）
-- ----------------------------------------------------------------------------
DO $b24$
BEGIN
  IF fn_setting_text('ALLOCATION_TIMING') <> 'order_entry' THEN
    RAISE EXCEPTION 'T38 失敗: 引当タイミングが %（期待 order_entry。9/15 ご確認）',
      fn_setting_text('ALLOCATION_TIMING') USING ERRCODE='TF001';
  END IF;
  IF fn_setting_text('SHIPMENT_NO_SOURCE') <> 'sales_order' THEN
    RAISE EXCEPTION 'T38 失敗: 出荷指示番号の採り方が %（期待 sales_order）',
      fn_setting_text('SHIPMENT_NO_SOURCE') USING ERRCODE='TF001';
  END IF;
  IF fn_setting_text('OMS_IMPORT_MODE') <> 'shipped_result' THEN
    RAISE EXCEPTION 'T38 失敗: 通販CSVの取込モードが %', fn_setting_text('OMS_IMPORT_MODE')
      USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T38 OK  引当は出荷指示時／出荷指示番号は受注番号／通販CSVは出荷済み実績';
END $b24$;

-- ----------------------------------------------------------------------------
-- T39  ロイヤリティ規定
--   同じブランドでも、販売先によって発生する／発生しないを表せること。
--   （支払先C＝1ブランドに販売先10社、うち一部だけ発生する、というご相談への対応）
-- ----------------------------------------------------------------------------
DO $b25$
DECLARE
  v_payee bigint; v_brand bigint; v_cust1 bigint; v_cust2 bigint;
  v_rate numeric; v_excl boolean; v_prio smallint;
BEGIN
  INSERT INTO partners (partner_code, name1, is_customer, is_supplier)
  VALUES ('LIC1', 'テストライセンサー', false, true) RETURNING id INTO v_payee;
  INSERT INTO partners (partner_code, name1, is_customer, is_supplier)
  VALUES ('P002', 'テスト販社2', true, false) RETURNING id INTO v_cust2;
  SELECT id INTO v_brand FROM brands   WHERE code = 'LX';
  SELECT id INTO v_cust1 FROM partners WHERE partner_code = 'P001';

  -- ① ブランド全体に 5%
  INSERT INTO royalty_rules (payee_partner_id, brand_id, calc_base, rate, valid_from)
  VALUES (v_payee, v_brand, '出荷', 0.0500, DATE '2026-01-01');
  -- ② そのうち販売先2 だけ対象外
  INSERT INTO royalty_rules (payee_partner_id, brand_id, customer_partner_id, is_excluded,
                             calc_base, valid_from)
  VALUES (v_payee, v_brand, v_cust2, true, '出荷', DATE '2026-01-01');

  -- 販売先1 は ① が当たり 5%
  SELECT rate, is_excluded INTO v_rate, v_excl FROM royalty_rules
   WHERE payee_partner_id = v_payee AND is_active
     AND (brand_id            IS NULL OR brand_id            = v_brand)
     AND (customer_partner_id IS NULL OR customer_partner_id = v_cust1)
   ORDER BY scope_priority DESC, valid_from DESC LIMIT 1;
  IF v_excl OR v_rate IS DISTINCT FROM 0.0500 THEN
    RAISE EXCEPTION 'T39 失敗: 販売先1 の料率が %（対象外＝%）', v_rate, v_excl USING ERRCODE='TF001';
  END IF;

  -- 販売先2 は ② が優先されて対象外
  SELECT is_excluded, scope_priority INTO v_excl, v_prio FROM royalty_rules
   WHERE payee_partner_id = v_payee AND is_active
     AND (brand_id            IS NULL OR brand_id            = v_brand)
     AND (customer_partner_id IS NULL OR customer_partner_id = v_cust2)
   ORDER BY scope_priority DESC, valid_from DESC LIMIT 1;
  IF NOT v_excl THEN
    RAISE EXCEPTION 'T39 失敗: 販売先2 が対象外にならない' USING ERRCODE='TF001';
  END IF;
  IF v_prio <> 5 THEN
    RAISE EXCEPTION 'T39 失敗: 優先度が %（期待 5＝ブランド1+販売先4）', v_prio USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T39 OK  同じブランドでも販売先ごとに発生／対象外を切り替えられる';

  -- 対象外の行に料率は入れられない
  BEGIN
    INSERT INTO royalty_rules (payee_partner_id, brand_id, customer_partner_id, is_excluded,
                               calc_base, rate, valid_from)
    VALUES (v_payee, v_brand, v_cust1, true, '出荷', 0.0300, DATE '2026-01-01');
    RAISE EXCEPTION 'T39b 失敗: 対象外なのに料率を持つ規定が通ってしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'T39b OK  対象外の規定に料率は入れられない';
  END;

  -- 同じ範囲・同じ開始日の二重登録を拒否する
  BEGIN
    INSERT INTO royalty_rules (payee_partner_id, brand_id, calc_base, rate, valid_from)
    VALUES (v_payee, v_brand, '出荷', 0.0800, DATE '2026-01-01');
    RAISE EXCEPTION 'T39c 失敗: 同じ範囲の規定が二重登録できてしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T39c OK  同じ範囲・同じ開始日の規定は二重登録できない';
  END;
END $b25$;

-- ----------------------------------------------------------------------------
-- T40  ロイヤリティ計算表（支払先ごとに毎月1枚。販売先別の内訳を持つ）
--   データの投入は素の SQL で行い、判定だけを小さなブロックに分ける。
--   ブロックを小さく保つほど、クエリツールの解釈の違いに左右されにくい。
-- ----------------------------------------------------------------------------
INSERT INTO royalty_calculations (target_month, payee_partner_id, calc_base)
SELECT DATE '2026-09-01', p.id, '出荷'
  FROM partners p WHERE p.partner_code = 'LIC1';

INSERT INTO royalty_calculation_lines
  (royalty_calculation_id, customer_partner_id, brand_id, sku_id, qty, base_amount, rate, royalty_amount)
SELECT rc.id, p.id, b.id, s.id, 20, 70000, 0.0500, 3500
  FROM royalty_calculations rc, partners p, brands b, skus s
 WHERE rc.target_month = DATE '2026-09-01'
   AND p.partner_code = 'P001' AND b.code = 'LX' AND s.sku_code = 'FT1196-0306-100';

INSERT INTO royalty_calculation_lines
  (royalty_calculation_id, customer_partner_id, brand_id, sku_id, qty, base_amount, rate, royalty_amount)
SELECT rc.id, p.id, b.id, s.id, 10, 35000, 0.0500, 1750
  FROM royalty_calculations rc, partners p, brands b, skus s
 WHERE rc.target_month = DATE '2026-09-01'
   AND p.partner_code = 'AMZN' AND b.code = 'LX' AND s.sku_code = 'FT1196-0306-100';

UPDATE royalty_calculations c
   SET total_base_amount = x.base_sum, total_amount = x.roy_sum
  FROM (SELECT royalty_calculation_id AS calc_id,
               sum(base_amount)    AS base_sum,
               sum(royalty_amount) AS roy_sum
          FROM royalty_calculation_lines
         GROUP BY royalty_calculation_id) x
 WHERE c.id = x.calc_id;

DO $b26$
DECLARE n int; v_sum numeric;
BEGIN
  SELECT count(DISTINCT customer_partner_id) INTO n
    FROM royalty_calculation_lines;
  IF n <> 2 THEN
    RAISE EXCEPTION 'T40 失敗: 販売先の内訳が % 件（期待 2 件）', n USING ERRCODE='TF001';
  END IF;

  SELECT total_amount INTO v_sum
    FROM royalty_calculations WHERE target_month = DATE '2026-09-01';
  IF v_sum <> 5250 THEN
    RAISE EXCEPTION 'T40 失敗: 合計が %（期待 5250）', v_sum USING ERRCODE='TF001';
  END IF;
  RAISE NOTICE 'T40 OK  支払先ごとの月次計算表と、販売先別の内訳（3,500 と 1,750 で 5,250）';
END $b26$;

-- ----------------------------------------------------------------------------
-- T40b  同じ支払先・同じ月の計算表は1枚だけ
-- ----------------------------------------------------------------------------
DO $b27$
DECLARE v_payee bigint;
BEGIN
  SELECT id INTO v_payee FROM partners WHERE partner_code = 'LIC1';
  BEGIN
    INSERT INTO royalty_calculations (target_month, payee_partner_id, calc_base)
    VALUES (DATE '2026-09-01', v_payee, '出荷');
    RAISE EXCEPTION 'T40b 失敗: 計算表が2枚作れてしまった' USING ERRCODE='TF001';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'T40b OK  同じ支払先・同じ月の計算表は1枚だけ';
  END;
END $b27$;

-- ----------------------------------------------------------------------------
-- T41  閲覧者に見せる範囲
--   要件定義書 7章「原価・仕入単価・ロイヤリティは、閲覧のみの方には表示されません」は
--   画面ではなく項目を指している。商品は見られるが原価は見られない状態を確かめる。
-- ----------------------------------------------------------------------------
DO $b28$
DECLARE n int;
BEGIN
  -- 閲覧者も商品マスタ・得意先別商品マスタは開ける
  SELECT count(*) INTO n
    FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id
    JOIN permissions p       ON p.id = rp.permission_id
   WHERE r.code = 'VIEWER' AND p.action = 'view' AND p.function_id IN ('M-08','M-11');
  IF n <> 2 THEN
    RAISE EXCEPTION 'T41 失敗: 閲覧者が商品マスタ／得意先別商品マスタを参照できない（% 件）', n
      USING ERRCODE='TF001';
  END IF;

  -- ただし原価・仕入単価・ロイヤリティは見られない
  SELECT count(*) INTO n
    FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id
    JOIN permissions p       ON p.id = rp.permission_id
   WHERE r.code = 'VIEWER' AND p.function_id = 'SENSITIVE';
  IF n <> 0 THEN
    RAISE EXCEPTION 'T41 失敗: 閲覧者に機微項目の参照権限がある' USING ERRCODE='TF001';
  END IF;

  -- 管理者・作業者・経理は見られる
  SELECT count(DISTINCT r.code) INTO n
    FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id
    JOIN permissions p       ON p.id = rp.permission_id
   WHERE p.function_id = 'SENSITIVE' AND r.code IN ('ADMIN','OPERATOR','ACCOUNTING');
  IF n <> 3 THEN
    RAISE EXCEPTION 'T41 失敗: 機微項目を見られるロールが % 件（期待 3 件）', n USING ERRCODE='TF001';
  END IF;

  -- 金額そのものを扱う画面は、従来どおり閲覧者には見せない
  SELECT count(*) INTO n
    FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id
    JOIN permissions p       ON p.id = rp.permission_id
   WHERE r.code = 'VIEWER' AND p.function_id IN ('M-15','P-01','P-03','C-01','Y-02','M-17');
  IF n <> 0 THEN
    RAISE EXCEPTION 'T41 失敗: 閲覧者に金額系画面の権限がある（% 件）', n USING ERRCODE='TF001';
  END IF;

  RAISE NOTICE 'T41 OK  閲覧者は商品を見られるが原価は見られない';
END $b28$;

-- ----------------------------------------------------------------------------
-- 完了
-- ----------------------------------------------------------------------------
DO $b29$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '==================================================';
  RAISE NOTICE '  スキーマ受入テスト 全件合格';
  RAISE NOTICE '==================================================';
END $b29$;
