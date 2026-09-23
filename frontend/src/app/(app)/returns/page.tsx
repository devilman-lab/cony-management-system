'use client';

import { useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch, useList, useWarehouses } from '@/lib/hooks';
import { money, qty, today, ymd } from '@/lib/format';
import { Badge, Button, Card, DataTable, ErrorBox, FormRow, Input, Modal, Num, PageHead, Pager, Select, Textarea, Toolbar } from '@/components/ui';
import { SearchSelect, fetchPartners, fetchSkus, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface ReturnRow extends Record<string, unknown> {
  id: number;
  return_no: string;
  return_type: string;
  status: string;
  return_date: string;
  return_amount: string;
  partner_name: string | null;
  warehouse_name: string;
}

interface ReturnLine extends Record<string, unknown> {
  id: number;
  line_no: number;
  sku_code: string;
  product_name: string;
  qty: string;
  unit_price: string;
  good_qty: string | null;
  defective_qty: string | null;
  refurbish_cost: string | null;
}

interface ReturnDetail extends ReturnRow {
  note: string | null;
  lines: ReturnLine[];
}

interface LineDraft {
  key: number;
  sku: Option | null;
  qty: string;
  unit_price: string;
  tax_rate: string;
}
let seq = 1;
const newLine = (): LineDraft => ({ key: seq++, sku: null, qty: '1', unit_price: '', tax_rate: '10.00' });

const TYPES = ['販社返品', '顧客返品', 'プラットフォーム返金'];

export default function ReturnsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const warehouses = useWarehouses();
  const fetchCustomers = useMemo(() => fetchPartners('customer'), []);

  const [status, setStatus] = useState('');
  const list = useList<ReturnRow>('/returns', { status: status || undefined });

  // 登録
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ type: '販社返品', partner: null as Option | null, warehouse: '', date: today(), note: '' });
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const setLine = (key: number, p: Partial<LineDraft>) => setLines((s) => s.map((l) => (l.key === key ? { ...l, ...p } : l)));

  // 検品
  const [inspectId, setInspectId] = useState<number | null>(null);
  const detail = useFetch<ReturnDetail>(inspectId ? `/returns/${inspectId}` : null);
  const [inspect, setInspect] = useState<Record<number, { good: string; defective: string; cost: string }>>({});

  const create = async () => {
    setError(null);
    // 候補から選ばずに文字だけ打った行は sku_id が無い。API に送る前に気づかせる
    const missing = lines.findIndex((l) => !l.sku);
    if (missing >= 0) return setError(new ApiError(400, `明細 ${missing + 1} 行目の商品を候補から選んでください（コードを打ったら候補をクリックするか Enter で確定します）`));
    setBusy(true);
    try {
      await api.post('/returns', {
        return_type: f.type,
        partner_id: f.partner?.id ?? null,
        warehouse_id: Number(f.warehouse || warehouses.data?.[0]?.id),
        return_date: f.date,
        note: f.note || null,
        lines: lines.map((l, i) => ({ line_no: i + 1, sku_id: l.sku?.id, qty: l.qty, unit_price: l.unit_price || undefined, tax_rate: l.tax_rate })),
      });
      toast('返品を受け付けました。検品して良品・不良に振り分けてください', 'good');
      setOpen(false);
      setLines([newLine()]);
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const doInspect = async () => {
    if (!detail.data) return;
    setBusy(true);
    try {
      await api.post(`/returns/${detail.data.id}/inspect`, {
        lines: detail.data.lines.map((l) => ({
          return_line_id: l.id,
          good_qty: inspect[l.id]?.good ?? l.qty,
          defective_qty: inspect[l.id]?.defective ?? '0',
          refurbish_cost: inspect[l.id]?.cost || null,
        })),
      });
      toast('検品を登録し、在庫に反映しました', 'good');
      setInspectId(null);
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-body">
      <PageHead
        title="返品・再生"
        sub="返品を受け付け、検品で良品・不良に振り分けると在庫に戻ります。返品額はマイナスの出荷として請求に反映されます"
        right={can('R-01', 'create') && <Button variant="primary" icon="plus" onClick={() => { setError(null); setOpen(true); }}>返品を登録</Button>}
      />
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.total}</Num> 件</span>}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="!w-[130px]">
            <option value="">状態：すべて</option>
            {['受付', '検品済', '完了', '取消'].map((s) => <option key={s}>{s}</option>)}
          </Select>
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<ReturnRow>
          columns={[
            { key: 'return_no', label: '返品番号', width: 140, render: (r) => <Num className="font-semibold text-[var(--color-brand-700)]">{r.return_no}</Num> },
            { key: 'return_date', label: '返品日', width: 100, render: (r) => <Num>{ymd(r.return_date)}</Num> },
            { key: 'return_type', label: '種類', width: 130 },
            { key: 'partner_name', label: '取引先', render: (r) => r.partner_name ?? '' },
            { key: 'warehouse_name', label: '入庫倉庫', width: 110 },
            { key: 'return_amount', label: '返品額', r: true, width: 100, render: (r) => money(r.return_amount) },
            { key: 'status', label: '状態', width: 80, render: (r) => <Badge status={r.status} /> },
            { key: '_act', label: '', width: 90, render: (r) => r.status === '受付' && can('R-01', 'update') && <Button size="sm" variant="primary" onClick={() => { setInspect({}); setInspectId(r.id); }}>検品</Button> },
          ]}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>

      <Modal open={open} title="返品の登録" onClose={() => setOpen(false)} width={860} footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} onClick={create}>受け付ける</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <div className="master-grid-2">
          <FormRow label="種類" required>
            <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} className="!w-[180px]">{TYPES.map((t) => <option key={t}>{t}</option>)}</Select>
          </FormRow>
          <FormRow label="返品日" required>
            <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} className="!w-[150px]" />
          </FormRow>
          <FormRow label="取引先">
            <SearchSelect value={f.partner} onChange={(o) => setF({ ...f, partner: o })} fetchOptions={fetchCustomers} placeholder="取引先を検索" width="100%" />
          </FormRow>
          <FormRow label="入庫倉庫" required>
            <Select value={f.warehouse} onChange={(e) => setF({ ...f, warehouse: e.target.value })}>
              {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.short_name}</option>)}
            </Select>
          </FormRow>
        </div>
        <div className="mt-2"><Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="備考" /></div>
        <div className="mt-3 tbl-wrap">
          <table className="tbl">
            <thead><tr><th>商品</th><th className="r" style={{ width: 80 }}>数量</th><th className="r" style={{ width: 100 }}>単価</th><th style={{ width: 80 }}>税率</th><th style={{ width: 44 }} /></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td><SearchSelect value={l.sku} onChange={(o) => setLine(l.key, { sku: o })} fetchOptions={fetchSkus} placeholder="SKU・JAN・商品名" width="100%" /></td>
                  <td className="r"><Input right value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} className="!h-[26px] !w-[70px]" /></td>
                  <td className="r"><Input right value={l.unit_price} onChange={(e) => setLine(l.key, { unit_price: e.target.value })} className="!h-[26px] !w-[90px]" placeholder="卸単価" /></td>
                  <td><Select value={l.tax_rate} onChange={(e) => setLine(l.key, { tax_rate: e.target.value })} className="!h-[26px]"><option value="10.00">10%</option><option value="8.00">8%</option><option value="0.00">0%</option></Select></td>
                  <td className="c"><button type="button" className="btn btn-quiet !px-1.5 !h-6" disabled={lines.length === 1} onClick={() => setLines((s) => s.filter((x) => x.key !== l.key))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2"><Button size="sm" icon="plus" onClick={() => setLines((s) => [...s, newLine()])}>行を追加</Button></div>
      </Modal>

      <Modal open={inspectId !== null} title={`検品 ${detail.data?.return_no ?? ''}`} onClose={() => setInspectId(null)} width={760} footer={<><Button onClick={() => setInspectId(null)}>やめる</Button><Button variant="primary" loading={busy} onClick={doInspect}>検品を登録する</Button></>}>
        <div className="text-[12px] text-[var(--color-ink-2)] mb-2">数量を良品と不良に分けます。良品はそのまま在庫に戻り、不良は不良在庫として別に管理されます。再生した場合は再生費を入れてください。</div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>SKU</th><th>商品</th><th className="r" style={{ width: 70 }}>返品数</th><th className="r" style={{ width: 90 }}>良品</th><th className="r" style={{ width: 90 }}>不良</th><th className="r" style={{ width: 100 }}>再生費</th></tr></thead>
            <tbody>
              {(detail.data?.lines ?? []).map((l) => {
                const v = inspect[l.id] ?? { good: l.qty, defective: '0', cost: '' };
                const set = (p: Partial<typeof v>) => setInspect((s) => ({ ...s, [l.id]: { ...v, ...p } }));
                return (
                  <tr key={l.id}>
                    <td><Num>{l.sku_code}</Num></td>
                    <td className="truncate">{l.product_name}</td>
                    <td className="r num">{qty(l.qty)}</td>
                    <td className="r"><Input right value={v.good} onChange={(e) => set({ good: e.target.value })} className="!h-[26px] !w-[80px]" /></td>
                    <td className="r"><Input right value={v.defective} onChange={(e) => set({ defective: e.target.value })} className="!h-[26px] !w-[80px]" /></td>
                    <td className="r"><Input right value={v.cost} onChange={(e) => set({ cost: e.target.value })} className="!h-[26px] !w-[90px]" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
  );
}
