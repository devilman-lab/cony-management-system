'use client';

import { useState } from 'react';

import { useList, useWarehouses } from '@/lib/hooks';
import { qty, ymdhm } from '@/lib/format';
import { Card, DataTable, ErrorBox, Input, Num, PageHead, Pager, Select, Toolbar } from '@/components/ui';

interface MoveRow extends Record<string, unknown> {
  id: number;
  moved_at: string;
  movement_type: string;
  ref_table: string;
  ref_id: number;
  qty: string;
  qty_before: string;
  qty_after: string;
  sku_code: string;
  product_name: string;
  warehouse_name: string;
  user_name: string | null;
}

const TYPES = ['入荷', '出荷', '出荷取消', '引当', '引当解除', '返品入庫', '再生', '不良振替', '倉庫間移動', '棚卸調整', '廃棄'];
const REF: Record<string, string> = { shipments: '出荷', sales_order_lines: '受注', receipts: '入荷', returns: '返品', stock_adjustments: '在庫調整', refurbishments: '再生' };

export default function MovesPage() {
  const warehouses = useWarehouses();
  const [type, setType] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const list = useList<MoveRow>('/inventory/stocks/movements', {
    movement_type: type || undefined,
    warehouse_id: warehouseId || undefined,
    from: from || undefined,
    to: to || undefined,
  }, 100);

  return (
    <div className="page-body">
      <PageHead title="入出荷履歴" sub="在庫が動いた記録です。追記だけで、消したり直したりはできません" />
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.total}</Num> 件</span>}>
          <Select value={type} onChange={(e) => setType(e.target.value)} className="!w-[130px]">
            <option value="">種別：すべて</option>
            {TYPES.map((t) => <option key={t}>{t}</option>)}
          </Select>
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="!w-[140px]">
            <option value="">倉庫：すべて</option>
            {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.short_name}</option>)}
          </Select>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="!w-[140px]" />
          <span className="text-[var(--color-ink-3)]">〜</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="!w-[140px]" />
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<MoveRow>
          wide
          columns={[
            { key: 'moved_at', label: '日時', width: 130, render: (r) => <Num>{ymdhm(r.moved_at)}</Num> },
            { key: 'movement_type', label: '種別', width: 90 },
            { key: 'sku_code', label: 'SKU', width: 150, render: (r) => <Num>{r.sku_code}</Num> },
            { key: 'product_name', label: '商品' },
            { key: 'warehouse_name', label: '倉庫', width: 100 },
            { key: 'qty', label: '増減', r: true, width: 80, render: (r) => <span className={Number(r.qty) < 0 ? 'text-[var(--color-crit-500)]' : ''}>{Number(r.qty) > 0 ? '+' : ''}{qty(r.qty)}</span> },
            { key: 'qty_before', label: '前', r: true, width: 70, render: (r) => qty(r.qty_before) },
            { key: 'qty_after', label: '後', r: true, width: 70, render: (r) => qty(r.qty_after) },
            { key: 'ref_table', label: '元伝票', width: 110, render: (r) => `${REF[r.ref_table] ?? r.ref_table} #${r.ref_id}` },
            { key: 'user_name', label: '担当', width: 90, render: (r) => r.user_name ?? '' },
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
