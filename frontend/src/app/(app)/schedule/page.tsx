'use client';

import { useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useList, useSalesCategories } from '@/lib/hooks';
import { qty, thisMonth } from '@/lib/format';
import { Button, Card, DataTable, ErrorBox, FormRow, Input, Modal, Num, PageHead, Pager, Select, Textarea, Toolbar, useConfirm } from '@/components/ui';
import { SearchSelect, fetchPartners, fetchSkus, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface ScheduleRow extends Record<string, unknown> {
  id: number;
  partner_id: number | null;
  partner_name: string | null;
  sales_category_id: number | null;
  sales_category_name: string | null;
  sku_id: number | null;
  sku_code: string | null;
  product_name: string | null;
  planned_sales_month: string | null;
  planned_arrival_month: string | null;
  planned_qty: string | null;
  note: string | null;
}

const ym = (v: string | null | undefined) => (v ? v.slice(0, 7) : '');

/** 販売予定（S-08 の一部）。取引先×商品ごとに「いつ・いくつ売る予定か」「いつ入荷するか」を控える。 */
export default function SchedulePage() {
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const categories = useSalesCategories();
  const fetchCustomers = useMemo(() => fetchPartners('customer'), []);

  const [month, setMonth] = useState(thisMonth());
  const [allMonths, setAllMonths] = useState(false);
  const list = useList<ScheduleRow>('/sales-schedules', { month: allMonths ? undefined : month }, 100);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduleRow | null>(null);
  const [f, setF] = useState({ partner: null as Option | null, sku: null as Option | null, category: '', sales_month: '', arrival_month: '', qty: '', note: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const openNew = () => {
    setEditing(null);
    setF({ partner: null, sku: null, category: '', sales_month: month, arrival_month: '', qty: '', note: '' });
    setError(null);
    setOpen(true);
  };
  const openEdit = (r: ScheduleRow) => {
    setEditing(r);
    setF({
      partner: r.partner_id ? { id: r.partner_id, label: r.partner_name ?? '' } : null,
      sku: r.sku_id ? { id: r.sku_id, label: `${r.sku_code}　${r.product_name}` } : null,
      category: r.sales_category_id ? String(r.sales_category_id) : '',
      sales_month: ym(r.planned_sales_month),
      arrival_month: ym(r.planned_arrival_month),
      qty: r.planned_qty ?? '',
      note: r.note ?? '',
    });
    setError(null);
    setOpen(true);
  };

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const body = {
        partner_id: f.partner?.id ?? null,
        sku_id: f.sku?.id ?? null,
        sales_category_id: f.category ? Number(f.category) : null,
        planned_sales_month: f.sales_month || null,
        planned_arrival_month: f.arrival_month || null,
        planned_qty: f.qty || null,
        note: f.note || null,
      };
      if (editing) await api.patch(`/sales-schedules/${editing.id}`, body);
      else await api.post('/sales-schedules', body);
      toast(editing ? '更新しました' : '登録しました', 'good');
      setOpen(false);
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: ScheduleRow) => {
    if (!(await confirm('この販売予定を削除しますか'))) return;
    try {
      await api.delete(`/sales-schedules/${r.id}`);
      toast('削除しました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    }
  };

  return (
    <div className="page-body">
      {element}
      <PageHead title="販売予定" sub="取引先・商品ごとの販売予定数と入荷予定月を控えておく表です。引当在庫（確保数）とは別で、在庫は動きません" right={can('S-08', 'create') && <Button variant="primary" icon="plus" onClick={openNew}>予定を登録</Button>} />
      <Card>
        <Toolbar>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="!w-[150px]" disabled={allMonths} />
          <label className="flex items-center gap-1 text-[12px]"><input type="checkbox" checked={allMonths} onChange={(e) => setAllMonths(e.target.checked)} />すべての月</label>
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<ScheduleRow>
          columns={[
            { key: 'planned_sales_month', label: '販売予定月', width: 100, render: (r) => <Num>{ym(r.planned_sales_month).replace('-', '/')}</Num> },
            { key: 'partner_name', label: '取引先', render: (r) => r.partner_name ?? <span className="text-[var(--color-ink-3)]">（指定なし）</span> },
            { key: 'sales_category_name', label: '販売カテゴリー', width: 130, render: (r) => r.sales_category_name ?? '' },
            { key: 'sku_code', label: 'SKU', width: 120, render: (r) => <Num>{r.sku_code ?? ''}</Num> },
            { key: 'product_name', label: '商品', render: (r) => r.product_name ?? '' },
            { key: 'planned_qty', label: '予定数', r: true, width: 90, render: (r) => <b>{qty(r.planned_qty)}</b> },
            { key: 'planned_arrival_month', label: '入荷予定', width: 100, render: (r) => <Num>{ym(r.planned_arrival_month).replace('-', '/')}</Num> },
            { key: 'note', label: '備考', render: (r) => <span className="truncate block max-w-[240px]">{r.note ?? ''}</span> },
            { key: '_act', label: '', width: 110, render: (r) => <span className="flex gap-1">{can('S-08', 'update') && <Button size="sm" onClick={() => openEdit(r)}>編集</Button>}{can('S-08', 'delete') && <Button size="sm" variant="danger" onClick={() => remove(r)}>削除</Button>}</span> },
          ]}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
          empty="この月の販売予定はありません"
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>

      <Modal open={open} title={editing ? '販売予定の編集' : '販売予定の登録'} onClose={() => setOpen(false)} width={600} footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} onClick={save}>{editing ? '更新する' : '登録する'}</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <FormRow label="販売予定月" required><Input type="month" value={f.sales_month} onChange={(e) => setF({ ...f, sales_month: e.target.value })} className="!w-[150px]" /></FormRow>
        <FormRow label="取引先"><SearchSelect value={f.partner} onChange={(o) => setF({ ...f, partner: o })} fetchOptions={fetchCustomers} placeholder="得意先を検索" width="100%" /></FormRow>
        <FormRow label="販売カテゴリー">
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} className="!w-[200px]">
            <option value="">（指定なし）</option>
            {(categories.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </FormRow>
        <FormRow label="商品（SKU）"><SearchSelect value={f.sku} onChange={(o) => setF({ ...f, sku: o })} fetchOptions={fetchSkus} placeholder="SKU・JAN・商品名で検索" width="100%" /></FormRow>
        <FormRow label="予定数"><Input right value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} className="!w-[120px]" /></FormRow>
        <FormRow label="入荷予定月"><Input type="month" value={f.arrival_month} onChange={(e) => setF({ ...f, arrival_month: e.target.value })} className="!w-[150px]" /></FormRow>
        <FormRow label="備考"><Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></FormRow>
      </Modal>
    </div>
  );
}
