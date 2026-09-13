# バックエンド（NestJS）

第2段階の成果物。第1段階で確定した `docs/02-schema.sql` の 69 テーブルに対して動く API サーバー。

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
すべて合格  257 項目
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
# データベースを正しく見ているか（テーブル69・初期データの件数が返る）
curl http://localhost:3001/api/health/db
```

`status: "ok"` かつ `tables: 69` なら、アプリと SQL が同じデータベースを見ています。

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

経路 133 本。**要件定義書の機能ID 30 すべて**に対応しています。

貴社のご回答待ちのため暫定にしてある箇所は次のとおりです（いずれも設定値・マスタ値で、コードの変更は要りません）。

| 箇所 | 暫定の扱い | 必要なご回答 |
|---|---|---|
| 納品書の様式 | 納品先マスタの伝票発行分類が4様式のいずれかならそれを使い、未設定なら設定 `DELIVERY_NOTE_DEFAULT_FORM` | 納品書4種の使い分け一覧 |
| 納品書「上代あり」の上代 | 上代の保持先が未定のため、いまは卸単価の欄を使用 | 上代をどのマスタで持つか |
| 帳票の差出人 | 設定 `COMPANY_ADDRESS` / `COMPANY_TEL` / `COMPANY_INVOICE_NO`（空欄） | 帳票に印刷する住所・電話・登録番号 |
| 送料 | 設定 `SHIPPING_FEE_AMOUNT` | 送料金額 |

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
| `GET` | `/api/billing/ar-balances` | B-04:view |
| `POST` | `/api/billing/cash-receipts` | B-05:create |
| `GET` | `/api/billing/cash-receipts` | B-05:view |
| `POST` | `/api/billing/royalties/calculate` | Y-02:create |
| `GET` | `/api/billing/royalties` | Y-02:view |
| `GET` | `/api/billing/royalties/:id` | Y-02:view |
| `POST` | `/api/billing/royalties/:id/confirm` | Y-02:update |
| `GET` | `/api/health` | ログインのみ |
| `GET` | `/api/health/db` | ログインのみ |
| `POST` | `/api/imports/partner-orders` | I-01:create |
| `POST` | `/api/imports/oms-orders` | I-01:create |
| `POST` | `/api/imports/amazon-transactions` | I-01:create |
| `GET` | `/api/imports/batches` | I-01:view |
| `GET` | `/api/imports/pending` | I-01:view |
| `POST` | `/api/inventory/receipts` | S-03:create |
| `GET` | `/api/inventory/receipts` | S-03:view |
| `GET` | `/api/inventory/receipts/:id` | S-03:view |
| `POST` | `/api/inventory/receipts/:id/receive` | S-03:update |
| `POST` | `/api/inventory/adjustments` | S-01:update |
| `GET` | `/api/inventory/adjustments` | S-01:view |
| `POST` | `/api/inventory/reservations` | S-08:create |
| `GET` | `/api/inventory/reservations` | S-08:view |
| `GET` | `/api/masters/sales-categories` | O-01:view |
| `GET` | `/api/masters/warehouses` | M-14:view |
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
| `POST` | `/api/masters/partner-products` | M-11:create |
| `PATCH` | `/api/masters/partner-products/:id` | M-11:update |
| `POST` | `/api/masters/warehouses` | M-14:create |
| `PATCH` | `/api/masters/warehouses/:id` | M-14:update |
| `GET` | `/api/masters/purchase-items` | M-15:view |
| `POST` | `/api/masters/purchase-items` | M-15:create |
| `PATCH` | `/api/masters/purchase-items/:id` | M-15:update |
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
| `POST` | `/api/payments` | P-01:create |
| `GET` | `/api/ap-balances` | P-03:view |
| `POST` | `/api/cash-transactions` | C-01:create |
| `GET` | `/api/cash-transactions` | C-01:view |
| `POST` | `/api/returns` | R-01:create |
| `GET` | `/api/returns` | R-01:view |
| `GET` | `/api/returns/:id` | R-01:view |
| `POST` | `/api/returns/:id/inspect` | R-01:update |
| `GET` | `/api/shipments` | D-01:view |
| `GET` | `/api/shipments/:id` | D-01:view |
| `POST` | `/api/shipments/:id/confirm` | D-01:update |
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
