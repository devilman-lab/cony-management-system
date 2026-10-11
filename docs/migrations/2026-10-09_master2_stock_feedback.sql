-- ============================================================================
-- 2026-10-09 マスター編②・在庫編のご要望への対応
--
--   1. 取引先に「海外」の印（partners.is_overseas）と、その消費税の扱いの設定（OVERSEAS_TAX_TREATMENT）
--   2. SKU ごとの商品名（skus.sku_name。空なら商品の商品名）
--   3. 入荷明細の商品ごとの備考（receipt_lines.note）
--   4. 引当在庫を「確保（見出し）＋明細」の形に（reservation_groups、reservations.group_id / media_id）
--   5. 在庫調整の状態をそろえる（すでに在庫が動いている「登録」を「確定」に）
--      今ある枠は1件ずつ「確保」を作ってそこにぶら下げる（中身・使用数はそのまま）
--
-- 何度流しても同じ結果になる（IF NOT EXISTS / ON CONFLICT）。1〜4 と 5 をそれぞれ1つのトランザクションで流す。
-- 既存のデータは消さない。行の増減は reservation_groups に既存の枠と同じ数の行ができることだけ。
--
-- 流し方（PowerShell）:
--   & $PSQL $URL -v ON_ERROR_STOP=1 -f docs\migrations\2026-10-09_master2_stock_feedback.sql
-- 流したあと docs\migrations\00-適用状況の確認.sql で ⑧ が「済」になることを確かめる。
-- 本番に出すときは「この SQL を先、push を後」（新しいコードはこれらの列を読むため）。
-- ============================================================================
SET client_encoding = 'UTF8';
SET lock_timeout = '10s';
BEGIN;
SET LOCAL search_path = cony;

-- 1. 取引先の「海外」
ALTER TABLE partners ADD COLUMN IF NOT EXISTS is_overseas BOOLEAN NOT NULL DEFAULT false;

INSERT INTO system_settings
  (setting_key, setting_group, name, value_text, value_type, allowed_values, description, sort_order)
VALUES
  ('OVERSEAS_TAX_TREATMENT', 'TAX', '海外取引先の消費税', 'exempt', 'text', 'exempt,non_taxable',
   'exempt＝免税（税抜扱い）／non_taxable＝課税対象外。どちらも消費税は 0 で計算し、帳票の表記だけが変わる。', 40)
ON CONFLICT (setting_key) DO NOTHING;

-- 2. SKU ごとの商品名
ALTER TABLE skus ADD COLUMN IF NOT EXISTS sku_name VARCHAR(200);

-- 3. 入荷明細の備考
ALTER TABLE receipt_lines ADD COLUMN IF NOT EXISTS note TEXT;

-- 4. 引当在庫の確保（見出し）
CREATE TABLE IF NOT EXISTS reservation_groups (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_from       DATE    NOT NULL,
  period_to         DATE    NOT NULL,
  media_id          BIGINT  REFERENCES media(id),
  partner_id        BIGINT  REFERENCES partners(id),
  sales_category_id BIGINT  NOT NULL REFERENCES sales_categories(id),
  item_label        VARCHAR(60),
  product_class_id  BIGINT  REFERENCES product_classes(id),
  note              TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by BIGINT REFERENCES users(id),
  CONSTRAINT ck_resgrp_period CHECK (period_to >= period_from)
);
COMMENT ON TABLE reservation_groups IS '確保（引当在庫）の見出し。明細は reservations';

-- 更新日時トリガ（ほかの表と同じもの）
DO $m1$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'reservation_groups'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER trg_reservation_groups_updated BEFORE UPDATE ON reservation_groups
      FOR EACH ROW EXECUTE FUNCTION cony.set_updated_at();
  END IF;
END
$m1$;

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS group_id BIGINT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS media_id BIGINT;
DO $m2$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_reservations_group') THEN
    ALTER TABLE reservations ADD CONSTRAINT fk_reservations_group
      FOREIGN KEY (group_id) REFERENCES reservation_groups(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_reservations_media') THEN
    ALTER TABLE reservations ADD CONSTRAINT fk_reservations_media
      FOREIGN KEY (media_id) REFERENCES media(id);
  END IF;
END
$m2$;

-- 今ある枠は、1件ずつ「確保」を作ってそこにぶら下げる（見出しは枠と同じ中身）
DO $m3$
DECLARE r record; g bigint;
BEGIN
  FOR r IN SELECT * FROM reservations WHERE group_id IS NULL ORDER BY id LOOP
    INSERT INTO reservation_groups (period_from, period_to, partner_id, sales_category_id, note, created_by, updated_by)
    VALUES (r.period_from, r.period_to, r.partner_id, r.sales_category_id, r.note, r.created_by, r.updated_by)
    RETURNING id INTO g;
    UPDATE reservations SET group_id = g WHERE id = r.id;
  END LOOP;
END
$m3$;

-- 一意の決まりを「1つの確保の中で同じ SKU は1行まで」に変える
DROP INDEX IF EXISTS ux_reservations_scope;
CREATE UNIQUE INDEX IF NOT EXISTS ux_reservations_group_sku ON reservations (group_id, sku_id);
CREATE INDEX IF NOT EXISTS ix_reservations_group ON reservations (group_id);

COMMIT;

-- 確認
SET search_path = cony;
SELECT '海外の印'        AS 項目, count(*) AS 件数 FROM information_schema.columns WHERE table_schema='cony' AND table_name='partners' AND column_name='is_overseas'
UNION ALL SELECT 'SKUの商品名',   count(*) FROM information_schema.columns WHERE table_schema='cony' AND table_name='skus' AND column_name='sku_name'
UNION ALL SELECT '入荷明細の備考', count(*) FROM information_schema.columns WHERE table_schema='cony' AND table_name='receipt_lines' AND column_name='note'
UNION ALL SELECT '確保の見出し',   count(*) FROM reservation_groups
UNION ALL SELECT '見出しの無い枠（0 なら正しい）', count(*) FROM reservations WHERE group_id IS NULL;

-- 5. 在庫調整の状態をそろえる
--    これまでは登録した時点で在庫が動いていたのに、状態は「登録」のままだった。
--    今回から「登録では在庫を動かさず、一覧の『調整』で動かして『確定』にする」形になったので、
--    すでに在庫が動いている調整は「確定」にそろえる（二重に動かさないため。在庫の数そのものは変えない）。
BEGIN;
SET LOCAL search_path = cony;
SET LOCAL lock_timeout = '10s';
UPDATE stock_adjustments a
   SET status = '確定'
 WHERE a.status = '登録'
   AND EXISTS (SELECT 1 FROM stock_movements m WHERE m.ref_table = 'stock_adjustments' AND m.ref_id = a.id);
COMMIT;
