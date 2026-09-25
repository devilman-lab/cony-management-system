'use client';

import { useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch } from '@/lib/hooks';
import { money, thisMonth, today, ymd } from '@/lib/format';
import { Button, Card, DataTable, ErrorBox, FormRow, Input, Modal, PageHead, Select, Textarea, Toolbar, useConfirm } from '@/components/ui';
import { SearchSelect, fetchPartners, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface CashRow extends Record<string, unknown> {
  id: number;
  cash_transaction_no: string;
  division: string;
  target_month: string;
  transaction_date: string | null;
  partner_id: number | null;
  partner_name: string | null;
  amount: string;
  cash_amount: string | null;
  transfer_amount: string | null;
  card_amount: string | null;
  bill_amount1: string | null;
  bill_amount2: string | null;
  bill_due_date1: string | null;
  bill_due_date2: string | null;
  offset_amount: string | null;
  check_amount: string | null;
  collection_amount: string | null;
  overseas_usd: string | null;
  overseas_cny: string | null;
  fee_amount: string | null;
  note: string | null;
}

/** 海外送金は円に換算していない。合計と足し合わせて読まないよう、単位を出して断りを添える */
const FX_NOTE = '円に換算していません';

const MEANS: { k: string; label: string; hint?: string }[] = [
  { k: 'transfer_amount', label: '振込' },
  { k: 'cash_amount', label: '現金' },
  { k: 'card_amount', label: 'カード' },
  { k: 'bill_amount1', label: '手形①' },
  { k: 'bill_amount2', label: '手形②' },
  { k: 'offset_amount', label: '相殺' },
  { k: 'check_amount', label: '小切手' },
  { k: 'collection_amount', label: '集金' },
  { k: 'overseas_usd', label: '海外送金 (USD)', hint: FX_NOTE },
  { k: 'overseas_cny', label: '海外送金 (CNY)', hint: FX_NOTE },
  { k: 'fee_amount', label: '手数料', hint: '合計には含みません' },
];

/** NUMERIC は "1500.00" の形で返る。入力欄に入れるときだけ見た目を整える（数値には通さない）。 */
const plain = (v: string | null | undefined): string => (v ?? '').replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');

const emptyForm = (): Record<string, string> => ({ division: '入金', target_month: thisMonth(), transaction_date: today(), note: '' });

/** 入出金処理（C-01）。1件ずつ登録が基本。手段ごとの内訳から合計を求める。 */
export default function CashPage() {
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const fetchAll = useMemo(() => fetchPartners(), []);
  const [month, setMonth] = useState(thisMonth());
  const [division, setDivision] = useState('');
  const list = useFetch<CashRow[]>('/cash-transactions', { target_month: month, division: division || undefined });

  const [open, setOpen] = useState(false);
  // 訂正中の入出金。null なら新規登録
  const [editing, setEditing] = useState<CashRow | null>(null);
  const [f, setF] = useState<Record<string, string>>(emptyForm());
  const [partner, setPartner] = useState<Option | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const openNew = () => {
    setEditing(null);
    setF(emptyForm());
    setPartner(null);
    setError(null);
    setOpen(true);
  };

  const openEdit = (r: CashRow) => {
    setEditing(r);
    const next: Record<string, string> = {
      division: r.division,
      target_month: String(r.target_month).slice(0, 7),
      transaction_date: r.transaction_date ? String(r.transaction_date).slice(0, 10) : '',
      note: r.note ?? '',
      bill_due_date1: r.bill_due_date1 ? String(r.bill_due_date1).slice(0, 10) : '',
      bill_due_date2: r.bill_due_date2 ? String(r.bill_due_date2).slice(0, 10) : '',
    };
    for (const m of MEANS) next[m.k] = plain(r[m.k] as string | null);
    setF(next);
    setPartner(r.partner_id ? { id: r.partner_id, label: r.partner_name ?? '' } : null);
    setError(null);
    setOpen(true);
  };

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { division: f.division, target_month: f.target_month, transaction_date: f.transaction_date || null, partner_id: partner?.id ?? null, note: f.note || null };
      // 訂正では空にした欄を「消す」として送る。登録のときは送らない（空欄のまま入る）
      for (const m of MEANS) {
        if (f[m.k]) body[m.k] = f[m.k];
        else if (editing) body[m.k] = null;
      }
      for (const k of ['bill_due_date1', 'bill_due_date2']) {
        if (f[k]) body[k] = f[k];
        else if (editing) body[k] = null;
      }
      if (editing) {
        await api.patch(`/cash-transactions/${editing.id}`, body);
        toast('入出金を直しました', 'good');
      } else {
        await api.post('/cash-transactions', body);
        toast('入出金を登録しました', 'good');
      }
      setOpen(false);
      setEditing(null);
      setF(emptyForm());
      setPartner(null);
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: CashRow) => {
    const body = `${r.cash_transaction_no}　${r.division}　${ymd(r.transaction_date)}　${r.partner_name ?? '（取引先なし）'}　合計 ${money(r.amount)} 円を削除します。この月の入出金一覧から消え、消した分だけ合計が戻ります。`;
    if (!(await confirm('この入出金を削除しますか', body, true))) return;
    setRemovingId(r.id);
    try {
      await api.delete(`/cash-transactions/${r.id}`);
      toast('入出金を削除しました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '削除できませんでした', 'bad');
    } finally {
      setRemovingId(null);
    }
  };

  const total = MEANS.filter((m) => m.k !== 'fee_amount').reduce((a, m) => a + Number(f[m.k] || 0), 0);
  const canEdit = can('C-01', 'update');
  const canRemove = can('C-01', 'delete');

  return (
    <div className="page-body">
      {element}
      <PageHead title="入出金" sub="入金・出金を1件ずつ登録します。振込・現金・カード・手形・相殺・小切手・集金・海外送金の内訳から合計を求めます" right={can('C-01', 'create') && <Button variant="primary" icon="plus" onClick={openNew}>入出金を登録</Button>} />
      <Card>
        <Toolbar>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="!w-[150px]" />
          <Select value={division} onChange={(e) => setDivision(e.target.value)} className="!w-[110px]"><option value="">入金・出金</option><option>入金</option><option>出金</option></Select>
        </Toolbar>
        <div className="px-3.5 py-2 text-[11.5px] text-[var(--color-ink-3)] border-b border-[var(--color-line)]">
          「合計」は振込・現金・カード・手形①②・相殺・小切手・集金・海外送金の合計です。手数料は含みません。海外送金の (USD)(CNY) は{FX_NOTE}ので、円の欄とは別のものとしてご覧ください。打ち間違えたときは、行の「編集」から直せます。
        </div>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<CashRow>
          wide
          stickyLast
          columns={[
            { key: 'cash_transaction_no', label: '番号', width: 100, render: (r) => <span className="num font-semibold">{r.cash_transaction_no}</span> },
            { key: 'division', label: '区分', width: 60 },
            { key: 'transaction_date', label: '日付', width: 100, render: (r) => ymd(r.transaction_date) },
            { key: 'partner_name', label: '取引先', render: (r) => r.partner_name ?? '' },
            { key: 'amount', label: '合計', r: true, width: 110, render: (r) => <b>{money(r.amount)}</b> },
            { key: 'transfer_amount', label: '振込', r: true, width: 90, render: (r) => money(r.transfer_amount) },
            { key: 'cash_amount', label: '現金', r: true, width: 80, render: (r) => money(r.cash_amount) },
            { key: 'card_amount', label: 'カード', r: true, width: 80, render: (r) => money(r.card_amount) },
            { key: 'bill_amount1', label: '手形①', r: true, width: 90, render: (r) => money(r.bill_amount1) },
            { key: 'bill_amount2', label: '手形②', r: true, width: 90, render: (r) => money(r.bill_amount2) },
            { key: 'offset_amount', label: '相殺', r: true, width: 80, render: (r) => money(r.offset_amount) },
            { key: 'check_amount', label: '小切手', r: true, width: 80, render: (r) => money(r.check_amount) },
            { key: 'collection_amount', label: '集金', r: true, width: 80, render: (r) => money(r.collection_amount) },
            // 見出しに単位を出す。合計（円）に足し込まれているが換算はしていない
            { key: 'overseas_usd', label: '海外送金 (USD)', r: true, width: 110, render: (r) => money(r.overseas_usd) },
            { key: 'overseas_cny', label: '海外送金 (CNY)', r: true, width: 110, render: (r) => money(r.overseas_cny) },
            // 手数料は内訳ではなく差し引き。合計には入れない
            { key: 'fee_amount', label: '手数料', r: true, width: 90, render: (r) => money(r.fee_amount) },
            {
              key: '_act',
              label: '',
              width: 130,
              render: (r) => (
                <span className="flex gap-1">
                  {canEdit && <Button size="sm" onClick={() => openEdit(r)}>編集</Button>}
                  {canRemove && <Button size="sm" variant="danger" loading={removingId === r.id} onClick={() => remove(r)}>削除</Button>}
                </span>
              ),
            },
          ]}
          rows={list.data ?? []}
          rowKey={(r) => r.id}
          loading={list.loading}
        />
      </Card>

      <Modal
        open={open}
        title={editing ? `入出金の訂正　${editing.cash_transaction_no}　${editing.division}` : '入出金の登録'}
        onClose={() => setOpen(false)}
        width={720}
        footer={<><span className="mr-auto text-[12px]">合計 <b className="num">{money(total)}</b> 円</span><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} onClick={save}>{editing ? '直す' : '登録する'}</Button></>}
      >
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <div className="master-grid-2">
          <FormRow label="区分" required><Select value={f.division} onChange={(e) => setF({ ...f, division: e.target.value })} className="!w-[110px]"><option>入金</option><option>出金</option></Select></FormRow>
          <FormRow label="対象月" required><Input type="month" value={f.target_month} onChange={(e) => setF({ ...f, target_month: e.target.value })} className="!w-[150px]" /></FormRow>
          <FormRow label="取引先"><SearchSelect value={partner} onChange={setPartner} fetchOptions={fetchAll} placeholder="取引先を検索" width="100%" /></FormRow>
          <FormRow label="日付"><Input type="date" value={f.transaction_date ?? ''} onChange={(e) => setF({ ...f, transaction_date: e.target.value })} className="!w-[150px]" /></FormRow>
        </div>
        <div className="mt-3 master-grid-2">
          {MEANS.map((m) => (
            <FormRow key={m.k} label={m.label} hint={m.hint}>
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
