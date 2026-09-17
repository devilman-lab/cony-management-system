'use client';

import { useMemo, useState } from 'react';

import { useList } from '@/lib/hooks';
import { money, ymd } from '@/lib/format';
import { Badge, Card, DataTable, ErrorBox, Num, PageHead, Pager, Toolbar, type Column } from '@/components/ui';
import { SearchSelect, fetchPartners, type Option } from '@/components/ui/SearchSelect';

interface ArRow extends Record<string, unknown> {
  id: number;
  invoice_no: string;
  status: string;
  period_to: string;
  partner_code: string;
  partner_name: string;
  prev_invoice_balance: string;
  current_receipt_amount: string;
  carryover_balance: string;
  shipment_amount: string;
  return_amount: string;
  unposted_10: string;
  unposted_8: string;
  fee_amount: string;
  adjust_10: string;
  adjust_8: string;
  shipping_fee_amount: string;
  current_invoice_amount: string;
  current_balance: string;
}

/** 売掛残高一覧（B-04）。現行と同じ12項目を同じ並びで。 */
export default function ArPage() {
  const fetchCustomers = useMemo(() => fetchPartners('customer'), []);
  const [partner, setPartner] = useState<Option | null>(null);
  const list = useList<ArRow>('/billing/ar-balances', { partner_id: partner?.id }, 100);
  const c = (k: keyof ArRow & string, label: string, w = 96): Column<ArRow> => ({ key: k, label, r: true, width: w, render: (r) => money(r[k] as string) });

  return (
    <div className="page-body">
      <PageHead title="売掛残高一覧" sub="請求ごとの残高です。金額は税抜、消費税は請求書の税率別内訳に出ます" />
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.total}</Num> 件</span>}>
          <SearchSelect value={partner} onChange={setPartner} fetchOptions={fetchCustomers} placeholder="取引先で絞る" width={220} />
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<ArRow>
          wide
          columns={[
            { key: 'partner_name', label: '取引先', width: 160 },
            { key: 'period_to', label: '締め日', width: 96, render: (r) => <Num>{ymd(r.period_to)}</Num> },
            { key: 'invoice_no', label: '請求番号', width: 120, render: (r) => <Num>{r.invoice_no}</Num> },
            c('prev_invoice_balance', '前回請求残高', 110),
            c('current_receipt_amount', '今回入金額', 100),
            c('carryover_balance', '繰越残高', 100),
            c('shipment_amount', '出荷', 100),
            c('return_amount', '返品額', 90),
            c('unposted_10', '未計上10%', 90),
            c('unposted_8', '未計上8%', 90),
            c('fee_amount', '手数料', 80),
            c('adjust_10', '調整10%', 80),
            c('adjust_8', '調整8%', 80),
            c('shipping_fee_amount', '送料', 80),
            c('current_invoice_amount', '当月請求額', 110),
            c('current_balance', '今回請求残高', 110),
            { key: 'status', label: '状態', width: 80, render: (r) => <Badge status={r.status} /> },
          ]}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>
    </div>
  );
}
