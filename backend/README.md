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
すべて合格  22 項目
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

| 経路 | 内容 | 必要な権限 |
|---|---|---|
| `GET /api/health` | 生存確認 | 不要 |
| `GET /api/health/db` | 接続先のデータベースが正しいかの照合 | 不要 |
| `POST /api/auth/login` | ログイン | 不要 |
| `GET /api/auth/me` | 自分の権限一覧 | ログインのみ |
| `GET /api/masters/partners` | 取引先の検索・一覧 | M-01:view |
| `GET /api/masters/partners/:id` | 取引先1件 | M-01:view |
| `GET /api/masters/partners/:id/delivery-destinations` | その取引先の納品先 | M-05:view |
| `GET /api/masters/products` | 商品の検索・一覧（SKU件数つき） | M-08:view |
| `GET /api/masters/products/:id` | 商品1件＋配下のSKU | M-08:view |
| `GET /api/masters/skus` | SKU検索（SKUコード・JAN・商品名・商品コード） | M-09:view |
| `GET /api/inventory/stocks` | 在庫表（実在庫・引当済・有効在庫） | S-01:view |
| `GET /api/inventory/stocks/by-sku/:skuId` | 1SKUの倉庫別在庫 | S-01:view |

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

### スキーマは cony 固定

接続時に `search_path=cony,public` を設定しています。`public` のオブジェクトを間違えて触ることはありません。

## これから作るもの

第1部（基盤・日次オペレーション）の順序です。

1. 商品・SKU マスタ、倉庫マスタ
2. 受注登録（卸・直送・通販・サンプル）
3. **出荷指示と引当** — ここが本システムの核。`ALLOCATION_TIMING=shipping_instruction` に従い、出荷指示のときだけ在庫を押さえます
4. 出荷確定と在庫移動履歴
5. 帳票（出荷指示書・ピッキングリスト・納品書・請求書）
