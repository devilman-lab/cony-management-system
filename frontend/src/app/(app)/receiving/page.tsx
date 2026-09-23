'use client';

import { useMemo, useState } from 'react';

import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useList, useWarehouses } from '@/lib/hooks';
import { today, ymd } from '@/lib/format';
import { Badge, Button, Card, DataTable, ErrorBox, FormRow, Input, Modal, Num, PageHead, Pager, Select, Toolbar, useConfirm } from '@/components/ui';
import { SearchSelect, fetchPartners, fetchSkus, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface ReceiptRow extends Record<string, unknown> {
  id: number;
  receipt_no: string;
  status: string;
  planned_date: string | null;
  received_date: string | null;
  warehouse_name: string;
  supplier_name: string | null;
}

interface LineDraft {
  key: number;
  sku: Option | null;
  qty: string;
  lot_no: string;
  expiry_date: string;
  cost_price: string;
}

let seq = 1;
const newLine = (): LineDraft => ({ key: seq++, sku: null, qty: '1', lot_no: '', expiry_date: '', cost_price: '' });

export default function ReceivingPage() {
  const { can, canSeeSensitive } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const warehouses = useWarehouses();
  const fetchSuppliers = useMemo(() => fetchPartners('supplier'), []);

  const [status, setStatus] = useState('');
  const list = useList<ReceiptRow>('/inventory/receipts', { status: status || undefined });

  const [open, setOpen] = useState(false);
  const [warehouseId, setWarehouseId] = useState('');
  const [supplier, setSupplier] = useState<Option | null>(null);
  const [planned, setPlanned] = useState(today());
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<number | 'new' | null>(null);

  const setLine = (key: number, p: Partial<LineDraft>) => setLines((s) => s.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const create = async () => {
    setError(null);
    // 候補から選ばずに文字だけ打った行は sku_id が無い。API に送る前に気づかせる
    const missing = lines.findIndex((l) => !l.sku);
    if (missing >= 0) return setError(new ApiError(400, `明細 ${missing + 1} 行目の商品を候補から選んでください（コードを打ったら候補をクリックするか Enter で確定します）`));
    setBusy('new');
    try {
      const wh = warehouseId || String(warehouses.data?.[0]?.id ?? '');
      await api.post('/inventory/receipts', {
        warehouse_id: Number(wh),
        supplier_partner_id: supplier?.id ?? null,
        planned_date: planned || null,
        note: note || null,
        lines: lines.map((l, i) => ({
          line_no: i + 1,
          sku_id: l.sku?.id,
          qty: l.qty,
          lot_no: l.lot_no || null,
          expiry_date: l.expiry_date || null,
          cost_price: l.cost_price || null,
        })),
      });
      toast('入荷予定を登録しました。届いたら「入荷確定」を押してください', 'good');
      setOpen(false);
      setLines([newLine()]);
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const receive = async (r: ReceiptRow) => {
    if (!(await confirm(`${r.receipt_no} を入荷確定しますか`, '実在庫が増えます。'))) return;
    setBusy(r.id);
    try {
      await api.post(`/inventory/receipts/${r.id}/receive`, { received_date: today() });
      toast('入荷を計上し、在庫に反映しました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page-body">
      {element}
      <PageHead
        title="入荷登録"
        sub="入荷予定を登録し、届いた時点で「入荷確定」を押すと実在庫が増えます"
        right={can('S-03', 'create') && <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>入荷を登録</Button>}
      />
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.total}</Num> 件</span>}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="!w-[130px]">
            <option value="">状態：すべて</option>
            <option value="指示">入荷予定</option>
            <option value="入荷済">入荷済</option>
            <option value="取消">取消</option>
          </Select>
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<ReceiptRow>
          columns={[
            { key: 'receipt_no', label: '入荷番号', width: 140, render: (r) => <Num className="font-semibold text-[var(--color-brand-700)]">{r.receipt_no}</Num> },
            { key: 'planned_date', label: '入荷予定日', width: 110, render: (r) => <Num>{ymd(r.planned_date)}</Num> },
            { key: 'received_date', label: '入荷日', width: 110, render: (r) => <Num>{ymd(r.received_date)}</Num> },
            { key: 'supplier_name', label: '仕入先', render: (r) => r.supplier_name ?? '' },
            { key: 'warehouse_name', label: '入荷倉庫', width: 120 },
            { key: 'status', label: '状態', width: 90, render: (r) => <Badge status={r.status}>{r.status === '指示' ? '入荷予定' : r.status}</Badge> },
            { key: '_act', label: '', width: 110, render: (r) => r.status === '指示' && can('S-03', 'update') && <Button size="sm" variant="primary" loading={busy === r.id} onClick={() => receive(r)}>入荷確定</Button> },
          ]}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>

      <Modal open={open} title="入荷の登録" onClose={() => setOpen(false)} width={860} footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy === 'new'} onClick={create}>登録する</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <div className="master-grid-2">
          <FormRow label="入荷倉庫" required>
            <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.short_name}</option>)}
            </Select>
          </FormRow>
          <FormRow label="仕入先">
            <SearchSelect value={supplier} onChange={setSupplier} fetchOptions={fetchSuppliers} placeholder="仕入先を検索" width="100%" />
          </FormRow>
          <FormRow label="入荷予定日">
            <Input type="date" value={planned} onChange={(e) => setPlanned(e.target.value)} className="!w-[150px]" />
          </FormRow>
          <FormRow label="備考">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </FormRow>
        </div>
        <div className="mt-3 tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>商品</th>
                <th className="r" style={{ width: 80 }}>数量</th>
                <th style={{ width: 110 }}>ロット</th>
                <th style={{ width: 140 }}>期限</th>
                {canSeeSensitive && <th className="r" style={{ width: 100 }}>仕入単価</th>}
                <th style={{ width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td><SearchSelect value={l.sku} onChange={(o) => setLine(l.key, { sku: o })} fetchOptions={fetchSkus} placeholder="SKU・JAN・商品名" width="100%" /></td>
                  <td className="r"><Input right value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} className="!h-[26px] !w-[70px]" /></td>
                  <td><Input value={l.lot_no} onChange={(e) => setLine(l.key, { lot_no: e.target.value })} className="!h-[26px]" /></td>
                  <td><Input type="date" value={l.expiry_date} onChange={(e) => setLine(l.key, { expiry_date: e.target.value })} className="!h-[26px]" /></td>
                  {canSeeSensitive && <td className="r"><Input right value={l.cost_price} onChange={(e) => setLine(l.key, { cost_price: e.target.value })} className="!h-[26px] !w-[90px]" /></td>}
                  <td className="c"><button type="button" className="btn btn-quiet !px-1.5 !h-6" disabled={lines.length === 1} onClick={() => setLines((s) => s.filter((x) => x.key !== l.key))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2"><Button size="sm" icon="plus" onClick={() => setLines((s) => [...s, newLine()])}>行を追加</Button></div>
      </Modal>
    </div>
  );
}
