-- ロイヤリティ規定を「1枚のフォーム」で入れられるようにする（2026-10-03）
--
-- 2026-10-01 いただいたご要望（ロイヤリティ規定シート）：
--   「媒体が入力必須で、販売先を選ぶと媒体内の販売先一覧がでてきて、販売先を選ぶと、
--     その販売先だけが対象となる。販売先を入れなければ媒体全体が対象となる。
--     販売先は20社まで選べるようにする」
--   「対象内よりも対象外の方が少ない場合もあり、対象内と同じ内容で対象外の入力フォームもほしい。
--     どちらかを入力して反映させる方法が理想です。」
--
-- 計算の仕組みは今のままで足ります（販売先ごとの行と is_excluded で表現できることを実機で確認済み）。
-- 足すのは **列1本だけ**。1枚のフォームから作った複数行を、一覧で1件に見せるための目印です。
--   例）媒体テレビ・5%・20社のうち2社だけ対象外
--       → 代表行（販売先=空欄・5%）＋ 対象外の行2本 の計3行。まとまりの鍵は COALESCE(rule_group_id, id)。
--
-- 既存のデータには触りません。今ある規定は rule_group_id が空欄のまま、
-- 1行＝1件として今までどおり一覧に出ます。計算結果も変わりません。
--
-- 使い方：
--   & $PSQL $URL -f docs\migrations\2026-10-03_royalty_group.sql
-- 何度流しても同じ結果になります（IF NOT EXISTS）。
--
-- このファイルは UTF-8 です。日本語のコメントを含みます。
-- 日本語版 Windows の psql は既定（Shift-JIS）で読もうとして止まるため、先に宣言します。
SET client_encoding = 'UTF8';

-- 本番のバックエンドを動かしたまま流すと、ロック待ちで画面が固まることがあります。
-- 10秒で諦めて、何も変えずに終わるようにしてあります。
SET lock_timeout = '10s';

-- 途中で失敗したときに「列だけ足って索引が無い」状態を残さないため、ひとまとめにします。
BEGIN;

SET LOCAL search_path TO cony, public;

ALTER TABLE royalty_rules
  ADD COLUMN IF NOT EXISTS rule_group_id BIGINT;

-- 代表行を消したら、そこを指している行も一緒に消える。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'cony.royalty_rules'::regclass
       AND conname  = 'fk_royalty_rules_group'
  ) THEN
    ALTER TABLE royalty_rules
      ADD CONSTRAINT fk_royalty_rules_group
      FOREIGN KEY (rule_group_id) REFERENCES royalty_rules(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_royalty_rules_group
  ON royalty_rules (rule_group_id) WHERE rule_group_id IS NOT NULL;

COMMENT ON COLUMN royalty_rules.rule_group_id IS
  '同じ入力フォームから作られた行のまとまり。空欄＝この行が代表。一覧で1件にまとめて見せるために使う';

-- 二重登録を止める鍵に「媒体」を足す。
-- 媒体を必須にしたため、同じブランドでも「テレビは5%・カタログは3%」を
-- 別の規定として入れられる必要があります。今の鍵には媒体が入っておらず、
-- 2つめを登録すると「二重登録です」と断られてしまいます。
--
-- 鍵が細かくなるだけなので、今あるデータが重複になることはありません
-- （列を足す向きの変更は、まとまりを分けるだけで、くっつけることはない）。
-- 張り替えの途中で失敗しても、この BEGIN〜COMMIT ごと巻き戻るので
-- 「索引が無い状態」が残ることはありません。
DROP INDEX IF EXISTS ux_royalty_rules_scope;
CREATE UNIQUE INDEX ux_royalty_rules_scope ON royalty_rules
  (payee_partner_id, COALESCE(brand_id, 0), COALESCE(product_id, 0),
   COALESCE(customer_partner_id, 0), COALESCE(media_id, 0), valid_from);

COMMIT;

-- 入ったことの確認
SET client_encoding = 'UTF8';
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'cony' AND table_name = 'royalty_rules'
      AND column_name = 'rule_group_id')                              AS "列",
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'cony' AND indexname = 'ix_royalty_rules_group') AS "索引",
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'cony.royalty_rules'::regclass
      AND conname = 'fk_royalty_rules_group')                          AS "外部キー",
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'cony' AND indexname = 'ux_royalty_rules_scope'
      AND indexdef LIKE '%media_id%')                                  AS "鍵に媒体",
  (SELECT count(*) FROM cony.royalty_rules)                            AS "今ある規定の数";
