-- 取込履歴に「郵便番号データ」を残せるようにする（2026-09-25）
--
-- 背景：販社発注・通販受注・Amazon決済レポートは import_batches に履歴が残るが、
-- 郵便番号（KEN_ALL）の取込だけ残っておらず、いつ・誰が・何件入れたかを
-- あとから辿れなかった。取込種別に POSTAL_CODE を足して、同じ履歴に残す。
--
-- 使い方：1) を実行する。docs/02-schema.sql からの新規構築では、
-- ck_import_type に最初から POSTAL_CODE が入っている必要がある
-- （docs/02-schema.sql 側の反映は別途）。
SET search_path = cony, public;

-- 1) 取込種別の許容値に POSTAL_CODE を足す
ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS ck_import_type;
ALTER TABLE import_batches ADD CONSTRAINT ck_import_type CHECK (import_type IN
  ('OMS_ORDER','AMAZON_TRANSACTION','PARTNER_ORDER','POSTAL_CODE'));

-- 2) 確認（4値が入っていること）
SELECT pg_get_constraintdef(oid) AS 取込種別の許容値
  FROM pg_constraint
 WHERE conrelid = 'import_batches'::regclass AND conname = 'ck_import_type';
