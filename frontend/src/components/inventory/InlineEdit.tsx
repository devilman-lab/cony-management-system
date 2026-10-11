'use client';

import { useEffect, useState } from 'react';

import { Input } from '@/components/ui';

/**
 * 一覧の中でそのまま直す入力欄（在庫表の備考・在庫調整の調整日／備考。2026-10-09 在庫編 Z-05・Z-23）。
 *
 * 保存ボタンを置かず、欄から離れたとき（または Enter）に変わっていれば保存する。
 * 一覧の行ごとに保存ボタンがあると、押し忘れて別の行へ進み、直したつもりで消える。
 * 保存に失敗したら元の値に戻す（画面の値と保存された値が食い違ったままにしない）。Esc でも元に戻す。
 */
export function InlineText({
  value,
  onSave,
  type = 'text',
  placeholder,
  className = '',
  disabled,
}: {
  value: string | null;
  /** 失敗したら例外を投げる。呼び出し側でトーストを出す。 */
  onSave: (next: string) => Promise<void>;
  type?: 'text' | 'date';
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [v, setV] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => setV(value ?? ''), [value]);

  const commit = async () => {
    if (v === (value ?? '')) return;
    // 日付は空にできない（調整日は必須）。空にしたら元に戻すだけにする
    if (type === 'date' && v === '') return setV(value ?? '');
    setSaving(true);
    try {
      await onSave(v);
    } catch {
      setV(value ?? '');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Input
      type={type}
      value={v}
      placeholder={placeholder}
      // 欄の幅より長い備考も、マウスを乗せれば全文が読めるように
      title={type === 'text' && v ? v : undefined}
      disabled={disabled || saving}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(value ?? '');
      }}
      // 行をクリックすると何かが開く一覧でも、欄を押しただけで開かないように
      onClick={(e) => e.stopPropagation()}
      className={`!h-[26px] ${className}`}
    />
  );
}
