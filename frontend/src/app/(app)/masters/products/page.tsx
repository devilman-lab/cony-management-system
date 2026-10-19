'use client';

import { Fragment, useEffect, useState, type ReactNode } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCodes, useSimpleMaster } from '@/lib/hooks';
import { money } from '@/lib/format';
import { Badge, Button, ErrorBox, Input, Num, Select, Textarea, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { MasterPage, numOrNull, strOrNull } from '@/components/masters/MasterPage';
import { MasterCsv } from '@/components/masters/MasterCsv';
import { Check, L, Section } from '@/components/masters/Form';

/** 一覧の SKU 1行（API が品番ごとに添える。M3-15） */
interface SkuLine {
  id: number;
  sku_code: string;
  /** 商品名（SKU の商品名か商品名）＋カラー＋サイズ */
  item_name: string;
  jan: string | null;
  /** 原価を見てよい人にだけ返る */
  cost_price?: string | null;
  old_cost_price?: string | null;
  /** SKU の原価が空のときに使われる商品の原価 */
  product_cost_price?: string | null;
  is_active: boolean;
}

interface ProductRow extends Record<string, unknown> {
  id: number;
  product_code: string;
  product_name: string;
  set_product_name: string | null;
  brand_name: string | null;
  category_name: string | null;
  product_class_code: string | null;
  product_class_name: string | null;
  tax_rate: string;
  carton_qty: number | null;
  is_set: boolean;
  sku_count?: number;
  is_active: boolean;
  skus: SkuLine[];
}

interface Sku {
  id?: number;
  /** 画面の中だけで使う行の鍵。行のコピー・削除で並びが変わっても入力欄が入れ替わらないように */
  _key: number;
  sku_code: string;
  /** SKU ごとの商品名。空なら商品の商品名を使う（2026-10-09 マスター編②） */
  sku_name: string;
  jan: string;
  fba_jan: string;
  shop_product_code: string;
  /** この SKU の原価。原価・旧原価は SKU ごとに持つ（2026-10-18 マスター編_3 M3-19） */
  cost_price: string;
  old_cost_price: string;
  color_id: string;
  size_id: string;
  /**
   * 入数区分。画面の列は外した（M3-20「不要」）が、登録済みの値は保存し直しても消さないよう持っておく
   * （CSV・JANコード一覧CSV には今までどおり出る）
   */
  pack_division: string;
  is_active: boolean;
  _dirty?: boolean;
  /**
   * 商品のコピーで写した行の、品番より後ろの部分（W2P1-0101 なら -0101）。品番を直すと、商品コードが
   * 「品番＋この部分」のままの行は頭を新しい品番に付け替える（2026-10-18 受入 W1 N5）。商品コードを手で直した行はそのまま
   */
  _suffix?: string;
}

interface Form {
  product_code: string;
  product_name: string;
  set_product_name: string;
  brand_id: string;
  category_id: string;
  product_class_id: string;
  carton_qty: string;
  tax_rate: string;
  is_set: boolean;
  /** ロイヤリティ区分（区分値 ROYALTY_CLASS：機械／機械以外。M3-23） */
  royalty_class_code_id: string;
  /** 下代調整対象（M3-23） */
  is_wholesale_adjust_target: boolean;
  sort_order: string;
  note: string;
  /**
   * 商品の原価（画面では直さない。M3-19）。SKU の原価が空のときに計算で使われる値なので、
   * SKU 表の原価の欄に薄い字で見せる
   */
  product_cost: string;
  skus: Sku[];
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
/** 数値を末尾の 0 なしで（3000.0000 → 3000） */
const dec = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));
let skuKeySeq = 1;
/** 商品の詳細（API）の SKU 1件 → 画面の行。編集できる欄はすべて写す（写し忘れた欄は保存し直すと消えるため） */
const toSku = (k: Record<string, unknown>): Sku => ({
  id: Number(k.id), _key: skuKeySeq++, sku_code: s(k.sku_code), sku_name: s(k.sku_name), jan: s(k.jan), fba_jan: s(k.fba_jan),
  shop_product_code: s(k.shop_product_code), cost_price: dec(k.cost_price), old_cost_price: dec(k.old_cost_price), color_id: s(k.color_id), size_id: s(k.size_id),
  pack_division: s(k.pack_division), is_active: k.is_active !== false,
});
const emptySku = (): Sku => ({ _key: skuKeySeq++, sku_code: '', sku_name: '', jan: '', fba_jan: '', shop_product_code: '', cost_price: '', old_cost_price: '', color_id: '', size_id: '', pack_division: '', is_active: true, _dirty: true });

type ProductDetail = Record<string, unknown> & { skus: Record<string, unknown>[] };
/** 商品の詳細（API）→ フォーム */
const detailToForm = (d: ProductDetail): Form => ({
  product_code: s(d.product_code), product_name: s(d.product_name), set_product_name: s(d.set_product_name),
  brand_id: s(d.brand_id), category_id: s(d.category_id), product_class_id: s(d.product_class_id),
  carton_qty: s(d.carton_qty), tax_rate: s(d.tax_rate || '10.00'), is_set: Boolean(d.is_set),
  royalty_class_code_id: s(d.royalty_class_code_id), is_wholesale_adjust_target: Boolean(d.is_wholesale_adjust_target),
  sort_order: s(d.sort_order), note: s(d.note), product_cost: dec(d.cost_price),
  skus: (d.skus ?? []).map(toSku),
});

/** 商品マスタ（M-08）と SKU（M-09）。商品（品番）の下に色・サイズごとの SKU（商品コード）を持つ。 */
export default function ProductsPage() {
  const { canSeeSensitive, can } = useAuth();
  const toast = useToast();
  const brands = useSimpleMaster('brands');
  const categories = useSimpleMaster('categories');
  const classes = useSimpleMaster('product_classes');
  const colors = useSimpleMaster('colors');
  const sizes = useSimpleMaster('sizes');
  const royaltyClasses = useCodes('ROYALTY_CLASS');
  const [brandId, setBrandId] = useState('');
  const [skuError, setSkuError] = useState<unknown>(null);

  /**
   * 商品分類の候補（M3-18）。ブランドを選んでいれば、そのブランドの分類と、ブランドを決めていない分類だけ。
   * 今選ばれている分類は、ブランドが合わなくても消さずに出す（登録済みのデータを開いたときに空に見えないように）
   */
  const classOptions = (brand: string, current: string) =>
    (classes.data?.items ?? []).filter((c) => {
      const b = (c as { brand_id?: number | null }).brand_id;
      return !brand || b === null || b === undefined || String(b) === brand || String(c.id) === current;
    });
  const classFits = (classId: string, brand: string) => {
    const c = (classes.data?.items ?? []).find((x) => String(x.id) === classId);
    const b = (c as { brand_id?: number | null } | undefined)?.brand_id;
    return !c || !brand || b === null || b === undefined || String(b) === brand;
  };

  /**
   * SKU は商品と別の経路で保存する（商品の更新後に呼ぶ）。
   *
   * 途中の行で失敗しても、それまでに保存できた行は「保存済み」として画面に戻す（keep）。
   * 戻さないと、もう一度保存したときに登録済みの行をまた登録しようとして、商品コードの重複で断られる。
   * 原価の欄は、見てよい人にだけ送る（見えない人が保存して原価が空で上書きされないように）。
   */
  /** SKU 1行の送る中身（商品の番号は除く）。原価の欄は見てよい人にだけ */
  const skuBody = (k: Sku) => ({
    sku_code: k.sku_code.trim(), sku_name: strOrNull(k.sku_name), jan: strOrNull(k.jan), fba_jan: strOrNull(k.fba_jan),
    shop_product_code: strOrNull(k.shop_product_code), color_id: numOrNull(k.color_id), size_id: numOrNull(k.size_id), pack_division: strOrNull(k.pack_division),
    ...(canSeeSensitive ? { cost_price: strOrNull(k.cost_price), old_cost_price: strOrNull(k.old_cost_price) } : {}),
  });
  const saveSkus = async (productId: number, skus: Sku[], keep: (skus: Sku[]) => void) => {
    const out = skus.map((k) => ({ ...k }));
    try {
      for (const k of out) {
        if (!k._dirty || !k.sku_code.trim()) continue;
        const body = { product_id: productId, ...skuBody(k) };
        if (k.id) await api.patch(`/masters/skus/${k.id}`, { ...body, is_active: k.is_active });
        else k.id = Number((await api.post<{ id: number }>('/masters/skus', body)).id);
        k._dirty = false;
      }
    } finally {
      keep(out);
    }
  };
  /** SKU を保存し、API から読み直して画面に戻す（保存されたとおりの値を見せる） */
  const saveAndReload = async (productId: number, skus: Sku[], set: (patch: Partial<Form>) => void) => {
    await saveSkus(productId, skus, (kept) => set({ skus: kept }));
    const d = await api.get<{ skus: Record<string, unknown>[] }>(`/masters/products/${productId}`);
    // 商品コードが空でまだ保存していない行は、読み直しで消さずに残す
    set({ skus: [...d.skus.map(toSku), ...skus.filter((k) => !k.id && !k.sku_code.trim() && k._dirty)] });
  };

  return (
    <MasterPage<ProductRow, Form>
      title="商品"
      sub="商品（品番）と、その下の SKU（商品コード：色・サイズ・JAN）。原価は権限のある方にだけ表示されます"
      functionId="M-08"
      csvSlug="products"
      csvHint="品番は「品番（商品分類コード）」の列で突き合わせます（前の CSV の「商品コード」の列も品番として読みます）。SKU（商品コード・JAN・原価）は「SKU」の CSV で直します。"
      listPath="/masters/products"
      writePath="/masters/products"
      extraFilters={{ brand_id: brandId || undefined }}
      // SKU 表の原価・有効まで横にずらさずに見えるよう広げる（M-07）。狭い画面では画面の幅いっぱいまで
      modalWidth={1300}
      headRight={
        <>
          {/* SKU は専用の画面が無いので、商品マスタからまとめて出し入れする（JAN・FBA用JANの一括修正用） */}
          {/* 見出しは画面の呼び方（2026-10-18 受入 W2）。前に書き出した CSV（「SKUコード」の見出しがあるもの）も前と同じ意味で読む */}
          <MasterCsv
            slug="skus"
            name="SKU"
            functionId="M-09"
            includeInactive={false}
            onImported={() => location.reload()}
            hint="見出しの「商品コード」は SKU のコード、「品番（商品分類コード）」はその SKU の品番です。前の書式（見出しに「SKUコード」がある CSV）は、前と同じく「SKUコード」＝SKU、「商品コード」＝品番として読みます。"
          />
          {can('M-09', 'print') && (
            <Button
              icon="download"
              onClick={() =>
                api.download('/masters/skus/jan-export').catch((e) => toast(e instanceof Error ? e.message : '失敗しました', 'bad'))
              }
            >
              JANコード一覧CSV
            </Button>
          )}
        </>
      }
      toolbar={
        <Select value={brandId} onChange={(e) => setBrandId(e.target.value)} className="!w-[160px]">
          <option value="">ブランド：すべて</option>
          {(brands.data?.items ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
      }
      // 一覧は品番ごとにまとめて SKU を1行ずつ並べる（M3-15）。表は下の ProductTable で組む
      columns={[]}
      renderTable={(t) => <ProductTable {...t} showCost={canSeeSensitive} />}
      rowKey={(r) => r.id}
      // 商品の削除は SKU ごと消える（どこにも使われていないときだけ）。何が消えるかを確認の文言に出す
      rowLabel={(r) => `${r.product_code}　${r.product_name}${r.sku_count ? `（SKU ${r.sku_count}件を含む）` : ''}`}
      empty={() => ({ product_code: '', product_name: '', set_product_name: '', brand_id: '', category_id: '', product_class_id: '', carton_qty: '', tax_rate: '10.00', is_set: false, royalty_class_code_id: '', is_wholesale_adjust_target: false, sort_order: '', note: '', product_cost: '', skus: [] })}
      toForm={async (r) => detailToForm(await api.get<ProductDetail>(`/masters/products/${r.id}`))}
      // 商品のコピー（M3-02）: SKU も写した登録の画面にする。SKU の id は外し（元の SKU を書き換えないように）、
      // 商品コードなどのコードは写す（重なるときは直してから「登録する」）
      // JAN・FBA用JAN・ショップ商品コードは SKU ごとに違うものなので空にする（行のコピーと同じ。2026-10-18 受入 W1 N5。
      // 写したままだと元の商品の JAN と重なり、登録できなかった）。品番で始まる商品コードは、品番を直すと頭が付け替わる（_suffix）
      toCopyForm={async (r) => {
        const f = detailToForm(await api.get<ProductDetail>(`/masters/products/${r.id}`));
        return {
          ...f,
          skus: f.skus.map((k) => ({
            ...k, id: undefined, _key: skuKeySeq++, is_active: true, _dirty: true, jan: '', fba_jan: '', shop_product_code: '',
            _suffix: f.product_code && k.sku_code.startsWith(f.product_code) ? k.sku_code.slice(f.product_code.length) : undefined,
          })),
        };
      }}
      // 新しく登録するときは SKU もまとめて送り、商品と SKU を1回で登録する（W1 N5）。SKU が1行でも登録できなければ
      // 行ごとの理由が返り、何も登録されない（以前は SKU の無い商品だけが残っていた）。編集は今までどおり別に保存する
      toBody={(f, editing) => ({
        ...(editing
          ? {}
          : {
              skus: f.skus
                .map((k, i) => ({ k, row_no: i + 1 }))
                .filter(({ k }) => k.sku_code.trim())
                .map(({ k, row_no }) => ({ ...skuBody(k), row_no })),
            }),
        product_code: f.product_code.trim(),
        product_name: f.product_name.trim(),
        set_product_name: strOrNull(f.set_product_name),
        brand_id: numOrNull(f.brand_id),
        category_id: numOrNull(f.category_id),
        product_class_id: numOrNull(f.product_class_id),
        carton_qty: numOrNull(f.carton_qty),
        // 原価・旧原価は SKU ごとに持つので、商品の画面からは送らない（M3-19）
        tax_rate: f.tax_rate,
        is_set: f.is_set,
        royalty_class_code_id: numOrNull(f.royalty_class_code_id),
        is_wholesale_adjust_target: f.is_wholesale_adjust_target,
        sort_order: numOrNull(f.sort_order),
        note: strOrNull(f.note),
      })}
      // 「更新する」「登録する」でも SKU 表の入力を保存する。以前は商品だけが保存され、SKU に入れた
      // FBA用JAN・ショップ商品コードが黙って捨てられていた（2026-10-09 マスター編②）
      afterSave={async (row, f, set) => {
        // 新規・コピーで SKU もまとめて登録したとき（API が sku_count を返す）は、ここで保存するものは無い
        if (row.sku_count !== undefined) return;
        if (!f.skus.some((k) => k._dirty && k.sku_code.trim())) return;
        await saveSkus(Number(row.id), f.skus, (kept) => set({ skus: kept }));
      }}
      renderForm={(f, set, editing) => (
        <div className="flex flex-col gap-3">
          <div className="master-grid-2">
            {/* 品番は「商品分類コード」とも呼ぶ（M3-16）。セット商品の印は品番の横に（M3-17） */}
            <L label="品番（商品分類コード）" required>
              <Input
                value={f.product_code}
                onChange={(e) => {
                  const code = e.target.value;
                  // コピーで写した SKU の商品コードは、品番に合わせて頭を付け替える（W1 N5）
                  const follow = (k: Sku) => k._suffix !== undefined && !k.id && k.sku_code === f.product_code + k._suffix;
                  set(
                    f.skus.some(follow)
                      ? { product_code: code, skus: f.skus.map((k) => (follow(k) ? { ...k, sku_code: code + k._suffix } : k)) }
                      : { product_code: code },
                  );
                }}
                className="!w-[160px]"
              />
              <Check checked={f.is_set} onChange={(v) => set({ is_set: v })} label="セット商品" />
            </L>
            <L label="税率" required>
              <Select value={f.tax_rate} onChange={(e) => set({ tax_rate: e.target.value })} className="!w-[100px]"><option value="10.00">10%</option><option value="8.00">8%</option><option value="0.00">0%</option></Select>
            </L>
            <L label="商品名" required><Input value={f.product_name} onChange={(e) => set({ product_name: e.target.value })} /></L>
            <L label="セット商品名"><Input value={f.set_product_name} onChange={(e) => set({ set_product_name: e.target.value })} /></L>
            <L label="ブランド">
              <Select
                value={f.brand_id}
                // ブランドを変えて、選んでいた商品分類がそのブランドのものでなくなったら外す（M3-18）
                onChange={(e) => set(classFits(f.product_class_id, e.target.value) ? { brand_id: e.target.value } : { brand_id: e.target.value, product_class_id: '' })}
              >
                <option value="">（なし）</option>
                {(brands.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </L>
            <L label="カテゴリー"><Select value={f.category_id} onChange={(e) => set({ category_id: e.target.value })}><option value="">（なし）</option>{(categories.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></L>
            <L label="商品分類" hint={f.brand_id ? '選んだブランドの分類と、ブランド共通の分類が出ます' : undefined}>
              <Select value={f.product_class_id} onChange={(e) => set({ product_class_id: e.target.value })}>
                <option value="">（なし）</option>
                {classOptions(f.brand_id, f.product_class_id).map((m) => <option key={m.id} value={m.id}>{m.code}　{m.name}</option>)}
              </Select>
            </L>
            <L label="カートン入数"><Input right value={f.carton_qty} onChange={(e) => set({ carton_qty: e.target.value })} className="!w-[90px]" /></L>
            {/* ロイヤリティ区分・下代調整対象（M3-23）。今は登録・表示・CSV だけで、計算には使いません */}
            <L label="ロイヤリティ区分">
              <Select value={f.royalty_class_code_id} onChange={(e) => set({ royalty_class_code_id: e.target.value })} className="!w-[160px]">
                <option value="">（なし）</option>
                {(royaltyClasses.data?.values ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </L>
            <L label="下代調整対象">
              <label className="flex items-center gap-1 text-[12px]"><input type="radio" checked={f.is_wholesale_adjust_target} onChange={() => set({ is_wholesale_adjust_target: true })} />対象</label>
              <label className="flex items-center gap-1 text-[12px] ml-3"><input type="radio" checked={!f.is_wholesale_adjust_target} onChange={() => set({ is_wholesale_adjust_target: false })} />対象外</label>
            </L>
            <L label="表示順"><Input right value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} className="!w-[90px]" /></L>
          </div>
          <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="備考" />

          <Section title="SKU（商品コード：色・サイズ・JAN）" />
          {!editing && <div className="text-[11.5px] text-[var(--color-ink-3)]">SKU は「登録する」で商品と一緒に保存されます。</div>}
          <SkuEditor
            showCost={canSeeSensitive}
            productName={f.product_name}
            productCost={f.product_cost}
            skus={f.skus}
            colors={colors.data?.items ?? []}
            sizes={sizes.data?.items ?? []}
            onChange={(skus) => set({ skus })}
            // 商品がまだ無い（新規）ときは SKU だけ先に保存できないので、ボタンを出さない
            onSave={
              editing
                ? async () => {
                    setSkuError(null);
                    try {
                      await saveAndReload(editing.id, f.skus, set);
                      toast('SKU を保存しました', 'good');
                    } catch (e) {
                      setSkuError(e);
                    }
                  }
                : undefined
            }
            onError={setSkuError}
            canDelete={can('M-09', 'delete')}
            error={skuError}
          />
        </div>
      )}
    />
  );
}

/**
 * 商品の一覧の表（2026-10-18 マスター編_3 M3-15）。
 *
 * 引当在庫の一覧と同じく、品番ごとにまとめて、その下の SKU を1行ずつ並べる。品番・商品名・カテゴリー・
 * ブランド・商品分類・税率と操作のボタンは rowSpan で SKU の行をまたぐ。列の並びはカテゴリー → ブランド。
 * 商品名の列は詰め、SKU の商品名（カラー・サイズ付き）に残りの幅を使う。
 */
function ProductTable({ rows, loading, actions, actionWidth, isActive, showCost }: {
  rows: ProductRow[];
  loading: boolean;
  actions: (r: ProductRow) => ReactNode;
  actionWidth?: number | string;
  isActive: (r: ProductRow) => boolean;
  showCost: boolean;
}) {
  const muted = 'text-[var(--color-ink-3)]';
  // 見出しの列と SKU の1行目の高さをそろえるため上揃え。品番の区切りは罫線を太く（引当在庫の一覧と同じ）
  const top = { verticalAlign: 'top' as const };
  const firstRow = { ...top, borderTop: '2px solid var(--color-line-strong)' };
  // 1440 より狭い画面（1280 など）では、操作のボタンを品番の欄に入れる（引当在庫の一覧と同じ。2026-10-18 受入 W2）。
  // 操作の列を右に置いたままだと表が枠より広くなり、ボタンが枠の外に出て、SKU の商品名の列も 82px に潰れていた
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1439px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const cols = 9 + (showCost ? 1 : 0) + (narrow ? 0 : 1);
  // 幅を決めた列の合計（原価込み 848px）＋操作の列。残りは SKU の商品名（カラー・サイズ）が使い、最低 160px。
  // 1280 の枠（約 1025px）・1440 の枠（約 1185px）のどちらにも収まる
  const fixed = 776 + (showCost ? 72 : 0) + (narrow ? 0 : Number(actionWidth ?? 122));
  return (
    <div className="tbl-wrap">
      <table className="tbl tbl-fit" style={{ minWidth: fixed + 160 }}>
        <thead>
          <tr>
            <th className="nw" style={{ width: 112 }}>品番<br />（商品分類コード）</th>
            <th style={{ width: 120 }}>商品名</th>
            <th style={{ width: 72 }}>カテゴリー</th>
            <th style={{ width: 80 }}>ブランド</th>
            <th style={{ width: 100 }}>商品分類</th>
            <th className="r" style={{ width: 44 }}>税率</th>
            <th className="nw" style={{ width: 136 }}>商品コード</th>
            <th>商品名（カラー・サイズ）</th>
            <th className="nw" style={{ width: 112 }}>JAN</th>
            {showCost && <th className="r" style={{ width: 72 }}>原価</th>}
            {!narrow && <th style={{ width: actionWidth ?? 122 }}></th>}
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 && <tr><td colSpan={cols} className={`text-center py-8 ${muted}`}>読み込み中…</td></tr>}
          {!loading && rows.length === 0 && <tr><td colSpan={cols} className={`text-center py-8 ${muted}`}>データがありません</td></tr>}
          {rows.map((r) => {
            const lines: (SkuLine | null)[] = r.skus.length > 0 ? r.skus : [null];
            const span = lines.length;
            const dim = isActive(r) ? '' : 'opacity-50';
            return (
              <Fragment key={r.id}>
                {lines.map((k, i) => (
                  <tr key={k ? k.id : `p${r.id}`} className={dim}>
                    {i === 0 && (
                      <>
                        <td rowSpan={span} style={firstRow} className="nw">
                          <Num className="font-semibold">{r.product_code}</Num>
                          {narrow && <div className="mt-1.5 [&_.tbl-acts]:justify-start">{actions(r)}</div>}
                        </td>
                        <td rowSpan={span} style={firstRow}>
                          {r.product_name}
                          {r.is_set && <Badge className="ml-1">セット</Badge>}
                          {!r.is_active && <Badge className="ml-1">非表示</Badge>}
                        </td>
                        <td rowSpan={span} style={firstRow}>{r.category_name ?? ''}</td>
                        <td rowSpan={span} style={firstRow}>{r.brand_name ?? ''}</td>
                        <td rowSpan={span} style={firstRow} title={r.product_class_code ?? ''}>{r.product_class_name ?? ''}</td>
                        <td rowSpan={span} style={firstRow} className="r num">{`${Number(r.tax_rate)}%`}</td>
                      </>
                    )}
                    <td style={i === 0 ? firstRow : top} className="nw">
                      {k ? <Num className="font-semibold">{k.sku_code}</Num> : <span className={muted}>（SKU なし）</span>}
                      {k && !k.is_active && <Badge className="ml-1">無効</Badge>}
                    </td>
                    <td style={i === 0 ? firstRow : top}>{k?.item_name ?? ''}</td>
                    <td style={i === 0 ? firstRow : top} className="nw num">{k?.jan ?? ''}</td>
                    {showCost && (
                      <td style={i === 0 ? firstRow : top} className="r num">
                        {/* SKU の原価が空なら、計算で使われる商品の原価を薄い字で */}
                        {k && (k.cost_price != null ? money(k.cost_price) : k.product_cost_price != null ? <span className={muted} title="SKU の原価が空のため、商品の原価を使います">{money(k.product_cost_price)}</span> : '')}
                      </td>
                    )}
                    {i === 0 && !narrow && (
                      <td rowSpan={span} style={firstRow}>
                        {actions(r)}
                      </td>
                    )}
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 商品の編集画面の SKU 表。
 *
 * 2026-10-09 マスター編②:
 *   - カラー・サイズの欄が、列の幅を決めていなかったため幅 0 に潰れて見えなくなっていた。
 *     すべての列に幅を決め、入りきらなければ表を横にずらせるようにした
 *   - 行ごとに「コピー」（その行を写して下に足す）と「削除」
 *     （未保存の行はその場で外す。保存済みは使われていなければ消す。使われていれば理由を出して断る）
 *   - SKU ごとの商品名（空なら商品の商品名）
 * 2026-10-18 マスター編_3:
 *   - 「SKUコード」→「商品コード」（M3-16）。入数区分の列を外した（M3-20）。旧原価の列を足した（M3-19）
 *   - 行のコピーで商品コードも写す（M3-21）。カラー・サイズの選択肢は「コード 名称」（M3-22）
 */
function SkuEditor({ skus, colors, sizes, onChange, onSave, onError, error, showCost, productName, productCost, canDelete }: {
  skus: Sku[];
  colors: { id: number; code: string; name: string }[];
  sizes: { id: number; code: string; name: string }[];
  onChange: (skus: Sku[]) => void;
  /** 「SKU を保存」。商品が未登録のときは無い（商品の「登録する」で一緒に保存する） */
  onSave?: () => Promise<void>;
  onError: (e: unknown) => void;
  error: unknown;
  /** 原価を見てよい人か。見せない人には欄ごと出さない */
  showCost: boolean;
  /** SKU の商品名が空のときに使われる商品名（入力欄の薄い字で見せる） */
  productName: string;
  /** SKU の原価が空のときに計算で使われる商品の原価（入力欄の薄い字で見せる） */
  productCost: string;
  /** 保存済みの SKU を消してよい人か */
  canDelete: boolean;
}) {
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [busy, setBusy] = useState(false);
  const upd = (key: number, patch: Partial<Sku>) => onChange(skus.map((k) => (k._key === key ? { ...k, ...patch, _dirty: true } : k)));
  const dirty = skus.some((k) => k._dirty);

  /**
   * その行を写して下に足す。商品コードも写す（末尾だけ直して使うことが多いため。M3-21）。
   * JAN・FBA用JAN・ショップ商品コードは SKU ごとに違うものなので空にする
   */
  const copy = (k: Sku) => {
    const i = skus.findIndex((x) => x._key === k._key);
    const dup: Sku = { ...k, id: undefined, _key: skuKeySeq++, jan: '', fba_jan: '', shop_product_code: '', is_active: true, _dirty: true };
    onChange([...skus.slice(0, i + 1), dup, ...skus.slice(i + 1)]);
  };
  const remove = async (k: Sku) => {
    // 未保存の行は、その場で外すだけ
    if (!k.id) {
      onChange(skus.filter((x) => x._key !== k._key));
      return;
    }
    if (
      !(await confirm(
        'この SKU を削除しますか',
        <>
          商品コード <b>{k.sku_code}</b> を完全に消します。元に戻せません。
          <br />
          在庫・受注・得意先別商品・セットなどで使われている SKU は消せません。その場合は「有効」の印を外してください。
        </>,
        true,
      ))
    ) {
      return;
    }
    onError(null);
    try {
      await api.delete(`/masters/skus/${k.id}`);
      onChange(skus.filter((x) => x._key !== k._key));
      toast(`商品コード ${k.sku_code} を削除しました`, 'good');
    } catch (e) {
      // 使われている場所（在庫表・受注 など）がサーバーの文言に入っているので、そのまま出す
      onError(e);
    }
  };

  // 列の幅。画面幅 1440・1280 のどちらでも、原価・有効まで横にずらさずに見える合計（約 1180px）にしてある
  // （M-07「原価・有効の列が横にずらさないと見えない」）。カラーは「01 シフォンピンク」が切れない幅。
  // 商品名（widths[2]）は表の残りの幅を使う（ここの値は最低の幅）。
  // 合計より狭い画面（タブレットなど）では表を横にずらす（列が潰れて見えなくならないように）
  // 2026-10-18: 入数区分の列を外し（M3-20）、旧原価の列を足した（M3-19）
  const widths = [62, 140, 130, 160, 150, 124, 124, 100, ...(showCost ? [80, 80] : []), 40];
  const SKU_SELECT = '!text-[12px] !pl-1.5 !pr-5';
  // 選択肢は「01 ブラック」の形（M3-22）
  const label = (x: { code: string; name: string }) => `${x.code} ${x.name}`;
  const titleOf = (list: { id: number; code: string; name: string }[], id: string) => {
    const x = list.find((y) => String(y.id) === id);
    return x ? label(x) : '';
  };
  const costHint = productCost && Number(productCost) !== 0 ? productCost : '';
  return (
    <div className="flex flex-col gap-2">
      {element}
      {error ? <ErrorBox error={error} onClose={() => onError(null)} /> : null}
      <div className="tbl-wrap">
        <table className="tbl tbl-fit" style={{ minWidth: widths.reduce((a, b) => a + b, 0) }}>
          <thead>
            <tr>
              <th style={{ width: widths[0] }}></th>
              <th style={{ width: widths[1] }}>商品コード</th>
              <th>商品名</th>
              <th style={{ width: widths[3] }}>カラー</th>
              <th style={{ width: widths[4] }}>サイズ</th>
              <th style={{ width: widths[5] }}>JAN</th>
              <th style={{ width: widths[6] }}>FBA用JAN</th>
              <th style={{ width: widths[7] }}>ショップ<br />商品コード</th>
              {showCost && <th style={{ width: widths[8] }}>原価</th>}
              {showCost && <th style={{ width: widths[9] }} title="原価を変えたとき、前の値を残しておく欄">旧原価</th>}
              <th style={{ width: widths[widths.length - 1] }}>有効</th>
            </tr>
          </thead>
          <tbody>
            {skus.length === 0 && <tr><td colSpan={widths.length} className="text-center py-4 text-[var(--color-ink-3)]">SKU がありません</td></tr>}
            {skus.map((k) => (
              <tr key={k._key}>
                <td>
                  <span className="tbl-acts">
                    <Button size="sm" onClick={() => copy(k)} title="この行を写して下に足す（商品コードも写します。直してから保存してください）">コピー</Button>
                    {(!k.id || canDelete) && (
                      <Button size="sm" variant="danger" onClick={() => remove(k)} title={k.id ? 'この SKU を削除する' : 'この行を外す'}>削除</Button>
                    )}
                  </span>
                </td>
                <td><Input value={k.sku_code} onChange={(e) => upd(k._key, { sku_code: e.target.value })} /></td>
                {/* 空なら商品の商品名を使う。薄い字で商品名を見せておく */}
                <td><Input value={k.sku_name} onChange={(e) => upd(k._key, { sku_name: e.target.value })} placeholder={productName || '商品と同じ'} title={k.sku_name || productName} /></td>
                {/* 欄に入りきらない名前でも、マウスを載せると選んだ名前の全文が出る */}
                <td><Select value={k.color_id} onChange={(e) => upd(k._key, { color_id: e.target.value })} className={SKU_SELECT} title={titleOf(colors, k.color_id)}><option value="">（なし）</option>{colors.map((c) => <option key={c.id} value={c.id}>{label(c)}</option>)}</Select></td>
                <td><Select value={k.size_id} onChange={(e) => upd(k._key, { size_id: e.target.value })} className={SKU_SELECT} title={titleOf(sizes, k.size_id)}><option value="">（なし）</option>{sizes.map((c) => <option key={c.id} value={c.id}>{label(c)}</option>)}</Select></td>
                <td><Input value={k.jan} onChange={(e) => upd(k._key, { jan: e.target.value })} placeholder="13桁" /></td>
                <td><Input value={k.fba_jan} onChange={(e) => upd(k._key, { fba_jan: e.target.value })} placeholder="13桁" /></td>
                <td><Input value={k.shop_product_code} onChange={(e) => upd(k._key, { shop_product_code: e.target.value })} /></td>
                {/* 原価は SKU ごと（M3-19）。空欄なら商品の原価（以前の登録の値）を使う。その値を薄い字で見せる */}
                {showCost && (
                  <td>
                    <Input
                      right
                      value={k.cost_price}
                      onChange={(e) => upd(k._key, { cost_price: e.target.value })}
                      placeholder={costHint}
                      title={!k.cost_price && costHint ? `空欄のときは商品の原価 ${costHint} を使います` : undefined}
                    />
                  </td>
                )}
                {showCost && <td><Input right value={k.old_cost_price} onChange={(e) => upd(k._key, { old_cost_price: e.target.value })} /></td>}
                <td className="c"><input type="checkbox" checked={k.is_active} onChange={(e) => upd(k._key, { is_active: e.target.checked })} disabled={!k.id} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <Button size="sm" icon="plus" onClick={() => onChange([...skus, emptySku()])}>SKU を追加</Button>
        {onSave && (
          <Button size="sm" variant="primary" disabled={!dirty} loading={busy} onClick={async () => { setBusy(true); try { await onSave(); } finally { setBusy(false); } }}>
            SKU を保存
          </Button>
        )}
        <span className="text-[10.5px] text-[var(--color-ink-3)] self-center">SKU の入力は「{onSave ? '更新する' : '登録する'}」でも商品と一緒に保存されます</span>
      </div>
    </div>
  );
}
