'use client';

import { useState } from 'react';

import { useList, useWarehouses, useDebounce } from '@/lib/hooks';
import { qty, ymd } from '@/lib/format';
import { Card, DataTable, ErrorBox, Input, Num, PageHead, Pager, Select, Toolbar } from '@/components/ui';

interface StockRow extends Record<string, unknown> {
  id: number;
  sku_code: string;
  jan: string | null;
  product_code: string;
  product_name: string;
  color_name: string | null;
  size_name: string | null;
  warehouse_name: string;
  quality_name: string;
  lot_no: string;
  expiry_date: string | null;
  qty_on_hand: string;
  qty_allocated: string;
  qty_available: string;
}

export default function StockPage() {
  const warehouses = useWarehouses();
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 300);
  const [warehouseId, setWarehouseId] = useState('');
  const [availableOnly, setAvailableOnly] = useState(false);

  const list = useList<StockRow>('/inventory/stocks', {
    q: dq || undefined,
    warehouse_id: warehouseId || undefined,
    available_only: availableOnly ? 'true' : undefined,
  }, 100);

  const sum = (k: keyof StockRow) => list.items.reduce((a, r) => a + Number(r[k] ?? 0), 0);

  return (
    <div className="page-body">
      <PageHead title="在庫表" sub="有効在庫＝実在庫−引当済。受注登録で引当済が増え、出荷確定で実在庫が減ります" />
      <div className="inventory-summary">
        <div className="card px-3.5 py-3">
          <div className="text-[11px] text-[var(--color-ink-3)] font-semibold">実在庫（表示分の合計）</div>
          <div className="num text-[20px] font-bold">{qty(sum('qty_on_hand'))}</div>
        </div>
        <div className="card px-3.5 py-3">
          <div className="text-[11px] text-[var(--color-ink-3)] font-semibold">引当済</div>
          <div className="num text-[20px] font-bold">{qty(sum('qty_allocated'))}</div>
        </div>
        <div className="card px-3.5 py-3">
          <div className="text-[11px] text-[var(--color-ink-3)] font-semibold">有効在庫</div>
          <div className="num text-[20px] font-bold text-[var(--color-brand-700)]">{qty(sum('qty_available'))}</div>
        </div>
      </div>
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.total}</Num> 件</span>}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU・JAN・商品名で検索" className="!w-[240px]" />
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="!w-[150px]">
            <option value="">倉庫：すべて</option>
            {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.short_name}</option>)}
          </Select>
          <label className="flex items-center gap-1 text-[11.5px] text-[var(--color-ink-2)]">
            <input type="checkbox" checked={availableOnly} onChange={(e) => setAvailableOnly(e.target.checked)} />
            有効在庫のあるものだけ
          </label>
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<StockRow>
          wide
          columns={[
            { key: 'sku_code', label: 'SKU', width: 150, render: (r) => <Num className="font-semibold">{r.sku_code}</Num> },
            { key: 'product_name', label: '商品', render: (r) => `${r.product_name}${r.color_name ? ' ' + r.color_name : ''}${r.size_name ? ' ' + r.size_name : ''}` },
            { key: 'jan', label: 'JAN', width: 130, render: (r) => <Num>{r.jan ?? ''}</Num> },
            { key: 'warehouse_name', label: '倉庫', width: 100 },
            { key: 'quality_name', label: '品質', width: 80 },
            { key: 'lot_no', label: 'ロット', width: 90 },
            { key: 'expiry_date', label: '期限', width: 96, render: (r) => <Num>{ymd(r.expiry_date)}</Num> },
            { key: 'qty_on_hand', label: '実在庫', r: true, width: 80, render: (r) => qty(r.qty_on_hand) },
            { key: 'qty_allocated', label: '引当済', r: true, width: 80, render: (r) => qty(r.qty_allocated) },
            { key: 'qty_available', label: '有効在庫', r: true, width: 90, render: (r) => <b className={Number(r.qty_available) <= 0 ? 'text-[var(--color-crit-500)]' : ''}>{qty(r.qty_available)}</b> },
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
