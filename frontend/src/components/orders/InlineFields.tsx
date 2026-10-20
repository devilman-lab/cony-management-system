'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * 受注一覧の編集モードの欄（2026-10-13 受注処理編 O-22「一覧のまま修正できる仕様に」。楽楽の編集モード）。
 *
 * 保存ボタンは置かず、欄を離れたとき（日付・文字）・選んだとき（納品時間）に、変わっていれば保存する。
 * 保存できたら枠を少しのあいだ緑にし（呼び手は短い知らせも出す）、失敗したら元の値に戻す（理由は呼び手が出す）。
 * Esc で打ちかけの内容を捨てて元に戻す。
 */

/** 保存できたことを、枠の色で少しのあいだ知らせる */
function useSavedFlash(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const flash = () => {
    setOn(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), 1500);
  };
  return [on, flash];
}

const SAVED = '!border-[#2e7d4f] !bg-[#eef8f2]';

/** 値を保存する。失敗したら例外（呼び手が理由を知らせる）。 */
type Save<T> = (next: T) => Promise<void>;

function useCommit<T>(value: T, save: Save<T>) {
  const [saving, setSaving] = useState(false);
  const [saved, flash] = useSavedFlash();
  const commit = async (next: T, revert: () => void) => {
    if (next === value) return;
    setSaving(true);
    try {
      await save(next);
      flash();
    } catch {
      revert();
    } finally {
      setSaving(false);
    }
  };
  return { saving, saved, commit };
}

/** 日付（出荷日・納品日）。空にもできる */
export function EditDate({ value, onSave, label }: { value: string | null; onSave: Save<string | null>; label: string }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const { saving, saved, commit } = useCommit<string | null>(value ?? null, onSave);
  return (
    <input
      type="date"
      aria-label={label}
      value={v}
      disabled={saving}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== (value ?? '') && void commit(v || null, () => setV(value ?? ''))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(value ?? '');
      }}
      className={`inp !h-[26px] !px-1.5 !text-[12px] ${saved ? SAVED : ''}`}
    />
  );
}

/** 選択肢（納品時間）。選んだときに保存する */
export function EditSelect({
  value,
  options,
  onSave,
  label,
  emptyLabel = '指定なし',
}: {
  value: number | null;
  options: { id: number; name: string }[];
  onSave: Save<number | null>;
  label: string;
  emptyLabel?: string;
}) {
  const [v, setV] = useState(value === null ? '' : String(value));
  useEffect(() => setV(value === null ? '' : String(value)), [value]);
  const { saving, saved, commit } = useCommit<number | null>(value, onSave);
  return (
    <select
      aria-label={label}
      value={v}
      disabled={saving}
      onChange={(e) => {
        const next = e.target.value;
        setV(next);
        void commit(next === '' ? null : Number(next), () => setV(value === null ? '' : String(value)));
      }}
      className={`inp !h-[26px] !pl-1.5 !pr-6 !text-[12px] ${saved ? SAVED : ''}`}
    >
      <option value="">{emptyLabel}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
      {/* 使わないにした時間帯が入っている受注も、そのまま出す */}
      {value !== null && !options.some((o) => o.id === value) && <option value={value}>（今の値）</option>}
    </select>
  );
}

/** 1行の文字（明細の出荷依頼書適用・納品書適用） */
export function EditText({
  value,
  onSave,
  label,
  maxLength,
  placeholder,
}: {
  value: string | null;
  onSave: Save<string | null>;
  label: string;
  maxLength?: number;
  placeholder?: string;
}) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const { saving, saved, commit } = useCommit<string | null>(value ?? null, onSave);
  return (
    <input
      aria-label={label}
      value={v}
      maxLength={maxLength}
      placeholder={placeholder}
      title={v || undefined}
      disabled={saving}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== (value ?? '') && void commit(v.trim() === '' ? null : v.trim(), () => setV(value ?? ''))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(value ?? '');
      }}
      className={`inp !h-[26px] !px-1.5 !text-[12px] ${saved ? SAVED : ''}`}
    />
  );
}

/** 複数行の文字（出荷依頼書備考・納品書備考） */
export function EditArea({
  value,
  onSave,
  label,
  placeholder,
}: {
  value: string | null;
  onSave: Save<string | null>;
  label: string;
  placeholder?: string;
}) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const { saving, saved, commit } = useCommit<string | null>(value ?? null, onSave);
  return (
    <textarea
      aria-label={label}
      value={v}
      rows={2}
      placeholder={placeholder}
      disabled={saving}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== (value ?? '') && void commit(v.trim() === '' ? null : v.replace(/\s+$/, ''), () => setV(value ?? ''))}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setV(value ?? '');
      }}
      className={`inp !text-[12px] !py-1 !px-2 leading-[1.45] ${saved ? SAVED : ''}`}
    />
  );
}
