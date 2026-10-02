-- 稼働中のデータベースに何が入っているかを見る（読むだけ。何も変えません）
--
-- 使いどころ：
--   ・テストを依頼する前に、利用者のログインIDと、入っているデータを確かめる
--   ・「登録したはずのものが見えない」と言われたときに、実際に入っているかを見る
--   ・本番開始前にデータを消す判断をするときに、何がどれだけあるかを数える
--
-- 使い方（本番の Render に対して、手元の PowerShell から）:
--   $PSQL = "C:\Program Files\PostgreSQL\17\bin\psql.exe"
--   $URL  = "postgresql://cony:（パスワード）@（ホスト）/cony?sslmode=require"
--   & $PSQL $URL -f docs\08-データ確認.sql
--
-- 文字化けして読めないときは、psql を呼ぶ前にコンソールを UTF-8 にします:
--   chcp 65001 | Out-Null
--   [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

-- このファイルは UTF-8 です。日本語のコメントと日本語の値を含みます。
-- 日本語版 Windows の psql は既定（Shift-JIS）で読もうとして止まるため、先に宣言します。
SET client_encoding = 'UTF8';
SET search_path = cony, public;

-- ---------------------------------------------------------------------------
-- 1) 利用者の一覧
-- ---------------------------------------------------------------------------
-- **パスワードは取り出せません。**暗号化して保存しており、元に戻せない方式のためです。
-- 忘れたときは作り直します：画面の「マスタ ＞ ユーザー・権限 ＞ 利用者」で
-- 対象の行の「パスワード」から設定し直してください。
SELECT u.id,
       u.login_id                                          AS ログインID,
       u.name                                              AS 名前,
       coalesce(string_agg(r.name, '、' ORDER BY r.sort_order), '（役割なし）') AS 役割,
       CASE WHEN u.is_active THEN '有効' ELSE '停止' END    AS 状態,
       to_char(u.created_at, 'YYYY/MM/DD HH24:MI')          AS 作成日時
  FROM users u
  LEFT JOIN user_roles ur ON ur.user_id = u.id
  LEFT JOIN roles r       ON r.id = ur.role_id
 GROUP BY u.id, u.login_id, u.name, u.is_active, u.created_at
 ORDER BY u.id;

-- ---------------------------------------------------------------------------
-- 2) 業務データの件数
-- ---------------------------------------------------------------------------
-- 0 件のものは「まだ使われていない」ということ。テスト前は上のマスタだけが入っている状態が普通です。
SELECT 'マスタ：取引先'      AS 種類, count(*) AS 件数 FROM partners
UNION ALL SELECT 'マスタ：納品先',        count(*) FROM delivery_destinations
UNION ALL SELECT 'マスタ：商品',          count(*) FROM products
UNION ALL SELECT 'マスタ：SKU',           count(*) FROM skus
UNION ALL SELECT 'マスタ：セット商品',    count(*) FROM set_headers
UNION ALL SELECT 'マスタ：得意先別商品',  count(*) FROM partner_products
UNION ALL SELECT 'マスタ：倉庫',          count(*) FROM warehouses
UNION ALL SELECT 'マスタ：仕入項目',      count(*) FROM purchase_items
UNION ALL SELECT 'マスタ：ロイヤリティ条件', count(*) FROM royalty_rules
UNION ALL SELECT '伝票：受注',            count(*) FROM sales_orders
UNION ALL SELECT '伝票：出荷',            count(*) FROM shipments
UNION ALL SELECT '伝票：入荷',            count(*) FROM receipts
UNION ALL SELECT '伝票：返品',            count(*) FROM returns
UNION ALL SELECT '伝票：仕入・経費',      count(*) FROM purchases
UNION ALL SELECT '金銭：請求',            count(*) FROM invoices
UNION ALL SELECT '金銭：入金',            count(*) FROM cash_receipts
UNION ALL SELECT '金銭：支払',            count(*) FROM cash_payments
UNION ALL SELECT '金銭：入出金',          count(*) FROM cash_transactions
UNION ALL SELECT '在庫：残高のあるSKU',   count(*) FROM stocks WHERE qty_on_hand <> 0
UNION ALL SELECT '在庫：入出荷履歴',      count(*) FROM stock_movements
UNION ALL SELECT '取込：履歴',            count(*) FROM import_batches
UNION ALL SELECT '取込：外部受注',        count(*) FROM external_orders
UNION ALL SELECT '取込：Amazon明細',      count(*) FROM platform_transactions
UNION ALL SELECT '参照：郵便番号',        count(*) FROM postal_codes
UNION ALL SELECT '記録：操作履歴',        count(*) FROM audit_logs
 ORDER BY 1;

-- ---------------------------------------------------------------------------
-- 3) いま入っている伝票（新しい順に10件ずつ）
-- ---------------------------------------------------------------------------
SELECT '受注' AS 種類, o.order_no AS 番号, to_char(o.order_date, 'YYYY/MM/DD') AS 日付,
       p.name1 AS 相手, o.status AS 状態
  FROM sales_orders o JOIN partners p ON p.id = o.partner_id
 ORDER BY o.id DESC LIMIT 10;

SELECT '入荷' AS 種類, r.receipt_no AS 番号, to_char(r.planned_date, 'YYYY/MM/DD') AS 日付,
       w.short_name AS 倉庫, r.status AS 状態
  FROM receipts r JOIN warehouses w ON w.id = r.warehouse_id
 ORDER BY r.id DESC LIMIT 10;

SELECT '請求' AS 種類, i.invoice_no AS 番号, to_char(i.period_to, 'YYYY/MM/DD') AS 締め日,
       p.name1 AS 相手, i.status AS 状態, i.current_invoice_amount AS 当月請求額
  FROM invoices i JOIN partners p ON p.id = i.partner_id
 ORDER BY i.id DESC LIMIT 10;

-- ---------------------------------------------------------------------------
-- 4) 操作履歴の直近20件（誰がいつ何を変えたか）
-- ---------------------------------------------------------------------------
SELECT to_char(a.acted_at, 'YYYY/MM/DD HH24:MI') AS 日時,
       coalesce(u.name, '（不明）')               AS 利用者,
       CASE a.action WHEN 'insert' THEN '登録' WHEN 'update' THEN '変更'
                     WHEN 'delete' THEN '削除' ELSE a.action END AS 操作,
       a.ref_table                                AS 対象,
       a.ref_id                                   AS 番号
  FROM audit_logs a
  LEFT JOIN users u ON u.id = a.user_id
 ORDER BY a.acted_at DESC, a.id DESC
 LIMIT 20;
