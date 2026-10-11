'use client';

import { useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useList, useWarehouses, useDebounce } from '@/lib/hooks';
import { money, qty, ymd } from '@/lib/format';
import { Badge, Card, DataTable, ErrorBox, Input, Num, PageHead, Pager, Select, Toolbar, type Column } from '@/components/ui';
import { InlineText } from '@/components/inventory/InlineEdit';
import { useToast } from '@/components/ui/Toast';

interface StockRow extends Record<string, unknown> {
  id: number;
  product_class_code: string | null;
  product_class_name: string | null;
  sku_code: string;
  jan: string | null;
  product_code: string;
  /** SKU ごとの商品名があればそれ（API 側で決めて返す） */
  product_name: string;
  color_name: string | null;
  size_name: string | null;
  warehouse_name: string;
  quality_code: string;
  quality_name: string;
  expiry_date: string | null;
  note: string | null;
  /** 在庫を更新できる人にだけ返る（閲覧だけの人には API が返さない） */
  qty_on_hand?: string;
  qty_allocated?: string;
  qty_available: string;
  /** 機微項目の権限がある人にだけ返る */
  cost_price?: string | null;
}

export default function StockPage() {
  const { can, canSeeSensitive } = useAuth();
  const toast = useToast();
  // 閲覧だけの人（在庫を更新できない人）には有効在庫だけを見せる（2026-10-09 在庫編 Z-02）。
  // API もこの人には実在庫・引当済を返さないので、ここは列を出し分けるだけ。
  const canUpdate = can('S-01', 'update');
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

  const saveNote = async (r: StockRow, note: string) => {
    try {
      await api.patch(`/inventory/stocks/${r.id}`, { note: note || null });
      toast('備考を保存しました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存できませんでした', 'bad');
      throw e;
    }
  };

  // 列の並びはご指定の順（Z-04）: 分類コード・商品分類・商品コード・商品名・有効在庫・賞味期限・倉庫・備考・原価。
  // 実在庫・引当済は在庫を直す人のために有効在庫の前に置く。ロットは出さない（Z-06）。
  // 「原価コード」は何を指すかご確認中のため、列を作っていない。
  // 幅は 1440・1280 のどちらでも原価まで横スクロールなしに見える値。商品名・備考などは折り返して全文を出す。
  const columns: Column<StockRow>[] = [
    { key: 'product_class_code', label: '分類コード', width: 76, render: (r) => <Num>{r.product_class_code ?? ''}</Num> },
    { key: 'product_class_name', label: '商品分類', width: 90, render: (r) => r.product_class_name ?? '' },
    { key: 'sku_code', label: '商品コード', width: 126, render: (r) => <Num className="font-semibold">{r.sku_code}</Num> },
    {
      key: 'product_name',
      label: '商品名',
      render: (r) => (
        <span>
          {`${r.product_name}${r.color_name ? ' ' + r.color_name : ''}${r.size_name ? ' ' + r.size_name : ''}`}
          {/* 品質の列は外したが、良品以外の行は同じ商品が2行並んで見えるので印を付ける */}
          {r.quality_code !== 'GOOD' && <Badge status="引当待ち" className="ml-1">{r.quality_name}</Badge>}
        </span>
      ),
    },
    ...(canUpdate
      ? ([
          { key: 'qty_on_hand', label: '実在庫', r: true, width: 62, render: (r) => qty(r.qty_on_hand) },
          { key: 'qty_allocated', label: '引当済', r: true, width: 62, render: (r) => qty(r.qty_allocated) },
        ] as Column<StockRow>[])
      : []),
    { key: 'qty_available', label: '有効在庫', r: true, width: 66, render: (r) => <b className={Number(r.qty_available) <= 0 ? 'text-[var(--color-crit-500)]' : ''}>{qty(r.qty_available)}</b> },
    { key: 'expiry_date', label: '賞味期限', width: 84, nowrap: true, render: (r) => <Num>{ymd(r.expiry_date)}</Num> },
    { key: 'warehouse_name', label: '倉庫', width: 80 },
    {
      key: 'note',
      label: '備考',
      width: 150,
      render: (r) => (canUpdate ? <InlineText value={r.note} onSave={(v) => saveNote(r, v)} placeholder="備考" /> : (r.note ?? '')),
    },
    ...(canSeeSensitive
      ? ([{ key: 'cost_price', label: '原価', r: true, width: 74, render: (r) => money(r.cost_price) }] as Column<StockRow>[])
      : []),
  ];

  return (
    <div className="page-body">
      <PageHead
        title="在庫表"
        sub={canUpdate ? '有効在庫＝実在庫−引当済。受注登録で引当済が増え、出荷確定で実在庫が減ります。備考はその場で直せます' : '今引き当てられる数（有効在庫）を表示しています'}
      />
      <div className="inventory-summary">
        {canUpdate && (
          <>
            <div className="card px-3.5 py-3">
              <div className="text-[11px] text-[var(--color-ink-3)] font-semibold">実在庫（表示分の合計）</div>
              <div className="num text-[20px] font-bold">{qty(sum('qty_on_hand'))}</div>
            </div>
            <div className="card px-3.5 py-3">
              <div className="text-[11px] text-[var(--color-ink-3)] font-semibold">引当済</div>
              <div className="num text-[20px] font-bold">{qty(sum('qty_allocated'))}</div>
            </div>
          </>
        )}
        <div className="card px-3.5 py-3">
          <div className="text-[11px] text-[var(--color-ink-3)] font-semibold">有効在庫{canUpdate ? '' : '（表示分の合計）'}</div>
          <div className="num text-[20px] font-bold text-[var(--color-brand-700)]">{qty(sum('qty_available'))}</div>
        </div>
      </div>
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.total}</Num> 件</span>}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="商品コード・JAN・商品名・分類で検索" className="!w-[260px]" />
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
          fit
          columns={columns}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>
    </div>
  );
}
