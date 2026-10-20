-- ============================================================================
-- 2026-10-20 受注処理編（2026-10-13 ご要望）
--
--   1. 受注: 受注区分に「社内移動」「返品」。サンプル・社内移動は取引先・販売カテゴリーを空にできる（売上に計上しない）
--      納品時間（区分値）、納品書に送料を記載するか、委託の入庫倉庫
--   2. 受注明細: 出荷依頼書適用・納品書適用
--   3. 区分値: 納品時間（5つの時間帯）、在庫調整理由「返品」。伝票発行分類「単価あり」は使わない
--   4. システム設定: 受注は登録だけにし、引当は受注一覧から行う（ALLOCATION_TIMING=manual）
--      納品書の既定様式から「単価あり」を外す。納品書の差出人欄（住所・電話・FAX・担当）
--   5. 取込テンプレート: 1つの列を2つの項目に入れられるようにする（「po_no+shipping_note」の形）
--      ビックカメラ: 単価＝Z列（発注時単価）、S列（発注No）を出荷依頼書適用にも入れる
--      ラベルヴィ: 数量＝Q列（発注セット数）、単価＝T列（卸値(税抜)）
--   6. 未確定の受注を「引当待ち」に（登録だけの受注は引当待ちで並ぶため）
--   7. 品名の関数 fn_item_name（商品名＋カラー＋サイズ。「2枚組」はカラー・サイズのあとに回す）
--
-- 列は足すだけ（既定値つき・空でよい）。行の増減は区分値の追加と設定の追加だけ。何度流しても同じ結果になる。
--
-- 流し方（PowerShell）:
--   Copy-Item docs\migrations\2026-10-20_order_feedback.sql $env:TEMP\cony-m12.sql
--   & $PSQL $URL -v ON_ERROR_STOP=1 -f $env:TEMP\cony-m12.sql
-- 流したあと docs\migrations\00-適用状況の確認.sql で ⑫ が「済」になることを確かめる。
-- 本番に出すときは「この SQL を先、push を後」（新しいコードはこれらの列を読むため）。
-- ============================================================================
SET client_encoding = 'UTF8';
SET lock_timeout = '10s';
BEGIN;
SET LOCAL search_path = cony;

-- 1. 受注
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS delivery_time_code_id    BIGINT REFERENCES codes(id);
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS print_shipping_fee       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS consignment_warehouse_id BIGINT REFERENCES warehouses(id);
ALTER TABLE sales_orders ALTER COLUMN partner_id        DROP NOT NULL;
ALTER TABLE sales_orders ALTER COLUMN sales_category_id DROP NOT NULL;
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS ck_so_type;
ALTER TABLE sales_orders ADD CONSTRAINT ck_so_type
  CHECK (order_type IN ('卸','直送','通販','サンプル','社内移動','返品'));
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS ck_so_sample;
ALTER TABLE sales_orders ADD CONSTRAINT ck_so_sample
  CHECK (order_type NOT IN ('サンプル','社内移動') OR is_billable = false);
ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS ck_so_partner;
ALTER TABLE sales_orders ADD CONSTRAINT ck_so_partner
  CHECK (order_type IN ('サンプル','社内移動') OR (partner_id IS NOT NULL AND sales_category_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS ix_so_ship_date ON sales_orders (ship_date DESC);
COMMENT ON COLUMN sales_orders.is_billable IS 'サンプル・社内移動は false。出荷依頼書は出て在庫も落ちるが、売上・請求には乗らない';
COMMENT ON COLUMN sales_orders.delivery_time_code_id IS '納品時間（区分値 DELIVERY_TIME）。納品希望日の代わりに受注入力で選ぶ（2026-10-13 受注処理編）';
COMMENT ON COLUMN sales_orders.print_shipping_fee IS '納品書に送料を記載するか（2026-10-13 受注処理編）';
COMMENT ON COLUMN sales_orders.consignment_warehouse_id IS '委託の入庫倉庫。出荷確定で出荷倉庫からこの倉庫へ在庫が移る（2026-10-13 受注処理編）';

-- 2. 受注明細
ALTER TABLE sales_order_lines ADD COLUMN IF NOT EXISTS shipping_note      VARCHAR(200);
ALTER TABLE sales_order_lines ADD COLUMN IF NOT EXISTS delivery_slip_note VARCHAR(200);

-- 3. 区分値
INSERT INTO code_categories (code, name, sort_order)
SELECT 'DELIVERY_TIME', '納品時間', 33
 WHERE NOT EXISTS (SELECT 1 FROM code_categories WHERE code = 'DELIVERY_TIME');

INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT cc.id, v.code, v.name, v.so
  FROM (VALUES
    ('DELIVERY_TIME',     '0812',   '8:00〜12:00',  10),
    ('DELIVERY_TIME',     '1416',   '14:00〜16:00', 20),
    ('DELIVERY_TIME',     '1618',   '16:00〜18:00', 30),
    ('DELIVERY_TIME',     '1820',   '18:00〜20:00', 40),
    ('DELIVERY_TIME',     '1921',   '19:00〜21:00', 50),
    ('ADJUSTMENT_REASON', 'RETURN', '返品',         35)
  ) AS v(cat, code, name, so)
  JOIN code_categories cc ON cc.code = v.cat
 WHERE NOT EXISTS (SELECT 1 FROM codes c WHERE c.code_category_id = cc.id AND c.code = v.code);

-- 納品書の様式「単価あり」は使わない（2026-10-13「単価あり」削除）。使っていた納品先は「単価あり2」に
UPDATE delivery_destinations d
   SET slip_issue_class_code_id = w2.id
  FROM codes w1
  JOIN code_categories cc ON cc.id = w1.code_category_id AND cc.code = 'SLIP_ISSUE_CLASS'
  JOIN codes w2 ON w2.code_category_id = cc.id AND w2.code = 'WITH_PRICE2'
 WHERE w1.code = 'WITH_PRICE' AND d.slip_issue_class_code_id = w1.id;
UPDATE codes c SET is_active = false
  FROM code_categories cc
 WHERE cc.code = 'SLIP_ISSUE_CLASS' AND c.code_category_id = cc.id AND c.code = 'WITH_PRICE';

-- 4. システム設定
UPDATE system_settings
   SET allowed_values = 'manual,order_entry,shipping_instruction',
       value_text = 'manual',
       description = 'manual＝受注は登録だけ。受注一覧で選んで「引当」を押したときに引き当てる（2026-10-13 受注処理編「登録だけできるように」）'
                     || '／order_entry＝受注登録時に引き当て、足りない分は引当待ちにする／shipping_instruction＝出荷指示ボタンを押した時。'
 WHERE setting_key = 'ALLOCATION_TIMING';

UPDATE system_settings
   SET allowed_values = '単価あり2,上代あり,単価なし',
       value_text = CASE WHEN value_text IN ('単価あり2','上代あり','単価なし') THEN value_text ELSE '単価あり2' END,
       description = '納品先マスタの伝票発行分類が未設定のときに使う様式。「単価あり」は 2026-10-13 のご指示で使わない。'
 WHERE setting_key = 'DELIVERY_NOTE_DEFAULT_FORM';

-- 納品書の差出人欄（貴社の納品書の様式どおり）。空のときだけ様式の値を入れる（画面で直した値は変えない）
INSERT INTO system_settings (setting_key, setting_group, name, value_text, value_type, allowed_values, description, sort_order)
SELECT v.k, 'DOCUMENT', v.n, v.val, 'text', NULL, v.d, v.so
  FROM (VALUES
    ('COMPANY_POSTAL_CODE', '帳票に印刷する郵便番号',      '541-0052',              '納品書の差出人欄に印刷する。', 45),
    ('COMPANY_ADDRESS2',    '帳票に印刷する住所（2行目）', '野村不動産大阪ビル8階', '納品書の差出人欄に印刷する（建物名など）。', 55),
    ('COMPANY_FAX',         '帳票に印刷するFAX番号',       '06-6267-0053',          '納品書の差出人欄に印刷する。', 65),
    ('COMPANY_CONTACT',     '帳票に印刷する担当者',        '',                      '納品書の差出人欄の「担当」に印刷する。空なら「担当：」だけを出す。', 66)
  ) AS v(k, n, val, d, so)
 WHERE NOT EXISTS (SELECT 1 FROM system_settings s WHERE s.setting_key = v.k);
UPDATE system_settings
   SET value_text = '大阪府大阪市中央区安土町1丁目8-15'
 WHERE setting_key = 'COMPANY_ADDRESS' AND coalesce(btrim(value_text), '') = '';
UPDATE system_settings
   SET description = '納品書の差出人欄に印刷する住所（1行目）。請求書は会社名だけを印刷する（9/15 ご回答）。'
 WHERE setting_key = 'COMPANY_ADDRESS';
UPDATE system_settings
   SET value_text = '06-6267-0052'
 WHERE setting_key = 'COMPANY_TEL' AND coalesce(btrim(value_text), '') = '';
UPDATE system_settings
   SET description = '納品書の差出人欄に印刷する。'
 WHERE setting_key = 'COMPANY_TEL';

-- 5. 取込テンプレート
--   1つの列を2つの項目に入れられるよう、取込先の項目を「+」でつなげて書けるようにする
--   （ビックカメラの発注Noは、先方発注番号と明細の出荷依頼書適用の両方に入れる）
ALTER TABLE import_template_columns DROP CONSTRAINT IF EXISTS ck_imptplcol_field;
ALTER TABLE import_template_columns ADD CONSTRAINT ck_imptplcol_field CHECK (
  string_to_array(target_field, '+') <@ ARRAY[
    'order_no','partner_code','partner_name','delivery_code','delivery_name',
    'po_no','po_line_no','line_no','sku_code','jan','partner_product_code',
    'item_name','color','size','qty','unit_price','retail_price','amount',
    'ship_date','delivery_date','requested_delivery_date','order_date','remarks',
    'shipping_note','delivery_slip_note','ignore']::text[]);

UPDATE import_template_columns c
   SET target_field = v.fld, transform = v.tr, is_required = v.req
  FROM (VALUES
    ('BIC',        19, 'po_no+shipping_note', 'trim',   false),
    ('BIC',        26, 'unit_price',          'number', true),
    ('BIC',        28, 'ignore',              NULL,     false),
    ('LABELLEVIE', 17, 'qty',                 'number', true),
    ('LABELLEVIE', 18, 'ignore',              NULL,     false),
    ('LABELLEVIE', 20, 'unit_price',          'number', false),
    ('LABELLEVIE', 23, 'amount',              'number', false)
  ) AS v(tpl, idx, fld, tr, req),
       import_templates t
 WHERE t.template_code = v.tpl AND c.import_template_id = t.id AND c.column_index = v.idx;

UPDATE import_templates
   SET note = '得意先ID SD0228。数量は「出荷数量」（AA列）、単価は「発注時単価」（Z列）（2026-10-13 ご指示）。'
              || '発注No（S列）は先方発注番号と明細の出荷依頼書適用に入れる。JANコードが指数表記に壊れているため商品コードで引き当てる。'
 WHERE template_code = 'BIC';
UPDATE import_templates
   SET note = '得意先ID SD0180。6列目は見出しが空欄で出荷日。数量は「発注セット数」（Q列）、単価は「卸値(税抜)」（T列）（2026-10-13 ご指示）。'
 WHERE template_code = 'LABELLEVIE';

-- 6. 登録だけの受注は「引当待ち」で並ぶ。今ある未確定（取消を除く）もそろえる
UPDATE sales_orders SET status = '引当待ち'
 WHERE status = '未確定' AND NOT is_cancelled;

-- 7. 品名（2026-10-13 受注処理編「商品・品名ともに すべて 商品名・カラー・サイズで出す」）。
-- 名前の末尾に「2枚組」のような組数があれば、カラー・サイズのあとに回す
-- （「骨盤ショーツ07 2枚組」＋ブラック・S →「骨盤ショーツ07 ブラック S 2枚組」）。
-- 名前にカラー・サイズがすでに語として入っていれば重ねない。画面側の composeItemName（frontend/src/lib/item-name.ts）と同じ決まり。
CREATE OR REPLACE FUNCTION fn_item_name(p_base text, p_color text, p_size text) RETURNS text AS $$
DECLARE
  -- 空白とみなす文字。画面（JavaScript の \s と trim()）と同じ集まりにする（2026-10-20 受入テスト T5）:
  -- 半角の空白・タブ・改行など（[[:space:]]）、ノーブレークスペース（chr(160)）、U+1680、U+2000〜U+200A、
  -- U+2028・U+2029・U+202F・U+205F、全角の空白（chr(12288)）、U+FEFF
  v_extra  text := chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197)
                   || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
                   || chr(8287) || chr(12288) || chr(65279);
  v_ws     text := ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || v_extra;
  v_sp     text := '[[:space:]' || v_extra || ']';
  v_nsp    text := '[^[:space:]' || v_extra || ']';
  v_base   text := btrim(coalesce(p_base, ''), v_ws);
  v_color  text := btrim(coalesce(p_color, ''), v_ws);
  v_size   text := btrim(coalesce(p_size, ''), v_ws);
  v_suffix text;
  v_tokens text[];
  v_out    text;
  m        text[];
BEGIN
  m := regexp_match(v_base, '^(.*' || v_nsp || ')' || v_sp || '+([0-9０-９]+(枚|個|本|足|点|袋|箱)?(組|セット|入り|入))$');
  IF m IS NOT NULL THEN
    v_base := btrim(m[1], v_ws);
    v_suffix := m[2];
  END IF;
  v_tokens := regexp_split_to_array(v_base, v_sp || '+');
  v_out := v_base;
  IF v_color <> '' AND NOT (v_color = ANY (v_tokens)) THEN v_out := v_out || ' ' || v_color; END IF;
  IF v_size  <> '' AND NOT (v_size  = ANY (v_tokens)) THEN v_out := v_out || ' ' || v_size;  END IF;
  IF v_suffix IS NOT NULL THEN v_out := v_out || ' ' || v_suffix; END IF;
  RETURN btrim(v_out, v_ws);
END; $$ LANGUAGE plpgsql IMMUTABLE;

COMMIT;

-- 確認（左の数になれば正しい）
SET search_path = cony;
SELECT '受注の追加の列（3）' AS 項目, count(*)::text AS 件数 FROM information_schema.columns
 WHERE table_schema = 'cony' AND table_name = 'sales_orders'
   AND column_name IN ('delivery_time_code_id','print_shipping_fee','consignment_warehouse_id')
UNION ALL SELECT '受注明細の追加の列（2）', count(*)::text FROM information_schema.columns
 WHERE table_schema = 'cony' AND table_name = 'sales_order_lines'
   AND column_name IN ('shipping_note','delivery_slip_note')
UNION ALL SELECT '取引先・販売カテゴリーを空にできる（2）', count(*)::text FROM information_schema.columns
 WHERE table_schema = 'cony' AND table_name = 'sales_orders'
   AND column_name IN ('partner_id','sales_category_id') AND is_nullable = 'YES'
UNION ALL SELECT '納品時間の区分値（5）', count(*)::text FROM codes c JOIN code_categories cc ON cc.id = c.code_category_id
 WHERE cc.code = 'DELIVERY_TIME'
UNION ALL SELECT '在庫調整理由「返品」（1）', count(*)::text FROM codes c JOIN code_categories cc ON cc.id = c.code_category_id
 WHERE cc.code = 'ADJUSTMENT_REASON' AND c.code = 'RETURN'
UNION ALL SELECT '「単価あり」の納品先（0）', count(*)::text FROM delivery_destinations d
  JOIN codes c ON c.id = d.slip_issue_class_code_id WHERE c.code = 'WITH_PRICE'
UNION ALL SELECT '引当のタイミングが manual（1）', count(*)::text FROM system_settings
 WHERE setting_key = 'ALLOCATION_TIMING' AND value_text = 'manual'
UNION ALL SELECT '差出人の追加の設定（4）', count(*)::text FROM system_settings
 WHERE setting_key IN ('COMPANY_POSTAL_CODE','COMPANY_ADDRESS2','COMPANY_FAX','COMPANY_CONTACT')
UNION ALL SELECT 'ビックカメラの単価の列が Z列（1）', count(*)::text FROM import_template_columns c
  JOIN import_templates t ON t.id = c.import_template_id
 WHERE t.template_code = 'BIC' AND c.column_index = 26 AND c.target_field = 'unit_price'
UNION ALL SELECT 'ラベルヴィの数量の列が Q列（1）', count(*)::text FROM import_template_columns c
  JOIN import_templates t ON t.id = c.import_template_id
 WHERE t.template_code = 'LABELLEVIE' AND c.column_index = 17 AND c.target_field = 'qty'
UNION ALL SELECT '未確定の受注（0）', count(*)::text FROM sales_orders WHERE status = '未確定' AND NOT is_cancelled
UNION ALL SELECT '品名の例（骨盤ショーツ07 ブラック S 2枚組）', fn_item_name('骨盤ショーツ07 2枚組', 'ブラック', 'S');
