-- JAN の重複を禁止する（2026-09-25）
--
-- 背景：JAN に一意制約が無く、別の商品に同じ JAN を登録できていた。
-- JAN で引き当てる販社CSV（白鳩）の取込がどちらの商品に付くか定まらず、
-- 間違えた側を「使わない」にしても無効な SKU に引き当たってしまう。
--
-- 使い方：先に 1) で重複が無いことを確かめ、0件なら 2) を実行する。
-- docs/02-schema.sql からの新規構築では、この索引は最初から入っている。
SET search_path = cony, public;

-- 1) 重複の確認（0件であること）
SELECT jan, count(*) AS 件数, string_agg(sku_code, ' / ') AS SKU
  FROM skus
 WHERE jan IS NOT NULL
 GROUP BY jan
HAVING count(*) > 1;

-- 2) 索引の入れ替え
DROP INDEX IF EXISTS ix_skus_jan;
CREATE UNIQUE INDEX ux_skus_jan ON skus (jan) WHERE jan IS NOT NULL;
