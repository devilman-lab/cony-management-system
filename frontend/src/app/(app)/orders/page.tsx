'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useList } from '@/lib/hooks';
import { money, ymd } from '@/lib/format';
import { Badge, Button, Card, DataTable, ErrorBox, Input, Num, PageHead, Pager, Select, Toolbar, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

interface OrderRow extends Record<string, unknown> {
  id: number;
  order_no: string;
  order_type: string;
  status: string;
  order_date: string;
  ship_date: string | null;
  partner_code: string;
  partner_name: string;
  delivery_name: string | null;
  sales_category_name: string;
  staff_name: string | null;
  total_amount: string;
  is_cancelled: boolean;
  shipment_id: number | null;
}

const STATUSES = ['未確定', '引当待ち', '引当済', '出荷指示済', '出荷済', '取消'];
const TYPES = ['卸', '直送', '通販', 'サンプル'];

function OrdersList() {
  const params = useSearchParams();
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();

  const [status, setStatus] = useState(params.get('status') ?? '');
  const [orderType, setOrderType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const list = useList<OrderRow>('/orders', {
    status: status || undefined,
    order_type: orderType || undefined,
    from: from || undefined,
    to: to || undefined,
    include_cancelled: includeCancelled ? 'true' : undefined,
  });

  const allocate = async (row: OrderRow) => {
    setBusyId(row.id);
    try {
      const r = await api.post<{ status: string; shortages: string[] }>(`/orders/${row.id}/allocate`);
      toast(r.status === '引当済' ? `${row.order_no} を引き当てました` : `${row.order_no} はまだ在庫が足りません（${r.shortages.join('、')}）`, r.status === '引当済' ? 'good' : 'info');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (row: OrderRow) => {
    if (!(await confirm(`${row.order_no} を取り消しますか`, '引当は戻ります。取り消した受注は元に戻せません。', true))) return;
    setBusyId(row.id);
    try {
      await api.post(`/orders/${row.id}/cancel`);
      toast(`${row.order_no} を取り消しました`, 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page-body">
      {element}
      <PageHead
        title="受注一覧"
        sub="登録した時点で在庫を引き当てます。引当待ちは在庫が空いたあとに「引当」を押してください"
        right={can('O-01', 'create') && <Link href="/orders/new" className="btn btn-primary">＋ 受注入力</Link>}
      />
      <Card>
        <Toolbar
          right={
            <span className="text-[11.5px] text-[var(--color-ink-2)]">
              <Num className="text-[13px] text-[var(--color-ink)]">{list.total}</Num> 件
            </span>
          }
        >
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="!w-[128px]">
            <option value="">状態：すべて</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Select value={orderType} onChange={(e) => setOrderType(e.target.value)} className="!w-[118px]">
            <option value="">区分：すべて</option>
            {TYPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="!w-[140px]" />
          <span className="text-[var(--color-ink-3)]">〜</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="!w-[140px]" />
          <label className="flex items-center gap-1 text-[11.5px] text-[var(--color-ink-2)]">
            <input type="checkbox" checked={includeCancelled} onChange={(e) => setIncludeCancelled(e.target.checked)} />
            取消も表示
          </label>
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<OrderRow>
          wide
          columns={[
            { key: 'order_no', label: '受注番号', width: 130, render: (r) => <Link href={`/orders/${r.id}`} className="num font-semibold text-[var(--color-brand-700)]">{r.order_no}</Link> },
            { key: 'order_date', label: '受注日', width: 96, render: (r) => <Num>{ymd(r.order_date)}</Num> },
            { key: 'order_type', label: '区分', width: 64 },
            { key: 'partner_name', label: '取引先', render: (r) => <span title={r.partner_code}>{r.partner_name}</span> },
            { key: 'delivery_name', label: '納品先', render: (r) => r.delivery_name ?? '（直送）' },
            { key: 'sales_category_name', label: '販売カテゴリー', width: 110 },
            { key: 'staff_name', label: '販売担当', width: 90, render: (r) => r.staff_name ?? '' },
            { key: 'total_amount', label: '金額', r: true, width: 100, render: (r) => money(r.total_amount) },
            { key: 'ship_date', label: '出荷日', width: 96, render: (r) => <Num>{ymd(r.ship_date)}</Num> },
            { key: 'status', label: '状態', width: 90, render: (r) => <Badge status={r.status} /> },
            {
              key: '_act',
              label: '',
              width: 150,
              render: (r) => (
                <div className="flex items-center gap-1">
                  {r.status === '引当待ち' && can('D-01', 'create') && (
                    <Button size="sm" variant="primary" loading={busyId === r.id} onClick={() => allocate(r)}>
                      引当
                    </Button>
                  )}
                  {['未確定', '引当待ち', '引当済'].includes(r.status) && can('O-01', 'update') && (
                    <Link href={`/orders/${r.id}/edit`} className="btn btn-ghost btn-sm">
                      修正
                    </Link>
                  )}
                  {['未確定', '引当待ち', '引当済'].includes(r.status) && can('O-01', 'delete') && (
                    <Button size="sm" variant="quiet" className="!text-[var(--color-crit-500)]" loading={busyId === r.id} onClick={() => cancel(r)}>
                      取消
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
          empty="該当する受注はありません"
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>
    </div>
  );
}

export default function OrdersPage() {
  return (
    <Suspense>
      <OrdersList />
    </Suspense>
  );
}
