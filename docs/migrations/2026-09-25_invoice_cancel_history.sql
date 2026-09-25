-- 取り消した請求書を履歴として残せるようにする（2026-09-25）
--
-- 背景：請求を「取消」にしてから同じ期間を締め直すと、取消にした請求の行そのものが
-- 消えていた（締め直しが既存の行を delete して同じ請求番号を使い回していたため）。
-- 画面の確認文は「この請求は「取消」として残り、同じ期間で締め直せるようになります」と
-- 案内しているのに、実際には請求番号も履歴も追えなくなっていた。
--
-- 締め直しで取消の行を残すには、同じ取引先・同じ締め期間の請求がもう1件作れないといけない。
-- そこで UNIQUE (partner_id, period_to) を、取消を数えない部分索引に入れ替える。
--   ・取消でない請求は、今まで通り 取引先＋締め期間 で1件だけ。
--   ・取消にした請求は何件あってもよい（履歴として積み上がる）。
--
-- 索引名は元の制約名（invoices_partner_id_period_to_key）のままにしてある。
-- 重複したときの日本語の案内「この取引先・締め期間の請求はすでに作られています」が
-- この名前で引かれているため（backend/src/common/database-exception.filter.ts）。
--
-- 使い方：1) で重複が無いことを確かめ、0件なら 2) を実行し、3) で確認する。
-- docs/02-schema.sql からの新規構築では、この索引は最初から入っている。
SET search_path = cony, public;

-- ---------------------------------------------------------------------------
-- 1) 確認（0件であること）
-- ---------------------------------------------------------------------------
-- 取消でない請求が、同じ取引先・同じ締め期間で2件以上ないこと。
-- 通常は元の UNIQUE 制約が効いていたので必ず0件になる。
SELECT partner_id,
       period_to,
       count(*) AS 件数,
       string_agg(invoice_no, ' / ' ORDER BY id) AS 請求番号
  FROM invoices
 WHERE status <> '取消'
 GROUP BY partner_id, period_to
HAVING count(*) > 1;

-- ---------------------------------------------------------------------------
-- 2) 入れ替え
-- ---------------------------------------------------------------------------
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_partner_id_period_to_key;

CREATE UNIQUE INDEX invoices_partner_id_period_to_key
  ON invoices (partner_id, period_to) WHERE status <> '取消';

-- ---------------------------------------------------------------------------
-- 3) 確認
-- ---------------------------------------------------------------------------
-- 索引が「WHERE status <> '取消'」付きで作られていること。
SELECT indexdef AS 請求の一意索引
  FROM pg_indexes
 WHERE schemaname = 'cony'
   AND tablename = 'invoices'
   AND indexname = 'invoices_partner_id_period_to_key';

-- 制約としては残っていないこと（索引に入れ替わっている）。
SELECT count(*) AS 残っている制約の数
  FROM pg_constraint
 WHERE conrelid = 'invoices'::regclass
   AND conname = 'invoices_partner_id_period_to_key';
