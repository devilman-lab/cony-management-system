-- マスタへのご要望（2026-10-01 いただいた「新システム要望事項(マスター編)」）を反映する（2026-10-02）
--
-- いずれも **列を足すだけ** で、既存のデータには触りません。
-- 既に入っているマスタはそのまま使えます。
--
-- 内訳：
--   1) 商品に「旧原価」           … 原価を変えたとき、前の値を残しておきたい
--   2) SKU に「FBA専用JAN」「ショップ商品コード」
--                                  … コニーJANとは別に持ち、出荷依頼書・JAN発行で使う
--   3) 得意先別商品に「出荷JAN」   … 受注入力で先方JANから引ける出荷用のJAN
--   4) 取引先に「請求書の宛名」「請求書の担当者名」
--                                  … 請求書発行時に取引先名ではなくこちらを使う
--   5) ロイヤリティ規定に「媒体」  … 媒体で対象を絞れるようにする
--   6) 取引先カテゴリーを複数持てるようにする（TVとカタログ両方など）
--   7) 通貨の区分を追加            … 売上・仕入で使う通貨を選べるようにする
--
-- ※「旧単価」「単価変更日付」（得意先別商品）と「税区分」（仕入項目）は
--   **すでに列があります**。画面に出していなかっただけなので、この SQL では何もしません。
--
-- 使い方：
--   & $PSQL $URL -f docs\migrations\2026-10-02_master_feedback.sql
-- 何度流しても同じ結果になります（IF NOT EXISTS / ON CONFLICT）。

-- このファイルは UTF-8 です。日本語のコメントと日本語の値を含みます。
-- 日本語版 Windows の psql は既定（Shift-JIS）で読もうとして止まるため、先に宣言します。
SET client_encoding = 'UTF8';
SET search_path = cony, public;

-- 本番のバックエンドを動かしたまま流すと、ロック待ちで画面が固まることがあります。
SET lock_timeout = '10s';

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) 商品：旧原価
-- ---------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN IF NOT EXISTS old_cost_price money_amt;
COMMENT ON COLUMN products.old_cost_price IS '旧原価。原価を変えたときに前の値を残す（1001 ご要望）';

-- ---------------------------------------------------------------------------
-- 2) SKU：FBA専用JAN・ショップ商品コード
-- ---------------------------------------------------------------------------
ALTER TABLE skus ADD COLUMN IF NOT EXISTS fba_jan           VARCHAR(20);
ALTER TABLE skus ADD COLUMN IF NOT EXISTS shop_product_code VARCHAR(60);
COMMENT ON COLUMN skus.fba_jan IS 'FBA専用のJAN。出荷依頼書・JAN発行でコニーJANの代わりに使う（1001 ご要望）';
COMMENT ON COLUMN skus.shop_product_code IS 'ショップ側の商品コード（1001 ご要望）';

-- ---------------------------------------------------------------------------
-- 3) 得意先別商品：出荷JAN
-- ---------------------------------------------------------------------------
ALTER TABLE partner_products ADD COLUMN IF NOT EXISTS shipping_jan VARCHAR(20);
COMMENT ON COLUMN partner_products.shipping_jan IS
  '出荷用のJAN。受注入力で先方JANを入れたときに、これを出す（1001 ご要望）';

-- ---------------------------------------------------------------------------
-- 4) 取引先：請求書の宛名・担当者名
-- ---------------------------------------------------------------------------
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_addressee    VARCHAR(120);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invoice_contact_name VARCHAR(120);
COMMENT ON COLUMN partners.invoice_addressee IS
  '請求書の宛名。空欄なら取引先名を使う（1001 ご要望）';
COMMENT ON COLUMN partners.invoice_contact_name IS
  '請求書に出す担当者名。空欄なら出さない（1001 ご要望）';

-- ---------------------------------------------------------------------------
-- 5) ロイヤリティ規定：媒体
-- ---------------------------------------------------------------------------
ALTER TABLE royalty_rules ADD COLUMN IF NOT EXISTS media_id BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'cony.royalty_rules'::regclass AND conname = 'fk_royalty_rules_media'
  ) THEN
    ALTER TABLE royalty_rules
      ADD CONSTRAINT fk_royalty_rules_media FOREIGN KEY (media_id) REFERENCES media(id);
  END IF;
END $$;
COMMENT ON COLUMN royalty_rules.media_id IS
  '媒体で対象を絞る。空欄ならすべての媒体（1001 ご要望）';

-- ---------------------------------------------------------------------------
-- 6) 取引先カテゴリーを複数持てるようにする
-- ---------------------------------------------------------------------------
-- 1つの取引先が「TV」と「カタログ」の両方を持つことがある（1001 ご要望）。
-- 既存の partners.partner_category_id は消さずに残し、「代表のカテゴリー」として扱う。
-- 消すと今動いている絞り込みが壊れるため。
CREATE TABLE IF NOT EXISTS partner_category_links (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partner_id          BIGINT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  partner_category_id BIGINT NOT NULL REFERENCES partner_categories(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT REFERENCES users(id),
  UNIQUE (partner_id, partner_category_id)
);
COMMENT ON TABLE partner_category_links IS
  '取引先が持つカテゴリー。1取引先で複数持てる（TVとカタログ両方など。1001 ご要望）';
CREATE INDEX IF NOT EXISTS ix_partner_category_links_partner
  ON partner_category_links (partner_id);

-- 今入っている代表カテゴリーを、複数側にも写しておく（画面の見え方を変えないため）。
INSERT INTO partner_category_links (partner_id, partner_category_id)
SELECT id, partner_category_id FROM partners
 WHERE partner_category_id IS NOT NULL
ON CONFLICT (partner_id, partner_category_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7) 通貨の区分
-- ---------------------------------------------------------------------------
-- 仕入・入出金の currency は3文字の文字列で持っている。
-- 選べる通貨を増やせるよう、区分値として持つ（区分値の画面から足せる）。
INSERT INTO code_categories (code, name, sort_order)
VALUES ('CURRENCY', '通貨', 62)
ON CONFLICT (code) DO NOTHING;

INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT cc.id, v.code, v.name, v.so
  FROM code_categories cc, (VALUES
    ('JPY', '円',       10),
    ('USD', '米ドル',   20),
    ('CNY', '中国元',   30),
    ('EUR', 'ユーロ',   40)
  ) AS v(code, name, so)
 WHERE cc.code = 'CURRENCY'
ON CONFLICT (code_category_id, code) DO NOTHING;

COMMIT;

-- ---------------------------------------------------------------------------
-- 確認
-- ---------------------------------------------------------------------------
SELECT '商品：旧原価'            AS 項目, count(*) AS 済 FROM information_schema.columns WHERE table_schema='cony' AND table_name='products'         AND column_name='old_cost_price'
UNION ALL SELECT 'SKU：FBA JAN',            count(*) FROM information_schema.columns WHERE table_schema='cony' AND table_name='skus'             AND column_name='fba_jan'
UNION ALL SELECT 'SKU：ショップ商品コード', count(*) FROM information_schema.columns WHERE table_schema='cony' AND table_name='skus'             AND column_name='shop_product_code'
UNION ALL SELECT '得意先別商品：出荷JAN',   count(*) FROM information_schema.columns WHERE table_schema='cony' AND table_name='partner_products' AND column_name='shipping_jan'
UNION ALL SELECT '取引先：請求書の宛名',    count(*) FROM information_schema.columns WHERE table_schema='cony' AND table_name='partners'         AND column_name='invoice_addressee'
UNION ALL SELECT '取引先：請求書の担当者',  count(*) FROM information_schema.columns WHERE table_schema='cony' AND table_name='partners'         AND column_name='invoice_contact_name'
UNION ALL SELECT 'ロイヤリティ：媒体',      count(*) FROM information_schema.columns WHERE table_schema='cony' AND table_name='royalty_rules'    AND column_name='media_id'
UNION ALL SELECT '取引先カテゴリー（複数）', count(*) FROM information_schema.tables  WHERE table_schema='cony' AND table_name='partner_category_links'
UNION ALL SELECT '通貨の区分',              count(*) FROM code_categories WHERE code='CURRENCY'
 ORDER BY 1;
