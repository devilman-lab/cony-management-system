'use client';

import { useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch } from '@/lib/hooks';
import { money, thisMonth, today, ymd } from '@/lib/format';
import { Button, Card, DataTable, ErrorBox, FormRow, Input, Modal, PageHead, Select, Textarea, Toolbar } from '@/components/ui';
import { SearchSelect, fetchPartners, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface CashRow extends Record<string, unknown> {
  id: number;
  cash_transaction_no: string;
  division: string;
  target_month: string;
  transaction_date: string | null;
  partner_name: string | null;
  amount: string;
  cash_amount: string | null;
  transfer_amount: string | null;
  card_amount: string | null;
  offset_amount: string | null;
  check_amount: string | null;
  collection_amount: string | null;
  overseas_usd: string | null;
  overseas_cny: string | null;
}

const MEANS: { k: string; label: string }[] = [
  { k: 'transfer_amount', label: '振込' },
  { k: 'cash_amount', label: '現金' },
  { k: 'card_amount', label: 'カード' },
  { k: 'bill_amount1', label: '手形①' },
  { k: 'bill_amount2', label: '手形②' },
  { k: 'offset_amount', label: '相殺' },
  { k: 'check_amount', label: '小切手' },
  { k: 'collection_amount', label: '集金' },
  { k: 'overseas_usd', label: '海外送金 USD' },
  { k: 'overseas_cny', label: '海外送金 CNY' },
  { k: 'fee_amount', label: '手数料' },
];

/** 入出金処理（C-01）。1件ずつ登録が基本。手段ごとの内訳から合計を求める。 */
export default function CashPage() {
  const { can } = useAuth();
  const toast = useToast();
  const fetchAll = useMemo(() => fetchPartners(), []);
  const [month, setMonth] = useState(thisMonth());
  const [division, setDivision] = useState('');
  const list = useFetch<CashRow[]>('/cash-transactions', { target_month: month, division: division || undefined });

  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Record<string, string>>({ division: '入金', target_month: thisMonth(), transaction_date: today(), note: '' });
  const [partner, setPartner] = useState<Option | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { division: f.division, target_month: f.target_month, transaction_date: f.transaction_date || null, partner_id: partner?.id ?? null, note: f.note || null };
      for (const m of MEANS) if (f[m.k]) body[m.k] = f[m.k];
      if (f.bill_due_date1) body.bill_due_date1 = f.bill_due_date1;
      if (f.bill_due_date2) body.bill_due_date2 = f.bill_due_date2;
      await api.post('/cash-transactions', body);
      toast('登録しました', 'good');
      setOpen(false);
      setF({ division: '入金', target_month: thisMonth(), transaction_date: today(), note: '' });
      setPartner(null);
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const total = MEANS.filter((m) => m.k !== 'fee_amount').reduce((a, m) => a + Number(f[m.k] || 0), 0);

  return (
    <div className="page-body">
      <PageHead title="入出金" sub="入金・出金を1件ずつ登録します。振込・現金・カード・手形・相殺・小切手・集金・海外送金の内訳から合計を求めます" right={can('C-01', 'create') && <Button variant="primary" icon="plus" onClick={() => { setError(null); setOpen(true); }}>入出金を登録</Button>} />
      <Card>
        <Toolbar>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="!w-[150px]" />
          <Select value={division} onChange={(e) => setDivision(e.target.value)} className="!w-[110px]"><option value="">入金・出金</option><option>入金</option><option>出金</option></Select>
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<CashRow>
          wide
          columns={[
            { key: 'cash_transaction_no', label: '番号', width: 100, render: (r) => <span className="num font-semibold">{r.cash_transaction_no}</span> },
            { key: 'division', label: '区分', width: 60 },
            { key: 'transaction_date', label: '日付', width: 100, render: (r) => ymd(r.transaction_date) },
            { key: 'partner_name', label: '取引先', render: (r) => r.partner_name ?? '' },
            { key: 'amount', label: '合計', r: true, width: 110, render: (r) => <b>{money(r.amount)}</b> },
            { key: 'transfer_amount', label: '振込', r: true, width: 90, render: (r) => money(r.transfer_amount) },
            { key: 'cash_amount', label: '現金', r: true, width: 80, render: (r) => money(r.cash_amount) },
            { key: 'card_amount', label: 'カード', r: true, width: 80, render: (r) => money(r.card_amount) },
            { key: 'offset_amount', label: '相殺', r: true, width: 80, render: (r) => money(r.offset_amount) },
            { key: 'check_amount', label: '小切手', r: true, width: 80, render: (r) => money(r.check_amount) },
            { key: 'collection_amount', label: '集金', r: true, width: 80, render: (r) => money(r.collection_amount) },
            { key: 'overseas_usd', label: 'USD', r: true, width: 80, render: (r) => money(r.overseas_usd) },
            { key: 'overseas_cny', label: 'CNY', r: true, width: 80, render: (r) => money(r.overseas_cny) },
          ]}
          rows={list.data ?? []}
          rowKey={(r) => r.id}
          loading={list.loading}
        />
      </Card>

      <Modal open={open} title="入出金の登録" onClose={() => setOpen(false)} width={720} footer={<><span className="mr-auto text-[12px]">合計 <b className="num">{money(total)}</b> 円</span><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} onClick={save}>登録する</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <div className="master-grid-2">
          <FormRow label="区分" required><Select value={f.division} onChange={(e) => setF({ ...f, division: e.target.value })} className="!w-[110px]"><option>入金</option><option>出金</option></Select></FormRow>
          <FormRow label="対象月" required><Input type="month" value={f.target_month} onChange={(e) => setF({ ...f, target_month: e.target.value })} className="!w-[150px]" /></FormRow>
          <FormRow label="取引先"><SearchSelect value={partner} onChange={setPartner} fetchOptions={fetchAll} placeholder="取引先を検索" width="100%" /></FormRow>
          <FormRow label="日付"><Input type="date" value={f.transaction_date} onChange={(e) => setF({ ...f, transaction_date: e.target.value })} className="!w-[150px]" /></FormRow>
        </div>
        <div className="mt-3 master-grid-2">
          {MEANS.map((m) => (
            <FormRow key={m.k} label={m.label}>
              <Input right value={f[m.k] ?? ''} onChange={(e) => setF({ ...f, [m.k]: e.target.value })} className="!w-[140px]" />
              {m.k === 'bill_amount1' && <Input type="date" value={f.bill_due_date1 ?? ''} onChange={(e) => setF({ ...f, bill_due_date1: e.target.value })} className="!w-[140px]" title="決済日" />}
              {m.k === 'bill_amount2' && <Input type="date" value={f.bill_due_date2 ?? ''} onChange={(e) => setF({ ...f, bill_due_date2: e.target.value })} className="!w-[140px]" title="決済日" />}
            </FormRow>
          ))}
        </div>
        <div className="mt-2"><Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="備考" /></div>
      </Modal>
    </div>
  );
}
