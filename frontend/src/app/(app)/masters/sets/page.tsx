'use client';

import { useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounce, useList } from '@/lib/hooks';
import { qty } from '@/lib/format';
import { Badge, Button, Card, DataTable, ErrorBox, Input, Modal, Num, PageHead, Pager, Textarea, Toolbar } from '@/components/ui';
import { SearchSelect, fetchSkus, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';
import { L, Section } from '@/components/masters/Form';

interface SetRow extends Record<string, unknown> {
  id: number;
  sku_code: string;
  product_name: string;
  is_active: boolean;
  component_count: number;
}
interface SetDetail {
  id: number;
  sku_id: number;
  note: string | null;
  components: { id: number; component_sku_id: number; sku_code: string; product_name: string; qty: string }[];
}
interface Line {
  sku: Option | null;
  qty: string;
}

/** セット登録（M-10）。セット SKU と、その構成品（内訳）。出荷時は構成品の在庫から引く。 */
export default function SetsPage() {
  const { can } = useAuth();
  const toast = useToast();
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
      setSetSku({ id: d.sku_id, label: `${r.sku_code}　${r.product_name}` });
      setLines(d.components.map((c) => ({ sku: { id: c.component_sku_id, label: `${c.sku_code}　${c.product_name}` }, qty: c.qty })));
      setNote(d.note ?? '');
    } catch (e) {
      setError(e);
    }
  };
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.post('/masters/sets', {
        sku_id: setSku?.id,
        components: lines.filter((l) => l.sku).map((l, i) => ({ component_sku_id: l.sku!.id, qty: l.qty, sort_order: i + 1 })),
        note: note || null,
      });
      toast('セットを登録しました', 'good');
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
      <PageHead title="セット登録" sub="セット商品の SKU と、その内訳（構成品と数量）。出荷すると構成品の在庫が減ります。登録し直すと内訳は入れ替わります" right={can('M-10', 'create') && <Button variant="primary" icon="plus" onClick={openNew}>新規登録</Button>} />
      <Card>
        <Toolbar><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU・商品名で検索" className="!w-[240px]" /></Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<SetRow>
          columns={[
            { key: 'sku_code', label: 'セット SKU', width: 140, render: (r) => <Num className="font-semibold">{r.sku_code}</Num> },
            { key: 'product_name', label: '商品名' },
            { key: 'component_count', label: '構成品', r: true, width: 80, render: (r) => `${r.component_count} 点` },
            { key: 'is_active', label: '', width: 60, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
            { key: '_act', label: '', width: 80, render: (r) => can('M-10', 'update') && <Button size="sm" onClick={() => openEdit(r)}>編集</Button> },
          ]}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>

      <Modal open={open} title={editingId ? 'セットの編集' : 'セットの登録'} onClose={() => setOpen(false)} width={680} footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} disabled={!setSku || !lines.some((l) => l.sku)} onClick={save}>登録する</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <L label="セット SKU" required><SearchSelect value={setSku} onChange={setSetSku} fetchOptions={fetchSkus} placeholder="セット商品の SKU を検索" width="100%" disabled={!!editingId} /></L>
        <div className="mt-3"><Section title="構成品" /></div>
        <table className="tbl mt-2">
          <thead><tr><th>構成品 SKU</th><th className="r" style={{ width: 90 }}>数量</th><th style={{ width: 50 }}></th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td><SearchSelect value={l.sku} onChange={(o) => setLines(lines.map((x, j) => (j === i ? { ...x, sku: o } : x)))} fetchOptions={fetchSkus} placeholder="SKU・JAN・商品名" width="100%" /></td>
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
