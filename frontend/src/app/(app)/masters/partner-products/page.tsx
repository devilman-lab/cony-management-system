'use client';

import { useMemo, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { money } from '@/lib/format';
import { Badge, Input, Num, Textarea } from '@/components/ui';
import { SearchSelect, fetchPartners, fetchSkus, type Option } from '@/components/ui/SearchSelect';
import { MasterPage, decOrNull, numOrNull, strOrNull } from '@/components/masters/MasterPage';
import { L, Section } from '@/components/masters/Form';

interface PpRow extends Record<string, unknown> {
  id: number;
  partner_id: number;
  partner_code: string;
  partner_name: string;
  sku_id: number;
  sku_code: string;
  product_name: string;
  partner_product_code: string | null;
  partner_jan: string | null;
  jan_code: string | null;
  sales_name: string | null;
  sales_name2: string | null;
  unit_price: string;
  retail_price: string | null;
  cost_price: string | null;
  partner_color: string | null;
  partner_size: string | null;
  color_name: string | null;
  size_name: string | null;
  memo: string | null;
  sort_order: number | null;
  note: string | null;
  is_active: boolean;
}

interface Form {
  partner: Option | null;
  sku: Option | null;
  partner_product_code: string;
  partner_jan: string;
  jan_code: string;
  sales_name: string;
  sales_name2: string;
  unit_price: string;
  retail_price: string;
  cost_price: string;
  partner_color: string;
  partner_size: string;
  color_name: string;
  size_name: string;
  memo: string;
  sort_order: string;
  note: string;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
/** 数値を末尾の 0 なしで（3000.0000 → 3000） */
const dec = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));

/** 得意先別商品（M-11）。取引先ごとの専用コード・卸単価・上代。受注入力で自動的に引かれる。 */
export default function PartnerProductsPage() {
  const { canSeeSensitive } = useAuth();
  const fetchCustomers = useMemo(() => fetchPartners('customer'), []);
  const [partner, setPartner] = useState<Option | null>(null);

  return (
    <MasterPage<PpRow, Form>
      title="得意先別商品"
      sub="取引先ごとの専用商品コード・卸単価・上代です。受注入力で取引先と SKU を選ぶと、ここの単価と上代が自動で入ります。販社CSVの取込でも突き合わせに使います"
      functionId="M-11"
      listPath="/masters/partner-products"
      writePath="/masters/partner-products"
      extraFilters={{ partner_id: partner?.id }}
      modalWidth={760}
      toolbar={<SearchSelect value={partner} onChange={setPartner} fetchOptions={fetchCustomers} placeholder="取引先で絞る" />}
      columns={[
        { key: 'partner_name', label: '取引先', width: 170, render: (r) => <span><Num className="text-[var(--color-ink-3)] mr-1">{r.partner_code}</Num>{r.partner_name}</span> },
        { key: 'sku_code', label: 'SKU', width: 120, render: (r) => <Num className="font-semibold">{r.sku_code}</Num> },
        { key: 'product_name', label: '商品名', render: (r) => <span className="truncate block max-w-[220px]">{r.sales_name || r.product_name}</span> },
        { key: 'partner_product_code', label: '先方コード', width: 120, render: (r) => <Num>{r.partner_product_code ?? ''}</Num> },
        { key: 'partner_jan', label: '先方JAN', width: 130, render: (r) => <Num>{r.partner_jan ?? ''}</Num> },
        { key: 'unit_price', label: '卸単価', r: true, width: 90, render: (r) => money(r.unit_price) },
        { key: 'retail_price', label: '上代', r: true, width: 90, render: (r) => money(r.retail_price) },
        { key: 'is_active', label: '', width: 60, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
      ]}
      rowKey={(r) => r.id}
      empty={() => ({ partner, sku: null, partner_product_code: '', partner_jan: '', jan_code: '', sales_name: '', sales_name2: '', unit_price: '', retail_price: '', cost_price: '', partner_color: '', partner_size: '', color_name: '', size_name: '', memo: '', sort_order: '', note: '' })}
      toForm={(r) => ({
        partner: { id: r.partner_id, label: r.partner_name, sub: r.partner_code },
        sku: { id: r.sku_id, label: `${r.sku_code}　${r.product_name}` },
        partner_product_code: s(r.partner_product_code), partner_jan: s(r.partner_jan), jan_code: s(r.jan_code),
        sales_name: s(r.sales_name), sales_name2: s(r.sales_name2), unit_price: dec(r.unit_price), retail_price: dec(r.retail_price), cost_price: dec(r.cost_price),
        partner_color: s(r.partner_color), partner_size: s(r.partner_size), color_name: s(r.color_name), size_name: s(r.size_name),
        memo: s(r.memo), sort_order: s(r.sort_order), note: s(r.note),
      })}
      toBody={(f) => ({
        partner_id: f.partner?.id,
        sku_id: f.sku?.id,
        partner_product_code: strOrNull(f.partner_product_code),
        partner_jan: strOrNull(f.partner_jan),
        jan_code: strOrNull(f.jan_code),
        sales_name: strOrNull(f.sales_name),
        sales_name2: strOrNull(f.sales_name2),
        unit_price: f.unit_price.trim() || '0',
        retail_price: decOrNull(f.retail_price),
        ...(canSeeSensitive ? { cost_price: decOrNull(f.cost_price) } : {}),
        partner_color: strOrNull(f.partner_color),
        partner_size: strOrNull(f.partner_size),
        color_name: strOrNull(f.color_name),
        size_name: strOrNull(f.size_name),
        memo: strOrNull(f.memo),
        sort_order: numOrNull(f.sort_order),
        note: strOrNull(f.note),
      })}
      renderForm={(f, set, editing) => (
        <div className="flex flex-col gap-3">
          <div className="master-grid-2">
            <L label="取引先" required><SearchSelect value={f.partner} onChange={(o) => set({ partner: o })} fetchOptions={fetchCustomers} placeholder="得意先を検索" width="100%" disabled={!!editing} /></L>
            <L label="自社 SKU" required><SearchSelect value={f.sku} onChange={(o) => set({ sku: o })} fetchOptions={fetchSkus} placeholder="SKU・JAN・商品名で検索" width="100%" disabled={!!editing} /></L>
          </div>
          <Section title="先方のコード・名称" />
          <div className="master-grid-2">
            <L label="先方の商品コード" hint="販社CSVの突き合わせに使います"><Input value={f.partner_product_code} onChange={(e) => set({ partner_product_code: e.target.value })} /></L>
            <L label="先方の JAN"><Input value={f.partner_jan} onChange={(e) => set({ partner_jan: e.target.value })} /></L>
            <L label="販売名（納品書に印字）"><Input value={f.sales_name} onChange={(e) => set({ sales_name: e.target.value })} /></L>
            <L label="販売名2"><Input value={f.sales_name2} onChange={(e) => set({ sales_name2: e.target.value })} /></L>
            <L label="先方のカラー／サイズ"><Input value={f.partner_color} onChange={(e) => set({ partner_color: e.target.value })} className="!w-[120px]" placeholder="カラー" /><Input value={f.partner_size} onChange={(e) => set({ partner_size: e.target.value })} className="!w-[120px]" placeholder="サイズ" /></L>
            <L label="印字するカラー／サイズ"><Input value={f.color_name} onChange={(e) => set({ color_name: e.target.value })} className="!w-[120px]" placeholder="カラー" /><Input value={f.size_name} onChange={(e) => set({ size_name: e.target.value })} className="!w-[120px]" placeholder="サイズ" /></L>
          </div>
          <Section title="単価" />
          <div className="master-grid-2">
            <L label="卸単価" required><Input right value={f.unit_price} onChange={(e) => set({ unit_price: e.target.value })} className="!w-[130px]" /></L>
            <L label="上代" hint="納品書「上代あり」に印字"><Input right value={f.retail_price} onChange={(e) => set({ retail_price: e.target.value })} className="!w-[130px]" /></L>
            {canSeeSensitive && <L label="原価（この取引先向け）"><Input right value={f.cost_price} onChange={(e) => set({ cost_price: e.target.value })} className="!w-[130px]" /></L>}
            <L label="表示順"><Input right value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} className="!w-[90px]" /></L>
          </div>
          <Input value={f.memo} onChange={(e) => set({ memo: e.target.value })} placeholder="メモ" />
          <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="備考" />
        </div>
      )}
    />
  );
}
