'use client';

import { useMemo, useState } from 'react';

import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch } from '@/lib/hooks';
import { money, monthRange, thisMonth, today } from '@/lib/format';
import { Button, Card, DataTable, ErrorBox, FormRow, Input, Modal, PageHead, Select, Textarea, Toolbar } from '@/components/ui';
import { SearchSelect, fetchPartners, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface ApRow extends Record<string, unknown> {
  partner_id: number;
  partner_code: string;
  partner_name: string;
  purchase_amount: string;
  payment_amount: string;
  balance?: string;
}

interface PurchaseOpt {
  id: number;
  purchase_no: string;
  total_amount: string;
  status: string;
}

/** 買掛残高一覧（P-03）と支払の登録。 */
export default function ApPage() {
  const { can } = useAuth();
  const toast = useToast();
  const fetchSuppliers = useMemo(() => fetchPartners('supplier'), []);
  const [month, setMonth] = useState(thisMonth());
  const range = monthRange(month);
  const list = useFetch<ApRow[]>('/ap-balances', { from: range.from, to: range.to });

  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ partner: null as Option | null, date: today(), amount: '', purchase_id: '', note: '' });
  const purchases = useFetch<Paged<PurchaseOpt>>(f.partner ? '/purchases' : null, { supplier_partner_id: f.partner?.id, limit: 50 });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.post('/payments', { partner_id: f.partner?.id, payment_date: f.date, amount: f.amount, purchase_id: f.purchase_id ? Number(f.purchase_id) : null, note: f.note || null });
      toast('支払を登録しました', 'good');
      setOpen(false);
      setF({ partner: null, date: today(), amount: '', purchase_id: '', note: '' });
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const rows = (list.data ?? []).map((r) => ({ ...r, balance: String(Number(r.purchase_amount) - Number(r.payment_amount)) }));

  return (
    <div className="page-body">
      <PageHead title="買掛・支払" sub="仕入先ごとの仕入額・支払額・残高です" right={can('P-01', 'create') && <Button variant="primary" icon="plus" onClick={() => { setError(null); setOpen(true); }}>支払を登録</Button>} />
      <Card>
        <Toolbar>
          <span className="text-[11.5px] text-[var(--color-ink-3)]">対象月</span>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="!w-[150px]" />
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<ApRow>
          columns={[
            { key: 'partner_code', label: 'コード', width: 100 },
            { key: 'partner_name', label: '仕入先' },
            { key: 'purchase_amount', label: '仕入・経費', r: true, width: 130, render: (r) => money(r.purchase_amount) },
            { key: 'payment_amount', label: '支払', r: true, width: 130, render: (r) => money(r.payment_amount) },
            { key: 'balance', label: '残高', r: true, width: 130, render: (r) => <b>{money(r.balance)}</b> },
          ]}
          rows={rows}
          rowKey={(r) => r.partner_id}
          loading={list.loading}
        />
      </Card>

      <Modal open={open} title="支払の登録" onClose={() => setOpen(false)} width={560} footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} onClick={save}>登録する</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <FormRow label="仕入先" required><SearchSelect value={f.partner} onChange={(o) => setF({ ...f, partner: o, purchase_id: '' })} fetchOptions={fetchSuppliers} placeholder="仕入先を検索" width="100%" /></FormRow>
        <FormRow label="支払日" required><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} className="!w-[150px]" /></FormRow>
        <FormRow label="支払額" required><Input right value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className="!w-[150px]" /></FormRow>
        <FormRow label="対象の仕入" hint="任意">
          <Select value={f.purchase_id} onChange={(e) => setF({ ...f, purchase_id: e.target.value })} disabled={!f.partner}>
            <option value="">（指定しない）</option>
            {(purchases.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.purchase_no}　{money(p.total_amount)}</option>)}
          </Select>
        </FormRow>
        <FormRow label="備考"><Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></FormRow>
      </Modal>
    </div>
  );
}
