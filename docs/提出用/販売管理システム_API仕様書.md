# 1. はじめに

## 1.1 この文書について

本書は、販売管理システムの第2段階として作成した **API（アプリケーション・プログラミング・インターフェース）** の仕様書です。

API とは、画面と、その裏側で実際にデータを読み書きする部分とをつなぐ窓口のことです。第3段階で作る画面は、すべてこの窓口を呼び出して動きます。

この形にしておくと、次の利点があります。

・画面を作り直しても、業務のきまりは API 側に残ります。業務の判断が画面ごとにばらつくことがありません。
・将来、貴社の別のシステムや外部サービスとつなぐ必要が生じたときも、同じ窓口をそのまま使えます。
・在庫や引当のように間違いが許されない処理を、画面の作り方に関係なく一箇所で守れます。

本書は、貴社に第2段階の完了をご報告する資料であるとともに、第3段階（画面）の作業と、将来の保守・連携のための資料を兼ねています。

**本版は、2026年9月15日にいただいた社内確認（受注〜出荷の3点、経理の3点、確認事項7件へのご回答）と、9月17日のご確認2点（販売担当のマスタ、引当在庫）を反映したものです。**反映した内容は第7章と第8章にまとめています。

## 1.2 対象と対象外

| 区分 | 内容 |
|---|---|
| 本書の対象 | 要件定義書に記載した機能ID **30件すべて**。経路（URL）は **139本** |
| 本書の対象外 | 画面（第3段階で作成） |
| 前提 | 第1段階で構築したデータベース（70テーブル）。本書の API はこのデータベースの上で動きます |

## 1.3 用語

| 用語 | 意味 |
|---|---|
| 経路（けいろ） | 呼び出し先の URL。本書では `/api/orders` のように表記します |
| メソッド | 呼び出しの種類。`GET`＝取得、`POST`＝登録・実行、`PATCH`＝一部更新、`PUT`＝入れ替え、`DELETE`＝削除 |
| 機能ID | 要件定義書で機能ごとに振った記号（M-01 取引先マスタ、O-01 受注登録 など） |
| 権限 | 「機能ID:操作」の形で表します。`M-01:view` は「取引先マスタを参照してよい」の意味です |
| トークン | ログインすると発行される、本人であることを示す文字列。以後の呼び出しに添えます |
| JSON | データのやり取りに使う書式。項目名と値の組で書き表したものです |
| 実在庫・引当済・有効在庫 | 実在庫＝棚にある数。引当済＝受注で押さえている数。有効在庫＝実在庫−引当済（これから受注に充てられる数） |

# 2. 全体の構成

## 2.1 三つの層

```
   ご担当者のブラウザ
          │
          ▼
   ┌─────────────────────────────┐
   │ 画面（Next.js）             │  第3段階
   │  受注入力・在庫表・請求など │
   └─────────────────────────────┘
          │  本書が定める窓口（JSON でやり取り）
          ▼
   ┌─────────────────────────────┐
   │ API（NestJS）               │  第2段階 ← 本書の対象
   │  業務のきまり・権限・採番   │
   └─────────────────────────────┘
          │
          ▼
   ┌─────────────────────────────┐
   │ データベース（PostgreSQL 17）│  第1段階（完了）
   │  cony スキーマ 70テーブル    │
   └─────────────────────────────┘
```

**業務のきまりは、上の層に上がるほど薄くしてあります。**引当のしかたや在庫が負にならないことなどは、いちばん下のデータベースで守っています。その上の API で、どの操作にどの権限が要るか、番号をどう採るか、といった手続きを受け持ちます。画面は入力と表示に徹します。

こうしておくと、画面の作り方を変えても在庫がおかしくなることはありません。

## 2.2 第2段階で作ったもの

| 項目 | 内容 |
|---|---|
| 経路の数 | **139本** |
| 対応した機能 | 要件定義書の機能ID **30件すべて** |
| 認証 | ログインしたご担当者だけが使えます。ログインしていない呼び出しは通りません |
| 権限 | 機能ID×操作の 151通り。どのロールに何を許すかはデータベース上の設定で、画面から変更できます |
| 動作確認 | データベースの構築から API の呼び出しまでを通しで確かめる 302項目、すべて合格 |
| 動作環境 | Node.js 24.14.0 で確認済み（20以上で動作）。PostgreSQL 17 |

## 2.3 機能IDと経路の数

| 機能ID | 名称 | 経路 |
|---|---|---|
| M-01 | 取引先マスタ | 5 |
| M-05 | 納品先マスタ | 5 |
| M-08 | 商品マスタ | 5 |
| M-09 | SKUコードマスタ | 4 |
| M-10 | セット登録マスタ | 3 |
| M-11 | 得意先別商品マスタ | 3 |
| M-14 | 倉庫マスタ | 3 |
| M-15 | 仕入マスタ | 3 |
| M-16 | 汎用区分マスタ・システム設定 | 9 |
| M-17 | ユーザー・権限 | 12 |
| O-01 | 受注登録 | 4 |
| O-03 | 受注一覧 | 2 |
| S-01 | 在庫表・在庫調整 | 4 |
| S-03 | 入荷登録 | 4 |
| S-05 | 入出荷履歴 | 1 |
| S-08 | 引当在庫（確保数）・販売予定 | 9 |
| D-01 | 出荷指示・引当・出荷確定・同梱・添付 | 14 |
| D-03 | 帳票一括印刷 | 4 |
| R-01 | 返品・再生 | 4 |
| B-01 | 締め処理 | 1 |
| B-02 | 請求書発行 | 4 |
| B-04 | 売掛残高一覧 | 1 |
| B-05 | 入金登録・消込 | 2 |
| P-01 | 仕入・経費登録 | 5 |
| P-03 | 買掛残高一覧 | 1 |
| C-01 | 入出金処理 | 2 |
| Y-02 | ロイヤリティ | 8 |
| A-01 | 販売実績管理 | 2 |
| A-03 | 汎用クエリ集計 | 3 |
| I-01 | CSV取込 | 6 |
| （なし） | ログイン・稼働確認・郵便番号参照 | 6 |

# 3. 共通仕様

ここに書いた決まりは、すべての経路に共通です。個々の経路の説明では繰り返しません。

## 3.1 接続先とURL

すべての経路は `/api` から始まります。

```
https://＜サーバー名＞/api/orders
https://＜サーバー名＞/api/inventory/stocks
```

サーバー名は稼働先が決まり次第ご連絡します。開発中は `http://localhost:3001/api` です。

やり取りの書式は JSON、文字コードは **UTF-8** です。日本語の項目名・商品名をそのまま扱えます。

## 3.2 ログイン

ログインIDとパスワードを送ると、**トークン**が返ります。以後の呼び出しには、このトークンを添えます。

```
POST /api/auth/login
{ "login_id": "sakamoto", "password": "＜パスワード＞" }
```

返ってくるもの（抜粋）

```
{
  "access_token": "eyJhbGciOiJI...",
  "user": {
    "id": 3,
    "login_id": "sakamoto",
    "name": "坂本",
    "roles": ["ADMIN"],
    "permissions": ["M-01:view", "M-01:create", ... ]
  }
}
```

以後の呼び出しでは、この `access_token` を添えます。

```
Authorization: Bearer eyJhbGciOiJI...
```

トークンの有効時間は **8時間**（1営業日）です。設定で変更できます。切れた場合は 401 が返るので、画面側でログイン画面に戻します。

パスワードは元に戻せない形（bcrypt）で保存しており、**画面にもデータベースにも平文では存在しません。**万一データベースの中身が漏れても、パスワードそのものは読み取れません。

## 3.3 権限

**何も指定しない経路は通れません。**開けたい経路にだけ「ログイン不要」の印を付ける作りにしてあります。付け忘れが「誰でも入れてしまう」ではなく「入れない」側に倒れるようにするためです。

権限は「機能ID:操作」の組で判定します。操作は 参照（view）・登録（create）・更新（update）・削除（delete）・印刷（print）の5種です。

| 状態 | 応答 |
|---|---|
| トークンがない・切れている | 401（ログインしてください） |
| トークンはあるが権限がない | 403（この操作を行う権限がありません） |

どのロールにどの権限を許すかは**データベース上の表**で持っています。画面（M-17 ユーザー・権限）から変更でき、**プログラムの修正は要りません。**初期状態は要件定義書 付録Bの権限マトリクスのとおりで、管理者・作業者・経理・閲覧者の4ロールです。

## 3.4 機微項目（原価・仕入単価・ロイヤリティ・利益）

要件定義書の「原価・仕入単価・ロイヤリティは、閲覧のみの方には表示されません」というご要望は、**画面ではなく項目**を指しているものと受け止めました。そこで次のようにしています。

・商品マスタ・得意先別商品マスタは、閲覧のみの方も開けます。
・ただし `SENSITIVE:view` の権限がない方には、**原価の項目そのものを返しません。**画面で隠すのではなく、届かないようにしています。
・集計の「原価」「ロイヤリティ」「利益」も同じ権限で制御します。権限のない方には選択肢に出さず、指定しても 403 を返します。
・仕入マスタ・仕入経費登録・入出金・ロイヤリティ計算のように、画面ごとお見せしないものは従来どおり機能単位で制御します。

画面側で隠す作りにすると、画面の不具合や操作でうっかり見えてしまうことがあります。そもそも送らない形にしてあります。

## 3.5 値の表し方

| 種類 | 表し方 | 例 | 理由 |
|---|---|---|---|
| 金額・数量・税率 | **文字列** | `"12500"` `"3"` `"10.00"` | 小数の丸め誤差を避けるため。合計や按分はデータベース側で計算します |
| 日付 | 文字列 `YYYY-MM-DD` | `"2026-09-16"` | 日付に時刻はありません。時刻付きで扱うと時差で1日ずれることがあります |
| 日時 | 文字列（ISO 8601） | `"2026-09-16T09:00:00.000Z"` | 記録した瞬間を表すもの（登録日時など）だけに使います |
| 真偽 | `true` / `false` | `true` | |
| ID | 数値 | `12` | |
| 未設定 | `null` | `null` | 「空文字」と「未設定」は区別します |

金額を文字列にしているのは、**コンピュータの小数計算では 0.1 を正確に表せない**ためです。1円の狂いが請求書に出ないよう、金額の計算は最後までデータベース側で行い、API は文字列のまま受け渡します。

## 3.6 一覧の返し方

一覧を返す経路は、すべて同じ形です。

```
{
  "items":  [ ... ],
  "total":  1243,
  "limit":  50,
  "offset": 0
}
```

| 項目 | 意味 |
|---|---|
| items | 今回返した明細 |
| total | 絞り込み条件に合う全件数（ページ送りの表示に使います） |
| limit | 1回に返す件数。既定 50、最大 200 |
| offset | 何件目から返すか。既定 0 |

## 3.7 エラーの返し方

| 状態コード | 意味 | 画面での扱い |
|---|---|---|
| 200 | 成功 | |
| 201 | 登録に成功 | |
| 400 | 入力内容に誤りがある | 入力欄にメッセージを表示します |
| 401 | ログインしていない・切れた | ログイン画面に戻します |
| 403 | 権限がない | メニューに出さない、またはボタンを押せなくします |
| 404 | 指定されたものが見つからない | 一覧に戻します |
| 409 | 今の状態では行えない（出荷済みの受注を直す など） | 理由を表示します |
| 413 | 送ったファイルが大きすぎる | 上限をご案内します |
| 500 | 想定外の問題 | 担当者にご連絡ください。サーバー側に記録が残ります |

**エラーはすべて日本語の文面で返します。**画面側で英語のメッセージを訳す必要はありません。

入力内容の誤りは、どの項目が、なぜ駄目なのかまで返します。

```
{
  "message": "入力内容に誤りがあります",
  "errors": [
    { "field": "order_date", "reason": "日付は YYYY-MM-DD の形式で入力してください" },
    { "field": "lines",      "reason": "明細を1行以上入力してください" }
  ]
}
```

データベースの決まりに触れた場合も、そのまま英語で返すことはせず、何に触れたのかを日本語にして返します。

```
{
  "statusCode": 400,
  "message": "有効在庫を超えて引き当てることはできません",
  "constraint": "ck_stocks_available"
}
```

## 3.8 ファイルのやり取り

| 用途 | 向き | 形式 |
|---|---|---|
| CSV取込（販社・通販・Amazon・郵便番号） | 送る | JSON の中に base64 で入れて送ります。Shift-JIS のファイルもそのまま送れます |
| 帳票（出荷指示書・納品書など） | 受け取る | PDF |
| JANコード出力 | 受け取る | CSV（Excel で開ける形。UTF-8 BOM付き） |
| 添付ファイル | 双方向 | 送るときは base64。実体はサーバーのディスクに保存し、データベースには目録だけを持ちます |

送信できる大きさの上限は既定で **20MB** です（設定で変更できます）。通販CSV 95KB、Amazon決済レポート 480KB に対しては十分な余裕があります。

# 4. 機能別の経路

各節の表は「メソッド／経路／必要な権限／内容」です。経路の全一覧は付録Aにあります。

## 4.1 ログイン・稼働確認

| メソッド | 経路 | 権限 | 内容 |
|---|---|---|---|
| POST | /api/auth/login | ログイン不要 | ログイン。トークンを発行します |
| GET | /api/auth/me | ログインのみ | 今のログインが有効か、何が見られるかを返します |
| GET | /api/health | ログイン不要 | 生存確認。監視から叩く用です |
| GET | /api/health/db | ログインのみ | 見ているデータベースが正しいかを、テーブル数と初期データの件数で照合します |

`/api/health/db` は**導入時の取り違え防止**のために用意しました。接続先を間違えたまま作業を進めるのが最もやっかいなため、テーブルが69件あるか、初期データが入っているかを数で確かめられるようにしています。

## 4.2 マスタ

| メソッド | 経路 | 権限 | 内容 |
|---|---|---|---|
| GET | /api/masters/partners | M-01:view | 取引先の一覧。得意先／仕入先での絞り込み、日本語での検索ができます |
| GET | /api/masters/partners/:id | M-01:view | 取引先1件 |
| POST | /api/masters/partners | M-01:create | 取引先の登録。担当者（販売担当）・送料の個別設定もここで持ちます |
| PATCH | /api/masters/partners/:id | M-01:update | 取引先の更新 |
| POST | /api/masters/partners/:id/deactivate | M-01:delete | 取引先を無効にする |
| GET | /api/masters/delivery-destinations | M-05:view | 納品先の一覧。伝票発行分類（納品書の様式）はここで持ちます |
| GET | /api/masters/products | M-08:view | 商品の一覧（原価は権限のある方にだけ） |
| GET | /api/masters/skus | M-09:view | SKU検索。SKUコード・JAN・商品名・商品コードで引けます |
| GET | /api/masters/skus/jan-export | M-09:print | JANコード一覧の CSV 出力 |
| GET | /api/masters/sets | M-10:view | セット登録 |
| GET | /api/masters/partner-products | M-11:view | 得意先別商品（取引先ごとの専用コード・卸単価・**上代**） |
| GET | /api/masters/warehouses | M-14:view | 倉庫 |
| GET | /api/masters/purchase-items | M-15:view | 仕入品目 |
| GET | /api/masters/codes/:categoryCode | M-16:view | 汎用区分の値 |
| GET | /api/masters/settings | M-16:view | システム設定の一覧 |
| PATCH | /api/masters/settings/:key | M-16:update | システム設定の変更。変えたその場で効きます |
| GET | /api/masters/simple/:kind | M-16:view | ブランド・カテゴリー・カラー・サイズ・**販売担当**など11種の分類マスタ |

**マスタは物理的に削除しません。**過去の伝票が参照しているため、消すと伝票が読めなくなります。使わなくなったものは「無効」にして一覧から外します（`.../deactivate`）。

分類マスタ（ブランド・カテゴリー・商品分類・カラー・サイズ・媒体・取引先カテゴリー・販売カテゴリー・納品ルール・作業指示内容・販売担当の11種）は、形が同じであるため一つの経路にまとめてあります。種類を増やすときも画面の作り直しは要りません。

**販売カテゴリー**は初期値として OA・カタログ・WEB を登録してあり、画面から追加できます。**販売担当**は9/17 のご確認を受けてマスタにしました（`/api/masters/simple/sales_staff`）。ログインする利用者とは別の一覧で、取引先マスタに既定の担当を持たせ、受注に引き継ぎます。

**上代**は、ご回答のとおり得意先別商品マスタで持ちます（`retail_price`）。納品書「上代あり」はここから印字します。

**納品書の様式**は、ご回答のとおり納品先マスタの「伝票発行分類」で選びます。汎用区分 `SLIP_ISSUE_CLASS` に 単価あり／単価あり2／上代あり／単価なし の4つを登録済みで、納品先ごとにこの中から選んでいただきます。未選択の納品先はシステム設定の既定様式になります。

## 4.3 受注

| メソッド | 経路 | 権限 | 内容 |
|---|---|---|---|
| POST | /api/orders | O-01:create | 受注登録（卸・直送・通販・サンプル）。**この時点で引き当てます** |
| GET | /api/orders | O-03:view | 受注一覧。状態・区分・取引先・期間で絞り込めます |
| GET | /api/orders/:id | O-03:view | 受注1件（明細つき） |
| PATCH | /api/orders/:id | O-01:update | 受注の修正。引当を組み直します |
| POST | /api/orders/:id/cancel | O-01:delete | 受注の取消。引当を戻します |
| POST | /api/orders/:id/allocate | D-01:create | 引当のやり直し（引当待ちの受注に在庫が空いたとき） |

**受注登録の時点で在庫を引き当てます**（9/15 ご確認②）。登録すると有効在庫が減ります。実在庫はまだ動きません。

受注登録時の在庫チェックは次のとおりです（9/15 ご確認①）。

| 入力した数量 | 結果 |
|---|---|
| 有効在庫の範囲内 | 登録し、全量を引き当てます。状態は「引当済」。出荷確定・帳票の対象になります |
| 有効在庫は超えるが、実在庫の範囲内 | 登録します。引き当てられた分は押さえ、足りない分を「引当待ち」にします。他の受注の取消や入荷で在庫が空いたあと、一覧から引き当て直します（`/allocate`） |
| 実在庫を超える | **登録できません（400）。**入荷を登録してからお試しください |

実在庫は、出荷元倉庫の指定があればその倉庫、なければ納品先の既定倉庫で見ます。セット商品は構成品ごとに照らします。

受注の状態は 未確定 → **引当済**／**引当待ち** → 出荷済 と進みます。取り消すと「取消」です。

受注の修正は、押さえている在庫をいったん戻してから直し、直した内容で引き当て直します。数量を変えても引当と受注が食い違いません。**出荷済みの受注は直接は直せません。**先に出荷確定を取り消していただきます（4.4）。

サンプル出荷（ご要望④）は受注区分「サンプル」で登録します。**出荷指示書が出て在庫も落ちますが、売上・請求には計上しません。**あとから売上計上に変えることもできないよう、データベース側でも止めています。

受注には**販売担当**を持ちます（9/15・9/17 ご要望）。販売担当マスタから選び、取引先マスタの既定担当を初期値にして受注ごとに変えられます。集計の軸に使います。

**引当在庫**（9/17 ご確認②）も受注登録時に見ます。受注の販売カテゴリー・商品・受注日に当てはまる枠（4.5）があれば、その枠から数量を減らします。枠の残りを超える受注は登録できません（400）。枠が登録されていない商品はそのまま通ります。取消・修正で減らした分は枠に戻ります。

## 4.4 出荷・引当・帳票

| メソッド | 経路 | 権限 | 内容 |
|---|---|---|---|
| GET | /api/shipments | D-01:view | 出荷の一覧 |
| GET | /api/shipments/:id | D-01:view | 出荷1件（明細つき） |
| POST | /api/reports/confirm-and-print | D-01:update＋D-03:print | **出荷確定と印刷を同時に行います。**実在庫が減り、帳票と添付ファイルを1つの PDF で返します |
| POST | /api/shipments/:id/confirm | D-01:update | 出荷確定だけを行う（印刷しない） |
| POST | /api/shipments/:id/unconfirm | D-01:update | **出荷確定の取消。**実在庫を戻し、受注を修正できる状態にします |
| POST | /api/shipments/consolidate | D-01:update | 同梱。同じ得意先・納品先・倉庫の出荷を1つにまとめます |
| DELETE | /api/shipments/:id/consolidation | D-01:update | 同梱を解く |
| GET | /api/attachments | D-01:view | 添付ファイルの一覧 |
| POST | /api/attachments | D-01:update | 添付ファイルの登録 |
| GET | /api/reports/shipping-instructions | D-03:print | 出荷指示書（PDF） |
| GET | /api/reports/picking-list | D-03:print | ピッキングリスト（PDF） |
| GET | /api/reports/delivery-notes | D-03:print | 納品書（PDF・4様式） |
| GET | /api/reports/invoices | D-03:print | 請求書（PDF） |
| POST | /api/orders/:id/shipping-instruction | D-01:create | 出荷指示（設定を「出荷指示時に引当」に戻したときだけ使います） |
| DELETE | /api/orders/:id/shipping-instruction | D-01:delete | 引当の解除 |

**物流PCの「出荷確定」ボタンは `POST /api/reports/confirm-and-print` です**（9/15 ご確認②）。選んだ出荷をまとめて確定し（実在庫が減る）、帳票と添付ファイルを1つの PDF にして返します。確定は全件をひとまとめに行うので、途中で1件でも通らなければ何も確定しません。

```
POST /api/reports/confirm-and-print
{
  "shipment_ids": [880, 881],
  "documents": ["出荷指示書", "納品書"],
  "include_attachments": true
}
→ 応答は PDF（出荷指示書2件 → 納品書2件 → 添付の順）
```

添付ファイルのうち PDF と画像は帳票と一緒に取り込みます。Excel や Word の形式はブラウザが印刷できないため取り込まず、応答ヘッダ `X-Skipped-Attachments` でファイル名をお知らせします。**添付は PDF にしてから付けていただく運用**をお願いいたします。

**出荷確定後の変更**（9/15 ご確認③）は、`unconfirm` で確定を取り消してから行います。取り消すと実在庫と引当済が確定前の数に戻り、受注は「引当済」に戻って修正できます。修正後に改めて出荷確定・印刷をしていただく流れです。在庫の増減の記録が食い違わないよう、確定した内容をその場で書き換える形にはしていません。取消と再確定の両方が在庫移動履歴（「出荷取消」「出荷」）に残ります。

締め処理で請求に含めたあとの出荷は取り消せません（409）。締めを取り直すか、返品として処理していただきます。

出荷指示書はセットのまま記載し、ピッキングリストは構成品に展開して同一商品を合算します（頂いた帳票サンプルのとおり）。この切り替えは設定 `PICKING_EXPAND_SET` にしてあります。

引当のタイミングは設定 `ALLOCATION_TIMING` で持っています。ご確認のとおり既定は「受注登録時」ですが、「出荷指示時」に戻すこともでき、その場合は `shipping-instruction` の経路で引き当てます。

## 4.5 在庫

| メソッド | 経路 | 権限 | 内容 |
|---|---|---|---|
| GET | /api/inventory/stocks | S-01:view | 在庫表。実在庫・引当済・有効在庫 |
| GET | /api/inventory/stocks/by-sku/:skuId | S-01:view | SKU別の在庫（倉庫・ロット別） |
| GET | /api/inventory/stocks/movements | S-05:view | 入出荷履歴。入荷・出荷・出荷取消・引当・引当解除・返品入庫・再生・不良振替・棚卸調整・廃棄 |
| POST | /api/inventory/adjustments | S-01:update | 在庫数の調整（ご要望⑫） |
| GET | /api/inventory/adjustments | S-01:view | 在庫調整の履歴 |
| POST | /api/inventory/receipts | S-03:create | 入荷登録 |
| POST | /api/inventory/receipts/:id/receive | S-03:update | 入荷確定。ここで実在庫が増えます |
| POST | /api/inventory/reservations | S-08:create | **引当在庫**の登録（期間・販売カテゴリー・商品。取引先は任意） |
| GET | /api/inventory/reservations | S-08:view | 引当在庫の一覧。登録数・使用数・残りが出ます |
| PATCH | /api/inventory/reservations/:id | S-08:update | 数量・期間の変更（使った分より減らせません） |
| DELETE | /api/inventory/reservations/:id | S-08:delete | 削除（まだ使われていない枠だけ） |
| POST | /api/inventory/reservations/copy | S-08:create | 前月の枠を翌月分として複写 |
| GET | /api/sales-schedules | S-08:view | 販売予定 |

**有効在庫＝実在庫−引当済**です。この計算はデータベース側の「生成列」で行っており、**アプリからは書き込めません。**引当と在庫が食い違うことが構造上ありません。

在庫が負になる操作、引当が実在庫を超える操作は、いずれもデータベースが拒みます。API はそれを日本語のメッセージに直して返します。

**引当在庫**（9/17 ご確認②）は、月ごとに販売カテゴリー×商品（SKU）で登録する枠です。要件定義書では「取引先別確保数」と呼んでいたもので、取引先を指定しなくても登録できるようにしました。受注登録のたびにこの枠から減り、期間で持つため**月末を過ぎれば自動的に効かなくなり、翌月1日からは翌月の枠が使われます。**夜間処理はありません。前月の枠を翌月分として複写できるので、毎月の登録は数量の見直しだけで済みます。棚の在庫（有効在庫）とは別の枠で、受注登録では両方を見ます。

## 4.6 返品・再生

| メソッド | 経路 | 権限 | 内容 |
|---|---|---|---|
| POST | /api/returns | R-01:create | 返品の登録 |
| GET | /api/returns | R-01:view | 返品一覧 |
| GET | /api/returns/:id | R-01:view | 返品1件 |
| POST | /api/returns/:id/inspect | R-01:update | 検品。良品・不良の振り分けで在庫が動きます |

## 4.7 請求・入金

| メソッド | 経路 | 権限 | 内容 |
|---|---|---|---|
| POST | /api/billing/closings | B-01:create | 締め処理。**取引先ごとの締め日**で期間を切って集計します。送料もここで判定します |
| GET | /api/billing/invoices | B-02:view | 請求一覧 |
| GET | /api/billing/invoices/:id | B-02:view | 請求1件（明細・税率別内訳つき） |
| PATCH | /api/billing/invoices/:id | B-02:update | 未計上10%/8%・調整10%/8%・手数料・送料の手入力 |
| POST | /api/billing/invoices/:id/issue | B-02:print | 発行 |
| GET | /api/billing/ar-balances | B-04:view | 売掛残高一覧（現行と同じ12項目・同じ並び） |
| POST | /api/billing/cash-receipts | B-05:create | 入金登録・消込 |
| GET | /api/billing/cash-receipts | B-05:view | 入金一覧 |

締め日は取引先ごとに異なります（月末＝99、20日など）。20日締めであれば前月21日〜当月20日で切ります。**カレンダー月では区切りません。**

**送料**はご回答のとおり、1回の出荷が **30,000円未満のとき一律750円** を請求します（30,000円ちょうどは請求しません）。締め処理が出荷ごとに判定して請求に載せます。直送は受注の送料調整欄に入れた額をそのまま使います。取引先マスタで「請求しない」「直送のみ」にした取引先には付けません。金額と閾値は設定・取引先マスタで変えられます。

未計上・調整・手数料は定義が固まっていないため、いま手入力で運用いただく形にしてあります。入力すると当月請求額・今回請求残高・売掛元帳を、締め処理と同じ式で計算し直します。発行済みの請求は直せません（409）。取り消して締め直していただきます。

## 4.8 仕入・経費・入出金

| メソッド | 経路 | 権限 | 内容 |
|---|---|---|---|
| POST | /api/purchases | P-01:create | 仕入・経費の登録 |
| GET | /api/purchases | P-01:view | 仕入・経費の一覧 |
| GET | /api/purchases/expense-by-product | P-01:view | 経費の商品別集計 |
| POST | /api/payments | P-01:create | 支払の登録 |
| GET | /api/ap-balances | P-03:view | 買掛残高一覧 |
| POST | /api/cash-transactions | C-01:create | 入出金の登録 |
| GET | /api/cash-transactions | C-01:view | 入出金の一覧 |

経費は SKU ではなく**商品名（品番）単位**で入力します。紐づけ先は 商品／商品分類／ブランド／指定なし の4段階です。

入出金は1件ずつの登録を基本とし、振込・現金・**カード**（9/15 ご要望で追加）・手形①②・相殺・小切手・集金・海外送金（USD／CNY）の内訳から合計を求めます。

## 4.9 ロイヤリティ

| メソッド | 経路 | 権限 | 内容 |
|---|---|---|---|
| GET | /api/masters/royalty-rules | Y-02:view | ロイヤリティ規定の一覧 |
| POST | /api/masters/royalty-rules | Y-02:create | 規定の登録 |
| PATCH | /api/masters/royalty-rules/:id | Y-02:update | 規定の更新 |
| POST | /api/masters/royalty-rules/:id/deactivate | Y-02:delete | 規定を無効にする |
| POST | /api/billing/royalties/calculate | Y-02:create | 対象月のロイヤリティ計算 |
| GET | /api/billing/royalties | Y-02:view | 計算結果の一覧 |
| GET | /api/billing/royalties/:id | Y-02:view | 計算結果1件（内訳つき） |
| POST | /api/billing/royalties/:id/confirm | Y-02:update | 確定 |

ロイヤリティは**専用のマスタに一本化**しました（貴社ご確認のとおり）。商品マスタ・得意先別商品マスタにロイヤリティ欄はありません。

規定は「支払先 × ブランドまたは商品 × 販売先 × 期間」で登録し、**発生しない組み合わせは「対象外」として登録**します。C社のように、同じブランドでも販売先によって発生したりしなかったりする場合は、販売先ごとに規定を作ります。

同じ支払先に複数の規定が当てはまる場合は、**指定が細かいものを優先**します（販売先の指定＞商品の指定＞ブランドの指定）。

計算は出荷金額をもとに行い、販売先への卸金額に料率を掛けます。返品はマイナスの出荷金額として同じ月に反映されます。端数はご回答のとおり切り捨てです（いずれも貴社ご回答のとおり）。

## 4.10 CSV取込

| メソッド | 経路 | 権限 | 内容 |
|---|---|---|---|
| POST | /api/imports/partner-orders | I-01:create | 販社の発注CSV（ビックカメラ・ラベルヴィ・白鳩・コネクト） |
| POST | /api/imports/oms-orders | I-01:create | 通販（OMS）受注CSV |
| POST | /api/imports/amazon-transactions | I-01:create | Amazon 決済レポート |
| POST | /api/postal-codes/import | I-01:create | 郵便番号データ（日本郵便 KEN_ALL） |
| GET | /api/imports/batches | I-01:view | 取込の履歴 |
| GET | /api/imports/pending | I-01:view | 取り込んだが受注にできていないもの |

販社4社は書式がすべて異なりますが、**どの販社かをプログラムは知りません。**列の対応づけは「取込テンプレート」というデータとして登録してあり、販社が増えても、書式が変わっても、**プログラムの修正なしに対応できます。**

販社の得意先ID・納品先IDは、ご回答のとおり **CSV の値をそのまま取引先コード・納品先コードとして登録**していただきます。対応表は要りません。

取込前に中身だけ確かめたい場合は `dry_run` を付けて呼びます。登録はせず、読めるかどうかだけを返します。

同じ受注番号を再度取り込んだ場合は、既定では取込済みとして除外します（設定 `OMS_DUPLICATE_POLICY`）。

## 4.11 集計

| メソッド | 経路 | 権限 | 内容 |
|---|---|---|---|
| GET | /api/analytics/options | A-03:view | 選べる軸と指標の一覧（機微な指標は権限のある方にだけ） |
| POST | /api/analytics/sales | A-01:view | 販売実績の集計 |
| POST | /api/analytics/saved-queries | A-03:create | 集計条件の保存 |
| GET | /api/analytics/saved-queries | A-03:view | 保存した条件の一覧 |
| GET | /api/analytics/amazon-summary | A-01:view | Amazon決済レポートの集計 |

軸は 月・日・取引先・**販売担当**・販売カテゴリー・受注区分・ブランド・商品・商品コード・SKU・倉庫・取引条件 の12種、指標は 数量・金額・件数・明細数・**原価・ロイヤリティ・利益** の7種です。軸は3つまで重ねられます。

**利益＝売上（出荷金額）−（原価＋ロイヤリティ）**です（9/15 ご要望）。原価は得意先別商品マスタ、なければ商品マスタの原価を使います。ロイヤリティは規定を出荷明細ごとに当てて求める概算で、確定値は月次のロイヤリティ計算表です。原価・ロイヤリティ・利益は機微項目（3.4）で、`SENSITIVE:view` のない方には返しません。

**任意の検索式は受け取りません。**選択肢から選んでいただく形にしてあります。自由に書ける仕組みにすると、意図しない読み出しや、業務時間中にデータベースを止めてしまうような重い検索が通ってしまうためです。

## 4.12 ユーザー・権限

| メソッド | 経路 | 権限 | 内容 |
|---|---|---|---|
| GET | /api/admin/users | M-17:view | 利用者の一覧 |
| POST | /api/admin/users | M-17:create | 利用者の登録 |
| PATCH | /api/admin/users/:id | M-17:update | 利用者の更新 |
| POST | /api/admin/users/:id/password | M-17:update | パスワードの再設定 |
| PUT | /api/admin/users/:id/roles | M-17:update | ロールの割当 |
| POST | /api/admin/users/:id/deactivate | M-17:delete | 利用者を無効にする |
| GET | /api/admin/roles | M-17:view | ロールの一覧 |
| GET | /api/admin/permission-matrix | M-17:view | 権限マトリクス（ロール×権限） |
| PUT | /api/admin/roles/:id/permissions | M-17:update | ロールの権限を保存する |
| GET | /api/admin/audit-logs | M-17:view | 監査ログの参照 |

利用者も**消さずに無効**にします。伝票に「登録した人」として残っているためです。

**最後の管理者は無効にできません。**また、管理者ロールからユーザー・権限（M-17）を外すこともできません。管理者が1人もいなくなると、誰もこの画面に入れなくなり、データベースを直接触る以外に戻す手段がなくなるためです。

権限を変えた場合は**その場で反映**されます。変更した方が再ログインする必要はありません。

## 4.13 参照・添付・販売予定

| メソッド | 経路 | 権限 | 内容 |
|---|---|---|---|
| GET | /api/postal-codes/:code | ログインのみ | 郵便番号から住所を引く |
| GET | /api/postal-codes/search | ログインのみ | 住所の一部から郵便番号を探す（逆引き） |
| GET | /api/attachments/:id/content | D-01:view | 添付ファイルの取り出し |
| DELETE | /api/attachments/:id | D-01:delete | 添付ファイルの削除 |
| GET | /api/sales-schedules | S-08:view | 販売予定の一覧 |
| POST | /api/sales-schedules | S-08:create | 販売予定の登録 |

郵便番号は**必ず配列で返します。**同じ郵便番号に複数の町域があることは珍しくないためです。1件なら画面で自動入力し、複数なら選んでいただきます。

郵便番号データは公開情報で個人情報を含まないため、ログインしていればどなたでも引けます。取り込み（保守契約での定期更新）だけは取込権限が必要です。

# 5. 主な業務の流れ

## 5.1 受注から出荷まで（9/15 ご確認の2段階）

| 順 | 操作 | 経路 | このとき起きること |
|---|---|---|---|
| 0 | 月初に引当在庫を登録する | POST /api/inventory/reservations（または /copy） | 販売カテゴリー×商品×期間の枠。前月分の複写で数量だけ直せます |
| 1 | 受注を登録する | POST /api/orders | 受注番号を採番し、**引当在庫の枠から減らし、在庫を引き当てます。**有効在庫が減り、実在庫は変わりません。枠や実在庫を超える数量はエラー、有効在庫が足りない分は引当待ち |
| 2 | （引当待ちがあれば）引き当て直す | POST /api/orders/:id/allocate | 在庫が空いたあとに一覧から。全量そろうと出荷の対象になります |
| 3 | 物流PCで印刷するものを選び、内容を確かめる | GET /api/orders（状態＝引当済）、GET /api/reports/... | 帳票の内容を画面で確かめます（この時点では何も動きません） |
| 4 | 出荷確定ボタン | POST /api/reports/confirm-and-print | **実在庫が減り、帳票と添付が1つの PDF で出ます** |
| 5 | （稀に）確定後に直す | POST /api/shipments/:id/unconfirm → PATCH /api/orders/:id → 手順4 | 実在庫が戻り、受注を直して確定し直します |

受注を取り消すと（`/cancel`）、引当が外れて有効在庫が戻ります。実在庫は動きません。

出荷指示番号は受注番号をそのまま使います（ご要望⑪）。複数の受注を1つにまとめる同梱のときだけ枝番を付けます。

## 5.2 販社・通販のCSVから受注まで

| 順 | 操作 | 経路 | このとき起きること |
|---|---|---|---|
| 1 | 中身を確かめる | POST /api/imports/partner-orders（dry_run） | 読めるかどうかだけを返します。登録しません |
| 2 | 取り込む | POST /api/imports/partner-orders | 取込内容を控えたうえで、引き当てられたものを受注にします |
| 3 | 残りを確かめる | GET /api/imports/pending | マスタに無いなどで受注にできなかったものが出ます |
| 4 | マスタを登録して取り込み直す | POST /api/masters/... → 手順2 | |

商品の引き当て方は販社ごとに異なります。自社商品コードのある販社はコードで、無い販社（白鳩）は JAN で、Amazon は取引先別商品マスタの専用コード（例 `TO-GXZN-60W8` → `CS2420-0000-100`）で引き当てます。**この違いも取込テンプレートの設定です。**

必須でない列（JANなど）が読めなかった場合は、その行を落とさず**警告として記録し、取り込みは続けます。**Excel で開いて保存された CSV では JAN が指数表記（`4.57349E+12`）に変わり元に戻せないことがあるためです。

## 5.3 締めから請求・入金まで

| 順 | 操作 | 経路 | このとき起きること |
|---|---|---|---|
| 1 | 締める | POST /api/billing/closings | 取引先ごとの締め日で期間を切り、請求を作ります。前回請求残高・今回入金額・繰越残高・送料（30,000円未満は750円）も入ります |
| 2 | 手入力欄を直す | PATCH /api/billing/invoices/:id | 未計上・調整・手数料。当月請求額と残高が計算し直されます |
| 3 | 内容を確かめる | GET /api/billing/invoices/:id | 明細と税率別内訳 |
| 4 | 発行する | POST /api/billing/invoices/:id/issue | 発行済みになります。以後は直せません |
| 5 | 印刷する | GET /api/reports/invoices | PDF。**発行日は印刷しません**（貴社ご指示） |
| 6 | 入金を消し込む | POST /api/billing/cash-receipts | 請求を指定すると消込まで行います |

サンプル出荷は請求に入りません。

## 5.4 ロイヤリティ

| 順 | 操作 | 経路 | このとき起きること |
|---|---|---|---|
| 1 | 規定を登録する | POST /api/masters/royalty-rules | 支払先・ブランド／商品・販売先・期間・料率。発生しないものは「対象外」で登録します |
| 2 | 計算する | POST /api/billing/royalties/calculate | 対象月の出荷金額に規定を当てて計算します（端数は切り捨て） |
| 3 | 内訳を確かめる | GET /api/billing/royalties/:id | どの出荷にどの規定が当たったかが出ます |
| 4 | 確定する | POST /api/billing/royalties/:id/confirm | |

# 6. やり取りの例

実際の呼び出しと応答の形です。項目は抜粋しています。

## 6.1 受注登録（引当まで）

```
POST /api/orders
Authorization: Bearer ＜トークン＞

{
  "order_type": "卸",
  "partner_id": 12,
  "delivery_destination_id": 34,
  "sales_category_id": 2,
  "order_date": "2026-09-16",
  "ship_date": "2026-09-18",
  "shipping_remarks": "午前着希望",
  "lines": [
    { "line_no": 1, "line_type": "商品",
      "sku_id": 501, "item_name": "クールインナー M ホワイト",
      "qty": "24", "unit_price": "1280" },
    { "line_no": 2, "line_type": "送料",
      "item_name": "送料", "qty": "1", "unit_price": "800" }
  ]
}
```

有効在庫が足りていれば、引き当てたうえで出荷の番号まで返ります。

```
201 Created
{ "id": 1042, "order_no": "SO20260900123", "status": "引当済",
  "shipment_id": 880, "shipment_no": "SO20260900123", "shortages": [] }
```

有効在庫が足りない（が実在庫の範囲内の）場合は、引当待ちとして登録され、足りない内容が返ります。

```
201 Created
{ "id": 1043, "order_no": "SO20260900124", "status": "引当待ち",
  "shipment_id": null, "shipment_no": null,
  "shortages": ["FT1196-0306-100（クールインナー M ホワイト）必要 24 / 有効在庫 10"] }
```

実在庫を超える場合は登録されません。

```
400 Bad Request
{ "message": "実在庫を超える数量は登録できません。入荷を登録してからお試しください",
  "over": ["FT1196-0306-100（クールインナー M ホワイト）入力 200 / 実在庫 120"] }
```

## 6.2 引当のやり直し

```
POST /api/orders/1043/allocate
```

```
200 OK
{ "order_id": 1043, "order_no": "SO20260900124", "status": "引当済",
  "shipment_id": 881, "shipment_no": "SO20260900124",
  "allocated": [ { "sku_code": "FT1196-0306-100", "qty": "24" } ], "shortages": [] }
```

## 6.3 在庫の確認

```
GET /api/inventory/stocks?warehouse_id=1&q=FT1196
```

```
200 OK
{
  "items": [
    { "sku_code": "FT1196-0306-100", "product_name": "クールインナー",
      "warehouse_name": "本社倉庫", "lot_no": "",
      "qty_on_hand": "120", "qty_allocated": "24", "qty_available": "96" }
  ],
  "total": 1, "limit": 50, "offset": 0
}
```

`qty_available`（有効在庫）はデータベースが計算する項目で、書き込むことはできません。

## 6.4 出荷確定と印刷

```
POST /api/reports/confirm-and-print
{ "shipment_ids": [880, 881], "documents": ["出荷指示書", "納品書"] }
```

応答は PDF そのものです。ヘッダに確定した出荷の番号（`X-Confirmed-Shipments`）と、同梱できなかった添付の名前（`X-Skipped-Attachments`）が入ります。実在庫はこの時点で減ります。

確定を取り消す場合は次のとおりです。

```
POST /api/shipments/880/unconfirm
```

```
200 OK
{ "shipment_id": 880, "shipment_no": "SO20260900123",
  "status": "確定済", "order_status": "引当済", "restored": 1 }
```

## 6.5 締め処理

```
POST /api/billing/closings
{ "target_month": "2026-09", "partner_id": 12 }
```

```
200 OK
{
  "invoices": [
    { "id": 77, "invoice_no": "IV2026090001",
      "period_from": "2026-08-21", "period_to": "2026-09-20",
      "shipment_amount": "1284000", "return_amount": "-32000",
      "shipping_fee_amount": "1500",
      "current_invoice_amount": "1377800", "current_balance": "1377800" }
  ]
}
```

`partner_id` を指定しなければ、締め日の設定がある得意先をまとめて締めます。`shipping_fee_amount` は、期間中の出荷のうち 30,000円未満だったものの件数 × 750円です。

## 6.6 帳票の印刷（確定とは別に出す場合）

```
GET /api/reports/delivery-notes?shipment_ids=880,881,882&form=上代あり
```

応答は PDF そのものです。伝票1件につき1ページで、明細が入りきらないときだけ見出しごと次ページへ繰り越します。様式を指定しなければ、納品先マスタの伝票発行分類、それも未設定ならシステム設定の既定様式を使います。

誰がいつ何を出したかは帳票発行履歴に残ります。

## 6.7 CSV取込

```
POST /api/imports/partner-orders
{
  "template_code": "SHIRAHATO",
  "file_name": "20260916_発注.csv",
  "content_base64": "k4rNlo...",
  "dry_run": true
}
```

```
200 OK
{
  "batch_id": 41, "rows": 132, "orders": 0, "lines": 0,
  "warnings": [
    { "row": 88, "field": "jan",
      "message": "「4.57349E+12」は指数表記に変わっています。Excelで開かずに保存したファイルをお使いください" }
  ],
  "errors": []
}
```

`dry_run` を外して呼び直すと、実際に受注として登録します。

## 6.8 集計（利益まで）

```
POST /api/analytics/sales
{
  "from": "2026-04-01", "to": "2026-09-30",
  "dimensions": ["月", "販売担当"],
  "measures": ["金額", "原価", "ロイヤリティ", "利益"]
}
```

```
200 OK
{
  "dimensions": ["月", "販売担当"],
  "measures": ["金額", "原価", "ロイヤリティ", "利益"],
  "rows": [
    { "月": "2026-04", "販売担当": "坂本", "金額": "2318400",
      "原価": "1159200", "ロイヤリティ": "115920", "利益": "1043280" }
  ]
}
```

原価・ロイヤリティ・利益は `SENSITIVE:view` のある方にだけ返ります。

# 7. 業務ルールがAPIのどこに表れているか

貴社にご確認いただいた業務のきまりが、API でどう形になっているかの対応表です。

| ご確認いただいたきまり | API での現れ方 |
|---|---|
| 受注登録で引当（有効在庫が減る）、出荷確定で実在庫が減る（9/15 ②） | `POST /api/orders` で引当、`POST /api/reports/confirm-and-print` で実在庫減。設定 `ALLOCATION_TIMING`＝受注登録時 |
| 有効在庫を超えても登録可、実在庫を超えたらエラー（9/15 ①） | 受注登録時に実在庫と照合。超えれば 400。足りない分は「引当待ち」 |
| 出荷確定と印刷を同時に。添付ファイルも一緒に（9/15 ②） | `POST /api/reports/confirm-and-print` が確定・帳票・添付（PDF・画像）を1回で返す |
| 出荷確定後でも内容を変えられる（9/15 ③） | `POST /api/shipments/:id/unconfirm` で実在庫を戻して修正、再確定。履歴に「出荷取消」が残る |
| 出荷一覧から削除すると引当が外れ、有効在庫が戻る。実在庫は動かさない | `POST /api/orders/:id/cancel`・`DELETE .../shipping-instruction`。引当を「解除」に変え、実在庫には触れません |
| セットの在庫は持たず、構成商品それぞれから引き落とす | 引当のときに構成品へ展開して押さえます。セット自体には在庫を持ちません |
| 販売カテゴリーはマスタ登録して選ぶ | `/api/masters/sales-categories`。取引先ごとの自由入力にはしていません |
| 締め日は取引先ごとにバラバラ | 締め処理が取引先ごとに期間を切ります。カレンダー月では区切りません |
| 1回の出荷が30,000円未満のとき送料750円（9/15 回答④） | 締め処理が出荷ごとに判定。閾値・金額は設定 `SHIPPING_FEE_THRESHOLD`／`SHIPPING_FEE_AMOUNT` と取引先マスタ。直送は送料調整欄 |
| 請求書に発注書Noを記載し、発行日は印刷しない | 請求書PDFに発注番号を印刷。発行日は設定 `INVOICE_PRINT_ISSUE_DATE` が既定 false のため印刷しません |
| 税率別内訳を請求書の上部に配置 | 請求書PDFで明細より前に配置しています |
| 納品書は4様式。納品先の伝票発行分類で自動切替（9/15 回答①） | 汎用区分 `SLIP_ISSUE_CLASS` に4様式を登録。納品先マスタで選び、`GET /api/reports/delivery-notes` が従います |
| 上代は得意先別商品マスタ（9/15 回答②） | `partner_products.retail_price`。納品書「上代あり」に印字 |
| 帳票の差出人は会社名のみ（9/15 回答③） | 設定 `COMPANY_NAME`。住所・電話は空欄なら見出しごと印字しません |
| ロイヤリティの端数は切り捨て（9/15 回答⑤） | 設定 `ROYALTY_ROUNDING_MODE`＝floor |
| 販社のIDはそのまま取引先コード・納品先コードに（9/15 回答⑥） | 取込は取引先コード・納品先コードで引き当てます。対応表は持ちません |
| 入出金に「カード」欄（9/15 経理1） | `POST /api/cash-transactions` の `card_amount`。合計に含めます |
| 販売担当のマスタ（9/17 ①） | `/api/masters/simple/sales_staff`。取引先の既定担当 → 受注の `sales_staff_id` に引き継ぎ、集計の軸「販売担当」 |
| 月次の引当在庫。受注登録時にその枠から減る（9/17 ②） | `/api/inventory/reservations`（取引先は任意）。`POST /api/orders` が枠を消費し、取消・修正で戻す。期間で持つので月末で自動的に切り替わる |
| 利益＝売上−（原価＋ロイヤリティ）（9/15 経理3） | 指標「原価」「ロイヤリティ」「利益」。機微項目として権限で制御 |
| 出荷指示書はセットのまま、ピッキングリストは構成品に展開して合算 | 設定 `PICKING_EXPAND_SET`。ピッキングリストは引当（展開後）を数えます |
| 取引先ごとの専用商品コードの読み替え | 得意先別商品マスタ。Amazon `TO-GXZN-60W8` → 自社 `CS2420-0000-100` |
| 経費はSKUではなく商品名（品番）単位 | `POST /api/purchases`。紐づけ先は 商品／商品分類／ブランド／指定なし の4段階 |
| 入出金は1件ずつ登録が基本 | `POST /api/cash-transactions`。手形・相殺・小切手・集金・海外送金に対応 |
| 受注一覧のまま編集（ご要望⑨⑩） | `PATCH /api/orders/:id`。引当を組み直します。出荷済みは確定取消のあとで |
| 受注番号と出荷指示番号を同じにする（ご要望⑪） | 設定 `SHIPMENT_NO_SOURCE`。同梱のときだけ枝番 |
| サンプル出荷は売上に反映しない（ご要望④） | 受注区分「サンプル」。出荷指示書は出て在庫も落ちますが、請求には入りません |
| 在庫数の調整（ご要望⑫） | `POST /api/inventory/adjustments`。良品・不良の振り替えも行えます |
| 取引条件を受注で自動表示し、変更もできる（ご要望③） | 取引先マスタの既定値を受注登録時に引き継ぎ、受注側で上書きできます |
| 送料調整欄（ご要望⑤） | 受注の `shipping_fee_adjustment`。入力すると自動計算した送料を上書きします |
| ロイヤリティはロイヤリティマスタに一本化 | 商品マスタ・得意先別商品マスタにロイヤリティ欄はありません |

**「設定」と書いたものは、すべて画面（M-16）から変更できます。**プログラムに固定値として書き込んではいません。運用が変わったときに改修をお待ちいただかずに済むようにするためです。

# 8. ご回答の反映と、今後の進め方

## 8.1 9/15 のご回答で確定し、反映した事項

| 事項 | ご回答 | 反映 |
|---|---|---|
| 納品書4種の使い分け | 納品先マスタの伝票発行分類で選ぶ | 伝票発行分類に4様式を登録。納品先ごとに選択、未選択は既定様式 |
| 納品書「上代あり」の上代 | 得意先別商品マスタに欄を追加 | `retail_price` を追加。納品書に印字 |
| 帳票の差出人 | 会社名のみ | 住所・電話が空のときは印字しない |
| 送料の金額 | 30,000円未満は一律750円。直送は送料調整欄 | 締め処理で出荷ごとに判定。「未満」で判定（ちょうどは請求しない） |
| ロイヤリティの端数処理 | 切り捨て | 既定のまま |
| 販社4社の得意先ID・納品先ID | CSVのIDをそのまま登録 | 対応表なし。取込はコードで引き当て |
| 受注〜出荷の流れ | 登録時に引当、確定ボタンで実在庫減と印刷、確定後の変更 | 4.3／4.4 のとおり |
| 経理 | カード欄、販売担当軸、利益集計 | 4.8／4.11 のとおり |
| 販売担当・販売カテゴリーのマスタ（9/17 ①） | 販売カテゴリーは既存。販売担当はマスタを新設 | 4.2 のとおり |
| 引当在庫（9/17 ②） | 期間・販売カテゴリー・商品で登録し、受注登録時に減る | 4.3／4.5 のとおり |

## 8.2 現在の作りのまま進める事項

次の事項は、いただいたご回答から判断できる範囲で決めて作ってあります。**このまま第3段階（画面）に進み、画面をお試しいただく際にご指摘があれば見直します。**改めてのご回答は不要です。

| 事項 | 現在の作り |
|---|---|
| 有効在庫が足りない受注の出荷 | 全量そろってから出荷します（引当待ちの受注は出荷の対象になりません）。足りる分だけ先に出す運用が必要になった場合は、分納として対応します |
| 引当在庫の枠を超える受注 | 登録できません（枠を増やしてから登録）。枠を超えても登録を通す運用が必要なら、警告に変えます |
| 販売担当に原価・利益を見せるか | 権限「機微項目の参照」で個別に付与する形にしています。ロールごとに一括で付けることもできます |
| 送料判定の基準額 | 税抜の出荷金額で 30,000円を判定しています。税込で判定する場合は設定を切り替えるだけです |

要件定義書 第10章に記載した暫定仕様も同じ扱いです。暫定のまま画面まで作り、実際にお試しいただいたうえで、直すべきところを直します。

## 8.3 貴社からご連絡いただく事項

| 事項 | 状況 |
|---|---|
| 楽楽販売から取り込むデータ | 「どのデータを取り込むか後日まとめます」とのご連絡をいただいております。まとまり次第お知らせください。取り込みに先立って必要になるのは、マスタ5種（取引先・納品先・商品・SKU・得意先別商品）と開始時点の在庫です |

# 付録A 経路の一覧

実装してある経路の全件です。`:id` のように `:` で始まる部分には番号が入ります。

<COLW 850 5600 3178>
| メソッド | 経路 | 必要な権限 |
|---|---|---|
| GET | /api/admin/users | M-17:view |
| GET | /api/admin/users/:id | M-17:view |
| POST | /api/admin/users | M-17:create |
| PATCH | /api/admin/users/:id | M-17:update |
| POST | /api/admin/users/:id/password | M-17:update |
| PUT | /api/admin/users/:id/roles | M-17:update |
| POST | /api/admin/users/:id/deactivate | M-17:delete |
| GET | /api/admin/roles | M-17:view |
| GET | /api/admin/permissions | M-17:view |
| GET | /api/admin/permission-matrix | M-17:view |
| PUT | /api/admin/roles/:id/permissions | M-17:update |
| GET | /api/admin/audit-logs | M-17:view |
| GET | /api/analytics/options | A-03:view |
| POST | /api/analytics/sales | A-01:view |
| POST | /api/analytics/saved-queries | A-03:create |
| GET | /api/analytics/saved-queries | A-03:view |
| GET | /api/analytics/amazon-summary | A-01:view |
| GET | /api/attachments | D-01:view |
| POST | /api/attachments | D-01:update |
| GET | /api/attachments/:id/content | D-01:view |
| DELETE | /api/attachments/:id | D-01:delete |
| POST | /api/auth/login | ログイン不要 |
| GET | /api/auth/me | ログインのみ |
| POST | /api/billing/closings | B-01:create |
| GET | /api/billing/invoices | B-02:view |
| GET | /api/billing/invoices/:id | B-02:view |
| PATCH | /api/billing/invoices/:id | B-02:update |
| POST | /api/billing/invoices/:id/issue | B-02:print |
| GET | /api/billing/ar-balances | B-04:view |
| POST | /api/billing/cash-receipts | B-05:create |
| GET | /api/billing/cash-receipts | B-05:view |
| POST | /api/billing/royalties/calculate | Y-02:create |
| GET | /api/billing/royalties | Y-02:view |
| GET | /api/billing/royalties/:id | Y-02:view |
| POST | /api/billing/royalties/:id/confirm | Y-02:update |
| GET | /api/health | ログイン不要 |
| GET | /api/health/db | ログインのみ |
| POST | /api/imports/partner-orders | I-01:create |
| POST | /api/imports/oms-orders | I-01:create |
| POST | /api/imports/amazon-transactions | I-01:create |
| GET | /api/imports/batches | I-01:view |
| GET | /api/imports/pending | I-01:view |
| POST | /api/inventory/receipts | S-03:create |
| GET | /api/inventory/receipts | S-03:view |
| GET | /api/inventory/receipts/:id | S-03:view |
| POST | /api/inventory/receipts/:id/receive | S-03:update |
| POST | /api/inventory/adjustments | S-01:update |
| GET | /api/inventory/adjustments | S-01:view |
| POST | /api/inventory/reservations | S-08:create |
| GET | /api/inventory/reservations | S-08:view |
| PATCH | /api/inventory/reservations/:id | S-08:update |
| DELETE | /api/inventory/reservations/:id | S-08:delete |
| POST | /api/inventory/reservations/copy | S-08:create |
| GET | /api/inventory/stocks | S-01:view |
| GET | /api/inventory/stocks/by-sku/:skuId | S-01:view |
| GET | /api/inventory/stocks/movements | S-05:view |
| GET | /api/masters/sales-categories | O-01:view |
| GET | /api/masters/warehouses | M-14:view |
| GET | /api/masters/codes/:categoryCode | M-16:view |
| GET | /api/masters/settings | M-16:view |
| GET | /api/masters/simple/:kind | M-16:view |
| POST | /api/masters/simple/:kind | M-16:create |
| PATCH | /api/masters/simple/:kind/:id | M-16:update |
| POST | /api/masters/simple/:kind/:id/deactivate | M-16:delete |
| POST | /api/masters/partners | M-01:create |
| PATCH | /api/masters/partners/:id | M-01:update |
| POST | /api/masters/partners/:id/deactivate | M-01:delete |
| GET | /api/masters/delivery-destinations | M-05:view |
| POST | /api/masters/delivery-destinations | M-05:create |
| PATCH | /api/masters/delivery-destinations/:id | M-05:update |
| POST | /api/masters/delivery-destinations/:id/deactivate | M-05:delete |
| POST | /api/masters/products | M-08:create |
| PATCH | /api/masters/products/:id | M-08:update |
| POST | /api/masters/products/:id/deactivate | M-08:delete |
| POST | /api/masters/skus | M-09:create |
| PATCH | /api/masters/skus/:id | M-09:update |
| POST | /api/masters/sets | M-10:create |
| GET | /api/masters/sets | M-10:view |
| GET | /api/masters/sets/:id | M-10:view |
| GET | /api/masters/partner-products | M-11:view |
| POST | /api/masters/partner-products | M-11:create |
| PATCH | /api/masters/partner-products/:id | M-11:update |
| POST | /api/masters/warehouses | M-14:create |
| PATCH | /api/masters/warehouses/:id | M-14:update |
| GET | /api/masters/purchase-items | M-15:view |
| POST | /api/masters/purchase-items | M-15:create |
| PATCH | /api/masters/purchase-items/:id | M-15:update |
| POST | /api/masters/codes | M-16:create |
| PATCH | /api/masters/codes/:id | M-16:update |
| PATCH | /api/masters/settings/:key | M-16:update |
| GET | /api/masters/royalty-rules | Y-02:view |
| POST | /api/masters/royalty-rules | Y-02:create |
| PATCH | /api/masters/royalty-rules/:id | Y-02:update |
| POST | /api/masters/royalty-rules/:id/deactivate | Y-02:delete |
| GET | /api/masters/partners | M-01:view |
| GET | /api/masters/partners/:id | M-01:view |
| GET | /api/masters/partners/:id/delivery-destinations | M-05:view |
| GET | /api/masters/products | M-08:view |
| GET | /api/masters/products/:id | M-08:view |
| GET | /api/masters/skus/jan-export | M-09:print |
| GET | /api/masters/skus | M-09:view |
| POST | /api/orders | O-01:create |
| GET | /api/orders | O-03:view |
| GET | /api/orders/:id | O-03:view |
| PATCH | /api/orders/:id | O-01:update |
| POST | /api/orders/:id/cancel | O-01:delete |
| POST | /api/orders/:id/allocate | D-01:create |
| POST | /api/orders/:id/shipping-instruction | D-01:create |
| DELETE | /api/orders/:id/shipping-instruction | D-01:delete |
| GET | /api/sales-schedules | S-08:view |
| POST | /api/sales-schedules | S-08:create |
| PATCH | /api/sales-schedules/:id | S-08:update |
| DELETE | /api/sales-schedules/:id | S-08:delete |
| POST | /api/purchases | P-01:create |
| GET | /api/purchases | P-01:view |
| GET | /api/purchases/expense-by-product | P-01:view |
| GET | /api/purchases/:id | P-01:view |
| POST | /api/payments | P-01:create |
| GET | /api/ap-balances | P-03:view |
| POST | /api/cash-transactions | C-01:create |
| GET | /api/cash-transactions | C-01:view |
| GET | /api/postal-codes/search | ログインのみ |
| POST | /api/postal-codes/import | I-01:create |
| GET | /api/postal-codes/:code | ログインのみ |
| POST | /api/reports/confirm-and-print | D-01:update |
| GET | /api/reports/shipping-instructions | D-03:print |
| GET | /api/reports/picking-list | D-03:print |
| GET | /api/reports/delivery-notes | D-03:print |
| GET | /api/reports/invoices | D-03:print |
| POST | /api/returns | R-01:create |
| GET | /api/returns | R-01:view |
| GET | /api/returns/:id | R-01:view |
| POST | /api/returns/:id/inspect | R-01:update |
| GET | /api/shipments | D-01:view |
| GET | /api/shipments/:id | D-01:view |
| POST | /api/shipments/consolidate | D-01:update |
| DELETE | /api/shipments/:id/consolidation | D-01:update |
| POST | /api/shipments/:id/unconfirm | D-01:update |
| POST | /api/shipments/:id/confirm | D-01:update |
