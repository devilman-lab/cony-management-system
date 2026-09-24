'use client';

import { useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useList, useSalesCategories } from '@/lib/hooks';
import { addMonths, monthRange, qty, thisMonth, ymd } from '@/lib/format';
import { Button, Card, DataTable, ErrorBox, FormRow, Input, Modal, Num, PageHead, Pager, Select, Toolbar, useConfirm } from '@/components/ui';
import { SearchSelect, fetchPartners, fetchSkus, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface ReservationRow extends Record<string, unknown> {
  id: number;
  partner_id: number | null;
  partner_name: string | null;
  sales_category_id: number;
  sales_category_name: string;
  sku_id: number;
  sku_code: string;
  product_name: string;
  period_from: string;
  period_to: string;
  reserved_qty: string;
  consumed_qty: string;
  remaining_qty: string;
}

/**
 * 引当在庫（確保数）。月初に販売カテゴリー×商品で枠を登録し、受注登録のたびにここから減る。
 * 期間で持つため、月末を過ぎると自動的に効かなくなり、翌月1日から翌月の枠が使われる。
 */
export default function AllocationPage() {
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const categories = useSalesCategories();
  const fetchCustomers = useMemo(() => fetchPartners('customer'), []);

  const [month, setMonth] = useState(thisMonth());
  const [categoryId, setCategoryId] = useState('');
  // その月に少しでもかかる枠をすべて出す（月の15日で判定すると、月の途中から始まる枠が出ない）
  const range = monthRange(month);
  const list = useList<ReservationRow>(
    '/inventory/reservations',
    { from: range.from, to: range.to, sales_category_id: categoryId || undefined },
    200,
  );

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ReservationRow | null>(null);
  const [f, setF] = useState({ category: '', sku: null as Option | null, partner: null as Option | null, from: '', to: '', qty: '', note: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const openNew = () => {
    const r = monthRange(month);
    setEditing(null);
    setF({ category: categoryId || String(categories.data?.[0]?.id ?? ''), sku: null, partner: null, from: r.from, to: r.to, qty: '', note: '' });
    setError(null);
    setOpen(true);
  };
  const openEdit = (row: ReservationRow) => {
    setEditing(row);
    setF({ category: String(row.sales_category_id), sku: { id: row.sku_id, label: `${row.sku_code}　${row.product_name}` }, partner: row.partner_id ? { id: row.partner_id, label: row.partner_name ?? '' } : null, from: row.period_from, to: row.period_to, qty: row.reserved_qty, note: '' });
    setError(null);
    setOpen(true);
  };

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      if (editing) {
        await api.patch(`/inventory/reservations/${editing.id}`, { reserved_qty: f.qty, period_to: f.to });
        toast('枠を更新しました', 'good');
      } else {
        await api.post('/inventory/reservations', {
          partner_id: f.partner?.id ?? null,
          sales_category_id: Number(f.category),
          sku_id: f.sku?.id,
          period_from: f.from,
          period_to: f.to,
          reserved_qty: f.qty,
          note: f.note || null,
        });
        toast('引当在庫を登録しました', 'good');
      }
      setOpen(false);
      await list.reload();
    } catch (e) {
      setError(e);
      // 失敗した理由が「今の使用数」に依るので、画面の数字を最新にしておく
      await list.reload();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: ReservationRow) => {
    if (!(await confirm('この枠を削除しますか', 'まだ受注で使われていない枠だけ削除できます。', true))) return;
    try {
      await api.delete(`/inventory/reservations/${row.id}`);
      toast('削除しました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    }
  };

  const copyFromPrev = async () => {
    const prev = addMonths(month, -1);
    if (!(await confirm(`${prev} の枠を ${month} に複写しますか`, '同じ枠がすでにある月には複写しません。複写後に数量を直してください。'))) return;
    try {
      const r = await api.post<{ copied: number; skipped: number }>('/inventory/reservations/copy', { from_month: prev, to_month: month });
      toast(`${r.copied} 件を複写しました（${r.skipped} 件は既にあるため飛ばしました）`, 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    }
  };

  const totals = list.items.reduce((a, r) => ({ reserved: a.reserved + Number(r.reserved_qty), consumed: a.consumed + Number(r.consumed_qty) }), { reserved: 0, consumed: 0 });

  return (
    <div className="page-body">
      {element}
      <PageHead
        title="引当在庫（確保数）"
        sub="販売カテゴリー×商品ごとに月の枠を登録します。受注登録のたびにこの枠から減り、月末を過ぎると自動的に翌月の枠に切り替わります"
        right={
          can('S-08', 'create') && (
            <>
              <Button onClick={copyFromPrev}>前月の枠を複写</Button>
              <Button variant="primary" icon="plus" onClick={openNew}>枠を登録</Button>
            </>
          )
        }
      />
      <div className="grid-auto-stats">
        <div className="card px-3.5 py-3"><div className="text-[11px] text-[var(--color-ink-3)] font-semibold">登録した枠（表示分）</div><div className="num text-[20px] font-bold">{qty(totals.reserved)}</div></div>
        <div className="card px-3.5 py-3"><div className="text-[11px] text-[var(--color-ink-3)] font-semibold">受注で使った数</div><div className="num text-[20px] font-bold">{qty(totals.consumed)}</div></div>
        <div className="card px-3.5 py-3"><div className="text-[11px] text-[var(--color-ink-3)] font-semibold">残り</div><div className="num text-[20px] font-bold text-[var(--color-brand-700)]">{qty(totals.reserved - totals.consumed)}</div></div>
      </div>
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.total}</Num> 件</span>}>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="!w-[150px]" />
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="!w-[170px]">
            <option value="">販売カテゴリー：すべて</option>
            {(categories.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<ReservationRow>
          wide
          columns={[
            { key: 'sales_category_name', label: '販売カテゴリー', width: 120 },
            { key: 'sku_code', label: 'SKU', width: 150, render: (r) => <Num className="font-semibold">{r.sku_code}</Num> },
            { key: 'product_name', label: '商品' },
            { key: 'partner_name', label: '取引先', width: 150, render: (r) => r.partner_name ?? <span className="text-[var(--color-ink-3)]">（カテゴリー全体）</span> },
            { key: 'period_from', label: '期間', width: 190, render: (r) => <Num>{ymd(r.period_from)} 〜 {ymd(r.period_to)}</Num> },
            { key: 'reserved_qty', label: '枠', r: true, width: 80, render: (r) => qty(r.reserved_qty) },
            { key: 'consumed_qty', label: '使用', r: true, width: 80, render: (r) => qty(r.consumed_qty) },
            { key: 'remaining_qty', label: '残り', r: true, width: 80, render: (r) => <b className={Number(r.remaining_qty) <= 0 ? 'text-[var(--color-crit-500)]' : ''}>{qty(r.remaining_qty)}</b> },
            {
              key: '_act', label: '', width: 120,
              render: (r) => (
                <div className="flex gap-1">
                  {can('S-08', 'update') && <Button size="sm" onClick={() => openEdit(r)}>数量</Button>}
                  {can('S-08', 'delete') && Number(r.consumed_qty) === 0 && <Button size="sm" variant="quiet" className="!text-[var(--color-crit-500)]" onClick={() => remove(r)}>削除</Button>}
                </div>
              ),
            },
          ]}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
          empty="この月の枠はありません。「前月の枠を複写」か「枠を登録」から始めてください"
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>

      <Modal open={open} title={editing ? '枠の変更' : '引当在庫の登録'} onClose={() => setOpen(false)} width={620} footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} onClick={save}>{editing ? '保存する' : '登録する'}</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <FormRow label="販売カテゴリー" required>
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} disabled={!!editing} className="!w-[200px]">
            {(categories.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </FormRow>
        <FormRow label="商品（SKU）" required>
          <SearchSelect value={f.sku} onChange={(o) => setF({ ...f, sku: o })} fetchOptions={fetchSkus} placeholder="SKU・JAN・商品名" width="100%" disabled={!!editing} />
        </FormRow>
        <FormRow label="取引先" hint="空ならカテゴリー全体の枠">
          <SearchSelect value={f.partner} onChange={(o) => setF({ ...f, partner: o })} fetchOptions={fetchCustomers} placeholder="（指定なし）" width={240} disabled={!!editing} />
        </FormRow>
        <FormRow label="期間" required>
          <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} className="!w-[150px]" disabled={!!editing} />
          <span className="text-[var(--color-ink-3)]">〜</span>
          <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} className="!w-[150px]" />
        </FormRow>
        <FormRow label="数量（枠）" required>
          <Input right value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} className="!w-[120px]" />
          {editing && <span className="text-[10.5px] text-[var(--color-ink-3)]">すでに {qty(editing.consumed_qty)} 使われています。それより減らせません</span>}
        </FormRow>
        {!editing && (
          <FormRow label="備考">
            <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </FormRow>
        )}
      </Modal>
    </div>
  );
}
