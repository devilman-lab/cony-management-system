'use client';

import { useMemo, useState, type ReactNode } from 'react';

import { api, type Paged } from '@/lib/api';
import { useSimpleMaster } from '@/lib/hooks';
import { money, today, ymd } from '@/lib/format';
import { Badge, Button, Input, Modal, Num, Select, Textarea, useConfirm } from '@/components/ui';
import {
  MultiSearchSelect,
  SearchSelect,
  fetchCustomers,
  fetchPartners,
  type Option,
  type ProductRow,
} from '@/components/ui/SearchSelect';
import { MasterPage, decOrNull, numOrNull, strOrNull } from '@/components/masters/MasterPage';
import { L, Section } from '@/components/masters/Form';
import { MasterCsv } from '@/components/masters/MasterCsv';

/** 販売先の指定のしかた。「どちらかを入力して反映させる」形（1001 ご要望）。 */
type CustomerMode = '媒体全体' | '対象' | '対象外';
/** ご要望の「20社まで」。 */
const MAX_CUSTOMERS = 20;
/** 対象の商品・対象外の商品の上限（それぞれ。API と同じ） */
const MAX_PRODUCTS = 50;

interface RuleProduct {
  id: number;
  name: string;
  code: string;
}

interface RuleRow extends Record<string, unknown> {
  id: number;
  payee_partner_id: number;
  payee_name: string;
  brand_id: number | null;
  brand_name: string | null;
  media_id: number | null;
  media_name: string | null;
  calc_base: string;
  rate: string | null;
  fixed_amount: string | null;
  valid_from: string;
  valid_to: string | null;
  note: string | null;
  is_active: boolean;
  /** ここから下は、1枚のフォームから作られた「まとまり」としてまとめた値 */
  customer_mode: CustomerMode;
  /** 対象のときは対象の販売先、対象外のときは外した販売先 */
  customers: { id: number; name: string }[];
  customer_count: number;
  /** 対象の商品（空ならブランド配下のすべて）と対象外の商品（M3-33） */
  products: RuleProduct[];
  excluded_products: RuleProduct[];
  row_count: number;
  /** 編集前の版として残している行の数（計算済みの月の根拠。一覧には別の規定として出さない） */
  history_count?: number;
}

interface Form {
  payee: Option | null;
  brand_id: string;
  products: Option[];
  excluded_products: Option[];
  media_id: string;
  customer_mode: CustomerMode;
  customers: Option[];
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
const productOption = (p: RuleProduct): Option => ({ id: p.id, label: `${p.code}　${p.name}` });
/** 計算の基準の表示。請求月に統一した（M3-32。中の値は「売上」） */
const baseName = (v: string) => (v === '売上' ? '請求月' : v);

/**
 * 商品の検索。ブランドを選んでいればそのブランドの商品だけ出す（違うブランドの商品は計算で当たらないため）。
 * 候補の検索は関数が替わるたびに読み直すので、ブランドごとに同じ関数を使い回す。
 */
const productFetchers = new Map<number, (q: string) => Promise<Option[]>>();
const fetchBrandProducts = (brandId: number | null) => {
  const key = brandId ?? 0;
  let fn = productFetchers.get(key);
  if (!fn) {
    fn = searchBrandProducts(brandId);
    productFetchers.set(key, fn);
  }
  return fn;
};
const searchBrandProducts = (brandId: number | null) => async (q: string): Promise<Option[]> => {
  const r = await api.get<Paged<ProductRow>>('/masters/products', { q: q || undefined, limit: 20, brand_id: brandId ?? undefined });
  return r.items.map((p) => ({
    id: p.id,
    label: `${p.product_code}　${p.product_name}`,
    sub: [p.brand_name, p.product_class_name].filter(Boolean).join(' / '),
  }));
};

/** 一覧の「販売先」欄。短い表示にし、押すと対象・対象外の明細を出す（M3-36） */
function customerSummary(r: RuleRow) {
  if (r.customer_mode === '媒体全体') return '媒体の全販売先';
  if (r.customer_mode === '対象') return `対象 ${r.customer_count} 社`;
  return `対象外あり（${r.customer_count} 社）`;
}

/** 一覧の「ブランド／商品」欄 */
function productSummary(r: RuleRow): ReactNode {
  const brand = r.brand_name ?? null;
  const products =
    r.products.length === 0 ? null : r.products.length === 1 ? r.products[0].name : `商品 ${r.products.length} 件`;
  if (!brand && !products) return <span className="text-[var(--color-ink-3)]">すべて</span>;
  return [brand, products].filter(Boolean).join(' ／ ');
}

/** 明細の1行 */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-[var(--color-line)] py-1.5 text-[12.5px]">
      <div className="text-[var(--color-ink-3)]">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function NameList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <span className="text-[var(--color-ink-3)]">{empty}</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

/** 一覧の行を押したときの明細。対象・対象外の販売先と商品をすべて出す（M3-36） */
function RuleDetail({ r }: { r: RuleRow }) {
  const amount = r.rate ? pct(r.rate) : r.fixed_amount ? `${money(r.fixed_amount)} 円（1個あたり）` : null;
  return (
    <div className="flex flex-col">
      <DetailRow label="支払先">{r.payee_name}</DetailRow>
      <DetailRow label="媒体">{r.media_name ?? 'すべて'}</DetailRow>
      <DetailRow label="ブランド">{r.brand_name ?? 'すべて（支払先に紐づくすべて）'}</DetailRow>
      <DetailRow label="対象の商品">
        <NameList
          items={r.products.map((p) => `${p.code}　${p.name}`)}
          empty={r.brand_name ? 'ブランド配下のすべて' : 'すべて'}
        />
      </DetailRow>
      <DetailRow label="対象外の商品">
        <NameList items={r.excluded_products.map((p) => `${p.code}　${p.name}`)} empty="なし" />
      </DetailRow>
      <DetailRow label="販売先の指定">
        {r.customer_mode === '媒体全体' && 'この媒体の全販売先が対象'}
        {r.customer_mode === '対象' && '選んだ販売先だけが対象'}
        {r.customer_mode === '対象外' && '選んだ販売先を外し、残りの販売先が対象'}
      </DetailRow>
      {r.customer_mode !== '媒体全体' && (
        <DetailRow label={r.customer_mode === '対象外' ? '対象外の販売先' : '対象の販売先'}>
          <NameList items={r.customers.map((c) => c.name)} empty="なし" />
        </DetailRow>
      )}
      <DetailRow label="料率／定額">
        {amount ? (
          <>
            {amount}
            {r.rate && <span className="text-[11px] text-[var(--color-ink-3)]">　下代（卸単価×数量）にかけます</span>}
          </>
        ) : (
          <span>なし（対象外だけの規定）</span>
        )}
      </DetailRow>
      <DetailRow label="計算の基準">{baseName(r.calc_base)}（締めた請求の月に計上）</DetailRow>
      <DetailRow label="適用期間">
        {ymd(r.valid_from)} 〜 {r.valid_to ? ymd(r.valid_to) : ''}
      </DetailRow>
      {r.note && <DetailRow label="備考">{r.note}</DetailRow>}
      {(r.history_count ?? 0) > 0 && (
        <p className="mt-2 text-[11px] text-[var(--color-ink-3)]">
          計算したあとで販売先・商品の指定を直したため、直す前の内容 {r.history_count} 行を計算済みの月の根拠として残しています（計算には使いません）。
        </p>
      )}
    </div>
  );
}

/** 一覧行 → フォーム。編集とコピー（M3-37）で同じ中身を使う */
const toForm = (r: RuleRow): Form => ({
  payee: { id: r.payee_partner_id, label: r.payee_name },
  brand_id: s(r.brand_id),
  products: r.products.map(productOption),
  excluded_products: r.excluded_products.map(productOption),
  media_id: s(r.media_id),
  customer_mode: r.customer_mode,
  customers: r.customers.map((c) => ({ id: c.id, label: c.name })),
  rate_pct: r.rate ? String(Number(r.rate) * 100) : '',
  fixed_amount: dec(r.fixed_amount),
  valid_from: r.valid_from.slice(0, 10),
  valid_to: r.valid_to ? r.valid_to.slice(0, 10) : '',
  note: s(r.note),
});

/** ロイヤリティ規定（Y-02 の設定側）。支払先 × ブランド／商品 × 媒体 × 販売先 × 期間で料率を決める。 */
export default function RoyaltyRulesPage() {
  // 支払先は「ロイヤリティ支払先」の印が付いた取引先だけ出す（1001 ご要望）。
  // 得意先として登録されていることがあるため、得意先／仕入先では絞れない。
  const fetchAll = useMemo(() => fetchPartners('royalty_payee'), []);
  const brands = useSimpleMaster('brands');
  const medias = useSimpleMaster('media');
  const { confirm, element } = useConfirm();
  // 一覧の販売先・商品を押したときに出す明細（M3-36）
  const [detail, setDetail] = useState<RuleRow | null>(null);

  const linkCls = 'text-left underline decoration-dotted underline-offset-2 hover:text-[var(--color-brand-700)] cursor-pointer';

  return (
    <>
      <MasterPage<RuleRow, Form>
        title="ロイヤリティ規定"
        sub="支払先ごとに、どのブランド（または商品）を、どの媒体のどの販売先に売ったときに、何％（または定額）を払うかを決めます。対象外にする商品は「対象外の商品」で選べます。料率を変えるときは既存の規定を直さず、新しい適用開始日で足してください（「コピー」で同じ中身の規定を開けます）"
        functionId="Y-02"
        // CSV 書き出しだけ（規定1件を1行。使わないものも出す。2026-10-12 受入 No.3）
        headRight={<MasterCsv slug="royalty-rules" functionId="Y-02" exportOnly includeInactive />}
        listPath="/masters/royalty-rules"
        writePath="/masters/royalty-rules"
        modalWidth={760}
        noSearch
        columns={[
          { key: 'payee_name', label: '支払先', width: 120, render: (r) => <b>{r.payee_name}</b> },
          {
            key: 'media_name',
            label: '媒体',
            width: 90,
            render: (r) => r.media_name ?? <span className="text-[var(--color-ink-3)]">すべて</span>,
          },
          {
            key: 'brand_name',
            label: 'ブランド／商品',
            render: (r) => (
              <button type="button" className={linkCls} onClick={() => setDetail(r)} title="押すと明細を出します">
                {productSummary(r)}
                {r.excluded_products.length > 0 && (
                  <>
                    {' '}
                    <Badge>対象外の商品 {r.excluded_products.length}</Badge>
                  </>
                )}
              </button>
            ),
          },
          {
            key: 'customer_mode',
            label: '販売先',
            width: 150,
            render: (r) => (
              <button
                type="button"
                className={`${linkCls} ${r.customer_mode === '媒体全体' ? 'text-[var(--color-ink-3)]' : ''}`}
                onClick={() => setDetail(r)}
                title="押すと対象・対象外の販売先と商品の明細を出します"
              >
                {r.customer_mode === '対象外' ? <Badge>{customerSummary(r)}</Badge> : customerSummary(r)}
              </button>
            ),
          },
          {
            key: 'rate',
            label: '料率／定額',
            r: true,
            width: 100,
            render: (r) =>
              r.rate ? <Num>{pct(r.rate)}</Num> : r.fixed_amount ? `${money(r.fixed_amount)} 円` : <Badge>対象外のみ</Badge>,
          },
          { key: 'calc_base', label: '基準', width: 60, render: (r) => baseName(r.calc_base) },
          {
            key: 'valid_from',
            label: '適用期間',
            width: 140,
            render: (r) => (
              <Num>
                {ymd(r.valid_from)} 〜 {r.valid_to ? ymd(r.valid_to) : ''}
              </Num>
            ),
          },
          {
            key: 'is_active',
            label: '',
            width: 60,
            render: (r) => (
              <>
                {r.is_active ? '' : <Badge>非表示</Badge>}
                {(r.history_count ?? 0) > 0 && (
                  <span
                    className="block text-[10.5px] text-[var(--color-ink-3)]"
                    title="計算したあとで販売先・商品の指定を直したため、直す前の内容を計算済みの月の根拠として残しています。計算には使いません"
                  >
                    旧版 {r.history_count}
                  </span>
                )}
              </>
            ),
          },
        ]}
        rowKey={(r) => r.id}
        rowLabel={(r) => `${r.payee_name} の規定`}
        empty={() => ({
          payee: null,
          brand_id: '',
          products: [],
          excluded_products: [],
          media_id: '',
          customer_mode: '媒体全体',
          customers: [],
          rate_pct: '',
          fixed_amount: '',
          valid_from: today(),
          valid_to: '',
          note: '',
        })}
        toForm={toForm}
        // コピー（M3-37）は同じ中身（支払先・媒体・ブランド・商品・販売先・料率・期間）で登録の画面を開く。
        // 同じ範囲・同じ適用開始日では登録できないので、適用開始日か範囲を変えて登録する
        toCopyForm={toForm}
        toBody={(f) => ({
          payee_partner_id: f.payee?.id,
          brand_id: numOrNull(f.brand_id),
          product_id: null,
          product_ids: f.products.map((p) => p.id),
          excluded_product_ids: f.excluded_products.map((p) => p.id),
          media_id: numOrNull(f.media_id),
          customer_mode: f.customer_mode,
          customer_partner_ids: f.customer_mode === '媒体全体' ? [] : f.customers.map((c) => c.id),
          customer_partner_id: null,
          is_excluded: false,
          // 計算の基準は請求月（中の値は売上）に統一（M3-32）。画面では選ばない
          calc_base: '売上',
          rate: f.rate_pct.trim() ? (Number(f.rate_pct) / 100).toFixed(4) : null,
          fixed_amount: decOrNull(f.fixed_amount),
          valid_from: f.valid_from,
          valid_to: f.valid_to || null,
          note: strOrNull(f.note),
        })}
        renderForm={(f, set) => {
          const mediaId = numOrNull(f.media_id);
          const brandId = numOrNull(f.brand_id);
          // 販売先は規定の媒体の販売先からだけ選ぶ（他の媒体の販売先を入れると計算では 0 円になるため。API でも断る）
          const waitingForMedia = !mediaId;
          const modes: [CustomerMode, string][] = [
            ['媒体全体', 'この媒体の全販売先が対象'],
            ['対象', '選んだ販売先だけが対象'],
            ['対象外', '選んだ販売先を外し、残りが対象'],
          ];
          const productCount = f.products.length + f.excluded_products.length;
          return (
            <div className="flex flex-col gap-3">
              {element}
              <div className="master-grid-2">
                <L label="支払先" required>
                  <SearchSelect
                    value={f.payee}
                    onChange={(o) => set({ payee: o })}
                    fetchOptions={fetchAll}
                    placeholder="ロイヤリティの支払先（取引先マスタで印を付けた先）"
                    width="100%"
                  />
                </L>
                {/* 計算の基準は請求月に統一したので選ばせず、表示だけ（M3-32） */}
                <L label="計算の基準">
                  <span className="text-[12.5px]">
                    請求月<span className="text-[var(--color-ink-3)]">（締めた請求の月に計上）</span>
                  </span>
                </L>
              </div>

              <Section title="対象の範囲" />
              <div className="master-grid-2">
                <L label="媒体" required hint="テレビ・カタログなど。販売先はこの媒体の販売先（取引先マスタの媒体）から選びます">
                  <Select
                    value={f.media_id}
                    onChange={async (e) => {
                      // 販売先はその媒体の販売先しか入れられないので、媒体を変えたら選んだ社を外す。
                      // 黙って外すと気付かないので、選んでいるときは確かめる（再テスト R1）
                      const mediaId = e.target.value;
                      if (f.customers.length > 0) {
                        const ok = await confirm(
                          '媒体を変えますか',
                          `選んだ販売先 ${f.customers.length} 社は前の媒体の販売先なので外れます。新しい媒体の販売先を選び直してください。`,
                        );
                        if (!ok) return;
                      }
                      set({ media_id: mediaId, customers: [] });
                    }}
                  >
                    <option value="">選んでください</option>
                    {(medias.data?.items ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                </L>
                <L label="ブランド" hint="空欄なら支払先に紐づくすべて">
                  <Select
                    value={f.brand_id}
                    onChange={async (e) => {
                      // 商品はブランドの商品から選ぶので、ブランドを変えたら選んだ商品を外す（API でも断る）
                      const brand = e.target.value;
                      if (brand && productCount > 0) {
                        const ok = await confirm(
                          'ブランドを変えますか',
                          `選んだ商品 ${productCount} 件を外します。新しいブランドの商品を選び直してください。`,
                        );
                        if (!ok) return;
                        set({ brand_id: brand, products: [], excluded_products: [] });
                        return;
                      }
                      set({ brand_id: brand });
                    }}
                  >
                    <option value="">すべて</option>
                    {(brands.data?.items ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                </L>
              </div>
              {/* 対象の商品・対象外の商品はそれぞれ複数選べる（M3-33）。両方は選ばない */}
              <div className="flex flex-col gap-2">
                <L label="対象の商品" hint="特定の商品だけに効かせるとき（複数選べます）。空欄ならブランド配下のすべて" wide>
                  <MultiSearchSelect
                    values={f.products}
                    onChange={(o) => set({ products: o })}
                    fetchOptions={fetchBrandProducts(brandId)}
                    max={MAX_PRODUCTS}
                    unit="件"
                    placeholder={
                      f.excluded_products.length > 0 ? '対象外の商品を選んだときは「すべて」です' : '商品を検索して追加…'
                    }
                    disabled={f.excluded_products.length > 0}
                    emptyLabel="すべて"
                  />
                </L>
                <L
                  label="対象外の商品"
                  hint="この商品だけロイヤリティを付けません（複数選べます）。料率を空欄にすると、この商品を対象外にするだけの規定になります"
                  wide
                >
                  <MultiSearchSelect
                    values={f.excluded_products}
                    onChange={(o) => set({ excluded_products: o })}
                    fetchOptions={fetchBrandProducts(brandId)}
                    max={MAX_PRODUCTS}
                    unit="件"
                    placeholder={
                      f.products.length > 0 ? '対象の商品を選んだときは使いません（選んだ商品だけが対象です）' : '商品を検索して追加…'
                    }
                    disabled={f.products.length > 0}
                    emptyLabel="なし"
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
                        onChange={async () => {
                          // 切り替えたら選んだ社を空にする。「対象外」で選んだ社がそのまま「対象」の社になり、
                          // 意味が逆になったまま保存できていた（T3 No.38）
                          if (f.customers.length > 0) {
                            const ok = await confirm(
                              `「${mode}」に切り替えますか`,
                              `選んだ販売先 ${f.customers.length} 社を外してから切り替えます。「${mode}」の販売先を選び直してください。`,
                            );
                            if (!ok) return;
                          }
                          set({ customer_mode: mode, customers: [] });
                        }}
                      />
                      <span>{mode}</span>
                      <span className="text-[11px] text-[var(--color-ink-3)]">{hint}</span>
                    </label>
                  ))}
                </div>

                {f.customer_mode !== '媒体全体' && (
                  <L label={f.customer_mode === '対象外' ? '対象外にする販売先' : '対象にする販売先'} required>
                    <MultiSearchSelect
                      values={f.customers}
                      onChange={(o) => set({ customers: o })}
                      fetchOptions={fetchCustomers(mediaId)}
                      max={MAX_CUSTOMERS}
                      placeholder={waitingForMedia ? '先に媒体を選んでください' : '販売先を検索して追加…'}
                      disabled={waitingForMedia}
                      emptyLabel="まだ選んでいません"
                    />
                  </L>
                )}
              </div>

              <Section title="料率" />
              <div className="master-grid-2">
                <L
                  label="料率（%）"
                  hint={
                    f.customer_mode === '対象外' || f.excluded_products.length > 0
                      ? '下代（卸単価×数量）にかけます。例：5 → 5%。空欄にすると「対象外」だけを登録します'
                      : '下代（卸単価×数量）にかけます。例：5 → 5%'
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
                  <span className="w-full text-[11px] text-[var(--color-ink-3)]">
                    料率は下代（卸単価×数量）にかけます。定額は1個あたりの金額です
                  </span>
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
      <Modal
        open={detail !== null}
        title="ロイヤリティ規定の明細"
        onClose={() => setDetail(null)}
        width={600}
        dismissible
        footer={<Button onClick={() => setDetail(null)}>閉じる</Button>}
      >
        {detail && <RuleDetail r={detail} />}
      </Modal>
    </>
  );
}
