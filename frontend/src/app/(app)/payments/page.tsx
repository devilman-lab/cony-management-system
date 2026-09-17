'use client';

import { useMemo, useState } from 'react';

import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch, useList } from '@/lib/hooks';
import { money, today, ymd } from '@/lib/format';
import { Button, Card, DataTable, ErrorBox, FormRow, Input, Modal, Num, PageHead, Pager, Select, Textarea, Toolbar } from '@/components/ui';
import { SearchSelect, fetchPartners, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface ReceiptRow extends Record<string, unknown> {
  id: number;
  receipt_date: string;
  amount: string;
  applied_amount: string | null;
  partner_name: string;
  invoice_no: string | null;
}

interface InvoiceOpt {
  id: number;
  invoice_no: string;
  period_to: string;
  current_balance: string;
  status: string;
}

/** 入金登録・消込（B-05）。請求を選ぶと、その請求に消し込む。 */
export default function PaymentsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const fetchCustomers = useMemo(() => fetchPartners('customer'), []);

  const [partner, setPartner] = useState<Option | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const list = useList<ReceiptRow>('/billing/cash-receipts', { partner_id: partner?.id, from: from || undefined, to: to || undefined });

  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ partner: null as Option | null, date: today(), amount: '', invoice_id: '', applied: '', note: '' });
  const invoices = useFetch<Paged<InvoiceOpt>>(f.partner ? '/billing/invoices' : null, { partner_id: f.partner?.id, limit: 50 });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.post('/billing/cash-receipts', {
        partner_id: f.partner?.id,
        receipt_date: f.date,
        amount: f.amount,
        invoice_id: f.invoice_id ? Number(f.invoice_id) : null,
        applied_amount: f.invoice_id ? f.applied || f.amount : null,
        note: f.note || null,
      });
      toast('入金を登録しました', 'good');
      setOpen(false);
      setF({ partner: null, date: today(), amount: '', invoice_id: '', applied: '', note: '' });
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
        title="入金消込"
        sub="入金を登録し、請求に消し込みます。売掛残高と次回請求の「今回入金額」に反映されます"
        right={can('B-05', 'create') && <Button variant="primary" icon="plus" onClick={() => { setError(null); setOpen(true); }}>入金を登録</Button>}
      />
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.total}</Num> 件</span>}>
          <SearchSelect value={partner} onChange={setPartner} fetchOptions={fetchCustomers} placeholder="取引先で絞る" width={220} />
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="!w-[140px]" />
          <span className="text-[var(--color-ink-3)]">〜</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="!w-[140px]" />
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<ReceiptRow>
          columns={[
            { key: 'receipt_date', label: '入金日', width: 110, render: (r) => <Num>{ymd(r.receipt_date)}</Num> },
            { key: 'partner_name', label: '取引先' },
            { key: 'amount', label: '入金額', r: true, width: 120, render: (r) => money(r.amount) },
            { key: 'invoice_no', label: '消込先の請求', width: 150, render: (r) => <Num>{r.invoice_no ?? '（未消込）'}</Num> },
            { key: 'applied_amount', label: '消込額', r: true, width: 120, render: (r) => money(r.applied_amount) },
          ]}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>

      <Modal open={open} title="入金の登録" onClose={() => setOpen(false)} width={560} footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} onClick={save}>登録する</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <FormRow label="取引先" required>
          <SearchSelect value={f.partner} onChange={(o) => setF({ ...f, partner: o, invoice_id: '' })} fetchOptions={fetchCustomers} placeholder="取引先を検索" width="100%" />
        </FormRow>
        <FormRow label="入金日" required>
          <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} className="!w-[150px]" />
        </FormRow>
        <FormRow label="入金額" required>
          <Input right value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className="!w-[150px]" />
        </FormRow>
        <FormRow label="消込先の請求" hint="選ぶと消し込みます">
          <Select value={f.invoice_id} onChange={(e) => setF({ ...f, invoice_id: e.target.value })} disabled={!f.partner}>
            <option value="">（消し込まない）</option>
            {(invoices.data?.items ?? [])
              .filter((i) => i.status !== '取消')
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.invoice_no}　{ymd(i.period_to)}締め　残高 {money(i.current_balance)}
                </option>
              ))}
          </Select>
        </FormRow>
        {f.invoice_id && (
          <FormRow label="消込額" hint="空なら入金額と同じ">
            <Input right value={f.applied} onChange={(e) => setF({ ...f, applied: e.target.value })} className="!w-[150px]" />
          </FormRow>
        )}
        <FormRow label="備考">
          <Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </FormRow>
      </Modal>
    </div>
  );
}
