'use client';

import { useState } from 'react';

import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCodes, useList, useWarehouses } from '@/lib/hooks';
import { today, ymd } from '@/lib/format';
import { Button, Card, DataTable, ErrorBox, FormRow, Input, Modal, Num, PageHead, Pager, Select, Textarea } from '@/components/ui';
import { SearchSelect, fetchSkus, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface AdjRow extends Record<string, unknown> {
  id: number;
  adjustment_no: string;
  adjustment_date: string;
  warehouse_name: string;
  reason_name: string | null;
  note: string | null;
}

interface LineDraft {
  key: number;
  sku: Option | null;
  qty: string;
  lot_no: string;
  from_quality: string;
  to_quality: string;
  note: string;
}
let seq = 1;
const newLine = (): LineDraft => ({ key: seq++, sku: null, qty: '', lot_no: '', from_quality: '', to_quality: '', note: '' });

const QUALITY = [
  { v: '', l: '（変更なし）' },
  { v: 'GOOD', l: '良品' },
  { v: 'DEFECTIVE', l: '不良' },
  { v: 'PENDING', l: '返品検品待ち' },
];

/** 在庫数の調整（ご要望⑫）。棚卸差異・破損・紛失・品質振替をここで直す。 */
export default function AdjustmentsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const warehouses = useWarehouses();
  const reasons = useCodes('ADJUSTMENT_REASON');
  const list = useList<AdjRow>('/inventory/adjustments', {});

  const [open, setOpen] = useState(false);
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('STOCKTAKE');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const setLine = (key: number, p: Partial<LineDraft>) => setLines((s) => s.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const create = async () => {
    setError(null);
    // 候補から選ばずに文字だけ打った行は sku_id が無い。API に送る前に気づかせる
    const missing = lines.findIndex((l) => !l.sku);
    if (missing >= 0) return setError(new ApiError(400, `明細 ${missing + 1} 行目の商品を候補から選んでください（コードを打ったら候補をクリックするか Enter で確定します）`));
    setBusy(true);
    try {
      await api.post('/inventory/adjustments', {
        warehouse_id: Number(warehouseId || warehouses.data?.[0]?.id),
        adjustment_date: date,
        reason_code: reason,
        note: note || null,
        lines: lines.map((l, i) => ({
          line_no: i + 1,
          sku_id: l.sku?.id,
          qty: l.qty,
          lot_no: l.lot_no || null,
          from_quality: l.from_quality || null,
          to_quality: l.to_quality || null,
          note: l.note || null,
        })),
      });
      toast('在庫を調整しました', 'good');
      setOpen(false);
      setLines([newLine()]);
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-body">
      <PageHead
        title="在庫調整"
        sub="棚卸差異・破損・紛失などで在庫数を直します。増やすときは正の数、減らすときは負の数を入れます"
        right={can('S-01', 'update') && <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>調整を登録</Button>}
      />
      <Card>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<AdjRow>
          columns={[
            { key: 'adjustment_no', label: '調整番号', width: 140, render: (r) => <Num className="font-semibold text-[var(--color-brand-700)]">{r.adjustment_no}</Num> },
            { key: 'adjustment_date', label: '調整日', width: 110, render: (r) => <Num>{ymd(r.adjustment_date)}</Num> },
            { key: 'warehouse_name', label: '倉庫', width: 120 },
            { key: 'reason_name', label: '理由', width: 120, render: (r) => r.reason_name ?? '' },
            { key: 'note', label: '備考', render: (r) => r.note ?? '' },
          ]}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>

      <Modal open={open} title="在庫調整の登録" onClose={() => setOpen(false)} width={900} footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} onClick={create}>登録する</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <div className="master-grid-2">
          <FormRow label="倉庫" required>
            <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.short_name}</option>)}
            </Select>
          </FormRow>
          <FormRow label="調整日" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="!w-[150px]" />
          </FormRow>
          <FormRow label="理由" required>
            <Select value={reason} onChange={(e) => setReason(e.target.value)} className="!w-[180px]">
              {(reasons.data?.values ?? []).map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
            </Select>
          </FormRow>
          <FormRow label="備考">
            <Textarea rows={1} value={note} onChange={(e) => setNote(e.target.value)} />
          </FormRow>
        </div>
        <div className="mt-3 tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>商品</th>
                <th className="r" style={{ width: 80 }}>増減</th>
                <th style={{ width: 100 }}>ロット</th>
                <th style={{ width: 130 }}>品質（前）</th>
                <th style={{ width: 130 }}>品質（後）</th>
                <th>メモ</th>
                <th style={{ width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td><SearchSelect value={l.sku} onChange={(o) => setLine(l.key, { sku: o })} fetchOptions={fetchSkus} placeholder="SKU・JAN・商品名" width="100%" /></td>
                  <td className="r"><Input right value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} className="!h-[26px] !w-[70px]" placeholder="-1" /></td>
                  <td><Input value={l.lot_no} onChange={(e) => setLine(l.key, { lot_no: e.target.value })} className="!h-[26px]" /></td>
                  <td><Select value={l.from_quality} onChange={(e) => setLine(l.key, { from_quality: e.target.value })} className="!h-[26px]">{QUALITY.map((q) => <option key={q.v} value={q.v}>{q.l}</option>)}</Select></td>
                  <td><Select value={l.to_quality} onChange={(e) => setLine(l.key, { to_quality: e.target.value })} className="!h-[26px]">{QUALITY.map((q) => <option key={q.v} value={q.v}>{q.l}</option>)}</Select></td>
                  <td><Input value={l.note} onChange={(e) => setLine(l.key, { note: e.target.value })} className="!h-[26px]" /></td>
                  <td className="c"><button type="button" className="btn btn-quiet !px-1.5 !h-6" disabled={lines.length === 1} onClick={() => setLines((s) => s.filter((x) => x.key !== l.key))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <Button size="sm" icon="plus" onClick={() => setLines((s) => [...s, newLine()])}>行を追加</Button>
          <span className="text-[11px] text-[var(--color-ink-3)]">品質の振替（良品→不良など）は「前」「後」を選び、増減には振り替える数を入れます</span>
        </div>
      </Modal>
    </div>
  );
}
