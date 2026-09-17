'use client';

import { useMemo } from 'react';

import { useSimpleMaster } from '@/lib/hooks';
import { Badge, Input, Num, Select, Textarea } from '@/components/ui';
import { SearchSelect, fetchPartners, type Option } from '@/components/ui/SearchSelect';
import { MasterPage, numOrNull, strOrNull } from '@/components/masters/MasterPage';
import { Check, L, PostalLookup, Section } from '@/components/masters/Form';

interface WarehouseRow extends Record<string, unknown> {
  id: number;
  warehouse_code: string;
  short_name: string;
  is_consignment: boolean;
  partner_id: number | null;
  media_id: number | null;
  postal_code: string | null;
  address1: string | null;
  address2: string | null;
  tel: string | null;
  fax: string | null;
  sort_order: number | null;
  note: string | null;
  is_active: boolean;
}

interface Form {
  warehouse_code: string;
  short_name: string;
  is_consignment: boolean;
  partner: Option | null;
  media_id: string;
  postal_code: string;
  address1: string;
  address2: string;
  tel: string;
  fax: string;
  sort_order: string;
  note: string;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** 倉庫マスタ（M-14）。自社倉庫のほか、委託先（販売先が預かる在庫）も倉庫として持つ。 */
export default function WarehousesPage() {
  const fetchAll = useMemo(() => fetchPartners(), []);
  const media = useSimpleMaster('media');
  return (
    <MasterPage<WarehouseRow, Form>
      title="倉庫"
      sub="在庫を置く場所です。委託先（販売先に預けている在庫）も倉庫として登録し、取引先と結びつけます"
      functionId="M-14"
      listPath="/masters/warehouses"
      writePath="/masters/warehouses"
      noSearch
      columns={[
        { key: 'warehouse_code', label: 'コード', width: 100, render: (r) => <Num className="font-semibold">{r.warehouse_code}</Num> },
        { key: 'short_name', label: '倉庫名' },
        { key: 'is_consignment', label: '種別', width: 90, render: (r) => (r.is_consignment ? <Badge>委託先</Badge> : '自社') },
        { key: 'address1', label: '住所', render: (r) => <span className="truncate block max-w-[300px]">{r.address1 ?? ''}{r.address2 ?? ''}</span> },
        { key: 'tel', label: '電話', width: 120, render: (r) => <Num>{r.tel ?? ''}</Num> },
        { key: 'is_active', label: '', width: 60, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
      ]}
      rowKey={(r) => r.id}
      empty={() => ({ warehouse_code: '', short_name: '', is_consignment: false, partner: null, media_id: '', postal_code: '', address1: '', address2: '', tel: '', fax: '', sort_order: '', note: '' })}
      toForm={(r) => ({
        warehouse_code: r.warehouse_code, short_name: r.short_name, is_consignment: r.is_consignment,
        partner: r.partner_id ? { id: r.partner_id, label: `取引先 ID ${r.partner_id}` } : null,
        media_id: s(r.media_id), postal_code: s(r.postal_code), address1: s(r.address1), address2: s(r.address2), tel: s(r.tel), fax: s(r.fax), sort_order: s(r.sort_order), note: s(r.note),
      })}
      toBody={(f) => ({
        warehouse_code: f.warehouse_code.trim(),
        short_name: f.short_name.trim(),
        is_consignment: f.is_consignment,
        partner_id: f.partner?.id ?? null,
        media_id: numOrNull(f.media_id),
        postal_code: strOrNull(f.postal_code),
        address1: strOrNull(f.address1),
        address2: strOrNull(f.address2),
        tel: strOrNull(f.tel),
        fax: strOrNull(f.fax),
        sort_order: numOrNull(f.sort_order),
        note: strOrNull(f.note),
      })}
      renderForm={(f, set) => (
        <div className="flex flex-col gap-3">
          <div className="master-grid-2">
            <L label="倉庫コード" required><Input value={f.warehouse_code} onChange={(e) => set({ warehouse_code: e.target.value })} className="!w-[160px]" /></L>
            <L label="倉庫名" required><Input value={f.short_name} onChange={(e) => set({ short_name: e.target.value })} /></L>
            <L label="種別"><Check checked={f.is_consignment} onChange={(v) => set({ is_consignment: v })} label="委託先（販売先に預けている在庫）" /></L>
            <L label="取引先" hint="委託先のとき"><SearchSelect value={f.partner} onChange={(o) => set({ partner: o })} fetchOptions={fetchAll} placeholder="取引先を検索" width="100%" /></L>
            <L label="媒体"><Select value={f.media_id} onChange={(e) => set({ media_id: e.target.value })}><option value="">（なし）</option>{(media.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></L>
            <L label="表示順"><Input right value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} className="!w-[90px]" /></L>
          </div>
          <Section title="住所・連絡先" />
          <div className="master-grid-2">
            <L label="郵便番号"><PostalLookup value={f.postal_code} onChange={(v) => set({ postal_code: v })} onAddress={(a) => set({ address1: a })} /></L>
            <L label="電話／FAX"><Input value={f.tel} onChange={(e) => set({ tel: e.target.value })} className="!w-[140px]" placeholder="電話" /><Input value={f.fax} onChange={(e) => set({ fax: e.target.value })} className="!w-[140px]" placeholder="FAX" /></L>
            <L label="住所1"><Input value={f.address1} onChange={(e) => set({ address1: e.target.value })} /></L>
            <L label="住所2"><Input value={f.address2} onChange={(e) => set({ address2: e.target.value })} /></L>
          </div>
          <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="備考" />
        </div>
      )}
    />
  );
}
