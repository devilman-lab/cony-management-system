-- JAN の重複を禁止する（2026-09-25）
--
-- 背景：JAN に一意制約が無く、別の商品に同じ JAN を登録できていた。
-- JAN で引き当てる販社CSV（白鳩）の取込がどちらの商品に付くか定まらず、
-- 間違えた側を「使わない」にしても無効な SKU に引き当たってしまう。
--
-- 使い方：先に 1) で重複が無いことを確かめ、0件なら 2) を実行する。
-- docs/02-schema.sql からの新規構築では、この索引は最初から入っている。
-- このファイルは UTF-8 です。日本語のコメントと、'取消' のような日本語の値を含みます。
-- 日本語版 Windows の psql は、コンソールの既定（Shift-JIS）でファイルを読もうとして
-- 「invalid byte sequence for encoding "SJIS"」で止まります。先にこれを宣言して防ぎます。
SET client_encoding = 'UTF8';
SET search_path = cony, public;

-- 本番のバックエンドを動かしたまま流すと、ロック待ちで画面が固まることがあります。
-- 10秒で諦めて自分から降りるようにしておきます（諦めても何も変わりません。空いてから流し直す）。
SET lock_timeout = '10s';


-- 1) 重複の確認（0件であること）
SELECT jan, count(*) AS 件数, string_agg(sku_code, ' / ') AS SKU
  FROM skus
 WHERE jan IS NOT NULL
 GROUP BY jan
HAVING count(*) > 1;

-- 2) 索引の入れ替え
-- まるごと1つのトランザクションにしてあります。囲まないと、重複があったときに
-- DROP INDEX だけが通って CREATE が落ち、**jan に索引が1本も無い状態**で残ります
-- （直す前より悪くなる）。囲んでおけば、失敗しても元の索引がそのまま残ります。
BEGIN;
DROP INDEX IF EXISTS ix_skus_jan;
CREATE UNIQUE INDEX ux_skus_jan ON skus (jan) WHERE jan IS NOT NULL;
COMMIT;

-- 1) で重複が出たときは、ここで止まります（Key (jan)=(…) is duplicated）。
-- 使わない側の SKU の jan を空欄にしてから、もう一度このファイルを流してください：
--   UPDATE cony.skus SET jan = NULL WHERE sku_code = '使わない側のSKUコード';
