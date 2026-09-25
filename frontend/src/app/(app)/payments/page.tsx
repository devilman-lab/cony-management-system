'use client';

import { useMemo, useState } from 'react';

import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch, useList } from '@/lib/hooks';
import { money, today, ymd } from '@/lib/format';
import { Button, Card, DataTable, ErrorBox, FormRow, Input, Modal, Num, PageHead, Pager, Select, Textarea, Toolbar, useConfirm } from '@/components/ui';
import { SearchSelect, fetchPartners, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface ReceiptRow extends Record<string, unknown> {
  id: number;
  receipt_date: string;
  amount: string;
  applied_amount: string | null;
  partner_id: number;
  partner_name: string;
  invoice_id: number | null;
  invoice_no: string | null;
  note: string | null;
}

interface InvoiceOpt {
  id: number;
  invoice_no: string;
  period_to: string;
  current_balance: string;
  status: string;
}

/** NUMERIC は "1500.00" の形で返る。入力欄に入れるときだけ見た目を整える（数値には通さない）。 */
const plain = (v: string | null | undefined): string => (v ?? '').replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');

const emptyForm = () => ({ partner: null as Option | null, date: today(), amount: '', invoice_id: '', applied: '', note: '' });

/** 入金登録・消込（B-05）。請求を選ぶと、その請求に消し込む。 */
export default function PaymentsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const fetchCustomers = useMemo(() => fetchPartners('customer'), []);

  const [partner, setPartner] = useState<Option | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const list = useList<ReceiptRow>('/billing/cash-receipts', { partner_id: partner?.id, from: from || undefined, to: to || undefined });

  const [open, setOpen] = useState(false);
  // 訂正中の入金。null なら新規登録
  const [editing, setEditing] = useState<ReceiptRow | null>(null);
  const [f, setF] = useState(emptyForm());
  const invoices = useFetch<Paged<InvoiceOpt>>(f.partner ? '/billing/invoices' : null, { partner_id: f.partner?.id, limit: 50 });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const openNew = () => {
    setEditing(null);
    setF(emptyForm());
    setError(null);
    setOpen(true);
  };

  const openEdit = (r: ReceiptRow) => {
    setEditing(r);
    setF({
      partner: { id: r.partner_id, label: r.partner_name },
      date: String(r.receipt_date).slice(0, 10),
      amount: plain(r.amount),
      invoice_id: r.invoice_id ? String(r.invoice_id) : '',
      applied: '',
      note: r.note ?? '',
    });
    setError(null);
    setOpen(true);
  };

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      if (editing) {
        // 取引先は入れ替えさせない（消込先の請求との組み合わせを取り違えるため）。
        // 相手を間違えたときは削除して入れ直していただく
        await api.patch(`/billing/cash-receipts/${editing.id}`, {
          receipt_date: f.date,
          amount: f.amount,
          invoice_id: f.invoice_id ? Number(f.invoice_id) : null,
          note: f.note || null,
        });
        toast('入金を直しました', 'good');
      } else {
        await api.post('/billing/cash-receipts', {
          partner_id: f.partner?.id,
          receipt_date: f.date,
          amount: f.amount,
          invoice_id: f.invoice_id ? Number(f.invoice_id) : null,
          applied_amount: f.invoice_id ? f.applied || f.amount : null,
          note: f.note || null,
        });
        toast('入金を登録しました', 'good');
      }
      setOpen(false);
      setEditing(null);
      setF(emptyForm());
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: ReceiptRow) => {
    const what = r.invoice_no ? `${ymd(r.receipt_date)} の ${money(r.amount)} 円（${r.invoice_no} に消込済み）を削除します。` : `${ymd(r.receipt_date)} の ${money(r.amount)} 円を削除します。`;
    if (!(await confirm('この入金を削除しますか', `${what}消し込んだ分の売掛残高は戻ります。`, true))) return;
    setRemovingId(r.id);
    try {
      await api.delete(`/billing/cash-receipts/${r.id}`);
      toast('入金を削除しました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '削除できませんでした', 'bad');
    } finally {
      setRemovingId(null);
    }
  };

  const options = invoices.data?.items ?? [];
  // 今つながっている請求が一覧の先頭50件に入っていないことがある。選び直すまで消えないようにする
  const linkedMissing = editing?.invoice_id && !options.some((i) => i.id === editing.invoice_id) ? editing : null;

  return (
    <div className="page-body">
      {element}
      <PageHead
        title="入金消込"
        sub="入金を登録し、請求に消し込みます。売掛残高と次回請求の「今回入金額」に反映されます"
        right={can('B-05', 'create') && <Button variant="primary" icon="plus" onClick={openNew}>入金を登録</Button>}
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
            // 備考は「編集」を押すと訂正の画面で読める。列に出すと表が画面より広くなり、
            // 1024px の画面で「編集」「削除」が右にはみ出して押せなくなるため、ここには出さない
            // （買掛・支払の一覧と同じ列数にそろえてある）。
            {
              key: '_act',
              label: '',
              width: 130,
              render: (r) => (
                <span className="flex gap-1">
                  {can('B-05', 'update') && <Button size="sm" onClick={() => openEdit(r)}>編集</Button>}
                  {can('B-05', 'delete') && <Button size="sm" variant="danger" loading={removingId === r.id} onClick={() => remove(r)}>削除</Button>}
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

      <Modal
        open={open}
        title={editing ? `入金の訂正　${ymd(editing.receipt_date)}　${editing.partner_name}` : '入金の登録'}
        onClose={() => setOpen(false)}
        width={560}
        footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} onClick={save}>{editing ? '直す' : '登録する'}</Button></>}
      >
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <FormRow label="取引先" required hint={editing ? '訂正では変えられません。相手が違うときは削除して入れ直してください' : undefined}>
          {editing
            ? <span className="text-[12.5px]">{editing.partner_name}</span>
            : <SearchSelect value={f.partner} onChange={(o) => setF({ ...f, partner: o, invoice_id: '' })} fetchOptions={fetchCustomers} placeholder="取引先を検索" width="100%" />}
        </FormRow>
        <FormRow label="入金日" required>
          <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} className="!w-[150px]" />
        </FormRow>
        <FormRow label="入金額" required>
          <Input right value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className="!w-[150px]" />
        </FormRow>
        <FormRow label="消込先の請求" hint={editing ? '選び直すと消込が付け替わります' : '選ぶと消し込みます'}>
          <Select value={f.invoice_id} onChange={(e) => setF({ ...f, invoice_id: e.target.value })} disabled={!f.partner}>
            <option value="">（消し込まない）</option>
            {linkedMissing && <option value={String(linkedMissing.invoice_id)}>{linkedMissing.invoice_no}　（今の消込先）</option>}
            {options
              .filter((i) => i.status !== '取消')
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.invoice_no}　{ymd(i.period_to)}締め　残高 {money(i.current_balance)}
                </option>
              ))}
          </Select>
        </FormRow>
        {!editing && f.invoice_id && (
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
