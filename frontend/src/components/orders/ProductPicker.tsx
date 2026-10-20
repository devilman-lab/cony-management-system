'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { composeItemName } from '@/lib/item-name';
import { Button, ErrorBox, Field, Loading, Modal, Select } from '@/components/ui';

/**
 * 絞り込みのダイアログの候補（GET /orders/sku-picker の1件。2026-10-13 受注処理編 O-04・O-05）。
 * 取引先を渡したときは、その取引先の使っている得意先別商品の行ごとに1件（同じ SKU に行が複数あれば複数件）。
 * 取引先が無いときは使っている SKU ごとに1件で、得意先別商品の項目（partner_product_id など）は null。
 */
export interface PickerRow {
  sku_id: number;
  sku_code: string;
  product_name: string;
  sku_name: string | null;
  /** SKU の品名（SKU の名前＋カラー＋サイズ。O-01） */
  item_name: string;
  /** 得意先別商品の販売名 */
  sales_name: string | null;
  brand_id: number | null;
  brand_name: string | null;
  product_class_id: number | null;
  product_class_name: string | null;
  color_id: number | null;
  color_name: string | null;
  size_id: number | null;
  size_name: string | null;
  jan: string | null;
  partner_jan: string | null;
  shipping_jan: string | null;
  partner_product_id: number | null;
  partner_product_code: string | null;
  /** 卸単価（得意先別商品） */
  unit_price: string | null;
  retail_price: string | null;
  is_set: boolean;
  tax_rate: string;
}

/**
 * 明細に入れる品名。得意先別商品に販売名があれば販売名＋カラー＋サイズ、無ければ SKU の品名
 * （O-01。販売名にカラー・サイズが入っていれば重ねない＝composeItemName）。
 */
export const pickerItemName = (r: PickerRow): string =>
  r.sales_name?.trim() ? composeItemName(r.sales_name, r.color_name, r.size_name) : r.item_name;

/** 一覧に出す JAN。出荷JAN、無ければ先方JAN、無ければ JAN（帳票と同じ順） */
export const pickerJan = (r: Pick<PickerRow, 'shipping_jan' | 'partner_jan' | 'jan'>): string => r.shipping_jan || r.partner_jan || r.jan || '';

const rowKey = (r: PickerRow) => `${r.sku_id}:${r.partner_product_id ?? ''}`;

/** 値の無い候補（ブランド・カラーなどが空の商品）を選ぶときの値 */
const NONE = '__none__';

/** 絞り込みの段。この順に上から絞る（O-04「ブランド→商品分類→カラー→サイズ→JAN の順で」） */
const STAGES: { label: string; value: (r: PickerRow) => string | null; name: (r: PickerRow) => string }[] = [
  { label: 'ブランド', value: (r) => (r.brand_id == null ? null : String(r.brand_id)), name: (r) => r.brand_name ?? '' },
  { label: '商品分類', value: (r) => (r.product_class_id == null ? null : String(r.product_class_id)), name: (r) => r.product_class_name ?? '' },
  { label: 'カラー', value: (r) => (r.color_id == null ? null : String(r.color_id)), name: (r) => r.color_name ?? '' },
  { label: 'サイズ', value: (r) => (r.size_id == null ? null : String(r.size_id)), name: (r) => r.size_name ?? '' },
  { label: 'JAN', value: (r) => pickerJan(r) || null, name: (r) => pickerJan(r) },
];
const EMPTY_SEL = STAGES.map(() => '');

/** 一覧に一度に出す件数の上限。多いときは上の段で絞ってもらう（何千件も並べると画面が重くなる） */
const SHOW_MAX = 500;

const matches = (r: PickerRow, stage: number, sel: string) => {
  if (!sel) return true;
  const v = STAGES[stage].value(r);
  return sel === NONE ? v === null : v === sel;
};

/**
 * 商品を「ブランド → 商品分類 → カラー → サイズ → JAN」の順に絞り込んで選ぶダイアログ（2026-10-13 受注処理編 O-04・O-05）。
 * 各段の選択肢は、上の段で絞ったあとに残る商品にあるものだけ。上の段を選び直すと下の段は「すべて」に戻る。
 * 一覧でチェックを付けて「明細に入れる」を押すと、onPick にチェックした行（一覧の並び順）と、読み込んだ全部の行を渡す。
 * 取引先を渡すと、その取引先の得意先別商品に登録した商品だけが出る（卸単価・先方コードつき）。取引先が無ければすべての商品。
 * 段の選び方は閉じても残す（同じブランドから続けて選ぶため）。取引先が替わったら読み直して段も戻す。
 */
export function ProductPicker({
  open,
  partnerId,
  partnerName,
  onClose,
  onPick,
}: {
  open: boolean;
  partnerId: number | null;
  partnerName?: string | null;
  onClose: () => void;
  onPick: (picked: PickerRow[], all: PickerRow[]) => void;
}) {
  const [rows, setRows] = useState<PickerRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sel, setSel] = useState<string[]>(EMPTY_SEL);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  /** 読み込んだときの取引先（取引先が替わったら読み直す） */
  const loadedFor = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setChecked(new Set());
    if (loadedFor.current === partnerId && rows) return;
    let alive = true;
    loadedFor.current = partnerId;
    setRows(null);
    setError(null);
    setSel(EMPTY_SEL);
    api
      .get<PickerRow[]>('/orders/sku-picker', { partner_id: partnerId ?? undefined })
      .then((r) => alive && setRows(r))
      .catch((e) => {
        if (!alive) return;
        setError(e);
        // 読めなかったときは次に開いたときに読み直す
        loadedFor.current = undefined;
      });
    return () => {
      alive = false;
    };
    // rows は読み直すかどうかの判定にだけ使う（読み終わるたびに読み直さない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, partnerId]);

  /** 段ごとの「その段より上で絞ったあとに残る行」。levels[i] が i 段目の選択肢の元、levels[5] が一覧 */
  const levels = useMemo(() => {
    const out: PickerRow[][] = [rows ?? []];
    STAGES.forEach((_, i) => out.push(out[i].filter((r) => matches(r, i, sel[i]))));
    return out;
  }, [rows, sel]);

  /** 段の選択肢（出てきた順。件数つき）。値の無い商品があれば「（なし）」も出す */
  const options = useMemo(
    () =>
      STAGES.map((st, i) => {
        const m = new Map<string, { name: string; n: number }>();
        let none = 0;
        for (const r of levels[i]) {
          const v = st.value(r);
          if (v === null) {
            none += 1;
            continue;
          }
          const cur = m.get(v);
          if (cur) cur.n += 1;
          else m.set(v, { name: st.name(r), n: 1 });
        }
        return { values: [...m.entries()].map(([value, x]) => ({ value, ...x })), none };
      }),
    [levels],
  );

  const list = levels[STAGES.length];
  const shown = list.slice(0, SHOW_MAX);
  const withPartner = partnerId !== null;

  const choose = (stage: number, v: string) =>
    setSel((s) => s.map((x, i) => (i < stage ? x : i === stage ? v : '')));
  const toggle = (k: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const allShownChecked = shown.length > 0 && shown.every((r) => checked.has(rowKey(r)));
  const toggleAll = () =>
    setChecked((s) => {
      const n = new Set(s);
      for (const r of shown) {
        if (allShownChecked) n.delete(rowKey(r));
        else n.add(rowKey(r));
      }
      return n;
    });

  // チェックした行は一覧の並び順で渡す（絞り込みを変えて見えなくなった行も、チェックしてあれば入れる）
  const picked = (rows ?? []).filter((r) => checked.has(rowKey(r)));

  return (
    <Modal
      open={open}
      title={`商品を絞り込んで選ぶ${withPartner && partnerName ? `（${partnerName} の得意先別商品）` : withPartner ? '（取引先の得意先別商品）' : '（すべての商品）'}`}
      onClose={onClose}
      width={1000}
      anchorTop
      footer={
        <>
          <span className="mr-auto text-[11.5px] text-[var(--color-ink-3)]">
            チェックした商品を、押した行に1つ目、その下に残りを行として入れます
          </span>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="primary" disabled={picked.length === 0} onClick={() => onPick(picked, rows ?? [])}>
            明細に入れる{picked.length > 0 ? `（${picked.length}件）` : ''}
          </Button>
        </>
      }
    >
      {error ? (
        <ErrorBox error={error} />
      ) : !rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-[#e8c88a] bg-[#fbf3e2] text-[#7a5407] px-3 py-2 text-[12.5px]">
          {withPartner ? 'この取引先の得意先別商品が登録されていません（得意先別商品マスタで登録してください）' : '選べる商品がありません'}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-5 gap-2 max-[767px]:grid-cols-2">
            {STAGES.map((st, i) => (
              <Field key={st.label} label={`${i + 1}. ${st.label}`}>
                <Select value={sel[i]} onChange={(e) => choose(i, e.target.value)} aria-label={st.label}>
                  <option value="">（すべて）</option>
                  {options[i].values.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.name}（{o.n}）
                    </option>
                  ))}
                  {options[i].none > 0 && <option value={NONE}>（なし）（{options[i].none}）</option>}
                </Select>
              </Field>
            ))}
          </div>
          <div className="flex items-center gap-3 text-[11.5px] text-[var(--color-ink-3)]">
            <span>上の段から順に選んで絞り込みます。上の段を選び直すと、下の段は「すべて」に戻ります。</span>
            {sel.some(Boolean) && (
              <button type="button" className="btn btn-quiet btn-sm ml-auto" onClick={() => setSel(EMPTY_SEL)}>
                絞り込みを解除
              </button>
            )}
          </div>
          <div className="text-[12px]">
            <b className="num">{list.length}</b> 件
            {checked.size > 0 && <span className="ml-3 text-[var(--color-brand-700)] font-semibold">チェックした商品 {picked.length} 件</span>}
            {list.length > SHOW_MAX && (
              <span className="ml-3 text-[#7a5407]">先頭の {SHOW_MAX} 件を出しています。上の段で絞り込んでください</span>
            )}
          </div>
          <div className="border border-[var(--color-line)] rounded-md overflow-auto max-h-[46vh]">
            <table className="tbl tbl-fit" style={{ minWidth: withPartner ? 860 : 700 }}>
              <thead>
                <tr>
                  <th className="c" style={{ width: 36 }}>
                    <input type="checkbox" checked={allShownChecked} onChange={toggleAll} aria-label="表示中をすべて選ぶ" />
                  </th>
                  <th className="nw" style={{ width: 150 }}>商品コード</th>
                  <th>品名</th>
                  <th style={{ width: 96 }}>カラー</th>
                  <th style={{ width: 64 }}>サイズ</th>
                  <th className="nw" style={{ width: 118 }}>JAN</th>
                  {withPartner && <th style={{ width: 110 }}>先方コード</th>}
                  {withPartner && <th className="r" style={{ width: 84 }}>卸単価</th>}
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={withPartner ? 8 : 6} className="text-center py-6 text-[var(--color-ink-3)]">
                      当てはまる商品がありません
                    </td>
                  </tr>
                )}
                {shown.map((r) => {
                  const k = rowKey(r);
                  const on = checked.has(k);
                  return (
                    <tr key={k} className={`cursor-pointer ${on ? 'sel' : ''}`} onClick={() => toggle(k)}>
                      <td className="c">
                        <input type="checkbox" checked={on} onChange={() => toggle(k)} onClick={(e) => e.stopPropagation()} aria-label={`${r.sku_code} を選ぶ`} />
                      </td>
                      <td className="nw num">{r.sku_code}</td>
                      <td>
                        {pickerItemName(r)}
                        {r.is_set && <span className="ml-1.5 text-[10.5px] text-[var(--color-ink-3)]">セット</span>}
                      </td>
                      <td>{r.color_name ?? ''}</td>
                      <td>{r.size_name ?? ''}</td>
                      <td className="nw num">{pickerJan(r)}</td>
                      {withPartner && <td>{r.partner_product_code ?? ''}</td>}
                      {withPartner && <td className="r num">{r.unit_price != null ? Number(r.unit_price).toLocaleString('ja-JP', { maximumFractionDigits: 4 }) : ''}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
