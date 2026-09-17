'use client';

import Link from 'next/link';

import { useAuth } from '@/lib/auth';
import { useFetch } from '@/lib/hooks';
import { today, ymd } from '@/lib/format';
import type { Paged } from '@/lib/api';
import { Badge, Card, CardHead, DataTable, KpiTile, Num, PageHead } from '@/components/ui';

interface OrderRow extends Record<string, unknown> {
  id: number;
  order_no: string;
  order_type: string;
  status: string;
  order_date: string;
  partner_name: string;
  delivery_name: string | null;
  staff_name: string | null;
  shipment_status: string | null;
}

/** ダッシュボード。今日やることが一目で分かるように、件数と直近の受注を出す。 */
export default function DashboardPage() {
  const { user, can } = useAuth();
  const t = today();
  const waiting = useFetch<Paged<OrderRow>>(can('O-03') ? '/orders' : null, { status: '引当待ち', limit: 1 });
  const ready = useFetch<Paged<OrderRow>>(can('O-03') ? '/orders' : null, { status: '引当済', limit: 1 });
  const shippedToday = useFetch<Paged<Record<string, unknown>>>(can('D-01') ? '/shipments' : null, { status: '出荷済', from: t, to: t, limit: 1 });
  const unissued = useFetch<Paged<Record<string, unknown>>>(can('B-02') ? '/billing/invoices' : null, { status: '未発行', limit: 1 });
  const recent = useFetch<Paged<OrderRow>>(can('O-03') ? '/orders' : null, { limit: 10 });

  return (
    <div className="page-body">
      <PageHead title={`こんにちは、${user?.name ?? ''} さん`} sub={`${ymd(t)} の状況です`} />

      <div className="grid-kpi">
        <Link href="/orders?status=引当待ち">
          <KpiTile label="引当待ちの受注" value={<Num>{waiting.data?.total ?? '–'}</Num>} sub="在庫が空いたら引き当て直す" tone={(waiting.data?.total ?? 0) > 0 ? 'warn' : undefined} />
        </Link>
        <Link href="/shipping">
          <KpiTile label="出荷待ち（引当済）" value={<Num>{ready.data?.total ?? '–'}</Num>} sub="出荷確定・印刷へ" />
        </Link>
        <KpiTile label="本日の出荷" value={<Num>{shippedToday.data?.total ?? '–'}</Num>} sub="出荷確定した件数" />
        <Link href="/invoices">
          <KpiTile label="未発行の請求" value={<Num>{unissued.data?.total ?? '–'}</Num>} sub="締め処理で作られた請求" />
        </Link>
      </div>

      {can('O-03') && (
        <Card>
          <CardHead title="直近の受注" right={<Link href="/orders" className="btn btn-ghost btn-sm">一覧へ</Link>} />
          <DataTable<OrderRow>
            columns={[
              { key: 'order_no', label: '受注番号', render: (r) => <Link href={`/orders/${r.id}`} className="num font-semibold text-[var(--color-brand-700)]">{r.order_no}</Link> },
              { key: 'order_date', label: '受注日', render: (r) => <Num>{ymd(r.order_date)}</Num> },
              { key: 'order_type', label: '区分' },
              { key: 'partner_name', label: '取引先' },
              { key: 'delivery_name', label: '納品先', render: (r) => r.delivery_name ?? '（直送）' },
              { key: 'staff_name', label: '販売担当', render: (r) => r.staff_name ?? '' },
              { key: 'status', label: '状態', render: (r) => <Badge status={r.status} /> },
            ]}
            rows={recent.data?.items ?? []}
            rowKey={(r) => r.id}
            loading={recent.loading}
          />
        </Card>
      )}

      <div className="text-[11px] text-[var(--color-ink-3)]">
        金額の表示はすべて税抜です。
      </div>
    </div>
  );
}
