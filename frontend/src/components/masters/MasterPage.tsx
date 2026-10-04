'use client';

import { useState, type ReactNode } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounce, useList } from '@/lib/hooks';
import { Button, Card, type Column, DataTable, ErrorBox, Input, Modal, PageHead, Pager, Toolbar, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { MasterCsv } from './MasterCsv';
import { MasterGrid } from './MasterGrid';

/**
 * マスタ画面の共通部品。一覧＋検索＋「無効も表示」＋登録・編集モーダル＋無効化。
 * マスタは物理削除しないため、削除の代わりに「使わない（無効）」にする。
 */
export interface MasterPageProps<T extends Record<string, unknown>, F> {
  title: string;
  sub?: string;
  functionId: string;
  /** 一覧 GET のパス。items/total を返すもの */
  listPath: string;
  /** 登録 POST / 更新 PATCH の基底パス（例 /masters/partners） */
  writePath: string;
  extraFilters?: Record<string, string | number | boolean | undefined | null>;
  columns: Column<T>[];
  rowKey: (r: T) => number;
  /** 新規のフォーム初期値 */
  empty: () => F;
  /** 一覧行 → フォーム。詳細 GET が必要なら loadDetail を使う */
  toForm: (r: T) => F | Promise<F>;
  /** フォーム → 送信ボディ */
  toBody: (f: F, editing: T | null) => Record<string, unknown>;
  /** フォームの見た目 */
  renderForm: (f: F, set: (patch: Partial<F>) => void, editing: T | null) => ReactNode;
  modalWidth?: number;
  /** 無効化 POST のパス（省略時は writePath/:id/deactivate。null で機能なし） */
  deactivatePath?: ((r: T) => string) | null;
  /** 削除 DELETE のパス（省略時は writePath/:id。null で機能なし） */
  deletePath?: ((r: T) => string) | null;
  /** 削除の確認で出す名前。「○○を完全に消します」の○○。 */
  rowLabel?: (r: T) => string;
  isActive?: (r: T) => boolean;
  headRight?: ReactNode;
  toolbar?: ReactNode;
  limit?: number;
  /** 一覧の並び順など、検索欄を隠す場合 */
  noSearch?: boolean;
  /**
   * CSV の書き出し・取り込みに使う名前（backend の masters-csv.ts の slug）。
   * 指定すると見出しの右にボタンが出る（1001 のご要望）。
   */
  csvSlug?: string;
  onSaved?: (row: Record<string, unknown>, editing: T | null) => void;
}

export function MasterPage<T extends Record<string, unknown>, F>(p: MasterPageProps<T, F>) {
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 300);
  const [inactive, setInactive] = useState(false);
  // 一覧の中で直接編集するか（1001 ご要望）。csvSlug がある画面だけ使える
  const [gridMode, setGridMode] = useState(false);
  const list = useList<T>(p.listPath, { q: dq || undefined, include_inactive: inactive ? 'true' : undefined, ...(p.extraFilters ?? {}) }, p.limit ?? 50);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);
  const [form, setForm] = useState<F | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const openNew = () => {
    setEditing(null);
    setForm(p.empty());
    setError(null);
    setOpen(true);
  };
  const openEdit = async (r: T) => {
    setEditing(r);
    setError(null);
    setForm(null);
    setOpen(true);
    try {
      setForm(await p.toForm(r));
    } catch (e) {
      setError(e);
    }
  };
  const save = async () => {
    if (!form) return;
    setError(null);
    setBusy(true);
    try {
      const body = p.toBody(form, editing);
      const row = editing
        ? await api.patch<Record<string, unknown>>(`${p.writePath}/${p.rowKey(editing)}`, body)
        : await api.post<Record<string, unknown>>(p.writePath, body);
      toast(editing ? '更新しました' : '登録しました', 'good');
      setOpen(false);
      p.onSaved?.(row, editing);
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const deactivate = async (r: T) => {
    if (!(await confirm('このデータを「使わない」にしますか', '一覧から外れますが、過去の伝票からは引き続き参照できます。'))) return;
    try {
      const path = p.deactivatePath ? p.deactivatePath(r) : `${p.writePath}/${p.rowKey(r)}/deactivate`;
      await api.post(path);
      toast('無効にしました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    }
  };
  /**
   * 一覧から消す。
   *
   * サーバー側は、どこからも使われていないものだけ消す。使われているものは
   * 409 で断られるので、その文言をそのまま出して「使わない」に誘導する
   * （1001 のご要望「入力後に、一覧から削除ができるようにしてほしい」）。
   */
  const remove = async (r: T) => {
    const label = p.rowLabel ? p.rowLabel(r) : '';
    if (
      !(await confirm(
        'このデータを削除しますか',
        <>
          {label ? <b>{label}</b> : null}
          {label ? 'を' : 'このデータを'}完全に消します。元に戻せません。
          <br />
          伝票などで使われているものは消せません。その場合は「使わない」をお使いください。
        </>,
        true,
      ))
    ) {
      return;
    }
    try {
      const path = p.deletePath ? p.deletePath(r) : `${p.writePath}/${p.rowKey(r)}`;
      await api.delete(path);
      toast('削除しました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    }
  };
  const reactivate = async (r: T) => {
    try {
      await api.patch(`${p.writePath}/${p.rowKey(r)}`, { is_active: true });
      toast('有効に戻しました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    }
  };

  const isActive = p.isActive ?? ((r: T) => r.is_active !== false);
  const actionCol: Column<T> = {
    key: '_act',
    label: '',
    width: p.deactivatePath === null ? 70 : 200,
    render: (r) => (
      <span className="flex gap-1 justify-end">
        {can(p.functionId, 'update') && <Button size="sm" onClick={() => openEdit(r)}>編集</Button>}
        {p.deactivatePath !== null && can(p.functionId, 'delete') && isActive(r) && <Button size="sm" variant="danger" onClick={() => deactivate(r)}>使わない</Button>}
        {p.deactivatePath !== null && can(p.functionId, 'update') && !isActive(r) && <Button size="sm" onClick={() => reactivate(r)}>有効に戻す</Button>}
        {p.deletePath !== null && can(p.functionId, 'delete') && <Button size="sm" variant="danger" onClick={() => remove(r)}>削除</Button>}
      </span>
    ),
  };

  return (
    <div className="page-body">
      {element}
      <PageHead
        title={p.title}
        sub={p.sub}
        right={
          <>
            {p.headRight}
            {p.csvSlug && (
              <Button icon={gridMode ? 'list' : 'edit'} onClick={() => setGridMode((v) => !v)}>
                {gridMode ? '通常の一覧に戻す' : '一覧で編集'}
              </Button>
            )}
            {p.csvSlug && (
              <MasterCsv
                slug={p.csvSlug}
                functionId={p.functionId}
                includeInactive={inactive}
                onImported={() => list.reload()}
              />
            )}
            {can(p.functionId, 'create') && <Button variant="primary" icon="plus" onClick={openNew}>新規登録</Button>}
          </>
        }
      />
      <Card>
        {/*
          一覧で編集するときは、CSV と同じ欄をそのまま並べて直接打てるようにする
          （1001 ご要望「一覧に全ての項目を表示し、一覧内で編集ができるようにしてほしい」）。
          保存は CSV取込と同じ経路を通るので、検査のしかたも同じになる。
        */}
        {gridMode && p.csvSlug ? (
          <MasterGrid slug={p.csvSlug} canEdit={can(p.functionId, 'update')} />
        ) : (
        <>
        <Toolbar right={<label className="flex items-center gap-1 text-[12px]"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} />使わないものも表示</label>}>
          {!p.noSearch && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="コード・名前で検索" className="!w-[240px]" />}
          {p.toolbar}
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<T>
          columns={[...p.columns, actionCol]}
          rows={list.items}
          rowKey={p.rowKey}
          loading={list.loading}
          rowClassName={(r) => (isActive(r) ? '' : 'opacity-50')}
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
        </>
        )}
      </Card>

      <Modal open={open} title={editing ? `${p.title}の編集` : `${p.title}の登録`} onClose={() => setOpen(false)} width={p.modalWidth ?? 640} footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} disabled={!form} onClick={save}>{editing ? '更新する' : '登録する'}</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        {form ? p.renderForm(form, (patch) => setForm((s) => (s ? { ...s, ...patch } : s)), editing) : <div className="py-6 text-center text-[12px] text-[var(--color-ink-3)]">読み込み中…</div>}
      </Modal>
    </div>
  );
}

/** 数値入力を送信用に整える。空欄は null。 */
export const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));
export const strOrNull = (v: string | null | undefined) => (v && v.trim() !== '' ? v.trim() : null);
export const decOrNull = (v: string | null | undefined) => (v && v.trim() !== '' ? v.trim() : null);
