'use client';

import { fetchSkusFor, type Option } from '@/components/ui/SearchSelect';

/**
 * 入荷・在庫調整の商品欄の候補。セット商品は在庫を持たないので出さない
 * （入荷・調整でセットの在庫を作ると、在庫表に出ず引当にも使われない在庫になる。2026-10-12 受入テスト）。
 * API でもセット商品は断る。候補の取り方を毎回作り直さないよう、ここで1つだけ作る。
 */
export const fetchStockSkus = fetchSkusFor(null, { isSet: false });

/**
 * 選んだ商品の全文（商品コード・商品名・カラー・サイズ）を、商品欄の下に折り返して出す（在庫編 Z-10・Z-17）。
 * 商品欄は1行なので、長い商品名だとカラー・サイズが「…」で切れ、同じ商品の M と L を見分けられなかった。
 */
export function PickedSkuText({ value }: { value: Option | null }) {
  if (!value) return null;
  return (
    <div className="mt-0.5 whitespace-normal break-words text-[11px] leading-[1.45] text-[var(--color-ink-2)]">
      {value.label}
    </div>
  );
}
