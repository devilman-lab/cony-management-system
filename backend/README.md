# バックエンド（NestJS）

第2段階の成果物。第1段階で確定した `docs/02-schema.sql` の 70 テーブルに対して動く API サーバー。

## 通し確認

使い捨ての PostgreSQL を別ポート（55432）に立て、SQL を流し、API を起動して主要な経路を叩き、最後に片付けるところまでを1コマンドで行います。**開発中の `cony_dev` には触りません。**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\smoke-backend.ps1
```

```
=== 2. スキーマと初期データ、受入テスト ===
  OK  02-schema.sql
  OK  03-seed-data.sql
  OK  07-verify-objects
  OK  04-schema-tests 全件合格
=== 4. 認証まわり ===
  OK  未ログインは 401
  OK  権限のない利用者は 403
=== 5. マスタと在庫 ===
  OK  有効在庫＝実在庫−引当済
=== 25. ユーザー・権限（M-17） ===
  OK  最後の管理者は無効にできない
=== 26. 帳票一括印刷（D-03） ===
  OK  納品書が4様式とも出る
=== 27. 郵便番号・同梱・請求の手入力・販売予定・JAN出力・添付 ===
  OK  同じ郵便番号に複数の町域があれば全部返す
すべて合格  309 項目
```

経路の一覧は実物から数え上げられます。提出用の API 仕様書の付録はこれで作っています。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\list-api-routes.ps1
powershell -ExecutionPolicy Bypass -File scripts\list-api-routes.ps1 -AsMarkdown
```

API を起動したままにして手で触りたいときは `-KeepRunning` を付けます。

## 準備

### 1. Node

**Node v24.14.0 で動作確認済み**です（要件は 20 以上）。

### 2. データベースを用意する

第1段階の手順どおり、`cony_dev` に `02` → `03` を適用しておきます（`docs/00-検証手順.md`）。

### 3. 設定ファイルを作る

```powershell
cd backend
Copy-Item .env.example .env
```

`.env` を開いて `DATABASE_URL` のパスワードと `JWT_SECRET` を実際の値にします。`JWT_SECRET` は次で作れます。

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 4. 依存をインストールして起動する

```powershell
npm install
npm run build      # まずここで型が通るかを見る
npm run dev
```

## 動作確認

```powershell
# データベースを正しく見ているか（テーブル70・初期データの件数が返る）
curl http://localhost:3001/api/health/db
```

`status: "ok"` かつ `tables: 70` なら、アプリと SQL が同じデータベースを見ています。

### ログインできるようにする

`03-seed-data.sql` が入れる `admin` のパスワードは差し替え前提の文字列で、そのままではログインできません。実際の値を設定します。

```powershell
npm run user:password -- admin "十文字以上のパスワード"
```

```powershell
curl -X POST http://localhost:3001/api/auth/login `
  -H "Content-Type: application/json" `
  -d '{\"login_id\":\"admin\",\"password\":\"十文字以上のパスワード\"}'
```

返ってきた `access_token` を付けて呼びます。

```powershell
curl http://localhost:3001/api/masters/partners -H "Authorization: Bearer <token>"
```

## 現在の実装範囲

経路 156 本。**要件定義書の機能ID 30 すべて**に対応しています。

2026-09-16、9/15 の社内確認へのご回答を反映しました（スキーマ v1.6）。

| 項目 | 内容 |
|---|---|
| 受注登録時に引当 | `ALLOCATION_TIMING=order_entry` が既定。実在庫を超える数量は 400、有効在庫が足りない分は「引当待ち」。`POST /api/orders/:id/allocate` で引き当て直す |
| 出荷確定と印刷を同時に | `POST /api/reports/confirm-and-print`。確定（実在庫減）＋帳票＋添付（PDF・画像）を1つのPDFで返す。Excel・Word は `X-Skipped-Attachments` で知らせる |
| 出荷確定の取消 | `POST /api/shipments/:id/unconfirm`。実在庫を戻し受注を「引当済」に。請求に含めた出荷は 409 |
| 送料 | 30,000円**未満**は 750 円（`fn_shipping_fee` は `<`）。締め処理が出荷ごとに判定 |
| 上代 | `partner_products.retail_price`。納品書「上代あり」に印字 |
| 納品書の様式 | 汎用区分 `SLIP_ISSUE_CLASS` に4様式。納品先マスタで選ぶ |
| カード欄 | `cash_transactions.card_amount` |
| 販売担当・利益 | 販売担当マスタ `sales_staff`（`/masters/simple/sales_staff`）。取引先の既定担当 → `sales_orders.sales_staff_id`。集計の軸「販売担当」、指標「原価・ロイヤリティ・利益」（SENSITIVE:view が要る） |
| 引当在庫（9/17） | `reservations` を販売カテゴリー×SKU×期間で登録（取引先は任意）。`POST /api/orders` が枠を消費（`sales_order_lines.reservation_id`）、取消・修正で戻す。枠超えは 400。`POST /api/inventory/reservations/copy` で前月分を翌月へ複写。CSV取込の受注も登録時に引当・消費（止めずに引当待ちで残す） |

次は現在の作りのまま画面に進み、画面テストでご指摘があれば見直す（改めて質問しない）。

| 箇所 | 現在の作り |
|---|---|
| 分納 | 全量そろってから出荷（引当待ちは出荷の対象外） |
| 引当在庫の枠超え | 登録できない（400）。警告に変える運用も可 |
| 販売担当への原価・利益 | 権限 SENSITIVE:view で個別付与 |
| 送料判定の基準額 | 税抜（`SHIPPING_FEE_BASE=excluded_tax`） |
| 楽楽販売のデータ | 「どのデータを取り込むか後日まとめます」とのこと。連絡待ち |

2026-09-25、全機能テストのご指摘に対応しました（第2弾：登録したものを訂正・取消できるように）。

| 箇所 | 現在の作り |
|---|---|
| 支払の訂正・取消 | `GET /api/payments` で一覧、`PATCH /api/payments/:id`（支払日・支払額・消込先の仕入・備考）、`DELETE /api/payments/:id` で物理削除。入出金処理に取り込み済み（`cash_transaction_id` あり）の支払は 409 |
| 入金の訂正・取消 | `PATCH /api/billing/cash-receipts/:id`・`DELETE /api/billing/cash-receipts/:id`。消込先を外すときは `invoice_id: null`。取引先は変えられない（削除して入れ直す）。消込額はサーバ側で辻褄を合わせる |
| 仕入・経費の取消 | `POST /api/purchases/:id/cancel` で `status='取消'`。支払がひも付いていれば 409。買掛残高・商品別経費の集計から外れる |
| 返品の取消 | `POST /api/returns/:id/cancel`。「受付」のうちだけ。検品で在庫が動いた後、未取消の請求に載っている返品は 409 |
| 入荷の取消 | `POST /api/inventory/receipts/:id/cancel`。「指示」のうちだけ。一覧の既定から「取消」を外したので、出すときは `include_cancelled=true` |
| 買掛残高 | `GET /api/ap-balances` に `carryover_amount`（前月繰越）を追加。`balance` は 繰越＋期間内仕入−期間内支払 を SQL の numeric で計算 |
| CSV取込 | 郵便番号は `dry_run` を受け付ける（確認だけで登録しない）。販社・通販の `created_orders` は実際に作れた受注だけを数え、マスタ未登録で残した分は `pending_orders`。Amazon は一意索引 `ux_platform_tx_natural` で二重登録を止める |

2026-09-25、あわせて第3弾（残っていた食い違いの解消）を入れました。

| 箇所 | 現在の作り |
|---|---|
| 取り消した請求を残す | 「取消」にした請求は締め直しでも消えず、履歴として残る。締め直すと**新しい請求番号**でもう1件できる（未発行のまま締め直したときは今まで通り同じ番号で作り直す）。取消の請求に消し込んでいた入金は、新しい請求へ付け替わる。売掛残高・前回請求残高は取消を数えない。請求書の一覧では「取消」として見える |
| 数量の検査をそろえた | 受注・入荷・**返品**のいずれも、0 とマイナスで同じ文言「N行目：数量は 0 より大きい数で入力してください」。仕入明細の数量0も同じ文言で弾く（単価のマイナスは値引・返金の記録に使うため残す） |
| 入出金の訂正・取消 | `PATCH /api/cash-transactions/:id`・`DELETE /api/cash-transactions/:id`。入金・支払と同じ作り |
| 支払の消込先 | `GET /api/purchases?exclude_cancelled=true`。支払の登録・訂正のプルダウンから取消済みの仕入を外す |
| 通販(OMS)CSV | 文字コードを自動で見分ける（UTF-8 → だめなら CP932）。見出しが合わないときの案内も文字コードに触れる |
| 取込履歴の件数 | 販社発注の「登録できた件数」を、読めた行数ではなく**実際に作れた受注の件数**に。郵便番号の取込も履歴に残る（取込種別 `POSTAL_CODE`） |
| 操作履歴 | `audit_logs` に書く側を実装（`src/common/audit.interceptor.ts`）。詳しくは「設計の決めごと ＞ 操作履歴は経路の一覧で決める」 |

稼働中のデータベースには `docs/migrations/` の SQL を**上から順に**当てる必要があります（新規構築では `docs/02-schema.sql` に入っています）。

| 順 | ファイル | 何をするか |
|---|---|---|
| 1 | `2026-09-25_jan_unique.sql` | JAN の重複を禁止する（販社CSVの引当先が定まらない問題） |
| 2 | `2026-09-25_amazon_unique.sql` | Amazon 決済レポートの二重登録を止める。**先に 2-a で行番号から作った注文番号を空欄に戻すこと** |
| 3 | `2026-09-25_import_type_postal.sql` | 取込履歴に「郵便番号データ」を残せるようにする |
| 4 | `2026-09-25_invoice_cancel_history.sql` | 取り消した請求を履歴として残せるようにする（一意制約を部分索引に入れ替え） |

どのファイルも、先頭の 1) で件数を確かめてから 2) 以降を流す作りにしてあります。

| | 経路 | 必要な権限 |
|---|---|---|
| `GET` | `/api/admin/users` | M-17:view |
| `GET` | `/api/admin/users/:id` | M-17:view |
| `POST` | `/api/admin/users` | M-17:create |
| `PATCH` | `/api/admin/users/:id` | M-17:update |
| `POST` | `/api/admin/users/:id/password` | M-17:update |
| `PUT` | `/api/admin/users/:id/roles` | M-17:update |
| `POST` | `/api/admin/users/:id/deactivate` | M-17:delete |
| `GET` | `/api/admin/roles` | M-17:view |
| `GET` | `/api/admin/permissions` | M-17:view |
| `GET` | `/api/admin/permission-matrix` | M-17:view |
| `PUT` | `/api/admin/roles/:id/permissions` | M-17:update |
| `GET` | `/api/admin/audit-logs` | M-17:view |
| `GET` | `/api/attachments` | D-01:view |
| `POST` | `/api/attachments` | D-01:update |
| `GET` | `/api/attachments/:id/content` | D-01:view |
| `DELETE` | `/api/attachments/:id` | D-01:delete |
| `GET` | `/api/postal-codes/search` | ログインのみ |
| `GET` | `/api/postal-codes/:code` | ログインのみ |
| `POST` | `/api/postal-codes/import` | I-01:create |
| `GET` | `/api/sales-schedules` | S-08:view |
| `POST` | `/api/sales-schedules` | S-08:create |
| `PATCH` | `/api/sales-schedules/:id` | S-08:update |
| `DELETE` | `/api/sales-schedules/:id` | S-08:delete |
| `GET` | `/api/masters/skus/jan-export` | M-09:print |
| `PATCH` | `/api/billing/invoices/:id` | B-02:update |
| `POST` | `/api/shipments/consolidate` | D-01:update |
| `DELETE` | `/api/shipments/:id/consolidation` | D-01:update |
| `GET` | `/api/reports/shipping-instructions` | D-03:print |
| `GET` | `/api/reports/picking-list` | D-03:print |
| `GET` | `/api/reports/delivery-notes` | D-03:print |
| `GET` | `/api/reports/invoices` | D-03:print |
| `GET` | `/api/analytics/options` | A-03:view |
| `POST` | `/api/analytics/sales` | A-01:view |
| `POST` | `/api/analytics/saved-queries` | A-03:create |
| `GET` | `/api/analytics/saved-queries` | A-03:view |
| `GET` | `/api/analytics/amazon-summary` | A-01:view |
| `POST` | `/api/auth/login` | ログインのみ |
| `GET` | `/api/auth/me` | ログインのみ |
| `POST` | `/api/billing/closings` | B-01:create |
| `GET` | `/api/billing/invoices` | B-02:view |
| `GET` | `/api/billing/invoices/:id` | B-02:view |
| `POST` | `/api/billing/invoices/:id/issue` | B-02:print |
| `POST` | `/api/billing/invoices/:id/cancel` | B-02:delete |
| `GET` | `/api/billing/ar-balances` | B-04:view |
| `POST` | `/api/billing/cash-receipts` | B-05:create |
| `GET` | `/api/billing/cash-receipts` | B-05:view |
| `PATCH` | `/api/billing/cash-receipts/:id` | B-05:update |
| `DELETE` | `/api/billing/cash-receipts/:id` | B-05:delete |
| `POST` | `/api/billing/royalties/calculate` | Y-02:create |
| `GET` | `/api/billing/royalties` | Y-02:view |
| `GET` | `/api/billing/royalties/:id` | Y-02:view |
| `POST` | `/api/billing/royalties/:id/confirm` | Y-02:update |
| `GET` | `/api/health` | ログイン不要（監視用） |
| `GET` | `/api/health/db` | ログインのみ |
| `POST` | `/api/imports/partner-orders` | I-01:create |
| `POST` | `/api/imports/oms-orders` | I-01:create |
| `POST` | `/api/imports/amazon-transactions` | I-01:create |
| `GET` | `/api/imports/templates` | I-01:view |
| `GET` | `/api/imports/batches` | I-01:view |
| `GET` | `/api/imports/pending` | I-01:view |
| `POST` | `/api/inventory/receipts` | S-03:create |
| `GET` | `/api/inventory/receipts` | S-03:view |
| `GET` | `/api/inventory/receipts/:id` | S-03:view |
| `POST` | `/api/inventory/receipts/:id/receive` | S-03:update |
| `POST` | `/api/inventory/receipts/:id/cancel` | S-03:delete |
| `POST` | `/api/inventory/adjustments` | S-01:update |
| `GET` | `/api/inventory/adjustments` | S-01:view |
| `POST` | `/api/inventory/reservations` | S-08:create |
| `GET` | `/api/inventory/reservations` | S-08:view |
| `PATCH` | `/api/inventory/reservations/:id` | S-08:update |
| `DELETE` | `/api/inventory/reservations/:id` | S-08:delete |
| `POST` | `/api/inventory/reservations/copy` | S-08:create |
| `GET` | `/api/masters/sales-categories` | O-01:view |
| `GET` | `/api/masters/warehouses` | M-14:view |
| `GET` | `/api/masters/code-categories` | M-16:view |
| `GET` | `/api/masters/codes/:categoryCode` | M-16:view |
| `GET` | `/api/masters/settings` | M-16:view |
| `GET` | `/api/masters/simple/:kind` | M-16:view |
| `POST` | `/api/masters/simple/:kind` | M-16:create |
| `PATCH` | `/api/masters/simple/:kind/:id` | M-16:update |
| `POST` | `/api/masters/simple/:kind/:id/deactivate` | M-16:delete |
| `POST` | `/api/masters/partners` | M-01:create |
| `PATCH` | `/api/masters/partners/:id` | M-01:update |
| `POST` | `/api/masters/partners/:id/deactivate` | M-01:delete |
| `GET` | `/api/masters/delivery-destinations` | M-05:view |
| `POST` | `/api/masters/delivery-destinations` | M-05:create |
| `PATCH` | `/api/masters/delivery-destinations/:id` | M-05:update |
| `POST` | `/api/masters/delivery-destinations/:id/deactivate` | M-05:delete |
| `POST` | `/api/masters/products` | M-08:create |
| `PATCH` | `/api/masters/products/:id` | M-08:update |
| `POST` | `/api/masters/products/:id/deactivate` | M-08:delete |
| `POST` | `/api/masters/skus` | M-09:create |
| `PATCH` | `/api/masters/skus/:id` | M-09:update |
| `POST` | `/api/masters/sets` | M-10:create |
| `GET` | `/api/masters/sets` | M-10:view |
| `GET` | `/api/masters/sets/:id` | M-10:view |
| `GET` | `/api/masters/partner-products` | M-11:view |
| `GET` | `/api/masters/partner-products/lookup` | O-01:view |
| `POST` | `/api/masters/partner-products` | M-11:create |
| `PATCH` | `/api/masters/partner-products/:id` | M-11:update |
| `POST` | `/api/masters/partner-products/:id/deactivate` | M-11:delete |
| `POST` | `/api/masters/warehouses` | M-14:create |
| `PATCH` | `/api/masters/warehouses/:id` | M-14:update |
| `POST` | `/api/masters/warehouses/:id/deactivate` | M-14:delete |
| `GET` | `/api/masters/purchase-items` | M-15:view |
| `POST` | `/api/masters/purchase-items` | M-15:create |
| `PATCH` | `/api/masters/purchase-items/:id` | M-15:update |
| `POST` | `/api/masters/purchase-items/:id/deactivate` | M-15:delete |
| `POST` | `/api/masters/codes` | M-16:create |
| `PATCH` | `/api/masters/codes/:id` | M-16:update |
| `PATCH` | `/api/masters/settings/:key` | M-16:update |
| `GET` | `/api/masters/royalty-rules` | Y-02:view |
| `POST` | `/api/masters/royalty-rules` | Y-02:create |
| `PATCH` | `/api/masters/royalty-rules/:id` | Y-02:update |
| `POST` | `/api/masters/royalty-rules/:id/deactivate` | Y-02:delete |
| `POST` | `/api/orders` | O-01:create |
| `GET` | `/api/orders` | O-03:view |
| `GET` | `/api/orders/:id` | O-03:view |
| `PATCH` | `/api/orders/:id` | O-01:update |
| `POST` | `/api/orders/:id/cancel` | O-01:delete |
| `POST` | `/api/orders/:id/allocate` | D-01:create |
| `POST` | `/api/orders/:id/shipping-instruction` | D-01:create |
| `DELETE` | `/api/orders/:id/shipping-instruction` | D-01:delete |
| `GET` | `/api/masters/partners` | M-01:view |
| `GET` | `/api/masters/partners/:id` | M-01:view |
| `GET` | `/api/masters/partners/:id/delivery-destinations` | M-05:view |
| `GET` | `/api/masters/products` | M-08:view |
| `GET` | `/api/masters/products/:id` | M-08:view |
| `GET` | `/api/masters/skus` | M-09:view |
| `POST` | `/api/purchases` | P-01:create |
| `GET` | `/api/purchases` | P-01:view |
| `GET` | `/api/purchases/expense-by-product` | P-01:view |
| `GET` | `/api/purchases/:id` | P-01:view |
| `POST` | `/api/purchases/:id/cancel` | P-01:delete |
| `POST` | `/api/payments` | P-01:create |
| `GET` | `/api/payments` | P-01:view |
| `PATCH` | `/api/payments/:id` | P-01:update |
| `DELETE` | `/api/payments/:id` | P-01:delete |
| `GET` | `/api/ap-balances` | P-03:view |
| `POST` | `/api/cash-transactions` | C-01:create |
| `GET` | `/api/cash-transactions` | C-01:view |
| `PATCH` | `/api/cash-transactions/:id` | C-01:update |
| `DELETE` | `/api/cash-transactions/:id` | C-01:delete |
| `POST` | `/api/returns` | R-01:create |
| `GET` | `/api/returns` | R-01:view |
| `GET` | `/api/returns/:id` | R-01:view |
| `POST` | `/api/returns/:id/inspect` | R-01:update |
| `POST` | `/api/returns/:id/cancel` | R-01:delete |
| `GET` | `/api/shipments` | D-01:view |
| `GET` | `/api/shipments/:id` | D-01:view |
| `POST` | `/api/shipments/:id/confirm` | D-01:update |
| `POST` | `/api/shipments/:id/unconfirm` | D-01:update |
| `POST` | `/api/reports/confirm-and-print` | D-01:update＋D-03:print |
| `GET` | `/api/inventory/stocks` | S-01:view |
| `GET` | `/api/inventory/stocks/by-sku/:skuId` | S-01:view |
| `GET` | `/api/inventory/stocks/movements` | S-05:view |

## 設計の決めごと

### 認証は既定で必須

`APP_GUARD` に認証と権限のガードを入れてあります。**何も書かなければ通れません。**開けたい経路にだけ `@Public()` を付けます。付け忘れが「素通し」ではなく「通れない」側に倒れるようにしています。

権限は `@RequirePermission('M-01', 'view')` の形で、データベースの `permissions` / `role_permissions` をそのまま参照します。権限マトリクスを画面から変えれば、コードを触らずに反映されます（最大1分の反映遅れがあります）。

### 金額は文字列で受け取る

`NUMERIC` は `string` として扱います。node-postgres が文字列で返すのをそのまま活かし、**金額を float に通さない**ためです。合計や按分は SQL 側で計算します。

日付（`DATE`）も文字列です。日付に時刻はないので、`Date` にすると時差でずれます。

### 型定義は SQL から生成する

`src/db/schema.ts` は `docs/02-schema.sql` から機械的に生成しています。**手で編集しないでください。**スキーマを変えたら作り直します。

```powershell
npm run db:types
```

生成列（`qty_available` など）は `Computed<>` になっており、**アプリからは書き込めません。**型の上で防いでいます。

### マスタは消さずに無効にする

取引先・商品・利用者は物理削除しません。伝票から参照されているため、消すと過去の伝票が読めなくなります。`.../deactivate` で無効にし、一覧から外します。

利用者についてはもう一段、**最後の管理者を無効にできない／管理者ロールから M-17 を外せない**ようにしてあります。管理者が1人もいなくなると、誰も権限画面に入れず、データベースを直接触るしか戻す手段がなくなるためです。

### 操作履歴は経路の一覧で決める

`src/common/audit.interceptor.ts` が `audit_logs` に「誰が・いつ・何を・どう変えたか」を残します。全経路を自動で拾うのではなく、**ファイル冒頭の `RULES` に載せた書き込み経路だけ**を記録します。

- `ref_table` に入るのは `RULES` に書いた文字列（実在のテーブル名）だけです。URL の文字がそのまま SQL に渡ることはありません。分類マスタの `:kind` は `SIMPLE_MASTERS` に載っているものだけ通します。
- 変更前後はその行をそのまま写します。伝票（受注・入荷・返品・仕入・請求など）は**明細も付けます**。受注の数量を 3 → 5 に直しても見出し側は何も変わらず、明細が無いと差が読めないためです。
- 締め処理・取込のように行が1つに決まらない操作は `ref_id` を空にし、「何を頼んだか」と「どういう結果になったか（件数）」を残します。
- パスワードは `（伏せ字）`、**取込ファイルの中身（`content_base64`）は残しません**。CSV には購入者の氏名・住所・電話番号が入っており、履歴に写すと個人情報がもう一か所に増え、行も何MBにもなるためです。
- 失敗した操作は残しません（`audit_logs.action` は insert/update/delete の3つだけのため）。
- 履歴の書き込みでつまずいても業務の操作は止めません（警告を出して先へ進みます）。

**書き込みの経路を足したら `RULES` にも足してください。**載せ忘れた経路は黙って記録されません。

### 帳票の日本語フォントは同梱しない

PDF に日本語を出すには書体の埋め込みが要りますが、書体には再配布の条件があるため**リポジトリには含めていません。**稼働先にあるもの（Windows なら メイリオ／MS ゴシック、Linux なら Noto CJK／IPAex）を自動で探します。見つからないときは `.env` に指定します。

```
PDF_FONT_PATH=C:\Windows\Fonts\meiryo.ttc
PDF_FONT_FAMILY=Meiryo
```

`.ttc` のように複数書体を含むファイルのときだけ `PDF_FONT_FAMILY` が要ります。設定がなくフォントも見つからない場合、帳票の経路は 503 と日本語の案内を返します（起動は妨げません）。

### スキーマは cony 固定

接続時に `search_path=cony,public` を設定しています。`public` のオブジェクトを間違えて触ることはありません。

## これから作るもの

バックエンドは要件定義書の機能をひととおり実装し終えています。次は画面（Next.js）です。

1. ログインと権限に応じたメニュー
2. 受注登録・受注一覧、出荷指示と引当
3. 在庫表・入出荷履歴、入荷・在庫調整
4. 締め処理・請求書・入金消込、ロイヤリティ
5. CSV取込、販売実績・汎用クエリ集計
6. マスタ各種とユーザー・権限

画面ができた時点で貴社に触っていただき、ご指摘をいただいて直す進め方です。
