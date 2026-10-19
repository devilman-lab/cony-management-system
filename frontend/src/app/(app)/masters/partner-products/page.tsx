'use client';

import { useMemo, useState } from 'react';

import { useSimpleMaster } from '@/lib/hooks';
import { moneyCell, ymd } from '@/lib/format';
import { Badge, Input, Num, Select, Textarea } from '@/components/ui';
import { SearchSelect, fetchPartners, fetchSkus, type Option } from '@/components/ui/SearchSelect';
import { MasterPage, decOrNull, numOrNull, strOrNull } from '@/components/masters/MasterPage';
import { L, Section } from '@/components/masters/Form';

interface PpRow extends Record<string, unknown> {
  id: number;
  partner_id: number;
  partner_code: string;
  partner_name: string;
  /** 取引先の略称（一覧はコードと略称の2列。2026-10-16 マスター編_3 M3-25） */
  partner_short_name: string | null;
  /** 取引先マスタの媒体（販売先カテゴリーに代えて出す。M3-08） */
  media_name: string | null;
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
  /** 取引先の通貨（2026-10-13 再テスト）。外貨の単価は「USD 12.50」と出す */
  partner_currency?: string;
  partner_color: string | null;
  partner_size: string | null;
  /** SKU マスタのカラー／サイズ名（一覧の表示用） */
  color_name: string | null;
  size_name: string | null;
  /** この得意先向けに印字するカラー／サイズ（得意先別商品の値） */
  print_color_name: string | null;
  print_size_name: string | null;
  product_class_name: string | null;
  sort_order: number | null;
  note: string | null;
  is_active: boolean;
}

interface Form {
  partner: Option | null;
  sku: Option | null;
  partner_product_code: string;
  /**
   * 先方の商品コードに自社SKUから写したコード。手で打ったコードと見分けるために覚えておく。
   * SKU を「×」で外しても消さない（外して選び直したときも、写したままのコードなら新しい SKU に追従させるため）。
   * 保存はしない。
   */
  copied_code: string;
  partner_jan: string;
  jan_code: string;
  shipping_jan: string;
  old_unit_price: string;
  price_changed_date: string;
  sales_name: string;
  sales_name2: string;
  unit_price: string;
  retail_price: string;
  partner_color: string;
  partner_size: string;
  color_name: string;
  size_name: string;
  sort_order: string;
  note: string;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
/** 数値を末尾の 0 なしで（3000.0000 → 3000） */
const dec = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));
/** 商品名は「商品名 カラー サイズ」で出す（2026-10-16 マスター編_3 M3-25「商品名は下記の通りで表記したい」） */
const skuFullName = (r: Pick<PpRow, 'product_name' | 'color_name' | 'size_name'>) => [r.product_name, r.color_name, r.size_name].filter(Boolean).join(' ');
/** 編集画面の3列の並び（M3-28「横に広く」）。狭い画面では1列 */
const GRID3 = 'grid grid-cols-1 lg:grid-cols-3 gap-x-6';

/** 得意先別商品（M-11）。取引先ごとの専用コード・卸単価・上代。受注入力で自動的に引かれる。 */
export default function PartnerProductsPage() {
  const fetchCustomers = useMemo(() => fetchPartners('customer'), []);
  const [partner, setPartner] = useState<Option | null>(null);
  // 取引先マスタの媒体で絞る。以前の「販売先カテゴリー」に代えた（2026-10-16 マスター編_3 M3-08「媒体で区別してるので」）
  const [mediaId, setMediaId] = useState('');
  const media = useSimpleMaster('media');

  const toForm = (r: PpRow): Form => ({
    partner: { id: r.partner_id, label: r.partner_name, sub: r.partner_code },
    // 候補（fetchSkus）と同じ書き方。編集画面ではカラー・サイズまで全部見せる（2026-10-09 マスター編② M-19）
    sku: { id: r.sku_id, label: `${r.sku_code}　${skuFullName(r)}` },
    partner_product_code: s(r.partner_product_code), copied_code: r.partner_product_code === r.sku_code ? r.sku_code : '', partner_jan: s(r.partner_jan), jan_code: s(r.jan_code),
    shipping_jan: s(r.shipping_jan), old_unit_price: dec(r.old_unit_price), price_changed_date: r.price_changed_date ? String(r.price_changed_date).slice(0, 10) : '',
    sales_name: s(r.sales_name), sales_name2: s(r.sales_name2), unit_price: dec(r.unit_price), retail_price: dec(r.retail_price),
    partner_color: s(r.partner_color), partner_size: s(r.partner_size), color_name: s(r.print_color_name), size_name: s(r.print_size_name),
    sort_order: s(r.sort_order), note: s(r.note),
  });

  return (
    <MasterPage<PpRow, Form>
      title="得意先別商品"
      sub="取引先ごとの専用商品コード・卸単価・上代です。同じ商品に先方コード・単価の違うものを複数登録でき、受注入力でどれかを選びます。販社CSVの取込でも突き合わせに使います"
      functionId="M-11"
      csvSlug="partner-products"
      csvHint={
        <>
          行は「取引先コード・SKUコード・先方の商品コード」で突き合わせます。同じ取引先・同じ SKU に2行目を足すときは、先方の商品コードを入れてください（先方の商品コードが空の行は、取引先・SKU ごとに1つまでです）。
          先方の商品コードを書き換えるときは、編集画面で直してください。
        </>
      }
      listPath="/masters/partner-products"
      writePath="/masters/partner-products"
      extraFilters={{ partner_id: partner?.id, media_id: mediaId || undefined }}
      modalWidth={1080}
      toolbar={
        <>
          <SearchSelect value={partner} onChange={setPartner} fetchOptions={fetchCustomers} placeholder="取引先で絞る" />
          <Select value={mediaId} onChange={(e) => setMediaId(e.target.value)} className="!w-[160px]">
            <option value="">媒体：すべて</option>
            {(media.data?.items ?? []).map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </Select>
        </>
      }
      // 横に長くてよい（横スクロール可）。取引先はコードと略称の2列、商品名は「商品名 カラー サイズ」で詰め、
      // 備考・単価変更日・旧単価を足した（2026-10-16 マスター編_3 M3-25）
      columns={[
        { key: 'partner_code', label: '取引先コード', width: 74, nowrap: true, render: (r) => <Num className="text-[var(--color-ink-2)]">{r.partner_code}</Num> },
        { key: 'partner_short_name', label: '略称', width: 110, render: (r) => r.partner_short_name || r.partner_name },
        { key: 'media_name', label: '媒体', width: 80, render: (r) => r.media_name ?? '' },
        { key: 'sku_code', label: 'SKU', width: 120, nowrap: true, render: (r) => <Num className="font-semibold">{r.sku_code}</Num> },
        { key: 'product_name', label: '商品名', width: 210, render: (r) => skuFullName(r) },
        { key: 'sales_name', label: '販売名', width: 130, render: (r) => r.sales_name ?? '' },
        // 商品分類は1行。全角10字ほどの分類名が収まる幅にし、収まらない分は「…」でマウスを載せると全文（2026-10-18 受入 W2 M3-25。
        // 表の既定は「…」を出さずに切るので、中の span で「…」にする）
        { key: 'product_class_name', label: '商品分類', width: 140, nowrap: true, render: (r) => <span className="block truncate" title={r.product_class_name ?? undefined}>{r.product_class_name ?? ''}</span> },
        { key: 'partner_product_code', label: '先方コード', width: 104, nowrap: true, render: (r) => <Num>{r.partner_product_code ?? ''}</Num> },
        { key: 'partner_jan', label: '先方JAN', width: 104, nowrap: true, render: (r) => <Num>{r.partner_jan ?? ''}</Num> },
        { key: 'unit_price', label: '卸単価', r: true, width: 70, render: (r) => moneyCell(r.unit_price, r.partner_currency) },
        { key: 'old_unit_price', label: '旧単価', r: true, width: 70, render: (r) => moneyCell(r.old_unit_price, r.partner_currency) },
        { key: 'price_changed_date', label: '単価変更日', width: 84, nowrap: true, render: (r) => <Num>{ymd(r.price_changed_date)}</Num> },
        { key: 'retail_price', label: '上代', r: true, width: 70, render: (r) => moneyCell(r.retail_price, r.partner_currency) },
        { key: 'note', label: '備考', width: 160, nowrap: true, render: (r) => <span className="block truncate" title={r.note ?? undefined}>{(r.note ?? '').replace(/\s+/g, ' ')}</span> },
        { key: 'is_active', label: '', width: 40, render: (r) => (r.is_active ? '' : <Badge>非表示</Badge>) },
      ]}
      rowKey={(r) => r.id}
      // 削除の確認に対象のコードと名前を出す（2026-10-12 受入 No.1 注記「このデータを完全に消します」だけで何を消すか分からない）
      rowLabel={(r) =>
        `得意先別商品 ${r.partner_code} ${r.partner_short_name || r.partner_name} × ${r.sku_code}${r.partner_product_code ? `（先方コード ${r.partner_product_code}）` : ''}${r.sales_name ? `（${r.sales_name}）` : ` ${r.product_name}`}`
      }
      empty={() => ({ partner, sku: null, partner_product_code: '', copied_code: '', partner_jan: '', jan_code: '', shipping_jan: '', old_unit_price: '', price_changed_date: '', sales_name: '', sales_name2: '', unit_price: '', retail_price: '', partner_color: '', partner_size: '', color_name: '', size_name: '', sort_order: '', note: '' })}
      toForm={toForm}
      // コピーは同じ取引先・同じ SKU に別の先方コード・単価の行を足す用途（M3-26）。先方の商品コードは取引先の中で
      // 重ねられないので空にして開く（そのまま保存すると「同じ専用コード」で断られるため）
      toCopyForm={(r) => ({ ...toForm(r), partner_product_code: '', copied_code: '' })}
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
        partner_color: strOrNull(f.partner_color),
        partner_size: strOrNull(f.partner_size),
        color_name: strOrNull(f.color_name),
        size_name: strOrNull(f.size_name),
        sort_order: numOrNull(f.sort_order),
        note: strOrNull(f.note),
      })}
      renderForm={(f, set, editing) => (
        // 縦に伸ばすより横に広く（2列→3列。2026-10-16 マスター編_3 M3-28「全体的に縦に伸ばすより、横に伸ばしてほしい」）。
        // 「原価（この取引先向け）」「メモ」は外した（得意先別原価は無い・メモ不要）。表示／非表示は共通の部品が足す
        <div className="flex flex-col gap-3">
          {/*
            取引先と自社SKUは全文を出す（2026-10-09 マスター編② M-19「表示名が切れてしまってる」）。
            編集では取引先・SKU を変えられないので、選択欄（長いと「…」で切れる）ではなく文字で出す。
          */}
          <div className="master-grid-2">
            <L label="取引先" required>
              {editing ? (
                <span className="text-[12.5px] py-1 break-all"><Num className="text-[var(--color-ink-3)] mr-1">{f.partner?.sub ?? ''}</Num>{f.partner?.label ?? ''}</span>
              ) : (
                <SearchSelect value={f.partner} onChange={(o) => set({ partner: o })} fetchOptions={fetchCustomers} placeholder="得意先を検索" width="100%" />
              )}
            </L>
            <L label="自社 SKU" required>
              {editing ? (
                <span className="text-[12.5px] py-1 break-all">{f.sku?.label ?? ''}</span>
              ) : (
              <SearchSelect
                value={f.sku}
                onChange={(o) => {
                  // 先方の商品コードが空、または前に選んだ SKU のコードを写したままのときは、自社SKUコードを写す。
                  // 多くの取引先で同じコードを使うため、都度手で打つと打ち間違いの元になる（1001 のご指摘）。
                  // 選び直したときに前の SKU のコードが残り、食い違ったまま保存できていた。
                  // 「×」で外してから選び直したときも追従させる（外すと前の SKU が空になるので、写したコードは copied_code で覚えておく。T3 No.30）。
                  const skuCode = (o?.raw as { sku_code?: string } | undefined)?.sku_code ?? '';
                  const prevCode = f.sku ? f.sku.label.split('　')[0] : '';
                  const current = f.partner_product_code.trim();
                  const copied = current === '' || current === f.copied_code || current === prevCode;
                  set(skuCode && copied ? { sku: o, partner_product_code: skuCode, copied_code: skuCode } : { sku: o });
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
          <div className={GRID3}>
            <L label="先方の商品コード" hint="販社CSVの突き合わせに使います。同じ取引先の中で重ねられません"><Input value={f.partner_product_code} onChange={(e) => set({ partner_product_code: e.target.value })} /></L>
            <L label="先方の JAN" hint="受注入力でこの JAN を打っても商品を引けます"><Input value={f.partner_jan} onChange={(e) => set({ partner_jan: e.target.value })} /></L>
            {/* 出荷JANは出荷指示書・納品書の JAN 欄に出す。空なら SKU の JAN（コニーJAN）（M-18） */}
            <L label="出荷 JAN" hint="出荷指示書・納品書の JAN 欄に印字。空欄なら SKU の JAN"><Input value={f.shipping_jan} onChange={(e) => set({ shipping_jan: e.target.value })} /></L>
            {/* 販売名｜販売名2 ／ 先方のカラー/サイズ｜印字するカラー/サイズ の並び（M-20） */}
            <L label="販売名" hint="納品書に印字"><Input value={f.sales_name} onChange={(e) => set({ sales_name: e.target.value })} /></L>
            <L label="販売名2"><Input value={f.sales_name2} onChange={(e) => set({ sales_name2: e.target.value })} /></L>
            <L label="表示順" hint="同じ SKU に複数あるときの並び"><Input right value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} className="!w-[90px]" /></L>
            <L label="先方のカラー／サイズ"><Input value={f.partner_color} onChange={(e) => set({ partner_color: e.target.value })} className="!w-[84px]" placeholder="カラー" /><Input value={f.partner_size} onChange={(e) => set({ partner_size: e.target.value })} className="!w-[84px]" placeholder="サイズ" /></L>
            <L label="印字するカラー／サイズ"><Input value={f.color_name} onChange={(e) => set({ color_name: e.target.value })} className="!w-[84px]" placeholder="カラー" /><Input value={f.size_name} onChange={(e) => set({ size_name: e.target.value })} className="!w-[84px]" placeholder="サイズ" /></L>
          </div>
          <Section title="単価" />
          <div className={GRID3}>
            <L label="卸単価" required><Input right value={f.unit_price} onChange={(e) => set({ unit_price: e.target.value })} className="!w-[130px]" /></L>
            <L label="旧単価" hint="値段を変えたとき、前の単価を残しておく欄"><Input right value={f.old_unit_price} onChange={(e) => set({ old_unit_price: e.target.value })} className="!w-[130px]" /></L>
            <L label="単価の変更日"><Input type="date" value={f.price_changed_date} onChange={(e) => set({ price_changed_date: e.target.value })} className="!w-[150px]" /></L>
            <L label="上代" hint="納品書「上代あり」に印字"><Input right value={f.retail_price} onChange={(e) => set({ retail_price: e.target.value })} className="!w-[130px]" /></L>
          </div>
          <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="備考（受注入力で同じ商品の行を選ぶときにも出ます）" />
        </div>
      )}
    />
  );
}
