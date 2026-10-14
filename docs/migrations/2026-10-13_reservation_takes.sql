-- ============================================================================
-- 2026-10-13 セット受注で減らした引当在庫の内訳（3回目の全面受入テスト Z-31）
--
--   sales_order_lines.reservation_takes（JSONB）を足す。
--   セット商品の受注を構成品の確保で減らしたとき、構成品ごとに「どの確保からいくつ減らしたか」を残す。
--   これまでは受注明細に確保を1つしか結べず、取消・修正のときに2つ目以降の構成品の戻し先を
--   その時点の条件で探し直していたため、減らしていない確保まで戻してしまうことがあった。
--
-- 列を足すだけで、行の増減も値の書き換えも無い。今ある受注は空（NULL）のままで、
-- 取消・修正のときは今までどおりの探し方で戻す。何度流しても同じ結果になる。
--
-- 流し方（PowerShell）:
--   Copy-Item docs\migrations\2026-10-13_reservation_takes.sql $env:TEMP\cony-m10.sql
--   & $PSQL $URL -v ON_ERROR_STOP=1 -f $env:TEMP\cony-m10.sql
-- 流したあと docs\migrations\00-適用状況の確認.sql で ⑩ が「済」になることを確かめる。
-- 本番に出すときは「この SQL を先、push を後」（新しいコードはこの列を読み書きするため）。
-- ============================================================================
SET client_encoding = 'UTF8';
SET lock_timeout = '10s';
BEGIN;
SET LOCAL search_path = cony;

ALTER TABLE sales_order_lines ADD COLUMN IF NOT EXISTS reservation_takes JSONB;

COMMIT;

-- 確認（1 なら正しい）
SET search_path = cony;
SELECT 'セット受注の確保の内訳の列（1 なら正しい）' AS 項目, count(*) AS 件数
  FROM information_schema.columns
 WHERE table_schema = 'cony' AND table_name = 'sales_order_lines' AND column_name = 'reservation_takes';
