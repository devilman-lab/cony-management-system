'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounce, useList } from '@/lib/hooks';
import { Button, Card, type Column, DataTable, ErrorBox, Input, Modal, PageHead, Pager, Toolbar, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { RecordStamp } from '@/components/ui/RecordStamp';
import { ActiveToggle } from './Form';
import { MasterCsv } from './MasterCsv';
import { MasterGrid } from './MasterGrid';

/**
 * マスタ画面の共通部品。一覧＋検索＋「使わないものも表示」＋登録・編集モーダル＋コピー＋削除。
 *
 * 2026-10-16 マスター編3（M3-01・M3-02）からの決まり。各画面はこれらを自分で作らず、ここに任せる:
 *  - 一覧の操作は「編集」「コピー」「削除」。以前の「使わない」「有効に戻す」は一覧から外した。
 *  - 「使わない」は編集画面の「表示／非表示」で切り替える（is_active。表示＝有効）。編集のときだけ
 *    フォームの最後に出し、保存の本体（toBody の結果）に is_active を足して PATCH で送る。
 *    新規登録・コピーでは出さない（登録したものは「表示」）。出したくない画面は activeToggle={false}。
 *  - 「コピー」は、その行の内容（コードも）で「登録」の画面を開く。保存すると POST で新しく登録する
 *    （editing は null。renderForm・toBody には新規と同じく null が渡る）。
 *    写し方は toCopyForm(row) → フォームの値。省略時は toForm(row) の値をそのまま使う（フォームの id は外す）。
 *    **フォームの中に既存の子の行の id（商品の SKU など）を持つ画面は、toCopyForm で必ず外すこと。**
 *    外さないと afterSave などで元の行を書き換えてしまう。コピーを出さない画面は toCopyForm={null}。
 *  - 編集画面の下に「登録日：YYYY/MM/DD hh:mm 名前　更新日：…」を出す（新規・コピーでは出さない）。
 *    読むテーブルは stampTable（省略時は writePath の末尾。/masters/partner-products → partner_products）。
 *    backend の record-stamps.controller.ts の表に載っているテーブルだけ読める。出さないときは stampTable={null}。
 *
 * マスタは伝票から参照されるので、削除はどこからも使われていないものだけ（使われていれば理由を出して断る）。
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
  renderForm: (f: F, set: (patch: Partial<F>) => void, editing: T | null, active: ActiveSlot) => ReactNode;
  modalWidth?: number;
  /**
   * 一覧の「コピー」で開く登録画面の初期値（M3-02）。省略時は toForm(r) の値（id は外す）。
   * フォームに子の行の id を持つ画面は、ここで外すこと。null でコピーのボタンを出さない。
   */
  toCopyForm?: ((r: T) => F | Promise<F>) | null;
  /** 編集画面の「表示／非表示」（is_active）を出すか。既定は出す */
  activeToggle?: boolean;
  /** 「登録日・更新日」を読むテーブル名（省略時は writePath の末尾の - を _ にしたもの。null で出さない） */
  stampTable?: string | null;
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
  /** CSV 取り込み画面に足す案内（複数のコードの区切り方など） */
  csvHint?: ReactNode;
  onSaved?: (row: Record<string, unknown>, editing: T | null) => void;
  /**
   * 本体を保存したあと、続けて別の経路で保存するもの（商品の SKU など）。
   *
   * 商品の SKU は別の経路で保存するため、SKU に FBA用JAN などを入れて「更新する」を押すと
   * 商品だけが保存され、SKU の入力が黙って捨てられていた（2026-10-09 マスター編②「入れて保存しても消えてしまう」）。
   * 失敗したら画面を閉じずに理由を出す（本体は保存済みなので、新規なら編集の状態に切り替える）。
   */
  afterSave?: (row: Record<string, unknown>, form: F, set: (patch: Partial<F>) => void) => Promise<void>;
  /**
   * 一覧の表を画面の側で組むとき（商品の一覧のように、1件の下に子の行を rowSpan で並べる表。2026-10-18 M3-15）。
   * actions(r) は操作の列の中身（編集・コピー・削除）、actionWidth はその列の幅。省略時は columns で表を出す。
   * canAct が false（閲覧者など、操作のボタンが1つも無い人）のときは、操作の列を出さない（2026-10-19 受入 X2）。
   */
  renderTable?: (t: { rows: T[]; loading: boolean; actions: (r: T) => ReactNode; actionWidth?: number | string; canAct: boolean; isActive: (r: T) => boolean }) => ReactNode;
  /**
   * 1440 より狭い画面（1280 など）では、操作のボタン（編集・コピー・削除）を右端の列ではなく、指定した列（key）の
   * 中身の下に入れる（引当在庫・商品の一覧と同じ。2026-10-18 受入 W1 N1・W2 M3-30）。true なら最初の列。
   * ボタン3つが横に並ぶ幅（約 150px）のある列（名称など）を選ぶと、行が高くならない。
   * 列が多く、操作の列まで入れると 1280 の枠（約 1025px）に収まらない一覧で使う。ほかの一覧は今までどおり右端の列。
   */
  narrowActions?: boolean | string;
  /**
   * 編集画面の「表示／非表示」をページ側で置く（M3-12。取引先は「表示順」と同じ行に並べる）。
   * 指定すると、フォームの最後には出さず、renderForm の4番目の引数（ActiveSlot）を使ってページが置く。
   */
  placeActiveToggle?: boolean;
  /**
   * コピーで開いた登録画面の上に出す説明。省略時は「コードなどを直して…」。
   * コードの欄が無いマスタ（ロイヤリティ規定）は、そのマスタに合った説明を渡す（2026-10-19 受入 X1）。
   */
  copyNote?: ReactNode;
}

/**
 * 編集画面の「表示／非表示」をページ側で置くときに renderForm に渡すもの（placeActiveToggle）。
 * show は「表示／非表示」を出す場面か（編集のときだけ true。新規・コピーでは false）。
 */
export interface ActiveSlot {
  show: boolean;
  value: boolean;
  onChange: (v: boolean) => void;
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
  // コピーで開いた登録画面か（見出しを「登録（コピー）」にするだけ。保存は新規と同じ）
  const [copying, setCopying] = useState(false);
  // 編集画面の「表示／非表示」（M3-02）。表示＝有効
  const [active, setActive] = useState(true);
  // 1440 より狭い画面か（narrowActions の一覧だけが使う）
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!p.narrowActions) return;
    const mq = window.matchMedia('(max-width: 1439px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [p.narrowActions]);

  const isActive = p.isActive ?? ((r: T) => r.is_active !== false);
  const showToggle = p.activeToggle !== false;
  const stampTable = p.stampTable === undefined ? (p.writePath.split('/').pop() ?? '').replace(/-/g, '_') : p.stampTable;

  const setFormPatch = (patch: Partial<F>) => setForm((s) => (s ? { ...s, ...patch } : s));
  const openNew = () => {
    setEditing(null);
    setCopying(false);
    setForm(p.empty());
    setActive(true);
    setError(null);
    setOpen(true);
  };
  const openEdit = async (r: T) => {
    setEditing(r);
    setCopying(false);
    setActive(isActive(r));
    setError(null);
    setForm(null);
    setOpen(true);
    try {
      setForm(await p.toForm(r));
    } catch (e) {
      setError(e);
    }
  };
  /** コピー。その行の内容（コードも）で登録の画面を開く（M3-02） */
  const openCopy = async (r: T) => {
    setEditing(null);
    setCopying(true);
    setActive(true);
    setError(null);
    setForm(null);
    setOpen(true);
    try {
      if (p.toCopyForm) {
        setForm(await p.toCopyForm(r));
      } else {
        const f = (await p.toForm(r)) as F & { id?: unknown };
        if (f && typeof f === 'object' && 'id' in f) {
          const { id: _omit, ...rest } = f;
          void _omit;
          setForm(rest as F);
        } else {
          setForm(f);
        }
      }
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
      // 「表示／非表示」は編集のときだけ送る（新規は API の既定で「表示」）
      if (editing && showToggle) body.is_active = active;
      const row = editing
        ? await api.patch<Record<string, unknown>>(`${p.writePath}/${p.rowKey(editing)}`, body)
        : await api.post<Record<string, unknown>>(p.writePath, body);
      if (p.afterSave) {
        try {
          await p.afterSave(row, form, setFormPatch);
        } catch (e) {
          // 本体は保存できている。新規だった場合にもう一度「登録する」で二重に登録しないよう、編集の状態にする
          if (!editing) setEditing(row as T);
          setError(e);
          toast(editing ? '更新しましたが、続きの保存に失敗しました' : '登録しましたが、続きの保存に失敗しました', 'bad');
          await list.reload();
          return;
        }
      }
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
          伝票などで使われているものは消せません。その場合は「編集」で「非表示」にしてください。
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
  // 操作のボタンは列の幅で折り返す（編集・コピー／削除 の2段）。横一列に並べて列を広げると、
  // 画面幅 1440 でも右の列が画面の外に出てしまうため（2026-10-09 顧客「見切れているので全部出るように」）。
  // 「使わない」は一覧から外し、編集画面の「表示／非表示」にした（2026-10-16 マスター編3 M3-02）
  const buttons = 1 + (p.toCopyForm !== null ? 1 : 0) + (p.deletePath !== null ? 1 : 0);
  const actionCol: Column<T> = {
    key: '_act',
    label: '',
    width: buttons >= 3 ? 122 : buttons === 2 ? 92 : 56,
    render: (r) => (
      <span className="tbl-acts justify-end">
        {can(p.functionId, 'update') && <Button size="sm" onClick={() => openEdit(r)}>編集</Button>}
        {p.toCopyForm !== null && can(p.functionId, 'create') && <Button size="sm" onClick={() => openCopy(r)}>コピー</Button>}
        {p.deletePath !== null && can(p.functionId, 'delete') && <Button size="sm" variant="danger" onClick={() => remove(r)}>削除</Button>}
      </span>
    ),
  };

  // 狭い画面で操作のボタンを指定の列の下に入れる（narrowActions）。閲覧者などボタンが1つも無い人には何も足さない。
  // 右端の操作の列も、ボタンが1つも無い人には出さない（空の列が残っていた。2026-10-19 受入 X2）
  const canAct = can(p.functionId, 'update') || (p.toCopyForm !== null && can(p.functionId, 'create')) || (p.deletePath !== null && can(p.functionId, 'delete'));
  const host = typeof p.narrowActions === 'string' ? p.columns.find((c) => c.key === p.narrowActions) : p.columns[0];
  const tableColumns: Column<T>[] =
    p.narrowActions && narrow && host
      ? p.columns.map((c) =>
          c !== host
            ? c
            : {
                ...c,
                render: (r: T, i: number) => (
                  <>
                    {c.render ? c.render(r, i) : ((r[c.key] as ReactNode) ?? '')}
                    {canAct && <div className="mt-1.5 [&_.tbl-acts]:justify-start">{actionCol.render?.(r, i)}</div>}
                  </>
                ),
              },
        )
      : canAct
        ? [...p.columns, actionCol]
        : p.columns;
  const slot: ActiveSlot = { show: !!(editing && showToggle), value: active, onChange: setActive };

  return (
    <div className="page-body">
      {element}
      <PageHead
        title={p.title}
        sub={p.sub}
        right={
          <>
            {p.headRight}
            {/* 一覧で編集は直す人だけに出す。閲覧者には出さない（押すと権限エラーになっていた。2026-10-12 受入 No.2） */}
            {p.csvSlug && can(p.functionId, 'update') && (
              <Button icon={gridMode ? 'list' : 'edit'} onClick={() => setGridMode((v) => !v)}>
                {gridMode ? '通常の一覧に戻す' : '一覧で編集'}
              </Button>
            )}
            {p.csvSlug && (
              <MasterCsv
                slug={p.csvSlug}
                functionId={p.functionId}
                includeInactive={inactive}
                hint={p.csvHint}
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
        {gridMode && p.csvSlug && can(p.functionId, 'update') ? (
          <MasterGrid slug={p.csvSlug} canEdit={can(p.functionId, 'update')} />
        ) : (
        <>
        <Toolbar right={<label className="flex items-center gap-1 text-[12px]"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} />使わないものも表示</label>}>
          {!p.noSearch && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="コード・名前で検索" className="!w-[240px]" />}
          {p.toolbar}
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        {/* 文字の列は「…」で切らずに折り返して全文を出す */}
        {p.renderTable ? (
          p.renderTable({ rows: list.items, loading: list.loading, actions: (r) => actionCol.render?.(r, 0), actionWidth: actionCol.width, canAct, isActive })
        ) : (
        <DataTable<T>
          fit
          columns={tableColumns}
          rows={list.items}
          rowKey={p.rowKey}
          loading={list.loading}
          rowClassName={(r) => (isActive(r) ? '' : 'opacity-50')}
        />
        )}
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
        </>
        )}
      </Card>

      <Modal open={open} title={editing ? `${p.title}の編集` : copying ? `${p.title}の登録（コピー）` : `${p.title}の登録`} onClose={() => setOpen(false)} width={p.modalWidth ?? 640} footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} disabled={!form} onClick={save}>{editing ? '更新する' : '登録する'}</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        {copying && !editing && (
          <div className="mb-2 text-[11.5px] text-[var(--color-ink-2)]">{p.copyNote ?? '選んだ行の内容を写しました。コードなどを直して「登録する」を押すと、新しく登録します（元のデータはそのままです）。'}</div>
        )}
        {form ? p.renderForm(form, setFormPatch, editing, slot) :<div className="py-6 text-center text-[12px] text-[var(--color-ink-3)]">読み込み中…</div>}
        {/* 表示／非表示（M3-02）。編集のときだけフォームの最後に出す */}
        {form && editing && showToggle && !p.placeActiveToggle && <ActiveToggle value={active} onChange={setActive} />}
        {/* 登録日・更新日（M3-01）。新規・コピーでは出さない */}
        {editing && stampTable ? <RecordStamp table={stampTable} id={p.rowKey(editing)} /> : null}
      </Modal>
    </div>
  );
}

/** 数値入力を送信用に整える。空欄は null。 */
export const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));
export const strOrNull = (v: string | null | undefined) => (v && v.trim() !== '' ? v.trim() : null);
export const decOrNull = (v: string | null | undefined) => (v && v.trim() !== '' ? v.trim() : null);
