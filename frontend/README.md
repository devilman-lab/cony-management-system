# 販売管理システム 画面（第3段階）

株式会社コニー様の販売管理システムの画面です。貴社にご確認いただいたデモ UI（配色・部品・画面構成）をそのまま踏襲し、第2段階の API に接続しています。

- Next.js 15（App Router）／React 19／TypeScript／Tailwind CSS v4
- 画面の見た目はデモの CSS を `src/app/globals.css` に移し、同じクラス名（`.btn` `.inp` `.tbl` `.card` `.shell-*` `.login-*`）で組んでいます
- ログインは JWT（`localStorage` の `cony.token`）。権限のない機能はメニューにも出ません

## 動かし方（開発）

```
cd backend  && npm run dev          # API（http://localhost:3001）
cd frontend && npm install && npm run dev   # 画面（http://localhost:3000）
```

API の場所を変えるときは `.env.local` に `NEXT_PUBLIC_API_URL=http://<host>:3001/api` を書きます（`.env.example` 参照）。

テスト版（Docker で 4 名にお試しいただく形）は `docs/テスト版セットアップ手順.md` を参照。Docker では画面と同じオリジンの `/api` を API へ中継するので、CORS もポート公開も 1 つで済みます（`next.config.ts` の `API_PROXY_TARGET`）。

## 画面一覧

| メニュー | パス | 機能ID |
|---|---|---|
| ダッシュボード／ヘルプ | `/dashboard` `/help` | — |
| 受注一覧・受注入力・受注詳細 | `/orders` `/orders/new` `/orders/[id]` | O-01 |
| 出荷確定印刷 | `/shipping` | D-01／D-03 |
| CSV取込 | `/imports` | I-01 |
| 入出荷履歴・返品再生 | `/moves` `/returns` | S-02／S-06 |
| 在庫表・入荷登録・在庫調整・引当在庫（確保数） | `/stock` `/receiving` `/adjustments` `/allocation` | S-01／S-03／S-05／S-08 |
| 締め請求書・入金消込・売掛残高 | `/invoices` `/payments` `/ar` | B-01／B-02／B-05／B-04 |
| 仕入経費・買掛支払・入出金 | `/purchases` `/ap` `/cash` | P-01／P-03／C-01 |
| 販売実績・ロイヤリティ・販売予定 | `/analytics` `/royalty` `/schedule` | A-01／A-03／Y-02／S-08 |
| マスタ（取引先・納品先・商品・セット・得意先別商品・倉庫・仕入品目・ロイヤリティ規定・分類区分設定・ユーザー権限） | `/masters/*` | M-01〜M-17 |

## 構成

```
src/
  app/            画面（App Router）。(app)/ 配下はログイン後の画面
  components/ui/  部品（Button, Input, DataTable, Modal, SearchSelect, Toast…）
  components/masters/  マスタ画面の共通部品（一覧＋登録・編集モーダル＋無効化）
  components/orders/   受注入力フォーム
  lib/api.ts      API 呼び出し（トークン、エラーの日本語化、PDF/CSV のダウンロード）
  lib/auth.tsx    ログイン状態と権限（can('O-01','create') など）
  lib/nav.ts      メニュー定義（機能IDで表示を絞る）
  lib/format.ts   金額・数量・日付の表示
```

## 確認

```
npx tsc --noEmit   # 型
npm run build      # 本番ビルド（37 画面）
```

画面の通し確認は、`scripts/smoke-backend.ps1 -KeepRunning` で使い捨ての API（3011 番）を立て、`NEXT_PUBLIC_API_URL=http://localhost:3011/api` で `npm run dev` を起動して行います（管理者 admin／SmokeTest123456）。
