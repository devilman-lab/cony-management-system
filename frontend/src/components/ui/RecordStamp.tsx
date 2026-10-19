'use client';

import { useFetch } from '@/lib/hooks';
import { ymdhm } from '@/lib/format';

interface Stamp {
  created_at: string | null;
  created_by_name: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
}

/**
 * 編集画面の下に出す「登録日：YYYY/MM/DD hh:mm 名前　更新日：YYYY/MM/DD hh:mm 名前」
 * （2026-10-16 マスター編3 M3-01。楽楽販売の「作成：… 最終更新：…」と同じもの）。
 *
 * table はテーブル名（partners・sales_orders など。backend の record-stamps.controller.ts の表にあるもの）。
 * id が無い（新規登録・コピー）ときは何も出さない。読めなかったときも黙って出さない（編集の邪魔をしないため）。
 * reloadKey を変えると読み直す（保存して画面を開いたままのとき、更新日を新しくするため）。
 */
export function RecordStamp({ table, id, reloadKey, className }: { table: string; id: number | null | undefined; reloadKey?: unknown; className?: string }) {
  const { data } = useFetch<Stamp>(id ? `/record-stamps/${table}/${id}` : null, reloadKey === undefined ? undefined : { _: String(reloadKey) });
  if (!id || !data) return null;
  const who = (v: string | null) => (v ? `　${v}` : '');
  return (
    <div className={`mt-3 pt-1.5 border-t border-[var(--color-line)] text-[11px] text-[var(--color-ink-3)] num flex flex-wrap gap-x-6 gap-y-0.5 ${className ?? ''}`}>
      <span>登録日：{ymdhm(data.created_at)}{who(data.created_by_name)}</span>
      <span>更新日：{ymdhm(data.updated_at)}{who(data.updated_by_name)}</span>
    </div>
  );
}
