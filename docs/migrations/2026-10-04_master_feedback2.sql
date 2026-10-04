-- マスタへのご要望（2026-10-01）のうち、保留していた分を反映する（2026-10-04）
--
-- 内訳：
--   1) 取引先の「既定の取引区分」に **仕入** を足す
--        ご要望：「『仕入』追加／区分で仕入先の場合に必要」
--   2) 取引先に「ロイヤリティ支払先」の印を足す
--        ご要望：「『ダイワホームズ』など支払先だけ出てくるようにしてほしい」
--        → 今は得意先として登録されているため「仕入先だけ」では絞れない。専用の印を持たせる
--   3) SKU に **原価** を足す（サイズ別の原価）
--        ご要望：「大きいサイズは原価が変わるため…同じ商品でもサイズによって原価登録できるように」
--        → 空欄なら商品の原価を使う。入っていればそのSKUはその値を使う
--   4) JAN の重複を「品番の左6桁が同じならOK」に変える
--        ご要望：「左６桁が違う場合JANコード重複はエラーにして、左６桁が同じならJANコードの重複はOKに」
--
-- 既存のデータは変わりません。2) だけは、**今ロイヤリティ規定で支払先になっている取引先に
-- 印を付ける**ので行が更新されますが、増減はしません（画面の見え方も変わりません）。
--
-- 使い方：
--   & $PSQL $URL -f docs\migrations\2026-10-04_master_feedback2.sql
-- 何度流しても同じ結果になります。
--
-- このファイルは UTF-8 です。日本語のコメントと日本語の値を含みます。
-- 日本語版 Windows の psql は既定（Shift-JIS）で読もうとして止まるため、先に宣言します。
SET client_encoding = 'UTF8';

-- 本番のバックエンドを動かしたまま流すと、ロック待ちで画面が固まることがあります。
SET lock_timeout = '10s';

-- 途中で失敗したときに半端な状態を残さないため、ひとまとめにします。
BEGIN;

SET LOCAL search_path TO cony, public;

-- ---------------------------------------------------------------------------
-- 1) 取引先の取引区分に「仕入」
--    受注の取引区分（sales_orders.trade_type）は 委託／買取 のままです。
--    受注に「仕入」はあり得ないため、取引先側の既定値だけを広げます。
-- ---------------------------------------------------------------------------
ALTER TABLE partners DROP CONSTRAINT IF EXISTS ck_partners_trade;
ALTER TABLE partners ADD CONSTRAINT ck_partners_trade CHECK (
  default_trade_type IS NULL OR default_trade_type IN ('委託', '買取', '仕入'));

-- ---------------------------------------------------------------------------
-- 2) ロイヤリティ支払先の印
-- ---------------------------------------------------------------------------
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS is_royalty_payee BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN partners.is_royalty_payee IS
  'ロイヤリティの支払先。ロイヤリティ規定の「支払先」の候補をこの印で絞る';

-- すでに規定で支払先になっている取引先には、最初から印を付けておく
UPDATE partners p
   SET is_royalty_payee = true
 WHERE NOT p.is_royalty_payee
   AND EXISTS (SELECT 1 FROM royalty_rules r WHERE r.payee_partner_id = p.id);

CREATE INDEX IF NOT EXISTS ix_partners_royalty_payee
  ON partners (is_royalty_payee) WHERE is_royalty_payee;

-- ---------------------------------------------------------------------------
-- 3) SKU の原価（サイズ別）
--    空欄＝商品の原価を使う。入っていればその値が優先される。
--    読む側は coalesce(s.cost_price, p.cost_price) で見ます。
-- ---------------------------------------------------------------------------
ALTER TABLE skus
  ADD COLUMN IF NOT EXISTS cost_price money_amt;

COMMENT ON COLUMN skus.cost_price IS
  'このSKUだけの原価。空欄なら商品の原価を使う（大きいサイズだけ原価が違う場合に入れる）';

-- ---------------------------------------------------------------------------
-- 4) JAN の重複の決まりを変える
--
--    今まで：JAN は全体で1つだけ（ux_skus_jan）
--    これから：**品番の左6桁が同じ商品の中でなら、同じ JAN を使ってよい**
--              左6桁が違う商品に同じ JAN を付けようとするとエラー
--
--    「ある JAN に対して、品番の左6桁はただ1つ」という決まりなので、
--    ふつうの一意索引では表せません。引き金（トリガー）で確かめます。
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS ux_skus_jan;

-- 引き当てに使うので、一意でない索引は残します
CREATE INDEX IF NOT EXISTS ix_skus_jan ON skus (jan) WHERE jan IS NOT NULL;

CREATE OR REPLACE FUNCTION fn_check_sku_jan() RETURNS trigger AS $$
DECLARE
  v_code6 text;
  v_other text;
BEGIN
  IF NEW.jan IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT left(p.product_code, 6) INTO v_code6
    FROM cony.products p WHERE p.id = NEW.product_id;

  -- 同じ JAN を持つ、別の品番グループの SKU があれば止める
  SELECT left(p.product_code, 6) INTO v_other
    FROM cony.skus s
    JOIN cony.products p ON p.id = s.product_id
   WHERE s.jan = NEW.jan
     AND s.id <> COALESCE(NEW.id, -1)
     AND left(p.product_code, 6) <> v_code6
   LIMIT 1;

  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION
      'この JAN コードは品番 % の商品で使われています。品番の左6桁が違う商品に同じ JAN は付けられません',
      v_other
      USING ERRCODE = '23505', CONSTRAINT = 'ux_skus_jan';
  END IF;

  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_skus_jan ON skus;
CREATE TRIGGER trg_skus_jan
  BEFORE INSERT OR UPDATE OF jan, product_id ON skus
  FOR EACH ROW EXECUTE FUNCTION fn_check_sku_jan();

COMMIT;

-- 入ったことの確認
SET client_encoding = 'UTF8';
SELECT
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'cony.partners'::regclass AND conname = 'ck_partners_trade'
      AND pg_get_constraintdef(oid) LIKE '%仕入%')                     AS "取引区分に仕入",
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'cony' AND table_name = 'partners'
      AND column_name = 'is_royalty_payee')                            AS "支払先の印",
  (SELECT count(*) FROM cony.partners WHERE is_royalty_payee)          AS "印が付いた取引先",
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'cony' AND table_name = 'skus'
      AND column_name = 'cost_price')                                  AS "SKUの原価",
  (SELECT count(*) FROM pg_trigger
    WHERE tgrelid = 'cony.skus'::regclass AND tgname = 'trg_skus_jan') AS "JANの引き金",
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'cony' AND indexname = 'ux_skus_jan')           AS "古い一意索引_0なら正常";
