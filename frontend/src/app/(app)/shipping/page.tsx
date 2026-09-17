'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useList, useWarehouses } from '@/lib/hooks';
import { today, ymd } from '@/lib/format';
import { Badge, Button, Card, DataTable, ErrorBox, Input, Modal, Num, PageHead, Pager, Select, Toolbar, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

interface ShipmentRow extends Record<string, unknown> {
  id: number;
  shipment_no: string;
  status: string;
  planned_ship_date: string | null;
  ship_date: string | null;
  consolidated_to_shipment_id: number | null;
  sales_order_id: number | null;
  order_no: string | null;
  order_type: string | null;
  is_billable: boolean | null;
  partner_name: string | null;
  warehouse_name: string;
}

const DOCS = ['出荷指示書', 'ピッキングリスト', '納品書'] as const;
const FORMS = ['（納品先の設定どおり）', '単価あり', '単価あり2', '上代あり', '単価なし'] as const;

function ShippingList() {
  const params = useSearchParams();
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const warehouses = useWarehouses();

  const [status, setStatus] = useState('確定済');
  const [warehouseId, setWarehouseId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [printOpen, setPrintOpen] = useState(false);
  const [docs, setDocs] = useState<Set<string>>(new Set(['出荷指示書', '納品書']));
  const [form, setForm] = useState<string>(FORMS[0]);
  const [shipDate, setShipDate] = useState(today());
  const [withAttachments, setWithAttachments] = useState(true);
  const [busy, setBusy] = useState(false);

  const list = useList<ShipmentRow>('/shipments', {
    status: status || undefined,
    warehouse_id: warehouseId || undefined,
    from: from || undefined,
    to: to || undefined,
  }, 100);

  useEffect(() => {
    const focus = params.get('focus');
    if (focus) setSelected(new Set([Number(focus)]));
  }, [params]);

  const visible = list.items;
  const allChecked = visible.length > 0 && visible.every((r) => selected.has(r.id));
  const selectedRows = useMemo(() => visible.filter((r) => selected.has(r.id)), [visible, selected]);
  const ids = [...selected];

  const toggle = (id: number) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const confirmAndPrint = async () => {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const r = await api.download('/reports/confirm-and-print', {
        method: 'POST',
        body: {
          shipment_ids: ids,
          documents: [...docs],
          form: form === FORMS[0] ? undefined : form,
          ship_date: shipDate || null,
          include_attachments: withAttachments,
        },
        open: true,
      });
      toast(`${r.confirmed.length} 件を出荷確定し、印刷用のPDFを開きました`, 'good');
      if (r.skipped.length > 0) toast(`同梱できなかった添付：${r.skipped.join('、')}（PDF・画像以外は印刷できません）`, 'info');
      setPrintOpen(false);
      setSelected(new Set());
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusy(false);
    }
  };

  const printOnly = async (kind: 'shipping-instructions' | 'picking-list' | 'delivery-notes') => {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      await api.download(`/reports/${kind}`, { query: { shipment_ids: ids.join(',') }, open: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusy(false);
    }
  };

  const consolidate = async () => {
    if (ids.length < 2) return toast('同梱するには2件以上選んでください', 'info');
    const into = selectedRows[0];
    if (!(await confirm('同梱しますか', `${selectedRows.map((r) => r.shipment_no).join('、')} を ${into.shipment_no} にまとめます。同じ得意先・納品先・倉庫の出荷だけまとめられます。`))) return;
    setBusy(true);
    try {
      await api.post('/shipments/consolidate', { shipment_ids: ids, into_shipment_id: into.id });
      toast('同梱しました', 'good');
      setSelected(new Set());
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusy(false);
    }
  };

  const unconfirm = async (row: ShipmentRow) => {
    if (!(await confirm(`${row.shipment_no} の出荷確定を取り消しますか`, '実在庫が戻り、受注を修正できる状態になります。請求に含めた出荷は取り消せません。', true))) return;
    setBusy(true);
    try {
      await api.post(`/shipments/${row.id}/unconfirm`);
      toast('出荷確定を取り消しました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-body">
      {element}
      <PageHead
        title="出荷確定・印刷"
        sub="対象を選んで「出荷確定して印刷」を押すと、実在庫が減り、出荷指示書・納品書・添付が1つのPDFで開きます"
        right={
          <>
            {can('D-03', 'print') && (
              <>
                <Button size="sm" disabled={ids.length === 0 || busy} onClick={() => printOnly('shipping-instructions')}>出荷指示書</Button>
                <Button size="sm" disabled={ids.length === 0 || busy} onClick={() => printOnly('picking-list')}>ピッキングリスト</Button>
                <Button size="sm" disabled={ids.length === 0 || busy} onClick={() => printOnly('delivery-notes')}>納品書</Button>
              </>
            )}
            {can('D-01', 'update') && (
              <Button size="sm" disabled={ids.length < 2 || busy} onClick={consolidate}>同梱</Button>
            )}
            {can('D-01', 'update') && can('D-03', 'print') && (
              <Button variant="primary" icon="print" disabled={ids.length === 0 || busy} onClick={() => setPrintOpen(true)}>
                出荷確定して印刷（{ids.length}）
              </Button>
            )}
          </>
        }
      />
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.total}</Num> 件</span>}>
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setSelected(new Set()); }} className="!w-[150px]">
            <option value="確定済">出荷待ち（引当済）</option>
            <option value="出荷済">出荷済</option>
            <option value="">すべて</option>
          </Select>
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="!w-[140px]">
            <option value="">倉庫：すべて</option>
            {(warehouses.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>{w.short_name}</option>
            ))}
          </Select>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="!w-[140px]" />
          <span className="text-[var(--color-ink-3)]">〜</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="!w-[140px]" />
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<ShipmentRow>
          wide
          columns={[
            {
              key: '_sel',
              label: <input type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(visible.map((r) => r.id)))} aria-label="すべて選択" />,
              c: true,
              width: 36,
              render: (r) => <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} onClick={(e) => e.stopPropagation()} aria-label="選択" />,
            },
            { key: 'shipment_no', label: '出荷指示番号', width: 140, render: (r) => <Num className="font-semibold text-[var(--color-brand-700)]">{r.shipment_no}</Num> },
            { key: 'planned_ship_date', label: '出荷予定日', width: 100, render: (r) => <Num>{ymd(r.planned_ship_date)}</Num> },
            { key: 'partner_name', label: '取引先', render: (r) => r.partner_name ?? '' },
            { key: 'order_type', label: '区分', width: 64, render: (r) => r.order_type ?? '' },
            { key: 'warehouse_name', label: '倉庫', width: 100 },
            { key: 'consolidated_to_shipment_id', label: '同梱', width: 70, render: (r) => (r.consolidated_to_shipment_id ? <span className="bdg bg-[var(--color-brand-50)] text-[var(--color-brand-700)]">同梱</span> : '') },
            { key: 'ship_date', label: '出荷日', width: 100, render: (r) => <Num>{ymd(r.ship_date)}</Num> },
            { key: 'status', label: '状態', width: 90, render: (r) => <Badge status={r.status}>{r.status === '確定済' ? '出荷待ち' : r.status}</Badge> },
            {
              key: '_act',
              label: '',
              width: 170,
              render: (r) => (
                <div className="flex items-center gap-1">
                  {r.sales_order_id && <Link href={`/orders/${r.sales_order_id}`} className="btn btn-quiet btn-sm">受注</Link>}
                  {r.status === '出荷済' && can('D-01', 'update') && (
                    <Button size="sm" variant="quiet" className="!text-[var(--color-crit-500)]" disabled={busy} onClick={() => unconfirm(r)}>確定取消</Button>
                  )}
                </div>
              ),
            },
          ]}
          rows={visible}
          rowKey={(r) => r.id}
          loading={list.loading}
          onRowClick={(r) => toggle(r.id)}
          empty="対象の出荷はありません"
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>

      <Modal
        open={printOpen}
        title={`出荷確定して印刷（${ids.length} 件）`}
        onClose={() => setPrintOpen(false)}
        footer={
          <>
            <Button onClick={() => setPrintOpen(false)}>やめる</Button>
            <Button variant="primary" icon="print" loading={busy} onClick={confirmAndPrint}>出荷確定して印刷する</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-[12.5px]">
          <div className="text-[var(--color-ink-2)]">
            選んだ出荷を確定します（実在庫が減ります）。同時に、下で選んだ帳票と添付ファイルを1つのPDFにして新しいタブで開きますので、そのまま印刷してください。
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="text-[10.5px] font-semibold text-[var(--color-ink-3)]">印刷する帳票</div>
            {DOCS.map((d) => (
              <label key={d} className="flex items-center gap-2">
                <input type="checkbox" checked={docs.has(d)} onChange={(e) => setDocs((s) => { const n = new Set(s); if (e.target.checked) n.add(d); else n.delete(d); return n; })} />
                {d}
              </label>
            ))}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={withAttachments} onChange={(e) => setWithAttachments(e.target.checked)} />
              添付ファイル（PDF・画像）も一緒に印刷する
            </label>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2">
              <span className="text-[10.5px] font-semibold text-[var(--color-ink-3)]">納品書の様式</span>
              <Select value={form} onChange={(e) => setForm(e.target.value)} className="!w-[190px]">
                {FORMS.map((f) => <option key={f}>{f}</option>)}
              </Select>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-[10.5px] font-semibold text-[var(--color-ink-3)]">出荷日</span>
              <Input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} className="!w-[150px]" />
            </label>
          </div>
          <ul className="text-[11.5px] text-[var(--color-ink-2)] list-disc pl-4">
            {selectedRows.map((r) => (
              <li key={r.id}><Num>{r.shipment_no}</Num>　{r.partner_name}</li>
            ))}
          </ul>
        </div>
      </Modal>
    </div>
  );
}

export default function ShippingPage() {
  return (
    <Suspense>
      <ShippingList />
    </Suspense>
  );
}
