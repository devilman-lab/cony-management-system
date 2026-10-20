/**
 * 品名（2026-10-13 受注処理編「商品・品名ともに すべて 商品名・カラー・サイズで出す」）。
 *
 * 名前＋カラー＋サイズ。名前の末尾に「2枚組」のような組数があれば、カラー・サイズのあとに回す
 * （「骨盤ショーツ07 2枚組」＋ブラック・S →「骨盤ショーツ07 ブラック S 2枚組」）。
 * 名前にカラー・サイズがすでに語として入っていれば重ねない（販売名にカラー・サイズまで書いてある得意先別商品など）。
 * サーバーのデータベース関数 fn_item_name（docs/02-schema.sql）と同じ決まり。どちらかを直すときは両方を直す。
 */
const SUFFIX = /^(.*\S)[\s　]+([0-9０-９]+(?:枚|個|本|足|点|袋|箱)?(?:組|セット|入り|入))$/u;

export function composeItemName(base: string | null | undefined, color: string | null | undefined, size: string | null | undefined): string {
  let name = (base ?? '').trim();
  let suffix: string | null = null;
  const m = SUFFIX.exec(name);
  if (m) {
    name = m[1];
    suffix = m[2];
  }
  const words = name.split(/[\s　]+/);
  let out = name;
  const c = (color ?? '').trim();
  const z = (size ?? '').trim();
  if (c && !words.includes(c)) out += ` ${c}`;
  if (z && !words.includes(z)) out += ` ${z}`;
  if (suffix) out += ` ${suffix}`;
  return out.trim();
}
