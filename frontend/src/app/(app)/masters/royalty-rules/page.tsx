'use client';

import { useMemo } from 'react';

import { useSimpleMaster } from '@/lib/hooks';
import { money, today, ymd } from '@/lib/format';
import { Badge, Input, Num, Select, Textarea } from '@/components/ui';
import { SearchSelect, fetchPartners, type Option } from '@/components/ui/SearchSelect';
import { MasterPage, decOrNull, numOrNull, strOrNull } from '@/components/masters/MasterPage';
import { Check, L, Section } from '@/components/masters/Form';

interface RuleRow extends Record<string, unknown> {
  id: number;
  payee_partner_id: number;
  payee_name: string;
  brand_id: number | null;
  brand_name: string | null;
  product_id: number | null;
  product_name: string | null;
  customer_partner_id: number | null;
  customer_name: string | null;
  is_excluded: boolean;
  calc_base: string;
  rate: string | null;
  fixed_amount: string | null;
  valid_from: string;
  valid_to: string | null;
  scope_priority: number;
  note: string | null;
  is_active: boolean;
}

interface Form {
  payee: Option | null;
  brand_id: string;
  product_id: string;
  customer: Option | null;
  is_excluded: boolean;
  calc_base: string;
  rate_pct: string;
  fixed_amount: string;
  valid_from: string;
  valid_to: string;
  note: string;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
/** 数値を末尾の 0 なしで（3000.0000 → 3000） */
const dec = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));
const pct = (rate: string | null) => (rate ? `${(Number(rate) * 100).toFixed(2).replace(/\.?0+$/, '')}%` : '');

/** ロイヤリティ規定（Y-02 の設定側）。支払先 × ブランド／商品 × 販売先 × 期間で料率を決める。 */
export default function RoyaltyRulesPage() {
  const fetchAll = useMemo(() => fetchPartners(), []);
  const fetchCustomers = useMemo(() => fetchPartners('customer'), []);
  const brands = useSimpleMaster('brands');

  return (
    <MasterPage<RuleRow, Form>
      title="ロイヤリティ規定"
      sub="支払先ごとに、どのブランド（または商品）を、どの販売先に売ったときに、何％（または定額）を払うかを決めます。ブランド・商品・販売先を空欄にすると「すべて」です。料率を変えるときは既存の行を直さず、新しい適用開始日で行を足してください"
      functionId="Y-02"
      listPath="/masters/royalty-rules"
      writePath="/masters/royalty-rules"
      modalWidth={700}
      noSearch
      columns={[
        { key: 'payee_name', label: '支払先', width: 160, render: (r) => <b>{r.payee_name}</b> },
        { key: 'brand_name', label: 'ブランド／商品', render: (r) => r.product_name ?? r.brand_name ?? <span className="text-[var(--color-ink-3)]">すべて</span> },
        { key: 'customer_name', label: '販売先', render: (r) => r.customer_name ?? <span className="text-[var(--color-ink-3)]">すべて</span> },
        { key: 'rate', label: '料率／定額', r: true, width: 110, render: (r) => (r.is_excluded ? <Badge>対象外</Badge> : r.rate ? <Num>{pct(r.rate)}</Num> : `${money(r.fixed_amount)} 円`) },
        { key: 'calc_base', label: '基準', width: 60 },
        { key: 'valid_from', label: '適用期間', width: 190, render: (r) => <Num>{ymd(r.valid_from)} 〜 {r.valid_to ? ymd(r.valid_to) : ''}</Num> },
        { key: 'is_active', label: '', width: 60, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
      ]}
      rowKey={(r) => r.id}
      empty={() => ({ payee: null, brand_id: '', product_id: '', customer: null, is_excluded: false, calc_base: '出荷', rate_pct: '', fixed_amount: '', valid_from: today(), valid_to: '', note: '' })}
      toForm={(r) => ({
        payee: { id: r.payee_partner_id, label: r.payee_name },
        brand_id: s(r.brand_id),
        product_id: s(r.product_id),
        customer: r.customer_partner_id ? { id: r.customer_partner_id, label: r.customer_name ?? '' } : null,
        is_excluded: r.is_excluded,
        calc_base: r.calc_base,
        rate_pct: r.rate ? String(Number(r.rate) * 100) : '',
        fixed_amount: dec(r.fixed_amount),
        valid_from: r.valid_from.slice(0, 10),
        valid_to: r.valid_to ? r.valid_to.slice(0, 10) : '',
        note: s(r.note),
      })}
      toBody={(f) => ({
        payee_partner_id: f.payee?.id,
        brand_id: numOrNull(f.brand_id),
        product_id: numOrNull(f.product_id),
        customer_partner_id: f.customer?.id ?? null,
        is_excluded: f.is_excluded,
        calc_base: f.calc_base,
        rate: f.is_excluded || !f.rate_pct.trim() ? null : (Number(f.rate_pct) / 100).toFixed(4),
        fixed_amount: f.is_excluded ? null : decOrNull(f.fixed_amount),
        valid_from: f.valid_from,
        valid_to: f.valid_to || null,
        note: strOrNull(f.note),
      })}
      renderForm={(f, set) => (
        <div className="flex flex-col gap-3">
          <div className="master-grid-2">
            <L label="支払先" required><SearchSelect value={f.payee} onChange={(o) => set({ payee: o })} fetchOptions={fetchAll} placeholder="ロイヤリティの支払先" width="100%" /></L>
            <L label="計算の基準"><Select value={f.calc_base} onChange={(e) => set({ calc_base: e.target.value })} className="!w-[110px]"><option>出荷</option><option>売上</option><option>入金</option></Select></L>
          </div>
          <Section title="対象の範囲（空欄は「すべて」）" />
          <div className="master-grid-2">
            <L label="ブランド"><Select value={f.brand_id} onChange={(e) => set({ brand_id: e.target.value })}><option value="">すべて</option>{(brands.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></L>
            <L label="商品 ID" hint="特定の商品だけに効かせるとき"><Input value={f.product_id} onChange={(e) => set({ product_id: e.target.value })} className="!w-[120px]" /></L>
            <L label="販売先" hint="C社のように販売先で発生要否が分かれるとき"><SearchSelect value={f.customer} onChange={(o) => set({ customer: o })} fetchOptions={fetchCustomers} placeholder="すべて" width="100%" /></L>
          </div>
          <Section title="料率" />
          <div className="master-grid-2">
            <L label="扱い"><Check checked={f.is_excluded} onChange={(v) => set({ is_excluded: v })} label="この範囲はロイヤリティの対象外" /></L>
            <L label="料率（%）" hint="例：5 → 5%"><Input right value={f.rate_pct} onChange={(e) => set({ rate_pct: e.target.value })} className="!w-[100px]" disabled={f.is_excluded} /><span className="text-[11px] text-[var(--color-ink-3)]">または</span><Input right value={f.fixed_amount} onChange={(e) => set({ fixed_amount: e.target.value })} className="!w-[110px]" placeholder="定額（円）" disabled={f.is_excluded} /></L>
            <L label="適用開始" required><Input type="date" value={f.valid_from} onChange={(e) => set({ valid_from: e.target.value })} className="!w-[150px]" /></L>
            <L label="適用終了" hint="空欄なら無期限"><Input type="date" value={f.valid_to} onChange={(e) => set({ valid_to: e.target.value })} className="!w-[150px]" /></L>
          </div>
          <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="備考" />
        </div>
      )}
    />
  );
}
