-- ============================================================================
--  株式会社コニー 販売管理システム  初期データ
--  v1.6  2026-09-16
--  v1.6：伝票発行分類に納品書4様式を登録、送料 750 円、引当は受注登録時（9/15 ご回答）
--  要件定義書 付録A「区分値マスタ初期データ」／付録B「権限マトリクス」に対応
--  ※印の値は貴社確認事項。画面から追加・変更できるため開発に支障はない。
--
--  psql / Navicat / pgAdmin のいずれでも実行できる。
--  02-schema.sql を適用した直後の空のスキーマに対して実行すること。
-- ============================================================================

SET client_encoding = 'UTF8';
SET search_path = cony, public;

-- ----------------------------------------------------------------------------
-- 1. 区分カテゴリー
-- ----------------------------------------------------------------------------
INSERT INTO code_categories (code, name, sort_order) VALUES
  ('QUALITY_DIVISION',       '品質区分',            10),
  ('PARTNER_DIVISION',       '取引先区分',          20),
  ('PARTNER_DIVISION2',      '取引先区分2',         21),
  ('GROSS_MARGIN_ADJUST',    '粗利調整対象',        22),
  ('MONTHLY_INVOICE',        '毎月請求書発行',      23),
  ('DIGITIZED',              '電子化',              24),
  ('SHIPPING_FEE_RULE',      '送料3万以下・直送',   25),
  ('DELIVERY_DIVISION',      '納品先区分',          30),
  ('MASTER_SEARCH_DISPLAY',  'マスタ検索表示区分',  31),
  ('SLIP_ISSUE_CLASS',       '伝票発行分類',        32),
  ('PRODUCT_DIVISION',       '商品区分',            40),
  ('PRODUCT_DISPLAY',        '商品表示',            41),
  ('WAREHOUSE_DIVISION',     '倉庫区分',            50),
  ('TAX_DIVISION',           '税区分',              60),
  ('EXPENSE_DIVISION',       '経費区分',            61),
  ('COST_DIVISION',          '費用区分',            62),
  ('SALES_PRICE_SETTING',    '売上単価設定区分',    63),
  ('PURCHASE_PRICE_SETTING', '仕入単価設定区分',    64),
  ('TAX_EXEMPT',             '非課税区分',          65),
  ('NEW_TAX_CLASS',          '新税分類',            66),
  ('CASH_TYPE',              '入出金種類',          70),
  ('PROCESS',                '処理',                71),
  ('ADJUSTMENT_REASON',      '在庫調整理由',        80);

-- ----------------------------------------------------------------------------
-- 2. 区分値
-- ----------------------------------------------------------------------------
-- 品質区分（在庫。システム動作に必須）
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('GOOD',      '良品',          10),
  ('DEFECTIVE', '不良',          20),
  ('PENDING',   '返品検品待ち',  30)
) AS v(code, name, so) WHERE code_categories.code = 'QUALITY_DIVISION';

-- 取引先区分 ※要確認
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('TV',       '販社（テレビ通販）', 10),
  ('CATALOG',  '販社（カタログ）',   20),
  ('EC',       '通販（EC）',         30),
  ('STORE',    '実店舗',             40),
  ('SUPPLIER', '仕入先',             50),
  ('OTHER',    'その他',             90)
) AS v(code, name, so) WHERE code_categories.code = 'PARTNER_DIVISION';

-- 粗利調整対象
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('TARGET',     '対象',   10),
  ('NOT_TARGET', '対象外', 20)
) AS v(code, name, so) WHERE code_categories.code = 'GROSS_MARGIN_ADJUST';

-- 毎月請求書発行
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('ISSUE',     '発行する',   10),
  ('NOT_ISSUE', '発行しない', 20)
) AS v(code, name, so) WHERE code_categories.code = 'MONTHLY_INVOICE';

-- 電子化
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('DIGITAL', '電子', 10),
  ('PAPER',   '紙',   20)
) AS v(code, name, so) WHERE code_categories.code = 'DIGITIZED';

-- 送料3万以下・直送
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('CHARGE',      '請求する',         10),
  ('NO_CHARGE',   '請求しない',       20),
  ('DIRECT_ONLY', '直送のみ請求する', 30)
) AS v(code, name, so) WHERE code_categories.code = 'SHIPPING_FEE_RULE';

-- 商品区分 ※要確認
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('MAIN',      '本体',   10),
  ('ACCESSORY', '付属品', 20),
  ('PROMO',     '販促品', 30),
  ('OTHER',     'その他', 90)
) AS v(code, name, so) WHERE code_categories.code = 'PRODUCT_DIVISION';

-- 商品表示
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('SHOW', '表示する',   10),
  ('HIDE', '表示しない', 20)
) AS v(code, name, so) WHERE code_categories.code = 'PRODUCT_DISPLAY';

-- 倉庫区分
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('OWN',         '自社倉庫', 10),
  ('CONSIGNMENT', '委託倉庫', 20),
  ('EXTERNAL',    '外部倉庫', 30)
) AS v(code, name, so) WHERE code_categories.code = 'WAREHOUSE_DIVISION';

-- 税区分
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('TAX10',    '課税10%', 10),
  ('TAX8',     '軽減8%',  20),
  ('EXEMPT',   '非課税',  30),
  ('NON_TAX',  '不課税',  40)
) AS v(code, name, so) WHERE code_categories.code = 'TAX_DIVISION';

-- 経費区分 ※要確認（Amazon 関連は Q14 の暫定仕様）
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('AD',         '広告費',           10),
  ('LOGISTICS',  '物流費',           20),
  ('PROMOTION',  '販促費',           30),
  ('AMZ_FEE',    'Amazon手数料',     40),
  ('AMZ_AD',     'Amazon広告費',     50),
  ('FBA_FEE',    'FBA手数料',        60),
  ('OTHER',      'その他',           90)
) AS v(code, name, so) WHERE code_categories.code = 'EXPENSE_DIVISION';

-- 非課税区分
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('TAXABLE', '課税',   10),
  ('EXEMPT',  '非課税', 20)
) AS v(code, name, so) WHERE code_categories.code = 'TAX_EXEMPT';

-- 入出金種類
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('AR_RECEIPT', '売掛入金', 10),
  ('AP_PAYMENT', '買掛支払', 20),
  ('EXPENSE',    '経費支払', 30),
  ('OTHER',      'その他',   90)
) AS v(code, name, so) WHERE code_categories.code = 'CASH_TYPE';

-- 処理
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('PENDING', '未処理', 10),
  ('DONE',    '処理済', 20)
) AS v(code, name, so) WHERE code_categories.code = 'PROCESS';

-- 在庫調整理由（確認事項⑫）※要確認
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('STOCKTAKE', '棚卸差異',   10),
  ('DAMAGE',    '破損',       20),
  ('LOSS',      '紛失',       30),
  ('QUALITY',   '品質振替',   40),
  ('OTHER',     'その他',     90)
) AS v(code, name, so) WHERE code_categories.code = 'ADJUSTMENT_REASON';

-- 伝票発行分類（9/15 ご回答：納品書の様式は納品先マスタのこの分類で選ぶ）
--   名称は納品書の様式名と一致させる。帳票はこの名称で様式を決める。
INSERT INTO codes (code_category_id, code, name, sort_order)
SELECT id, v.code, v.name, v.so FROM code_categories, (VALUES
  ('WITH_PRICE',   '単価あり',  10),
  ('WITH_PRICE2',  '単価あり2', 20),
  ('WITH_RETAIL',  '上代あり',  30),
  ('NO_PRICE',     '単価なし',  40)
) AS v(code, name, so) WHERE code_categories.code = 'SLIP_ISSUE_CLASS';

-- ※以下は貴社確認後に登録する（Q5）
--   PARTNER_DIVISION2 / DELIVERY_DIVISION / MASTER_SEARCH_DISPLAY /
--   COST_DIVISION / SALES_PRICE_SETTING / PURCHASE_PRICE_SETTING / NEW_TAX_CLASS


-- ----------------------------------------------------------------------------
-- 3. 販売カテゴリー（OA／カタログ／WEB）
-- ----------------------------------------------------------------------------
INSERT INTO sales_categories (code, name, sort_order) VALUES
  ('OA',      'OA（オンエア）', 10),
  ('CATALOG', 'カタログ',       20),
  ('WEB',     'WEB',            30);

-- ----------------------------------------------------------------------------
-- 4. ロール
-- ----------------------------------------------------------------------------
INSERT INTO roles (code, name, sort_order) VALUES
  ('ADMIN',      '管理者', 10),
  ('OPERATOR',   '作業者', 20),
  ('ACCOUNTING', '経理',   30),
  ('VIEWER',     '閲覧者', 40);

-- ----------------------------------------------------------------------------
-- 5. 権限（機能 × 操作）
-- ----------------------------------------------------------------------------
INSERT INTO permissions (function_id, action, name, is_sensitive)
SELECT f.fid, a.act, f.fname || '：' || a.aname, f.sens
FROM (VALUES
  ('M-01','取引先マスタ',        false),
  ('M-05','納品先マスタ',        false),
  ('M-08','商品マスタ',          false),   -- 原価は SENSITIVE 権限で項目単位に隠す
  ('M-09','SKUコードマスタ',     false),
  ('M-10','セット登録マスタ',    false),
  ('M-11','得意先別商品マスタ',  false),   -- 原価は SENSITIVE 権限で項目単位に隠す
  ('M-14','倉庫マスタ',          false),
  ('M-15','仕入マスタ',          true ),   -- 仕入単価を含む
  ('M-16','汎用区分マスタ',      false),
  ('M-17','ユーザー・権限',      true ),
  ('O-01','受注登録',            false),
  ('O-03','受注一覧',            false),
  ('S-01','在庫表',              false),
  ('S-03','入荷登録',            false),
  ('S-05','入出荷履歴',          false),
  ('S-08','取引先別確保数',      false),
  ('D-01','出荷指示',            false),
  ('D-03','帳票一括印刷',        false),
  ('R-01','返品・再生',          false),
  ('B-01','締め処理',            false),
  ('B-02','請求書発行',          false),
  ('B-04','売掛残高一覧',        false),
  ('B-05','入金登録・消込',      false),
  ('P-01','仕入・経費登録',      true ),
  ('P-03','買掛残高一覧',        true ),
  ('C-01','入出金処理',          true ),
  ('Y-02','ロイヤリティ計算',    true ),
  ('A-01','販売実績管理',        false),
  ('A-03','汎用クエリ集計',      false),
  ('I-01','CSV取込',             false)
) AS f(fid, fname, sens),
(VALUES
  ('view','参照'), ('create','登録'), ('update','更新'),
  ('delete','削除'), ('print','印刷')
) AS a(act, aname);

-- 機微項目の参照。画面ではなく「項目」に対する権限。
--   要件定義書の「原価・仕入単価・ロイヤリティは、閲覧のみの方には表示されません」は
--   画面ではなく項目を挙げている。商品マスタ・得意先別商品マスタは閲覧者も開けるが、
--   この権限がないと原価の欄が出ない、という作りにする。
--   仕入マスタ・仕入経費登録・入出金・ロイヤリティ計算のように画面ごと見せないものは
--   従来どおり機能側の is_sensitive で制御する。
INSERT INTO permissions (function_id, action, name, is_sensitive) VALUES
  ('SENSITIVE', 'view', '機微項目（原価・仕入単価・ロイヤリティ）の参照', true);

-- ----------------------------------------------------------------------------
-- 6. ロール権限（付録B の権限マトリクス）
-- ----------------------------------------------------------------------------
-- 管理者：全権限
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.code = 'ADMIN';

-- 閲覧者：機微でない機能の参照のみ
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'VIEWER' AND p.action = 'view' AND p.is_sensitive = false;

-- 作業者：機微でない機能の全操作＋機微機能の参照（ただし M-15/P-01/C-01/Y-02 を除く）
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'OPERATOR'
   AND (
        (p.is_sensitive = false)
     OR (p.is_sensitive = true AND p.action = 'view'
         AND p.function_id NOT IN ('M-15','P-01','C-01','Y-02','M-17'))
   );

-- 経理：金額系の全操作＋その他の参照
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
 WHERE r.code = 'ACCOUNTING'
   AND (
        p.function_id IN ('M-15','B-01','B-02','B-04','B-05','P-01','P-03','C-01','Y-02','A-01','A-03')
     OR p.action = 'view'
   )
   AND p.function_id <> 'M-17';

-- ----------------------------------------------------------------------------
-- 7. 採番ルール（要件定義書 6.8）
-- ----------------------------------------------------------------------------
INSERT INTO numbering_rules (target, prefix, use_yyyymm, seq_length, reset_unit) VALUES
  ('sales_order',      'SO', true,  5, 'month'),
  ('shipment',         'D',  false, 7, 'none'),
  ('receipt',          'RC', true,  5, 'month'),
  ('return',           'RT', true,  5, 'month'),
  ('invoice',          'IV', true,  4, 'month'),
  ('purchase',         'PU', true,  5, 'month'),
  ('cash_transaction', NULL, false, 8, 'none'),
  ('delivery_code',    NULL, false, 8, 'none'),
  ('warehouse_code',   NULL, false, 4, 'none'),
  ('purchase_item',    NULL, false, 8, 'none'),
  ('stock_adjustment', 'AJ', true,  5, 'month');
-- 確認事項⑪により、出荷指示番号は受注番号をそのまま使う（system_settings の
-- SHIPMENT_NO_SOURCE＝sales_order）。上の 'shipment' は、複数受注を1つにまとめる
-- 同梱のときだけ使用する。

-- ----------------------------------------------------------------------------
-- 8. 倉庫（実データより）
--   受領した OMS 受注CSV の「処理ルート」に実在する4値をそのまま登録する。
--   （v1.1 では 0002／0003 の名称が誤っていたため v1.2 で是正）
-- ----------------------------------------------------------------------------
INSERT INTO warehouses (warehouse_code, short_name, is_consignment, division_code_id, sort_order)
SELECT v.wc, v.nm, false,
       (SELECT c.id FROM codes c
          JOIN code_categories cc ON cc.id = c.code_category_id
         WHERE cc.code = 'WAREHOUSE_DIVISION' AND c.code = 'OWN'),
       v.so
FROM (VALUES
  ('0001', 'コニー倉庫(EC)',           10),
  ('0002', 'コニー倉庫(交換・修理)',   20),
  ('0003', 'コニー倉庫(美整体直販)',   30),
  ('0004', 'コニー倉庫(コニーストア)', 40)
) AS v(wc, nm, so);

-- ----------------------------------------------------------------------------
-- 9. 初期ユーザー（本番投入時にパスワードを変更すること）
-- ----------------------------------------------------------------------------
INSERT INTO users (login_id, name, password_hash, is_active)
VALUES ('admin', 'システム管理者', '$2b$12$CHANGE_THIS_ON_DEPLOY', true);

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u, roles r WHERE u.login_id = 'admin' AND r.code = 'ADMIN';

-- ----------------------------------------------------------------------------
-- 10. システム設定（要件定義書で「設定で変更できる」とご説明した項目）
--   すべて暫定値。貴社のご回答後は、この表の値を画面から変更するだけで反映される。
--   ※印は貴社確認事項。
-- ----------------------------------------------------------------------------
INSERT INTO system_settings
  (setting_key, setting_group, name, value_text, value_type, allowed_values, description, sort_order)
VALUES
  -- 消費税（Q8）
  ('TAX_ROUNDING_UNIT',  'TAX', '消費税の計算単位', 'invoice', 'text', 'invoice,slip',
   '※ invoice＝請求書単位で税率別に計算／slip＝伝票単位で計算。暫定は invoice。', 10),
  ('TAX_ROUNDING_MODE',  'TAX', '消費税の端数処理', 'floor', 'text', 'floor,round,ceil',
   '※ floor＝切捨て／round＝四捨五入／ceil＝切上げ。暫定は floor。', 20),
  ('TAX_BY_RATE',        'TAX', '税率別に集計する', 'true', 'boolean', NULL,
   '10%と8%を分けて計算し、請求書の税率別内訳へ出力する。', 30),

  -- 送料（貴社ルール：1回の出荷が30,000円未満のとき一律750円を請求。9/15 ご回答で確定）
  ('SHIPPING_FEE_THRESHOLD', 'SHIPPING', '送料を請求する金額の上限', '30000', 'number', NULL,
   'この金額未満の出荷に送料を請求する（ちょうどは請求しない）。取引先マスタで個別に上書きできる。', 10),
  ('SHIPPING_FEE_AMOUNT',    'SHIPPING', '請求する送料額', '750', 'number', NULL,
   '9/15 ご回答により一律 750 円。直送は受注の送料調整欄に直接入力する。取引先マスタで個別に上書きできる。', 20),
  ('SHIPPING_FEE_BASE',      'SHIPPING', '送料判定の基準額', 'excluded_tax', 'text',
   'excluded_tax,included_tax',
   '※ 30,000円の判定を税抜と税込のどちらで行うか。暫定は税抜。', 30),

  -- 外部データ取込
  ('OMS_IMPORT_MODE', 'IMPORT', '通販CSVの取込モード', 'shipped_result', 'text',
   'order,shipped_result',
   'order＝これから出荷する受注として取り込む／shipped_result＝出荷済みの実績として取り込む。'
   || '2026/09/08 に「通販のCSVデータは出荷済みデータ」とご回答をいただき確定。', 10),
  ('OMS_DUPLICATE_POLICY', 'IMPORT', '同一受注番号を再取込したときの扱い', 'skip', 'text',
   'skip,error', 'skip＝取込済として除外／error＝エラーとして停止。暫定は skip。', 20),
  ('AMAZON_PARTNER_CODE', 'IMPORT', 'Amazonの取引先コード', 'AMZN', 'text', NULL,
   'Amazon決済レポートの SKU を読み替えるときに参照する取引先。', 30),

  -- ロイヤリティ（貴社ご回答により確定）
  ('ROYALTY_CALC_BASE', 'ROYALTY', 'ロイヤリティの計算基準', 'shipment_amount', 'text',
   'shipment_amount,invoice_amount,qty',
   '出荷金額をもとに計算する。返品はマイナスの出荷金額として同じ月に反映される。', 10),
  ('ROYALTY_PRICE_BASE', 'ROYALTY', '料率をかける金額', 'wholesale', 'text',
   'wholesale,retail',
   'wholesale＝販売先への卸金額／retail＝上代。貴社ご回答により卸金額で確定。', 15),
  ('ROYALTY_INCLUDE_RETURNS', 'ROYALTY', '返品をロイヤリティに反映する', 'true', 'boolean', NULL,
   '返品はマイナスの出荷金額として計上し、入力されたマイナス金額の分だけを差し引く。', 18),
  ('ROYALTY_ROUNDING_MODE', 'ROYALTY', 'ロイヤリティの端数処理', 'floor', 'text',
   'floor,round,ceil', '消費税と同じく切捨て。画面から変更できる。', 20),

  -- 帳票
  ('INVOICE_PRINT_ISSUE_DATE', 'DOCUMENT', '請求書に発行日を印刷する', 'false', 'boolean', NULL,
   '貴社ご指示により印刷しない。', 10),
  ('PICKING_EXPAND_SET', 'DOCUMENT', 'ピッキングリストでセットを構成品に展開する', 'true',
   'boolean', NULL, 'いただいた帳票サンプルどおり、展開したうえで同一商品を合算する。', 20),
  ('DELIVERY_NOTE_DEFAULT_FORM', 'DOCUMENT', '納品書の既定様式', '単価あり', 'text',
   '単価あり,単価あり2,上代あり,単価なし',
   '※ 納品先マスタの伝票発行分類が未設定のときに使う様式。使い分け一覧を頂戴後に見直す。', 30),

  -- 帳票の差出人。納品書・請求書の上部に印刷する。画面から変更できる。
  ('COMPANY_NAME',       'DOCUMENT', '帳票に印刷する自社名', '株式会社コニー', 'text', NULL,
   '納品書・請求書の差出人。', 40),
  ('COMPANY_ADDRESS',    'DOCUMENT', '帳票に印刷する自社住所', '', 'text', NULL,
   '※ 帳票に印刷する住所を頂戴ください。', 50),
  ('COMPANY_TEL',        'DOCUMENT', '帳票に印刷する電話番号', '', 'text', NULL,
   '※ 帳票に印刷する電話番号を頂戴ください。', 60),
  ('COMPANY_INVOICE_NO', 'DOCUMENT', '適格請求書発行事業者番号', '', 'text', NULL,
   '※ T から始まる登録番号。空欄のときは請求書に印刷しない。', 70),

  -- 受注・在庫の運用（2026/09/08 確認事項、2026/09/15 に見直し）
  ('ALLOCATION_TIMING', 'ORDER', '在庫を引き当てるタイミング', 'order_entry', 'text',
   'order_entry,shipping_instruction',
   'order_entry＝受注登録時に引き当て、足りない分は引当待ちにする／shipping_instruction＝出荷指示ボタンを押した時。'
   || '9/15 のご確認により order_entry で確定（実在庫は出荷確定で減る）。', 10),
  ('SHIPMENT_NO_SOURCE', 'ORDER', '出荷指示番号の採り方', 'sales_order', 'text',
   'sales_order,independent',
   'sales_order＝受注番号をそのまま使う／independent＝独自に採番する。'
   || '確認事項⑪により sales_order で確定。同梱で複数受注を1つにまとめるときのみ枝番を付す。', 20),
  ('SAMPLE_ORDER_TYPE', 'ORDER', 'サンプル出荷の受注区分', 'サンプル', 'text', NULL,
   '確認事項④。出荷指示書が出て在庫も落ちるが、売上・請求には計上しない。', 30),

  -- 参照データ
  ('POSTAL_DATA_VERSION', 'REFERENCE', '郵便番号データの版', NULL, 'text', NULL,
   '取り込んだ日本郵便 KEN_ALL の版（YYYYMM）。保守契約の定期更新で更新する。', 10);

-- ----------------------------------------------------------------------------
-- 11. 取込テンプレート（販社の発注CSV。2026/09/08 に4社分を受領）
--   販社ごとに書式がまったく異なるため、書式そのものをマスタとして持つ。
--   5社目が増えても、この登録を追加するだけで取り込める（プログラムの変更は不要）。
--
--   transform に指定できる値
--     trim         前後の空白を除去する（白鳩のJANは末尾に空白が入っている）
--     date_slash   2026/9/8 形式
--     date_ymd     20260908 形式
--     date_yymmdd  260909 形式（ビックカメラの納品予定日）
--     number       桁区切りを除去して数値にする
--     jan13        13桁のJANとして検査する。指数表記（4.57349E+12）は取込エラーとする
--
--   ※ partner_id は取引先マスタ登録後に設定する。当面はCSV内の得意先IDで突き合わせる。
-- ----------------------------------------------------------------------------
INSERT INTO import_templates
  (template_code, name, import_type, file_encoding, has_header, order_no_source,
   sku_match_key, default_order_type, sort_order, note)
VALUES
  ('BIC',        'ビックカメラ 発注CSV',  'PARTNER_ORDER', 'CP932', true, 'csv',
   'sku_code', '卸', 10,
   '得意先ID SD0228。数量・単価は「出荷数量／出荷時単価」を採用する（発注時単価と異なるため）。'
   || 'JANコードが指数表記に壊れているため商品コードで引き当てる。'),
  ('LABELLEVIE', 'ラベルヴィ 発注CSV',    'PARTNER_ORDER', 'CP932', true, 'csv',
   'sku_code', '卸', 20,
   '得意先ID SD0180。6列目は見出しが空欄で出荷日。単価は「発注金額(税抜)÷発注バラ数」で求める。'),
  ('SHIRAHATO',  '白鳩 発注CSV',          'PARTNER_ORDER', 'CP932', true, 'csv',
   'jan',      '卸', 30,
   '得意先ID SD0264。自社商品コードの列がないためJANで引き当てる。'
   || 'JANの末尾に半角空白が入る。最終列のJANCDは見出しが重複した空列。'),
  ('CONNECT',    'コネクト 発注CSV',      'PARTNER_ORDER', 'UTF8',  true, 'csv',
   'sku_code', '卸', 40,
   '取引先コード SD0194。1列目は見出しが空欄で受注番号。');

INSERT INTO import_template_columns
  (import_template_id, column_index, source_header, target_field, transform, is_required)
SELECT t.id, v.idx, v.hdr, v.fld, v.tr, v.req
  FROM import_templates t
  JOIN (VALUES
  -- ビックカメラ（36列）
  ('BIC',  1,'No.',                        'order_no',      NULL,         true),
  ('BIC',  2,'得意先ID',                   'partner_code',  'trim',       true),
  ('BIC',  3,'得意先名',                   'partner_name',  NULL,         false),
  ('BIC',  4,'納品先ID',                   'delivery_code', 'trim',       true),
  ('BIC',  5,'納品先名',                   'delivery_name', NULL,         false),
  ('BIC',  6,'商品コード',                 'sku_code',      'trim',       true),
  ('BIC',  7,'出荷日',                     'ship_date',     'date_ymd',   false),
  ('BIC',  8,'納品日',                     'delivery_date', 'date_ymd',   false),
  ('BIC',  9,'データ種別',                 'ignore',        NULL,         false),
  ('BIC', 10,'取消フラグ',                 'ignore',        NULL,         false),
  ('BIC', 11,'法人コード',                 'ignore',        NULL,         false),
  ('BIC', 12,'発注場所コード',             'ignore',        NULL,         false),
  ('BIC', 13,'納品場所コード',             'ignore',        NULL,         false),
  ('BIC', 14,'フロアコード',               'ignore',        NULL,         false),
  ('BIC', 15,'発注年月日',                 'order_date',    'date_ymd',   false),
  ('BIC', 16,'送信年月日',                 'ignore',        NULL,         false),
  ('BIC', 17,'有効期限年月日',             'ignore',        NULL,         false),
  ('BIC', 18,'取引先コード',               'ignore',        NULL,         false),
  ('BIC', 19,'発注No',                     'po_no',         'trim',       false),
  ('BIC', 20,'発注行No',                   'po_line_no',    'number',     false),
  ('BIC', 21,'分納No',                     'ignore',        NULL,         false),
  ('BIC', 22,'JANコード',                  'jan',           'jan13',      false),
  ('BIC', 23,'型番/商品名',                'item_name',     NULL,         false),
  ('BIC', 24,'色・規格',                   'color',         NULL,         false),
  ('BIC', 25,'発注数量',                   'ignore',        NULL,         false),
  ('BIC', 26,'発注時単価',                 'ignore',        NULL,         false),
  ('BIC', 27,'出荷数量',                   'qty',           'number',     true),
  ('BIC', 28,'出荷時単価',                 'unit_price',    'number',     true),
  ('BIC', 29,'お客様着日',                 'ignore',        NULL,         false),
  ('BIC', 30,'弊社指定納品日',             'ignore',        NULL,         false),
  ('BIC', 31,'法人区分',                   'ignore',        NULL,         false),
  ('BIC', 32,'伝票No',                     'ignore',        NULL,         false),
  ('BIC', 33,'入荷予定区分／納期回答区分', 'ignore',        NULL,         false),
  ('BIC', 34,'コメント欄',                 'remarks',       NULL,         false),
  ('BIC', 35,'倉庫出荷日付',               'ignore',        NULL,         false),
  ('BIC', 36,'納品予定日',                 'requested_delivery_date','date_yymmdd', false),

  -- ラベルヴィ（26列）
  ('LABELLEVIE',  1,'№',              'order_no',      NULL,        true),
  ('LABELLEVIE',  2,'得意先ID',        'partner_code',  'trim',      true),
  ('LABELLEVIE',  3,'得意先名',        'partner_name',  NULL,        false),
  ('LABELLEVIE',  4,'納品先ID',        'delivery_code', 'trim',      true),
  ('LABELLEVIE',  5,'納品先名',        'delivery_name', NULL,        false),
  ('LABELLEVIE',  6,'（見出し空欄）',  'ship_date',     'date_slash',false),
  ('LABELLEVIE',  7,'入荷予定日',      'delivery_date', 'date_slash',false),
  ('LABELLEVIE',  8,'発注番号',        'po_no',         'trim',      false),
  ('LABELLEVIE',  9,'明細番号',        'line_no',       'number',    false),
  ('LABELLEVIE', 10,'ブランド名',      'ignore',        NULL,        false),
  ('LABELLEVIE', 11,'ブランドライン',  'ignore',        NULL,        false),
  ('LABELLEVIE', 12,'商品品番',        'sku_code',      'trim',      true),
  ('LABELLEVIE', 13,'JANCODE',         'jan',           'jan13',     false),
  ('LABELLEVIE', 14,'アイテム',        'item_name',     NULL,        false),
  ('LABELLEVIE', 15,'カラー',          'color',         NULL,        false),
  ('LABELLEVIE', 16,'サイズ',          'size',          NULL,        false),
  ('LABELLEVIE', 17,'発注セット数',    'ignore',        NULL,        false),
  ('LABELLEVIE', 18,'発注バラ数',      'qty',           'number',    true),
  ('LABELLEVIE', 19,'掛率',            'ignore',        NULL,        false),
  ('LABELLEVIE', 20,'卸値(税抜)',      'ignore',        NULL,        false),
  ('LABELLEVIE', 21,'セール単価(税抜)','ignore',        NULL,        false),
  ('LABELLEVIE', 22,'GLS単価(税込)',   'retail_price',  'number',    false),
  ('LABELLEVIE', 23,'発注金額(税抜)',  'amount',        'number',    true),
  ('LABELLEVIE', 24,'GLSコード',       'ignore',        NULL,        false),
  ('LABELLEVIE', 25,'メーカーコード',  'partner_product_code', 'trim', false),
  ('LABELLEVIE', 26,'備考',            'remarks',       NULL,        false),

  -- 白鳩（29列。最終列は見出しが重複した空列）
  ('SHIRAHATO',  1,'伝票№',        'order_no',      NULL,        true),
  ('SHIRAHATO',  2,'得意先ID',      'partner_code',  'trim',      true),
  ('SHIRAHATO',  3,'得意先名',      'partner_name',  NULL,        false),
  ('SHIRAHATO',  4,'納品先CD',      'delivery_code', 'trim',      true),
  ('SHIRAHATO',  5,'出荷日',        'ship_date',     'date_slash',false),
  ('SHIRAHATO',  6,'発注区分',      'ignore',        NULL,        false),
  ('SHIRAHATO',  7,'発注番号',      'po_no',         'trim',      false),
  ('SHIRAHATO',  8,'発注日',        'order_date',    'date_slash',false),
  ('SHIRAHATO',  9,'発注先CD',      'ignore',        NULL,        false),
  ('SHIRAHATO', 10,'発注担当者名',  'ignore',        NULL,        false),
  ('SHIRAHATO', 11,'入荷依頼日',    'delivery_date', 'date_slash',false),
  ('SHIRAHATO', 12,'摘要',          'remarks',       NULL,        false),
  ('SHIRAHATO', 13,'発注数合計',    'ignore',        NULL,        false),
  ('SHIRAHATO', 14,'発注金額合計',  'ignore',        NULL,        false),
  ('SHIRAHATO', 15,'JANCD有無',     'ignore',        NULL,        false),
  ('SHIRAHATO', 16,'JANCD',         'jan',           'trim',      true),
  ('SHIRAHATO', 17,'メーカー品番',  'item_name',     NULL,        false),
  ('SHIRAHATO', 18,'白鳩品番',      'partner_product_code', 'trim', false),
  ('SHIRAHATO', 19,'カラー名',      'color',         NULL,        false),
  ('SHIRAHATO', 20,'サイズ名',      'size',          NULL,        false),
  ('SHIRAHATO', 21,'上代',          'retail_price',  'number',    false),
  ('SHIRAHATO', 22,'下代',          'unit_price',    'number',    true),
  ('SHIRAHATO', 23,'発注数',        'qty',           'number',    true),
  ('SHIRAHATO', 24,'発注金額',      'amount',        'number',    false),
  ('SHIRAHATO', 25,'備考',          'ignore',        NULL,        false),
  ('SHIRAHATO', 26,'納品有無',      'ignore',        NULL,        false),
  ('SHIRAHATO', 27,'納品数',        'ignore',        NULL,        false),
  ('SHIRAHATO', 28,'納品予定日',    'requested_delivery_date','date_slash', false),
  ('SHIRAHATO', 29,'JANCD（重複）', 'ignore',        NULL,        false),

  -- コネクト（10列）
  ('CONNECT',  1,'（見出し空欄）', 'order_no',      NULL,        true),
  ('CONNECT',  2,'注文ID',         'po_no',         'trim',      false),
  ('CONNECT',  3,'取引先コード',   'partner_code',  'trim',      true),
  ('CONNECT',  4,'お届け先コード', 'delivery_code', 'trim',      true),
  ('CONNECT',  5,'出荷日',         'ship_date',     'date_slash',false),
  ('CONNECT',  6,'納品予定日',     'delivery_date', 'date_slash',false),
  ('CONNECT',  7,'納品希望日',     'requested_delivery_date','date_slash', false),
  ('CONNECT',  8,'商品コード',     'sku_code',      'trim',      true),
  ('CONNECT',  9,'数量',           'qty',           'number',    true),
  ('CONNECT', 10,'発注単価',       'unit_price',    'number',    true)
) AS v(tpl, idx, hdr, fld, tr, req) ON v.tpl = t.template_code;

-- ----------------------------------------------------------------------------
-- 12. 郵便番号マスタ（postal_codes）の取り込み
--   件数が約12.4万件あるため、このファイルには含めず別手順で投入する。
--
--   (1) 日本郵便から utf_ken_all.zip を取得して展開する
--       https://www.post.japanpost.jp/zipcode/dl/utf-zip.html
--   (2) 一時表へ読み込む（CSV は UTF-8・ヘッダなし・15列）
--
--       CREATE TEMP TABLE ken_all_raw (
--         jis text, old_zip text, zip text,
--         pref_kana text, city_kana text, town_kana text,
--         pref text, city text, town text,
--         f1 int, f2 int, f3 int, f4 int, f5 int, f6 int);
--       \copy ken_all_raw FROM 'utf_ken_all.csv' WITH (FORMAT csv, ENCODING 'UTF8')
--
--   (3) 本表へ整形して投入する（town の「以下に掲載がない場合」等は空にする）
--
--       INSERT INTO postal_codes
--         (postal_code, prefecture, city, town,
--          prefecture_kana, city_kana, town_kana, jis_code, is_multi_town,
--          source, data_version)
--       SELECT r.zip, r.pref, r.city,
--              CASE WHEN r.town LIKE '以下に掲載がない場合%'
--                    OR r.town LIKE '%の次に番地がくる場合%'
--                    OR r.town LIKE '%一円%' THEN ''
--                   ELSE regexp_replace(r.town, '（.*$', '') END,
--              r.pref_kana, r.city_kana, r.town_kana, r.jis, (r.f2 = 1),
--              'KEN_ALL', to_char(CURRENT_DATE, 'YYYYMM')
--         FROM ken_all_raw r
--        ON CONFLICT (postal_code, town) DO NOTHING;
--
--       UPDATE system_settings SET value_text = to_char(CURRENT_DATE, 'YYYYMM')
--        WHERE setting_key = 'POSTAL_DATA_VERSION';
--
--   受入テスト（04-schema-tests.sql）は本表が空でも通るようにしてある。
-- ----------------------------------------------------------------------------

-- ============================================================================
--  以上
-- ============================================================================
