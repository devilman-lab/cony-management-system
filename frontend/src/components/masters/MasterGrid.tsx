'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { useDebounce } from '@/lib/hooks';
import { Button, ErrorBox, Input, Pager, Toolbar } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

interface GridColumn {
  field: string;
  label: string;
  kind: 'text' | 'number' | 'decimal' | 'bool' | 'date' | 'digits';
  ref: string | null;
  read_only: boolean;
}

interface GridData {
  label: string;
  key_fields: string[];
  columns: GridColumn[];
  items: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

interface ImportRow {
  line: number;
  key: string;
  action: string;
  changes: string[];
  message?: string;
}

/** 欄の幅。種類ごとに決める。 */
const widthOf = (c: GridColumn): number => {
  if (c.kind === 'bool') return 70;
  if (c.kind === 'number') return 90;
  if (c.kind === 'decimal') return 110;
  if (c.kind === 'date') return 130;
  if (c.ref) return 150;
  return c.label.length > 8 ? 190 : 150;
};

const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;

/**
 * 一覧の中で直接編集する（2026-10-01 ご要望
 * 「一覧に全ての項目を表示し、一覧内で編集ができるようにしてほしい」）。
 *
 * 欄の定義も保存の道も **CSV取込と同じもの**を使っています。
 * そのため、ここで直せるものは CSV でも直せ、検査の仕方も同じになります。
 * 相手のマスタ（ブランドなど）はコードで持ちます。
 */
export function MasterGrid({ slug, canEdit }: { slug: string; canEdit: boolean }) {
  const toast = useToast();
  const [data, setData] = useState<GridData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 300);
  const [inactive, setInactive] = useState(false);
  const [offset, setOffset] = useState(0);
  /** 直した値。行のid → {欄: 値} */
  const [edits, setEdits] = useState<Record<number, Record<string, unknown>>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get<GridData>(`/masters/csv/${slug}/rows`, {
        q: dq || undefined,
        include_inactive: inactive ? 'true' : undefined,
        limit: 50,
        offset,
      });
      setData(r);
      setEdits({});
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [slug, dq, inactive, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const changedIds = useMemo(() => Object.keys(edits).map(Number), [edits]);

  const valueOf = (row: Record<string, unknown>, field: string): unknown => {
    const e = edits[Number(row.id)];
    return e && field in e ? e[field] : row[field];
  };
  const setCell = (row: Record<string, unknown>, field: string, v: unknown) => {
    const id = Number(row.id);
    setEdits((prev) => {
      const next = { ...(prev[id] ?? {}) };
      // 元に戻したら「直していない」に戻す
      if (String(v) === String(row[field] ?? '')) delete next[field];
      else next[field] = v;
      const out = { ...prev };
      if (Object.keys(next).length === 0) delete out[id];
      else out[id] = next;
      return out;
    });
  };

  /**
   * 保存。直した行だけを CSV の形にして、取り込みと同じ経路へ送る。
   * 検査・コードの引き直し・権限・操作履歴が CSV取込とまったく同じになる。
   */
  const save = async () => {
    if (!data || changedIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // 鍵の欄＋直した欄だけを送る。載せていない欄には触らない決まりなので、これで足りる
      const touched = new Set<string>(data.key_fields);
      for (const id of changedIds) for (const k of Object.keys(edits[id])) touched.add(k);
      const cols = data.columns.filter((c) => touched.has(c.field));

      const lines = [cols.map((c) => esc(c.label)).join(',')];
      for (const id of changedIds) {
        const row = data.items.find((r) => Number(r.id) === id);
        if (!row) continue;
        lines.push(
          cols
            .map((c) => {
              const v = valueOf(row, c.field);
              if (c.kind === 'bool') return esc(v ? '有効' : '無効');
              return esc(v === null || v === undefined ? '' : String(v));
            })
            .join(','),
        );
      }
      const csv = '﻿' + lines.join('\r\n') + '\r\n';
      const body = { content_base64: btoa(unescape(encodeURIComponent(csv))), dry_run: false };
      const r = await api.post<{ updated: number; added: number; rows: ImportRow[] }>(
        `/masters/csv/${slug}/import`,
        body,
      );
      toast(`${r.updated}件を保存しました`, 'good');
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <div className="p-4 text-[12px] text-[var(--color-ink-3)]">読み込み中…</div>;
  if (!data) return <ErrorBox error={error} />;

  return (
    <div className="flex flex-col gap-2">
      <Toolbar
        right={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-[12px]">
              <input type="checkbox" checked={inactive} onChange={(e) => { setInactive(e.target.checked); setOffset(0); }} />
              使わないものも表示
            </label>
            {canEdit && (
              <Button variant="primary" loading={busy} disabled={changedIds.length === 0} onClick={save}>
                {changedIds.length > 0 ? `${changedIds.length}件を保存` : '保存'}
              </Button>
            )}
            {changedIds.length > 0 && <Button onClick={() => setEdits({})}>直したものを取り消す</Button>}
          </div>
        }
      >
        <Input value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} placeholder="コード・名前で検索" className="!w-[240px]" />
        <span className="text-[11.5px] text-[var(--color-ink-3)]">
          {data.columns.length} 項目すべてを表示しています。横にスクロールします
        </span>
      </Toolbar>

      {error ? <div className="px-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}

      <div className="overflow-auto max-h-[62vh] border-t border-[var(--color-line)]">
        <table className="text-[12px]" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr>
              {data.columns.map((c) => (
                <th
                  key={c.field}
                  className="sticky top-0 z-10 bg-[#f4f7f8] text-left px-2 py-1.5 border-b border-r border-[var(--color-line)] whitespace-nowrap"
                  style={{ minWidth: widthOf(c) }}
                  title={c.ref ? `${c.ref}マスタのコードを入れます` : undefined}
                >
                  {c.label}
                  {c.read_only && <span className="text-[10px] text-[var(--color-ink-3)]">（鍵）</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 && (
              <tr>
                <td colSpan={data.columns.length} className="text-center py-6 text-[var(--color-ink-3)]">
                  ありません
                </td>
              </tr>
            )}
            {data.items.map((row) => {
              const id = Number(row.id);
              const dirty = Boolean(edits[id]);
              return (
                <tr key={id} className={dirty ? 'bg-[var(--color-brand-50)]' : ''}>
                  {data.columns.map((c) => {
                    const v = valueOf(row, c.field);
                    const locked = c.read_only || !canEdit;
                    return (
                      <td key={c.field} className="px-1 py-0.5 border-b border-r border-[var(--color-line)]">
                        {c.kind === 'bool' ? (
                          <input
                            type="checkbox"
                            checked={Boolean(v)}
                            disabled={locked}
                            onChange={(e) => setCell(row, c.field, e.target.checked)}
                          />
                        ) : (
                          <Input
                            value={v === null || v === undefined ? '' : String(v)}
                            disabled={locked}
                            right={c.kind === 'number' || c.kind === 'decimal'}
                            type={c.kind === 'date' ? 'date' : 'text'}
                            onChange={(e) => setCell(row, c.field, e.target.value)}
                            className="!h-[26px] !text-[12px]"
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pager total={data.total} limit={data.limit} offset={data.offset} onChange={setOffset} />
      {changedIds.length > 0 && (
        <div className="px-3 pb-2 text-[11.5px] text-[var(--color-ink-3)]">
          {changedIds.length} 行を直しています。「保存」を押すまでデータは変わりません。
          読めない値が1つでもあれば、1件も保存せずに理由をお知らせします。
        </div>
      )}
    </div>
  );
}
