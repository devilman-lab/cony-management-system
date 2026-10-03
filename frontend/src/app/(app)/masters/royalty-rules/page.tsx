'use client';

import { useMemo } from 'react';

import { useSimpleMaster } from '@/lib/hooks';
import { money, today, ymd } from '@/lib/format';
import { Badge, Input, Num, Select, Textarea } from '@/components/ui';
import {
  MultiSearchSelect,
  SearchSelect,
  fetchCustomers,
  fetchPartners,
  fetchProducts,
  type Option,
} from '@/components/ui/SearchSelect';
import { MasterPage, decOrNull, numOrNull, strOrNull } from '@/components/masters/MasterPage';
import { Check, L, Section } from '@/components/masters/Form';

/** 販売先の指定のしかた。「どちらかを入力して反映させる」形（1001 ご要望）。 */
type CustomerMode = '媒体全体' | '対象' | '対象外';
/** ご要望の「20社まで」。 */
const MAX_CUSTOMERS = 20;

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
  media_id: number | null;
  media_name: string | null;
  is_excluded: boolean;
  calc_base: string;
  rate: string | null;
  fixed_amount: string | null;
  valid_from: string;
  valid_to: string | null;
  scope_priority: number;
  note: string | null;
  is_active: boolean;
  /** ここから下は、1枚のフォームから作られた「まとまり」としてまとめた値 */
  customer_mode: CustomerMode;
  customers: { id: number; name: string }[];
  customer_count: number;
  row_count: number;
}

interface Form {
  payee: Option | null;
  brand_id: string;
  product: Option | null;
  media_id: string;
  customer_mode: CustomerMode;
  customers: Option[];
  /** 販売先の候補を媒体で絞らない（1社が複数の媒体で売るとき） */
  all_media_customers: boolean;
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

/** 一覧の「販売先」欄。20社まで入るので、社名は3つまで見せて残りは件数で示す。 */
function CustomerCell({ r }: { r: RuleRow }) {
  if (r.customer_mode === '媒体全体') return <span className="text-[var(--color-ink-3)]">媒体の全販売先</span>;
  const names = r.customers.map((c) => c.name);
  const rest = names.length - 3;
  return (
    <span title={names.join('、')}>
      {r.customer_mode === '対象外' && (
        <>
          <Badge>対象外</Badge>{' '}
        </>
      )}
      {names.slice(0, 3).join('、')}
      {rest > 0 && <span className="text-[var(--color-ink-3)]"> ほか{rest}社</span>}
      {r.customer_mode === '対象外' && <span className="text-[var(--color-ink-3)]"> 以外が対象</span>}
    </span>
  );
}

/** ロイヤリティ規定（Y-02 の設定側）。支払先 × ブランド／商品 × 媒体 × 販売先 × 期間で料率を決める。 */
export default function RoyaltyRulesPage() {
  const fetchAll = useMemo(() => fetchPartners(), []);
  const brands = useSimpleMaster('brands');
  const medias = useSimpleMaster('media');

  return (
    <MasterPage<RuleRow, Form>
      title="ロイヤリティ規定"
      sub="支払先ごとに、どのブランド（または商品）を、どの媒体のどの販売先に売ったときに、何％（または定額）を払うかを決めます。販売先は「対象」と「対象外」のどちらか一方を入れてください。料率を変えるときは既存の行を直さず、新しい適用開始日で足してください"
      functionId="Y-02"
      listPath="/masters/royalty-rules"
      writePath="/masters/royalty-rules"
      modalWidth={720}
      noSearch
      columns={[
        { key: 'payee_name', label: '支払先', width: 150, render: (r) => <b>{r.payee_name}</b> },
        {
          key: 'media_name',
          label: '媒体',
          width: 100,
          render: (r) => r.media_name ?? <span className="text-[var(--color-ink-3)]">すべて</span>,
        },
        {
          key: 'brand_name',
          label: 'ブランド／商品',
          width: 150,
          render: (r) => r.product_name ?? r.brand_name ?? <span className="text-[var(--color-ink-3)]">すべて</span>,
        },
        { key: 'customer_name', label: '販売先', render: (r) => <CustomerCell r={r} /> },
        {
          key: 'rate',
          label: '料率／定額',
          r: true,
          width: 110,
          render: (r) =>
            r.rate ? <Num>{pct(r.rate)}</Num> : r.fixed_amount ? `${money(r.fixed_amount)} 円` : <Badge>対象外のみ</Badge>,
        },
        { key: 'calc_base', label: '基準', width: 60 },
        {
          key: 'valid_from',
          label: '適用期間',
          width: 180,
          render: (r) => (
            <Num>
              {ymd(r.valid_from)} 〜 {r.valid_to ? ymd(r.valid_to) : ''}
            </Num>
          ),
        },
        { key: 'is_active', label: '', width: 50, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
      ]}
      rowKey={(r) => r.id}
      rowLabel={(r) => `${r.payee_name} の規定`}
      empty={() => ({
        payee: null,
        brand_id: '',
        product: null,
        media_id: '',
        customer_mode: '媒体全体',
        customers: [],
        all_media_customers: false,
        calc_base: '出荷',
        rate_pct: '',
        fixed_amount: '',
        valid_from: today(),
        valid_to: '',
        note: '',
      })}
      toForm={(r) => ({
        payee: { id: r.payee_partner_id, label: r.payee_name },
        brand_id: s(r.brand_id),
        product: r.product_id ? { id: r.product_id, label: r.product_name ?? '' } : null,
        media_id: s(r.media_id),
        customer_mode: r.customer_mode,
        customers: r.customers.map((c) => ({ id: c.id, label: c.name })),
        // すでに入っている販売先が媒体の外にいることもあるため、編集では絞らずに開く
        all_media_customers: true,
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
        product_id: f.product?.id ?? null,
        media_id: numOrNull(f.media_id),
        customer_mode: f.customer_mode,
        customer_partner_ids: f.customer_mode === '媒体全体' ? [] : f.customers.map((c) => c.id),
        customer_partner_id: null,
        is_excluded: false,
        calc_base: f.calc_base,
        rate: f.rate_pct.trim() ? (Number(f.rate_pct) / 100).toFixed(4) : null,
        fixed_amount: decOrNull(f.fixed_amount),
        valid_from: f.valid_from,
        valid_to: f.valid_to || null,
        note: strOrNull(f.note),
      })}
      renderForm={(f, set) => {
        const mediaId = numOrNull(f.media_id);
        const narrowed = !f.all_media_customers;
        const waitingForMedia = narrowed && !mediaId;
        const modes: [CustomerMode, string][] = [
          ['媒体全体', 'この媒体の全販売先が対象'],
          ['対象', '選んだ販売先だけが対象'],
          ['対象外', '選んだ販売先を外し、残りが対象'],
        ];
        return (
          <div className="flex flex-col gap-3">
            <div className="master-grid-2">
              <L label="支払先" required>
                <SearchSelect
                  value={f.payee}
                  onChange={(o) => set({ payee: o })}
                  fetchOptions={fetchAll}
                  placeholder="ロイヤリティの支払先"
                  width="100%"
                />
              </L>
              <L label="計算の基準" hint="どの時点の金額にかけるか。ふつうは「出荷」">
                <Select value={f.calc_base} onChange={(e) => set({ calc_base: e.target.value })} className="!w-[110px]">
                  <option>出荷</option>
                  <option>売上</option>
                  <option>入金</option>
                </Select>
              </L>
            </div>

            <Section title="対象の範囲" />
            <div className="master-grid-2">
              <L label="媒体" required hint="テレビ・カタログなど。販売先の候補はこの媒体で絞ります">
                <Select value={f.media_id} onChange={(e) => set({ media_id: e.target.value, customers: [] })}>
                  <option value="">選んでください</option>
                  {(medias.data?.items ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </L>
              <L label="ブランド" hint="空欄なら支払先に紐づくすべて">
                <Select value={f.brand_id} onChange={(e) => set({ brand_id: e.target.value })}>
                  <option value="">すべて</option>
                  {(brands.data?.items ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </L>
              <L label="商品" hint="特定の商品だけに効かせるとき。空欄ならブランド配下のすべて">
                <SearchSelect
                  value={f.product}
                  onChange={(o) => set({ product: o })}
                  fetchOptions={fetchProducts}
                  placeholder="すべて"
                  width="100%"
                />
              </L>
            </div>

            {/*
              販売先の指定。「対象」と「対象外」はどちらか一方だけを入れる形にしてある
              （1001 のご要望「どちらかを入力して反映させる方法が理想です」）。
            */}
            <Section title="販売先の指定（どちらか一方を入れます）" />
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-4 text-[12.5px]">
                {modes.map(([mode, hint]) => (
                  <label key={mode} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="customer_mode"
                      checked={f.customer_mode === mode}
                      onChange={() => set({ customer_mode: mode, customers: mode === '媒体全体' ? [] : f.customers })}
                    />
                    <span>{mode}</span>
                    <span className="text-[11px] text-[var(--color-ink-3)]">{hint}</span>
                  </label>
                ))}
              </div>

              {f.customer_mode !== '媒体全体' && (
                <>
                  <L label={f.customer_mode === '対象外' ? '対象外にする販売先' : '対象にする販売先'} required>
                    <MultiSearchSelect
                      values={f.customers}
                      onChange={(o) => set({ customers: o })}
                      fetchOptions={narrowed ? fetchCustomers(mediaId) : fetchCustomers(null)}
                      max={MAX_CUSTOMERS}
                      placeholder={waitingForMedia ? '先に媒体を選んでください' : '販売先を検索して追加…'}
                      disabled={waitingForMedia}
                      emptyLabel="まだ選んでいません"
                    />
                  </L>
                  <Check
                    checked={f.all_media_customers}
                    onChange={(v) => set({ all_media_customers: v })}
                    label="媒体で絞らずに、すべての販売先から選ぶ"
                  />
                </>
              )}
            </div>

            <Section title="料率" />
            <div className="master-grid-2">
              <L
                label="料率（%）"
                hint={
                  f.customer_mode === '対象外'
                    ? '例：5 → 5%。空欄にすると「この販売先は対象外」だけを登録します'
                    : '例：5 → 5%'
                }
              >
                <Input
                  right
                  value={f.rate_pct}
                  onChange={(e) => set({ rate_pct: e.target.value })}
                  className="!w-[100px]"
                />
                <span className="text-[11px] text-[var(--color-ink-3)]">または</span>
                <Input
                  right
                  value={f.fixed_amount}
                  onChange={(e) => set({ fixed_amount: e.target.value })}
                  className="!w-[110px]"
                  placeholder="定額（円）"
                />
              </L>
              <L label="適用開始" required>
                <Input
                  type="date"
                  value={f.valid_from}
                  onChange={(e) => set({ valid_from: e.target.value })}
                  className="!w-[150px]"
                />
              </L>
              <L label="適用終了" hint="空欄なら無期限">
                <Input
                  type="date"
                  value={f.valid_to}
                  onChange={(e) => set({ valid_to: e.target.value })}
                  className="!w-[150px]"
                />
              </L>
            </div>
            <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="備考" />
          </div>
        );
      }}
    />
  );
}
