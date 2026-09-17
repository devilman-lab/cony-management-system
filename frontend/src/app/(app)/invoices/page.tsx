'use client';

import { useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch, useList } from '@/lib/hooks';
import { money, qty, thisMonth, ymd } from '@/lib/format';
import { Badge, Button, Card, CardHead, DataTable, ErrorBox, FormRow, Input, Modal, Num, PageHead, Pager, Select, Toolbar, useConfirm } from '@/components/ui';
import { SearchSelect, fetchPartners, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface InvoiceRow extends Record<string, unknown> {
  id: number;
  invoice_no: string;
  status: string;
  period_from: string;
  period_to: string;
  partner_code: string;
  partner_name: string;
  prev_invoice_balance: string;
  current_receipt_amount: string;
  carryover_balance: string;
  shipment_amount: string;
  return_amount: string;
  unposted_10: string;
  unposted_8: string;
  fee_amount: string;
  adjust_10: string;
  adjust_8: string;
  shipping_fee_amount: string;
  current_invoice_amount: string;
  current_balance: string;
}

interface InvoiceDetail extends InvoiceRow {
  closing_date: string;
  po_no: string | null;
  lines: { line_no: number; item_name: string; qty: string; tax_rate: string; amount: string }[];
  tax_summaries: { tax_rate: string; taxable_base: string; tax_amount: string }[];
}

const MANUAL: { k: keyof InvoiceRow; label: string }[] = [
  { k: 'unposted_10', label: '未計上10%' },
  { k: 'unposted_8', label: '未計上8%' },
  { k: 'adjust_10', label: '調整10%' },
  { k: 'adjust_8', label: '調整8%' },
  { k: 'fee_amount', label: '手数料' },
  { k: 'shipping_fee_amount', label: '送料' },
];

export default function InvoicesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const fetchCustomers = useMemo(() => fetchPartners('customer'), []);

  const [status, setStatus] = useState('');
  const [partner, setPartner] = useState<Option | null>(null);
  const list = useList<InvoiceRow>('/billing/invoices', { status: status || undefined, partner_id: partner?.id });

  const [closeOpen, setCloseOpen] = useState(false);
  const [closeMonth, setCloseMonth] = useState(thisMonth());
  const [closePartner, setClosePartner] = useState<Option | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [detailId, setDetailId] = useState<number | null>(null);
  const detail = useFetch<InvoiceDetail>(detailId ? `/billing/invoices/${detailId}` : null);
  const [manual, setManual] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);

  const runClose = async () => {
    setBusy('close');
    try {
      const r = await api.post<{ closed: number; invoices: { invoice_no: string }[] }>('/billing/closings', { target_month: closeMonth, partner_id: closePartner?.id ?? null });
      toast(`${r.closed} 件の請求を作りました（${r.invoices.map((i) => i.invoice_no).join('、')}）`, 'good');
      setCloseOpen(false);
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '締め処理に失敗しました', 'bad');
    } finally {
      setBusy(null);
    }
  };

  const saveManual = async () => {
    if (!detail.data) return;
    setError(null);
    setBusy('manual');
    try {
      const body: Record<string, string> = {};
      for (const m of MANUAL) if (manual[m.k] !== undefined && manual[m.k] !== '') body[m.k] = manual[m.k];
      if (Object.keys(body).length === 0) return toast('変更がありません', 'info');
      await api.patch(`/billing/invoices/${detail.data.id}`, body);
      toast('請求額を計算し直しました', 'good');
      setManual({});
      await detail.reload();
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const issue = async (inv: InvoiceRow) => {
    if (!(await confirm(`${inv.invoice_no} を発行しますか`, '発行後は手入力欄を直せません。'))) return;
    setBusy('issue');
    try {
      await api.post(`/billing/invoices/${inv.id}/issue`);
      toast('発行しました', 'good');
      await list.reload();
      if (detailId === inv.id) await detail.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusy(null);
    }
  };

  const print = async (ids: number[]) => {
    setBusy('print');
    try {
      await api.download('/reports/invoices', { query: { invoice_ids: ids.join(',') }, open: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusy(null);
    }
  };

  const d = detail.data;

  return (
    <div className="page-body">
      {element}
      <PageHead
        title="締め・請求書"
        sub="対象月を締めると取引先ごとの締め日で請求が作られます。内容を確かめて発行し、印刷します"
        right={can('B-01', 'create') && <Button variant="primary" onClick={() => setCloseOpen(true)}>締め処理</Button>}
      />
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.total}</Num> 件</span>}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="!w-[120px]">
            <option value="">状態：すべて</option>
            <option>未発行</option>
            <option>発行済</option>
            <option>取消</option>
          </Select>
          <SearchSelect value={partner} onChange={setPartner} fetchOptions={fetchCustomers} placeholder="取引先で絞る" width={220} />
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<InvoiceRow>
          wide
          columns={[
            { key: 'invoice_no', label: '請求番号', width: 130, render: (r) => <button type="button" className="num font-semibold text-[var(--color-brand-700)] underline" onClick={() => { setManual({}); setError(null); setDetailId(r.id); }}>{r.invoice_no}</button> },
            { key: 'partner_name', label: '請求先' },
            { key: 'period_from', label: '期間', width: 190, render: (r) => <Num>{ymd(r.period_from)}〜{ymd(r.period_to)}</Num> },
            { key: 'shipment_amount', label: '出荷', r: true, width: 100, render: (r) => money(r.shipment_amount) },
            { key: 'return_amount', label: '返品', r: true, width: 90, render: (r) => money(r.return_amount) },
            { key: 'shipping_fee_amount', label: '送料', r: true, width: 80, render: (r) => money(r.shipping_fee_amount) },
            { key: 'current_invoice_amount', label: '当月請求額', r: true, width: 110, render: (r) => <b>{money(r.current_invoice_amount)}</b> },
            { key: 'current_balance', label: '今回請求残高', r: true, width: 110, render: (r) => money(r.current_balance) },
            { key: 'status', label: '状態', width: 80, render: (r) => <Badge status={r.status} /> },
            {
              key: '_act', label: '', width: 150,
              render: (r) => (
                <div className="flex gap-1">
                  {r.status === '未発行' && can('B-02', 'print') && <Button size="sm" variant="primary" loading={busy === 'issue'} onClick={() => issue(r)}>発行</Button>}
                  {can('D-03', 'print') && <Button size="sm" icon="print" loading={busy === 'print'} onClick={() => print([r.id])}>PDF</Button>}
                </div>
              ),
            },
          ]}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
          empty="請求はまだありません。「締め処理」から作ります"
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>

      <Modal open={closeOpen} title="締め処理" onClose={() => setCloseOpen(false)} width={520} footer={<><Button onClick={() => setCloseOpen(false)}>やめる</Button><Button variant="primary" loading={busy === 'close'} onClick={runClose}>締める</Button></>}>
        <div className="text-[12px] text-[var(--color-ink-2)] mb-3">取引先ごとの締め日（月末＝1日〜末日、20日締め＝前月21日〜当月20日）で期間を切り、出荷・返品・送料を集計して請求を作ります。未発行の請求は作り直されます。</div>
        <FormRow label="対象月" required><Input type="month" value={closeMonth} onChange={(e) => setCloseMonth(e.target.value)} className="!w-[150px]" /></FormRow>
        <FormRow label="取引先" hint="空なら締め日のある得意先すべて"><SearchSelect value={closePartner} onChange={setClosePartner} fetchOptions={fetchCustomers} placeholder="（すべて）" width={240} /></FormRow>
      </Modal>

      <Modal open={detailId !== null} title={d ? `請求 ${d.invoice_no}　${d.partner_name}` : '請求'} onClose={() => setDetailId(null)} width={900}
        footer={d && (
          <>
            {can('D-03', 'print') && <Button icon="print" onClick={() => print([d.id])}>請求書PDF</Button>}
            {d.status === '未発行' && can('B-02', 'update') && <Button variant="primary" loading={busy === 'manual'} onClick={saveManual}>手入力欄を保存して再計算</Button>}
            {d.status === '未発行' && can('B-02', 'print') && <Button variant="primary" loading={busy === 'issue'} onClick={() => issue(d)}>発行する</Button>}
          </>
        )}
      >
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        {d && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 text-[12px] flex-wrap">
              <Badge status={d.status} />
              <span>締め日 <Num>{ymd(d.closing_date)}</Num></span>
              <span>期間 <Num>{ymd(d.period_from)}〜{ymd(d.period_to)}</Num></span>
            </div>
            <div className="detail-grid-2">
              <Card>
                <CardHead title="金額（現行の12項目）" />
                <div className="px-3.5">
                  {[
                    ['前回請求残高', d.prev_invoice_balance], ['今回入金額', d.current_receipt_amount], ['繰越残高', d.carryover_balance],
                    ['出荷', d.shipment_amount], ['返品額', d.return_amount],
                  ].map(([k, v]) => <div key={k} className="form-row"><div className="form-row-label field-label px-3 flex items-center h-full">{k}</div><div className="px-3 text-right num">{money(v)}</div></div>)}
                  {MANUAL.map((m) => (
                    <div key={m.k} className="form-row">
                      <div className="form-row-label field-label px-3 flex items-center h-full">{m.label}</div>
                      <div className="px-3 flex items-center justify-end">
                        {d.status === '未発行' && can('B-02', 'update') ? (
                          <Input right value={manual[m.k] ?? String(d[m.k])} onChange={(e) => setManual((s) => ({ ...s, [m.k]: e.target.value }))} className="!h-[26px] !w-[120px]" />
                        ) : (
                          <span className="num">{money(d[m.k] as string)}</span>
                        )}
                      </div>
                    </div>
                  ))}
                  {[['当月請求額', d.current_invoice_amount], ['今回請求残高', d.current_balance]].map(([k, v]) => (
                    <div key={k} className="form-row"><div className="form-row-label field-label px-3 flex items-center h-full font-bold">{k}</div><div className="px-3 text-right num font-bold text-[14px]">{money(v)}</div></div>
                  ))}
                </div>
              </Card>
              <Card>
                <CardHead title="税率別内訳" sub="請求書の上部に印字されます" />
                <table className="tbl">
                  <thead><tr><th>税率</th><th className="r">対象額（税抜）</th><th className="r">消費税</th></tr></thead>
                  <tbody>
                    {d.tax_summaries.map((t) => <tr key={t.tax_rate}><td>{Number(t.tax_rate)}%</td><td className="r num">{money(t.taxable_base)}</td><td className="r num">{money(t.tax_amount)}</td></tr>)}
                  </tbody>
                </table>
                <CardHead title="明細" />
                <div className="max-h-[300px] overflow-auto">
                  <table className="tbl">
                    <thead><tr><th style={{ width: 36 }}>行</th><th>内容</th><th className="r" style={{ width: 70 }}>数量</th><th className="r" style={{ width: 60 }}>税率</th><th className="r" style={{ width: 100 }}>金額</th></tr></thead>
                    <tbody>
                      {d.lines.map((l) => <tr key={l.line_no}><td className="num">{l.line_no}</td><td className="truncate">{l.item_name}</td><td className="r num">{qty(l.qty)}</td><td className="r num">{Number(l.tax_rate)}%</td><td className="r num">{money(l.amount)}</td></tr>)}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
