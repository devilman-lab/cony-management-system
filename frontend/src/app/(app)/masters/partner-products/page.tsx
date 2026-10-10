'use client';

import { useMemo, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { useSimpleMaster } from '@/lib/hooks';
import { money } from '@/lib/format';
import { Badge, Input, Num, Select, Textarea } from '@/components/ui';
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
  shipping_jan: string | null;
  old_unit_price: string | null;
  price_changed_date: string | null;
  sales_name: string | null;
  sales_name2: string | null;
  unit_price: string;
  retail_price: string | null;
  cost_price: string | null;
  partner_color: string | null;
  partner_size: string | null;
  /** SKU マスタのカラー／サイズ名（一覧の表示用） */
  color_name: string | null;
  size_name: string | null;
  /** この得意先向けに印字するカラー／サイズ（得意先別商品の値） */
  print_color_name: string | null;
  print_size_name: string | null;
  product_class_name: string | null;
  /** 販売先カテゴリー（複数持てるので読点でつないだ文字列。1001 ご要望） */
  partner_category_names: string | null;
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
  shipping_jan: string;
  old_unit_price: string;
  price_changed_date: string;
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
  const [categoryId, setCategoryId] = useState('');
  const categories = useSimpleMaster('partner_categories');

  return (
    <MasterPage<PpRow, Form>
      title="得意先別商品"
      sub="取引先ごとの専用商品コード・卸単価・上代です。受注入力で取引先と SKU を選ぶと、ここの単価と上代が自動で入ります。販社CSVの取込でも突き合わせに使います"
      functionId="M-11"
      csvSlug="partner-products"
      listPath="/masters/partner-products"
      writePath="/masters/partner-products"
      extraFilters={{ partner_id: partner?.id, partner_category_id: categoryId || undefined }}
      modalWidth={760}
      toolbar={
        <>
          <SearchSelect value={partner} onChange={setPartner} fetchOptions={fetchCustomers} placeholder="取引先で絞る" />
          {/* 販売先カテゴリーで絞る（1001 ご要望） */}
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="!w-[190px]">
            <option value="">販売先カテゴリー：すべて</option>
            {(categories.data?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </>
      }
      columns={[
        { key: 'partner_name', label: '取引先', width: 100, render: (r) => <span><Num className="text-[var(--color-ink-3)] mr-1">{r.partner_code}</Num>{r.partner_name}</span> },
        { key: 'partner_category_names', label: '販売先カテゴリー', width: 72, render: (r) => r.partner_category_names ?? <span className="text-[var(--color-ink-3)]">（なし）</span> },
        { key: 'sku_code', label: 'SKU', width: 116, render: (r) => <Num className="font-semibold">{r.sku_code}</Num> },
        { key: 'product_name', label: '商品名', render: (r) => r.sales_name || r.product_name },
        { key: 'product_class_name', label: '商品分類', width: 58, render: (r) => r.product_class_name ?? '' },
        { key: 'color_name', label: 'カラー', width: 58, render: (r) => r.color_name ?? '' },
        { key: 'size_name', label: 'サイズ', width: 48, render: (r) => r.size_name ?? '' },
        { key: 'partner_product_code', label: '先方コード', width: 70, render: (r) => <Num>{r.partner_product_code ?? ''}</Num> },
        { key: 'partner_jan', label: '先方JAN', width: 100, nowrap: true, render: (r) => <Num>{r.partner_jan ?? ''}</Num> },
        { key: 'unit_price', label: '卸単価', r: true, width: 62, render: (r) => money(r.unit_price) },
        { key: 'retail_price', label: '上代', r: true, width: 62, render: (r) => money(r.retail_price) },
        { key: 'is_active', label: '', width: 36, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
      ]}
      rowKey={(r) => r.id}
      empty={() => ({ partner, sku: null, partner_product_code: '', partner_jan: '', jan_code: '', shipping_jan: '', old_unit_price: '', price_changed_date: '', sales_name: '', sales_name2: '', unit_price: '', retail_price: '', cost_price: '', partner_color: '', partner_size: '', color_name: '', size_name: '', memo: '', sort_order: '', note: '' })}
      toForm={(r) => ({
        partner: { id: r.partner_id, label: r.partner_name, sub: r.partner_code },
        // 候補（fetchSkus）と同じ書き方。編集画面ではカラー・サイズまで全部見せる（2026-10-09 マスター編② M-19）
        sku: { id: r.sku_id, label: `${r.sku_code}　${r.product_name}${r.color_name ? ' ' + r.color_name : ''}${r.size_name ? ' ' + r.size_name : ''}` },
        partner_product_code: s(r.partner_product_code), partner_jan: s(r.partner_jan), jan_code: s(r.jan_code),
        shipping_jan: s(r.shipping_jan), old_unit_price: dec(r.old_unit_price), price_changed_date: r.price_changed_date ? String(r.price_changed_date).slice(0, 10) : '',
        sales_name: s(r.sales_name), sales_name2: s(r.sales_name2), unit_price: dec(r.unit_price), retail_price: dec(r.retail_price), cost_price: dec(r.cost_price),
        partner_color: s(r.partner_color), partner_size: s(r.partner_size), color_name: s(r.print_color_name), size_name: s(r.print_size_name),
        memo: s(r.memo), sort_order: s(r.sort_order), note: s(r.note),
      })}
      toBody={(f) => ({
        partner_id: f.partner?.id,
        sku_id: f.sku?.id,
        partner_product_code: strOrNull(f.partner_product_code),
        partner_jan: strOrNull(f.partner_jan),
        jan_code: strOrNull(f.jan_code),
        shipping_jan: strOrNull(f.shipping_jan),
        old_unit_price: decOrNull(f.old_unit_price),
        price_changed_date: strOrNull(f.price_changed_date),
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
          {/*
            取引先の下に自社SKUを置き、どちらも横幅いっぱいで全文を出す（2026-10-09 マスター編② M-19「表示名が切れてしまってる」）。
            編集では取引先・SKU を変えられないので、選択欄（長いと「…」で切れる）ではなく文字で出す。
          */}
          <div className="master-grid-2">
            <L label="取引先" required wide>
              {editing ? (
                <span className="text-[12.5px] py-1 break-all"><Num className="text-[var(--color-ink-3)] mr-1">{f.partner?.sub ?? ''}</Num>{f.partner?.label ?? ''}</span>
              ) : (
                <SearchSelect value={f.partner} onChange={(o) => set({ partner: o })} fetchOptions={fetchCustomers} placeholder="得意先を検索" width="100%" />
              )}
            </L>
            <L label="自社 SKU" required wide>
              {editing ? (
                <span className="text-[12.5px] py-1 break-all">{f.sku?.label ?? ''}</span>
              ) : (
              <SearchSelect
                value={f.sku}
                onChange={(o) => {
                  // 先方の商品コードが空、または前に選んだ SKU のコードを写したままのときは、自社SKUコードを写す。
                  // 多くの取引先で同じコードを使うため、都度手で打つと打ち間違いの元になる（1001 のご指摘）。
                  // 選び直したときに前の SKU のコードが残り、食い違ったまま保存できていた。
                  const skuCode = (o?.raw as { sku_code?: string } | undefined)?.sku_code ?? '';
                  const prevCode = f.sku ? f.sku.label.split('　')[0] : '';
                  const current = f.partner_product_code.trim();
                  set(skuCode && (current === '' || current === prevCode) ? { sku: o, partner_product_code: skuCode } : { sku: o });
                }}
                fetchOptions={fetchSkus}
                placeholder="SKU・JAN・商品名で検索"
                width="100%"
              />
              )}
              {/* 新規で選んだ後も、長い商品名を切らずに読めるようにする */}
              {!editing && f.sku && <span className="w-full text-[11.5px] text-[var(--color-ink-2)] break-all">{f.sku.label}</span>}
            </L>
          </div>
          <Section title="先方のコード・名称" />
          <div className="master-grid-2">
            <L label="先方の商品コード" hint="販社CSVの突き合わせに使います"><Input value={f.partner_product_code} onChange={(e) => set({ partner_product_code: e.target.value })} /></L>
            <L label="先方の JAN" hint="受注入力でこの JAN を打っても商品を引けます"><Input value={f.partner_jan} onChange={(e) => set({ partner_jan: e.target.value })} /></L>
            {/* 出荷JANは出荷指示書・納品書の JAN 欄に出す。空なら SKU の JAN（コニーJAN）（M-18） */}
            <L label="出荷 JAN" hint="出荷指示書・納品書の JAN 欄に印字します。空欄なら SKU の JAN（コニーJAN）" wide><Input value={f.shipping_jan} onChange={(e) => set({ shipping_jan: e.target.value })} className="!w-[220px]" /></L>
            {/* 販売名｜販売名2 ／ 先方のカラー/サイズ｜印字するカラー/サイズ の並び（M-20） */}
            <L label="販売名（納品書に印字）"><Input value={f.sales_name} onChange={(e) => set({ sales_name: e.target.value })} /></L>
            <L label="販売名2"><Input value={f.sales_name2} onChange={(e) => set({ sales_name2: e.target.value })} /></L>
            <L label="先方のカラー／サイズ"><Input value={f.partner_color} onChange={(e) => set({ partner_color: e.target.value })} className="!w-[120px]" placeholder="カラー" /><Input value={f.partner_size} onChange={(e) => set({ partner_size: e.target.value })} className="!w-[120px]" placeholder="サイズ" /></L>
            <L label="印字するカラー／サイズ"><Input value={f.color_name} onChange={(e) => set({ color_name: e.target.value })} className="!w-[120px]" placeholder="カラー" /><Input value={f.size_name} onChange={(e) => set({ size_name: e.target.value })} className="!w-[120px]" placeholder="サイズ" /></L>
          </div>
          <Section title="単価" />
          <div className="master-grid-2">
            <L label="卸単価" required><Input right value={f.unit_price} onChange={(e) => set({ unit_price: e.target.value })} className="!w-[130px]" /></L>
            <L label="上代" hint="納品書「上代あり」に印字"><Input right value={f.retail_price} onChange={(e) => set({ retail_price: e.target.value })} className="!w-[130px]" /></L>
            <L label="旧単価" hint="値段を変えたとき、前の単価を残しておく欄"><Input right value={f.old_unit_price} onChange={(e) => set({ old_unit_price: e.target.value })} className="!w-[130px]" /></L>
            <L label="単価の変更日"><Input type="date" value={f.price_changed_date} onChange={(e) => set({ price_changed_date: e.target.value })} className="!w-[150px]" /></L>
            {/* 取引先ごとに原価が違うときだけ入れる上書き用。粗利の計算は 得意先別 → SKU → 商品 の順に使う（M-22） */}
            {canSeeSensitive && <L label="原価（この取引先向け）" hint="空欄なら商品（SKU）の原価を使います"><Input right value={f.cost_price} onChange={(e) => set({ cost_price: e.target.value })} className="!w-[130px]" /></L>}
            <L label="表示順"><Input right value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} className="!w-[90px]" /></L>
          </div>
          <Input value={f.memo} onChange={(e) => set({ memo: e.target.value })} placeholder="メモ" />
          <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="備考" />
        </div>
      )}
    />
  );
}
