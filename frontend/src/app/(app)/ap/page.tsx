'use client';

import { useEffect, useMemo, useState } from 'react';

import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch } from '@/lib/hooks';
import { money, monthRange, thisMonth, today, ymd } from '@/lib/format';
import { Button, Card, CardHead, DataTable, ErrorBox, FormRow, Input, Modal, Num, PageHead, Pager, Select, Textarea, Toolbar, useConfirm } from '@/components/ui';
import { SearchSelect, fetchPartners, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface ApRow extends Record<string, unknown> {
  partner_id: number;
  partner_code: string;
  partner_name: string;
  carryover_amount: string;
  purchase_amount: string;
  payment_amount: string;
  balance: string;
}

interface PaymentRow extends Record<string, unknown> {
  id: number;
  payment_date: string;
  partner_id: number;
  partner_code: string;
  supplier_name: string;
  amount: string;
  applied_amount: string | null;
  purchase_id: number | null;
  purchase_no: string | null;
  purchase_status: string | null;
  note: string | null;
}

interface PurchaseOpt {
  id: number;
  purchase_no: string;
  total_amount: string;
  status: string;
}

/** NUMERIC は "1500.00" の形で返る。入力欄に入れるときだけ見た目を整える（数値には通さない）。 */
const plain = (v: string | null | undefined): string => (v ?? '').replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');

const emptyForm = () => ({ partner: null as Option | null, date: today(), amount: '', purchase_id: '', note: '' });

const PAY_LIMIT = 50;

/** 買掛残高一覧（P-03）と支払の登録・訂正・削除（P-01）。 */
export default function ApPage() {
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const fetchSuppliers = useMemo(() => fetchPartners('supplier'), []);
  const [month, setMonth] = useState(thisMonth());
  const range = monthRange(month);
  const list = useFetch<ApRow[]>('/ap-balances', { from: range.from, to: range.to });

  // 支払一覧。P-01 を持たない方には出さない（出すと 403 になるだけなので呼びにも行かない）
  const canViewPayments = can('P-01', 'view');
  const [payPartner, setPayPartner] = useState<Option | null>(null);
  const [payOffset, setPayOffset] = useState(0);
  useEffect(() => setPayOffset(0), [month, payPartner?.id]);
  const payments = useFetch<Paged<PaymentRow>>(canViewPayments ? '/payments' : null, {
    partner_id: payPartner?.id,
    from: range.from,
    to: range.to,
    limit: PAY_LIMIT,
    offset: payOffset,
  });

  const [open, setOpen] = useState(false);
  // 訂正中の支払。null なら新規登録
  const [editing, setEditing] = useState<PaymentRow | null>(null);
  const [f, setF] = useState(emptyForm());
  // 消込先に選べるのは取消していない仕入だけ。取消済みを並べると、
  // 選んで「登録する」を押して初めて「取消済みです」と弾かれてしまう
  const purchases = useFetch<Paged<PurchaseOpt>>(f.partner ? '/purchases' : null, { supplier_partner_id: f.partner?.id, exclude_cancelled: true, limit: 50 });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const reloadAll = async () => {
    await Promise.all([list.reload(), payments.reload()]);
  };

  const openNew = () => {
    setEditing(null);
    setF(emptyForm());
    setError(null);
    setOpen(true);
  };

  const openEdit = (r: PaymentRow) => {
    setEditing(r);
    setF({
      partner: { id: r.partner_id, label: r.supplier_name },
      date: String(r.payment_date).slice(0, 10),
      amount: plain(r.amount),
      purchase_id: r.purchase_id ? String(r.purchase_id) : '',
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
        // 仕入先は入れ替えさせない（買掛残高が2社にまたがって動くため）。
        // 相手を間違えたときは削除して入れ直していただく
        await api.patch(`/payments/${editing.id}`, {
          payment_date: f.date,
          amount: f.amount,
          purchase_id: f.purchase_id ? Number(f.purchase_id) : null,
          note: f.note || null,
        });
        toast('支払を直しました', 'good');
      } else {
        await api.post('/payments', {
          partner_id: f.partner?.id,
          payment_date: f.date,
          amount: f.amount,
          purchase_id: f.purchase_id ? Number(f.purchase_id) : null,
          note: f.note || null,
        });
        toast('支払を登録しました', 'good');
      }
      setOpen(false);
      setEditing(null);
      setF(emptyForm());
      await reloadAll();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: PaymentRow) => {
    if (!(await confirm('この支払を削除しますか', `${ymd(r.payment_date)}　${r.supplier_name}　${money(r.amount)} 円を削除します。消した分だけ買掛残高が戻ります。`, true))) return;
    setRemovingId(r.id);
    try {
      await api.delete(`/payments/${r.id}`);
      toast('支払を削除しました', 'good');
      await reloadAll();
    } catch (e) {
      toast(e instanceof Error ? e.message : '削除できませんでした', 'bad');
    } finally {
      setRemovingId(null);
    }
  };

  const options = purchases.data?.items ?? [];
  // 今つながっている仕入が一覧の先頭50件に入っていないことがある。選び直すまで消えないようにする
  const linkedMissing = editing?.purchase_id && !options.some((p) => p.id === editing.purchase_id) ? editing : null;

  return (
    <div className="page-body">
      {element}
      <PageHead
        title="買掛・支払"
        sub="仕入先ごとの前月繰越・仕入額・支払額・残高です。支払は下の一覧から直せます"
        right={can('P-01', 'create') && <Button variant="primary" icon="plus" onClick={openNew}>支払を登録</Button>}
      />
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
            { key: 'carryover_amount', label: '前月繰越', r: true, width: 130, render: (r) => money(r.carryover_amount) },
            { key: 'purchase_amount', label: '仕入・経費', r: true, width: 130, render: (r) => money(r.purchase_amount) },
            { key: 'payment_amount', label: '支払', r: true, width: 130, render: (r) => money(r.payment_amount) },
            { key: 'balance', label: '残高', r: true, width: 130, render: (r) => <b>{money(r.balance)}</b> },
          ]}
          rows={list.data ?? []}
          rowKey={(r) => r.partner_id}
          loading={list.loading}
        />
      </Card>

      {canViewPayments && (
        <Card>
          <CardHead
            title="この月の支払"
            sub="登録を間違えたときは、ここから訂正・削除できます"
            right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{payments.data?.total ?? 0}</Num> 件</span>}
          />
          <Toolbar>
            <SearchSelect value={payPartner} onChange={setPayPartner} fetchOptions={fetchSuppliers} placeholder="仕入先で絞る" width={220} />
          </Toolbar>
          {payments.error ? <div className="p-3"><ErrorBox error={payments.error} /></div> : null}
          <DataTable<PaymentRow>
            columns={[
              { key: 'payment_date', label: '支払日', width: 110, render: (r) => <Num>{ymd(r.payment_date)}</Num> },
              { key: 'supplier_name', label: '仕入先' },
              { key: 'amount', label: '支払額', r: true, width: 120, render: (r) => money(r.amount) },
              { key: 'purchase_no', label: '対象の仕入', width: 150, render: (r) => <Num>{r.purchase_no ?? '（指定なし）'}</Num> },
              { key: 'note', label: '備考', render: (r) => <span className="truncate block max-w-[200px]">{r.note ?? ''}</span> },
              {
                key: '_act',
                label: '',
                width: 130,
                render: (r) => (
                  <span className="flex gap-1">
                    {can('P-01', 'update') && <Button size="sm" onClick={() => openEdit(r)}>編集</Button>}
                    {can('P-01', 'delete') && <Button size="sm" variant="danger" loading={removingId === r.id} onClick={() => remove(r)}>削除</Button>}
                  </span>
                ),
              },
            ]}
            rows={payments.data?.items ?? []}
            rowKey={(r) => r.id}
            loading={payments.loading}
            empty="この月の支払はありません"
          />
          <Pager total={payments.data?.total ?? 0} limit={PAY_LIMIT} offset={payOffset} onChange={setPayOffset} />
        </Card>
      )}

      <Modal
        open={open}
        title={editing ? `支払の訂正　${ymd(editing.payment_date)}　${editing.supplier_name}` : '支払の登録'}
        onClose={() => setOpen(false)}
        width={560}
        footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} onClick={save}>{editing ? '直す' : '登録する'}</Button></>}
      >
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <FormRow label="仕入先" required hint={editing ? '訂正では変えられません。相手が違うときは削除して入れ直してください' : undefined}>
          {editing
            ? <span className="text-[12.5px]">{editing.supplier_name}</span>
            : <SearchSelect value={f.partner} onChange={(o) => setF({ ...f, partner: o, purchase_id: '' })} fetchOptions={fetchSuppliers} placeholder="仕入先を検索" width="100%" />}
        </FormRow>
        <FormRow label="支払日" required><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} className="!w-[150px]" /></FormRow>
        <FormRow label="支払額" required><Input right value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className="!w-[150px]" /></FormRow>
        <FormRow label="対象の仕入" hint={editing ? '外すと「指定しない」に戻ります。取消済みの仕入は出ません' : '任意。取消済みの仕入は出ません'}>
          <Select value={f.purchase_id} onChange={(e) => setF({ ...f, purchase_id: e.target.value })} disabled={!f.partner}>
            <option value="">（指定しない）</option>
            {linkedMissing && <option value={String(linkedMissing.purchase_id)}>{linkedMissing.purchase_no}　（今の対象）</option>}
            {options.map((p) => <option key={p.id} value={p.id}>{p.purchase_no}　{money(p.total_amount)}</option>)}
          </Select>
        </FormRow>
        <FormRow label="備考"><Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></FormRow>
      </Modal>
    </div>
  );
}
