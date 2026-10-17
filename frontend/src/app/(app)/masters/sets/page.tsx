'use client';

import { useState, type ReactNode } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounce, useList } from '@/lib/hooks';
import { qty } from '@/lib/format';
import { Badge, Button, Card, DataTable, ErrorBox, Input, Modal, Num, PageHead, Pager, Textarea, Toolbar, useConfirm } from '@/components/ui';
import { SearchSelect, fetchSetSkus, fetchSkusFor, type Option } from '@/components/ui/SearchSelect';

// 構成品の候補は単品の SKU だけ（セット商品は構成品にできない。3回目の全面テスト）
const fetchComponentSkus = fetchSkusFor(null, { isSet: false });
import { useToast } from '@/components/ui/Toast';
import { L, Section } from '@/components/masters/Form';
import { MasterCsv } from '@/components/masters/MasterCsv';

interface SetRow extends Record<string, unknown> {
  id: number;
  sku_id: number;
  sku_code: string;
  /** SKU の商品名があればそれ、無ければ商品名 */
  product_name: string;
  /** 一覧に出す商品名（商品名　カラー　サイズ） */
  display_name: string;
  color_name: string | null;
  size_name: string | null;
  product_class_name: string | null;
  is_active: boolean;
  component_count: number;
}
interface SetDetail {
  id: number;
  sku_id: number;
  sku_code: string | null;
  product_name: string | null;
  color_name: string | null;
  size_name: string | null;
  note: string | null;
  components: { id: number; component_sku_id: number; sku_code: string; product_name: string; color_name: string | null; size_name: string | null; qty: string }[];
}
interface Line {
  sku: Option | null;
  qty: string;
}

/** 候補と同じ見え方（SKU　商品名 カラー サイズ）。選び直さなくても何が入っているか分かるように */
const skuLabel = (c: { sku_code: string | null; product_name: string | null; color_name: string | null; size_name: string | null }) =>
  `${c.sku_code ?? ''}　${c.product_name ?? ''}${c.color_name ? ' ' + c.color_name : ''}${c.size_name ? ' ' + c.size_name : ''}`;
/** 一覧の欄は折り返して全部見せる（2026-10-09 マスター編②「見切れているので全部出るように」） */
const Wrap = ({ children }: { children: ReactNode }) => <span className="whitespace-normal break-words">{children}</span>;
/**
 * 選んだ SKU の全文（SKU　商品名 カラー サイズ）を欄の下に折り返して出す（No.23・M-16）。
 * 選択欄は1行で、長い名前だと末尾のサイズが「…」で隠れていた。短い名前は欄の中で読めるので出さない。
 */
const LONG_LABEL = 30;
const FullLabel = ({ o }: { o: Option | null }) =>
  o && o.label.length > LONG_LABEL ? (
    <div className="mt-0.5 text-[11.5px] leading-[1.4] text-[var(--color-ink-2)] whitespace-normal break-all">{o.label}</div>
  ) : null;

/** セット登録（M-10）。セット SKU と、その構成品（内訳）。出荷時は構成品の在庫から引く。 */
export default function SetsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [listError, setListError] = useState<unknown>(null);
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 300);
  const list = useList<SetRow>('/masters/sets', { q: dq || undefined }, 50);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [setSku, setSetSku] = useState<Option | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const openNew = () => {
    setEditingId(null);
    setSetSku(null);
    setLines([{ sku: null, qty: '1' }, { sku: null, qty: '1' }]);
    setNote('');
    setError(null);
    setOpen(true);
  };
  const openEdit = async (r: SetRow) => {
    setError(null);
    setOpen(true);
    setEditingId(r.id);
    try {
      const d = await api.get<SetDetail>(`/masters/sets/${r.id}`);
      // セット SKU も候補と同じ見え方（SKU　商品名 カラー サイズ）にする（2026-10-09 マスター編②）
      setSetSku({ id: d.sku_id, label: d.sku_code ? skuLabel(d) : `${r.sku_code}　${r.display_name}` });
      // 構成品は新規で選んだときと同じ見え方（品番　商品名 カラー サイズ）にする
      setLines(d.components.map((c) => ({ sku: { id: c.component_sku_id, label: skuLabel(c) }, qty: c.qty })));
      setNote(d.note ?? '');
    } catch (e) {
      setError(e);
    }
  };
  /**
   * コピー。構成品と数量・備考を写した新規登録を開き、セット SKU だけを選び直してもらう
   * （2026-10-09 マスター編②。色・サイズ違いのセットを、同じ構成で続けて登録するため）。
   */
  const openCopy = async (r: SetRow) => {
    setError(null);
    setEditingId(null);
    setSetSku(null);
    setLines([]);
    setNote('');
    setOpen(true);
    try {
      const d = await api.get<SetDetail>(`/masters/sets/${r.id}`);
      setLines(d.components.map((c) => ({ sku: { id: c.component_sku_id, label: skuLabel(c) }, qty: c.qty })));
      setNote(d.note ?? '');
    } catch (e) {
      setError(e);
    }
  };
  /**
   * 削除。構成ごと消す。セット SKU が受注などで使われていればサーバーが理由を付けて断るので、
   * その文言を一覧の上にそのまま出す（トーストだと長い理由が読み切れずに消えるため）。
   */
  const remove = async (r: SetRow) => {
    setListError(null);
    if (
      !(await confirm(
        'このセットを削除しますか',
        <>
          <b>{r.sku_code}　{r.display_name}</b> のセット登録を構成品ごと消します。元に戻せません。
          <br />
          セット SKU（商品マスタ）は残ります。受注などで使われているセットは消せません。
        </>,
        true,
      ))
    ) {
      return;
    }
    try {
      await api.delete(`/masters/sets/${r.id}`);
      toast('セットを削除しました', 'good');
      await list.reload();
    } catch (e) {
      setListError(e);
    }
  };
  /**
   * 保存。編集は構成の入れ替え（PUT）、新規・コピーは新しく作るだけ（POST）。
   * 新規・コピーで登録済みのセット SKU を送ると、サーバーが 409 で断る（M-14。以前は黙って上書きしていた）。
   */
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const body = {
        components: lines.filter((l) => l.sku).map((l, i) => ({ component_sku_id: l.sku!.id, qty: l.qty, sort_order: i + 1 })),
        note: note || null,
      };
      if (editingId) await api.put(`/masters/sets/${editingId}`, body);
      else await api.post('/masters/sets', { sku_id: setSku?.id, ...body });
      toast(editingId ? 'セットを更新しました' : 'セットを登録しました', 'good');
      setOpen(false);
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-body">
      {element}
      <PageHead title="セット登録" sub="セット商品の SKU と、その内訳（構成品と数量）。出荷すると構成品の在庫が減ります。内訳を直すときは一覧の「編集」から" right={<>{/* CSV 書き出しだけ（構成品ごとに1行。2026-10-12 受入 No.3） */}<MasterCsv slug="sets" functionId="M-10" exportOnly includeInactive />{can('M-10', 'create') && <Button variant="primary" icon="plus" onClick={openNew}>新規登録</Button>}</>} />
      <Card>
        <Toolbar><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU・商品名で検索" className="!w-[240px]" /></Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        {listError ? <div className="p-3"><ErrorBox error={listError} onClose={() => setListError(null)} /></div> : null}
        <DataTable<SetRow>
          columns={[
            { key: 'sku_code', label: 'セット SKU', width: 160, render: (r) => <Num className="font-semibold">{r.sku_code}</Num> },
            // 商品名は「商品名（SKU の商品名があればそれ）　カラー　サイズ」（2026-10-09 マスター編②）
            { key: 'display_name', label: '商品名', render: (r) => <Wrap>{r.display_name}</Wrap> },
            { key: 'product_class_name', label: '商品分類', width: 170, render: (r) => <Wrap>{r.product_class_name ?? ''}</Wrap> },
            { key: 'color_name', label: 'カラー', width: 120, render: (r) => <Wrap>{r.color_name ?? ''}</Wrap> },
            { key: 'size_name', label: 'サイズ', width: 80, render: (r) => <Wrap>{r.size_name ?? ''}</Wrap> },
            { key: 'component_count', label: '構成品', r: true, width: 70, render: (r) => `${r.component_count} 点` },
            { key: 'is_active', label: '', width: 50, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
            {
              key: '_act',
              label: '',
              width: 190,
              render: (r) => (
                <span className="flex gap-1 justify-end">
                  {can('M-10', 'update') && <Button size="sm" onClick={() => openEdit(r)}>編集</Button>}
                  {can('M-10', 'create') && <Button size="sm" onClick={() => openCopy(r)}>コピー</Button>}
                  {can('M-10', 'delete') && <Button size="sm" variant="danger" onClick={() => remove(r)}>削除</Button>}
                </span>
              ),
            },
          ]}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>

      {/* 長い構成品の名前（41字程度）でもサイズまで読めるよう広げる（No.23・M-16。以前は 680px） */}
      <Modal open={open} title={editingId ? 'セットの編集' : 'セットの登録'} onClose={() => setOpen(false)} width={900} anchorTop footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} disabled={!setSku || !lines.some((l) => l.sku)} onClick={save}>{editingId ? '更新する' : '登録する'}</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        {/*
          候補は商品マスタで「セット商品」にした商品の SKU のうち、まだセット登録が無いものだけ（2026-10-09 マスター編②・M-14）。
          編集ではセット SKU を変えられない
        */}
        <L
          label="セット SKU"
          required
          hint={editingId ? 'セット SKU は変えられません。構成品と数量を直して「更新する」' : '商品マスタで「セット商品」にした商品の SKU から選びます。セット登録済みの SKU は出ません（直すときは一覧の「編集」から）'}
        >
          <div className="w-full">
            <SearchSelect value={setSku} onChange={setSetSku} fetchOptions={fetchSetSkus} placeholder="セット商品の SKU を検索" width="100%" disabled={!!editingId} />
            <FullLabel o={setSku} />
          </div>
        </L>
        <div className="mt-3"><Section title="構成品" /></div>
        <table className="tbl tbl-form mt-2">
          <thead><tr><th>構成品 SKU</th><th className="r" style={{ width: 90 }}>数量</th><th style={{ width: 50 }}></th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <SearchSelect value={l.sku} onChange={(o) => setLines(lines.map((x, j) => (j === i ? { ...x, sku: o } : x)))} fetchOptions={fetchComponentSkus} placeholder="SKU・JAN・商品名" width="100%" />
                  <FullLabel o={l.sku} />
                </td>
                <td><Input right value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></td>
                <td className="c"><Button size="sm" variant="quiet" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 flex items-center gap-3">
          <Button size="sm" icon="plus" onClick={() => setLines([...lines, { sku: null, qty: '1' }])}>行を足す</Button>
          <span className="text-[10.5px] text-[var(--color-ink-3)]">合計 {qty(lines.reduce((a, l) => a + Number(l.qty || 0), 0))} 点</span>
        </div>
        <div className="mt-3"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="備考" /></div>
      </Modal>
    </div>
  );
}
