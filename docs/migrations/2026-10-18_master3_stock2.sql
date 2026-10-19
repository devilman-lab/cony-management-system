-- ============================================================================
-- 2026-10-18 マスター編_3・在庫編_2（2026-10-16 ご要望）
--
--   1. 取引先: 支払②、入金方法①②、請求書送付方法、請求書送付先メールアドレス、消費税免税区分（取引先ごと）
--   2. 商品: ロイヤリティ区分・下代調整対象。SKU: 旧原価。商品分類: ブランド
--   3. 得意先別商品: 同じ取引先・同じ SKU に複数の行（単価・先方コード違い）を持てるようにする
--   4. 引当在庫: 販売カテゴリーを必須にしない（空ならどの販売カテゴリーの受注でも減る）
--   5. ロイヤリティ規定: 計算の基準を「請求月」（売上＝締めた請求の月）に統一
--   6. 区分値: 入金方法・請求書送付方法・ロイヤリティ区分を追加。在庫調整理由を「その他・再生・棚卸差異」に。
--      費用区分（使っていない）を使わないに
--   7. 原価は SKU ごと: 商品の原価・旧原価を、SKU の原価・旧原価が空のものに写す（金額の結果は変わらない）
--
-- 列は足すだけ（既定値つき・空でよい）。行の増減は区分値の追加だけ。何度流しても同じ結果になる。
--
-- 流し方（PowerShell）:
--   Copy-Item docs\migrations\2026-10-18_master3_stock2.sql $env:TEMP\cony-m11.sql
--   & $PSQL $URL -v ON_ERROR_STOP=1 -f $env:TEMP\cony-m11.sql
-- 流したあと docs\migrations\00-適用状況の確認.sql で ⑪ が「済」になることを確かめる。
-- 本番に出すときは「この SQL を先、push を後」（新しいコードはこれらの列を読むため）。
-- ============================================================================
SET client_encoding = 'UTF8';
SET lock_timeout = '10s';
BEGIN;
SET LOCAL search_path = cony;

-- 1. 取引先
ALTER TABLE partners ADD COLUMN IF NOT EXISTS payment_month_offset2       SMALLINT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS payment_day2                SMALLINT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS receipt_method1_code_id     BIGINT REFERENCES codes(id);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS receipt_method2_code_id     BIGINT REFERENCES codes(id);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_send_method_code_id BIGINT REFERENCES codes(id);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_email               VARCHAR(200);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS overseas_tax_treatment      VARCHAR(20);
DO $m1$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'cony.partners'::regclass AND conname = 'ck_partners_payday2') THEN
    ALTER TABLE cony.partners ADD CONSTRAINT ck_partners_payday2 CHECK (payment_day2 IS NULL OR payment_day2 BETWEEN 1 AND 99);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'cony.partners'::regclass AND conname = 'ck_partners_overseas_tax') THEN
    ALTER TABLE cony.partners ADD CONSTRAINT ck_partners_overseas_tax
      CHECK (overseas_tax_treatment IS NULL OR overseas_tax_treatment IN ('exempt','non_taxable'));
  END IF;
END
$m1$;

-- 今ある海外の取引先には、いまのシステム設定の扱いを取引先ごとの区分として入れる。
-- 空のままだと画面・CSV で「なし」と見え、別の欄を直して取り込んだときに国内に戻ってしまうため
UPDATE partners
   SET overseas_tax_treatment = COALESCE(
         (SELECT value_text FROM system_settings WHERE setting_key = 'OVERSEAS_TAX_TREATMENT'
             AND value_text IN ('exempt', 'non_taxable')),
         'exempt')
 WHERE is_overseas AND overseas_tax_treatment IS NULL;
UPDATE system_settings
   SET name = '海外取引先の消費税（取引先で選ばないとき）',
       description = 'exempt＝免税（税抜扱い）／non_taxable＝課税対象外。取引先マスタの「消費税免税区分」が空の海外取引先に使う。どちらも消費税は 0 で計算し、帳票の表記だけが変わる。'
 WHERE setting_key = 'OVERSEAS_TAX_TREATMENT';

-- 2. 商品・SKU・商品分類
ALTER TABLE skus            ADD COLUMN IF NOT EXISTS old_cost_price money_amt;
ALTER TABLE products        ADD COLUMN IF NOT EXISTS royalty_class_code_id BIGINT REFERENCES codes(id);
ALTER TABLE products        ADD COLUMN IF NOT EXISTS is_wholesale_adjust_target BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE product_classes ADD COLUMN IF NOT EXISTS brand_id BIGINT REFERENCES brands(id);

-- 3. 得意先別商品: (取引先, SKU) の一意の決まりを外す。名前は環境で違い得るので、列の組で探す
DO $m3$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'cony.partner_products'::regclass
       AND c.contype = 'u'
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k)
           = ARRAY['partner_id', 'sku_id']
  LOOP
    EXECUTE format('ALTER TABLE cony.partner_products DROP CONSTRAINT %I', r.conname);
  END LOOP;
END
$m3$;

-- 先方の商品コードが空の行は、取引先×SKU ごとに1つまで（今までは (取引先, SKU) が一意だったので、今あるデータは必ず満たす）
CREATE UNIQUE INDEX IF NOT EXISTS ux_partner_products_nocode
  ON partner_products (partner_id, sku_id)
  WHERE partner_product_code IS NULL;

-- 4. 引当在庫: 販売カテゴリーを空にできる
ALTER TABLE reservation_groups ALTER COLUMN sales_category_id DROP NOT NULL;
ALTER TABLE reservations       ALTER COLUMN sales_category_id DROP NOT NULL;

-- 5. ロイヤリティ規定: 計算の基準を請求月（売上）に統一。確定した計算表は作り直さないので変わらない
ALTER TABLE royalty_rules ALTER COLUMN calc_base SET DEFAULT '売上';
UPDATE royalty_rules SET calc_base = '売上' WHERE calc_base <> '売上';

-- 6. 区分値
INSERT INTO code_categories (code, name, sort_order)
SELECT v.code, v.name, v.so FROM (VALUES
  ('RECEIPT_METHOD',      '入金方法',         26),
  ('INVOICE_SEND_METHOD', '請求書送付方法',   27),
  ('ROYALTY_CLASS',       'ロイヤリティ区分', 42)
) AS v(code, name, so)
WHERE NOT EXISTS (SELECT 1 FROM code_categories c WHERE c.code = v.code);

INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT cc.id, v.code, v.name, v.so
  FROM (VALUES
    ('RECEIPT_METHOD',      'TRANSFER',     '振込',       10),
    ('RECEIPT_METHOD',      'E_RECEIVABLE', '電子債権',   20),
    ('RECEIPT_METHOD',      'OTHER',        'その他',     90),
    ('INVOICE_SEND_METHOD', 'MAIL',         'メール送付', 10),
    ('INVOICE_SEND_METHOD', 'EDI',          'EDI',        20),
    ('INVOICE_SEND_METHOD', 'POST',         '郵送',       30),
    ('INVOICE_SEND_METHOD', 'FAX_RECV',     'FAX受信',    40),
    ('INVOICE_SEND_METHOD', 'MAIL_RECV',    'メール受信', 50),
    ('ROYALTY_CLASS',       'MACHINE',      '機械',       10),
    ('ROYALTY_CLASS',       'NON_MACHINE',  '機械以外',   20),
    ('ADJUSTMENT_REASON',   'REFURB',       '再生',       20)
  ) AS v(cat, code, name, so)
  JOIN code_categories cc ON cc.code = v.cat
 WHERE NOT EXISTS (SELECT 1 FROM codes c WHERE c.code_category_id = cc.id AND c.code = v.code);

-- 在庫調整理由: 「その他・再生・棚卸差異」の順。破損・紛失・品質振替は使わない（過去の調整のために残す）
UPDATE codes c SET sort_order = v.so, is_active = v.active
  FROM (VALUES ('OTHER', 10, true), ('REFURB', 20, true), ('STOCKTAKE', 30, true),
               ('DAMAGE', 40, false), ('LOSS', 50, false), ('QUALITY', 60, false)) AS v(code, so, active),
       code_categories cc
 WHERE cc.code = 'ADJUSTMENT_REASON' AND c.code_category_id = cc.id AND c.code = v.code;

-- 費用区分は使っていない（値も無い）
UPDATE code_categories SET is_active = false WHERE code = 'COST_DIVISION';

-- 7. 原価は SKU ごと。SKU に原価・旧原価が無いものへ、商品の値を写す（計算の結果は今と同じ）
UPDATE skus s SET cost_price = p.cost_price
  FROM products p WHERE p.id = s.product_id AND s.cost_price IS NULL;
UPDATE skus s SET old_cost_price = p.old_cost_price
  FROM products p WHERE p.id = s.product_id AND s.old_cost_price IS NULL AND p.old_cost_price IS NOT NULL;

COMMIT;

-- 確認（左の数になれば正しい）
SET search_path = cony;
SELECT '取引先の追加の列（7）' AS 項目, count(*) AS 件数 FROM information_schema.columns
 WHERE table_schema = 'cony' AND table_name = 'partners'
   AND column_name IN ('payment_month_offset2','payment_day2','receipt_method1_code_id','receipt_method2_code_id',
                       'invoice_send_method_code_id','invoice_email','overseas_tax_treatment')
UNION ALL SELECT '商品・SKU・商品分類の追加の列（4）', count(*) FROM information_schema.columns
 WHERE table_schema = 'cony' AND ((table_name = 'skus' AND column_name = 'old_cost_price')
    OR (table_name = 'products' AND column_name IN ('royalty_class_code_id','is_wholesale_adjust_target'))
    OR (table_name = 'product_classes' AND column_name = 'brand_id'))
UNION ALL SELECT '販売カテゴリーを空にできる表（2）', count(*) FROM information_schema.columns
 WHERE table_schema = 'cony' AND table_name IN ('reservation_groups','reservations')
   AND column_name = 'sales_category_id' AND is_nullable = 'YES'
UNION ALL SELECT '新しい区分値カテゴリー（3）', count(*) FROM code_categories
 WHERE code IN ('RECEIPT_METHOD','INVOICE_SEND_METHOD','ROYALTY_CLASS')
UNION ALL SELECT '請求月でないロイヤリティ規定（0）', count(*) FROM royalty_rules WHERE calc_base <> '売上'
UNION ALL SELECT '原価の無い SKU（0 が望ましい）', count(*) FROM skus WHERE cost_price IS NULL;
