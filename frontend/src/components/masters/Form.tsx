'use client';

import { type ReactNode } from 'react';

import { api } from '@/lib/api';
import { Button, Input } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

/** マスタ登録フォームの1行。ラベル＋入力欄（複数可）。 */
export function L({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: ReactNode }) {
  return (
    <div className="form-row">
      <div className="form-row-label field-label h-full flex flex-col justify-center px-3 py-1.5">
        <span>{label}{required && <span className="text-[var(--color-crit-500)] text-[10px] ml-1">必須</span>}</span>
        {hint && <span className="text-[10px] font-normal text-[var(--color-ink-3)] leading-tight">{hint}</span>}
      </div>
      <div className="px-3 py-1.5 flex flex-wrap items-center gap-1.5 min-w-0">{children}</div>
    </div>
  );
}

export function Section({ title }: { title: string }) {
  return <div className="text-[11px] font-bold text-[var(--color-brand-700)] border-b border-[var(--color-line)] pb-1 mt-1">{title}</div>;
}

/** 郵便番号の入力＋「住所を引く」。7桁を入れると都道府県〜町域を住所1に入れる。 */
export function PostalLookup({ value, onChange, onAddress }: { value: string; onChange: (v: string) => void; onAddress: (address: string) => void }) {
  const toast = useToast();
  const lookup = async () => {
    const code = value.replace(/[^0-9]/g, '');
    if (code.length !== 7) return toast('郵便番号は7桁で入力してください', 'bad');
    try {
      const rows = await api.get<{ prefecture: string; city: string; town: string }[]>(`/postal-codes/${code}`);
      if (rows.length === 0) return toast('該当する住所がありません', 'info');
      const a = rows[0];
      onAddress(`${a.prefecture}${a.city}${a.town}`);
      if (rows.length > 1) toast(`同じ郵便番号に ${rows.length} 件の町域があります。住所を確かめてください`, 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : '住所を引けませんでした', 'bad');
    }
  };
  return (
    <>
      <Input value={value} onChange={(e) => onChange(e.target.value)} className="!w-[120px]" placeholder="1000001" />
      <Button size="sm" onClick={lookup}>住所を引く</Button>
    </>
  );
}

/** チェックボックス1つ。 */
export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-1 text-[12px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
