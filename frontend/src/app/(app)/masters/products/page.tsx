'use client';

import { useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useSimpleMaster } from '@/lib/hooks';
import { money } from '@/lib/format';
import { Badge, Button, ErrorBox, Input, Num, Select, Textarea, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { MasterPage, decOrNull, numOrNull, strOrNull } from '@/components/masters/MasterPage';
import { MasterCsv } from '@/components/masters/MasterCsv';
import { Check, L, Section } from '@/components/masters/Form';

interface ProductRow extends Record<string, unknown> {
  id: number;
  product_code: string;
  product_name: string;
  set_product_name: string | null;
  brand_name: string | null;
  category_name: string | null;
  tax_rate: string;
  carton_qty: number | null;
  is_set: boolean;
  cost_price?: string;
  old_cost_price?: string | null;
  is_cost_undecided: boolean;
  sku_count?: number;
  is_active: boolean;
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
  /** このSKUだけの原価。空欄なら商品の原価を使う（1001 ご要望） */
  cost_price: string;
  color_id: string;
  size_id: string;
  pack_division: string;
  is_active: boolean;
  _dirty?: boolean;
}

interface Form {
  product_code: string;
  product_name: string;
  set_product_name: string;
  brand_id: string;
  category_id: string;
  product_class_id: string;
  carton_qty: string;
  cost_price: string;
  old_cost_price: string;
  is_cost_undecided: boolean;
  tax_rate: string;
  is_set: boolean;
  sort_order: string;
  note: string;
  skus: Sku[];
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
let skuKeySeq = 1;
/** 商品の詳細（API）の SKU 1件 → 画面の行。編集できる欄はすべて写す（写し忘れた欄は保存し直すと消えるため） */
const toSku = (k: Record<string, unknown>): Sku => ({
  id: Number(k.id), _key: skuKeySeq++, sku_code: s(k.sku_code), sku_name: s(k.sku_name), jan: s(k.jan), fba_jan: s(k.fba_jan),
  shop_product_code: s(k.shop_product_code), cost_price: s(k.cost_price), color_id: s(k.color_id), size_id: s(k.size_id),
  pack_division: s(k.pack_division), is_active: k.is_active !== false,
});
const emptySku = (): Sku => ({ _key: skuKeySeq++, sku_code: '', sku_name: '', jan: '', fba_jan: '', shop_product_code: '', cost_price: '', color_id: '', size_id: '', pack_division: '', is_active: true, _dirty: true });
/** 数値を末尾の 0 なしで（3000.0000 → 3000） */
const dec = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));

/** 商品マスタ（M-08）と SKU（M-09）。商品の下に色・サイズごとの SKU を持つ。 */
export default function ProductsPage() {
  const { canSeeSensitive, can } = useAuth();
  const toast = useToast();
  const brands = useSimpleMaster('brands');
  const categories = useSimpleMaster('categories');
  const classes = useSimpleMaster('product_classes');
  const colors = useSimpleMaster('colors');
  const sizes = useSimpleMaster('sizes');
  const [brandId, setBrandId] = useState('');
  const [skuError, setSkuError] = useState<unknown>(null);

  /**
   * SKU は商品と別の経路で保存する（商品の更新後に呼ぶ）。
   *
   * 途中の行で失敗しても、それまでに保存できた行は「保存済み」として画面に戻す（keep）。
   * 戻さないと、もう一度保存したときに登録済みの行をまた登録しようとして、SKUコードの重複で断られる。
   * 原価の欄は、見てよい人にだけ送る（見えない人が保存して原価が空で上書きされないように）。
   */
  const saveSkus = async (productId: number, skus: Sku[], keep: (skus: Sku[]) => void) => {
    const out = skus.map((k) => ({ ...k }));
    try {
      for (const k of out) {
        if (!k._dirty || !k.sku_code.trim()) continue;
        const body = {
          product_id: productId, sku_code: k.sku_code.trim(), sku_name: strOrNull(k.sku_name), jan: strOrNull(k.jan), fba_jan: strOrNull(k.fba_jan),
          shop_product_code: strOrNull(k.shop_product_code), color_id: numOrNull(k.color_id), size_id: numOrNull(k.size_id), pack_division: strOrNull(k.pack_division),
          ...(canSeeSensitive ? { cost_price: strOrNull(k.cost_price) } : {}),
        };
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
    // SKUコードが空でまだ保存していない行は、読み直しで消さずに残す
    set({ skus: [...d.skus.map(toSku), ...skus.filter((k) => !k.id && !k.sku_code.trim() && k._dirty)] });
  };

  return (
    <MasterPage<ProductRow, Form>
      title="商品"
      sub="商品（品番）と、その下の SKU（色・サイズ・JAN）。原価は権限のある方にだけ表示されます"
      functionId="M-08"
      csvSlug="products"
      listPath="/masters/products"
      writePath="/masters/products"
      extraFilters={{ brand_id: brandId || undefined }}
      // SKU 表の原価・有効まで横にずらさずに見えるよう広げる（M-07）。狭い画面では画面の幅いっぱいまで
      modalWidth={1300}
      headRight={
        <>
          {/* SKU は専用の画面が無いので、商品マスタからまとめて出し入れする（JAN・FBA用JANの一括修正用） */}
          <MasterCsv slug="skus" name="SKU" functionId="M-09" includeInactive={false} onImported={() => location.reload()} />
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
      columns={[
        { key: 'product_code', label: '品番', width: 110, render: (r) => <Num className="font-semibold">{r.product_code}</Num> },
        { key: 'product_name', label: '商品名', render: (r) => <span>{r.product_name}{r.is_set && <Badge className="ml-1">セット</Badge>}</span> },
        { key: 'brand_name', label: 'ブランド', width: 120, render: (r) => r.brand_name ?? '' },
        { key: 'category_name', label: 'カテゴリー', width: 110, render: (r) => r.category_name ?? '' },
        { key: 'sku_count', label: 'SKU', r: true, width: 60, render: (r) => r.sku_count ?? '' },
        { key: 'tax_rate', label: '税率', r: true, width: 60, render: (r) => `${Number(r.tax_rate)}%` },
        ...(canSeeSensitive ? [{ key: 'cost_price', label: '原価', r: true, width: 90, render: (r: ProductRow) => (r.is_cost_undecided ? <span className="text-[var(--color-warn)]">未定</span> : money(r.cost_price)) }] : []),
        { key: 'is_active', label: '', width: 60, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
      ]}
      rowKey={(r) => r.id}
      // 商品の削除は SKU ごと消える（どこにも使われていないときだけ）。何が消えるかを確認の文言に出す
      rowLabel={(r) => `${r.product_code}　${r.product_name}${r.sku_count ? `（SKU ${r.sku_count}件を含む）` : ''}`}
      empty={() => ({ product_code: '', product_name: '', set_product_name: '', brand_id: '', category_id: '', product_class_id: '', carton_qty: '', cost_price: '0', old_cost_price: '', is_cost_undecided: false, tax_rate: '10.00', is_set: false, sort_order: '', note: '', skus: [] })}
      toForm={async (r) => {
        const d = await api.get<Record<string, unknown> & { skus: Record<string, unknown>[]; brand_id?: number; category_id?: number; product_class_id?: number }>(`/masters/products/${r.id}`);
        return {
          product_code: s(d.product_code), product_name: s(d.product_name), set_product_name: s(d.set_product_name),
          brand_id: s(d.brand_id), category_id: s(d.category_id), product_class_id: s(d.product_class_id),
          carton_qty: s(d.carton_qty), cost_price: dec(d.cost_price ?? '0'), old_cost_price: dec(d.old_cost_price ?? ''), is_cost_undecided: Boolean(d.is_cost_undecided),
          tax_rate: s(d.tax_rate || '10.00'), is_set: Boolean(d.is_set), sort_order: s(d.sort_order), note: s(d.note),
          skus: (d.skus ?? []).map(toSku),
        };
      }}
      toBody={(f) => ({
        product_code: f.product_code.trim(),
        product_name: f.product_name.trim(),
        set_product_name: strOrNull(f.set_product_name),
        brand_id: numOrNull(f.brand_id),
        category_id: numOrNull(f.category_id),
        product_class_id: numOrNull(f.product_class_id),
        carton_qty: numOrNull(f.carton_qty),
        ...(canSeeSensitive ? { cost_price: f.cost_price.trim() || '0', old_cost_price: decOrNull(f.old_cost_price), is_cost_undecided: f.is_cost_undecided } : {}),
        tax_rate: f.tax_rate,
        is_set: f.is_set,
        sort_order: numOrNull(f.sort_order),
        note: strOrNull(f.note),
      })}
      // 「更新する」「登録する」でも SKU 表の入力を保存する。以前は商品だけが保存され、SKU に入れた
      // FBA用JAN・ショップ商品コードが黙って捨てられていた（2026-10-09 マスター編②）
      afterSave={async (row, f, set) => {
        if (!f.skus.some((k) => k._dirty && k.sku_code.trim())) return;
        await saveSkus(Number(row.id), f.skus, (kept) => set({ skus: kept }));
      }}
      renderForm={(f, set, editing) => (
        <div className="flex flex-col gap-3">
          <div className="master-grid-2">
            <L label="品番（商品コード）" required><Input value={f.product_code} onChange={(e) => set({ product_code: e.target.value })} className="!w-[160px]" /></L>
            <L label="税率" required>
              <Select value={f.tax_rate} onChange={(e) => set({ tax_rate: e.target.value })} className="!w-[100px]"><option value="10.00">10%</option><option value="8.00">8%</option><option value="0.00">0%</option></Select>
              <Check checked={f.is_set} onChange={(v) => set({ is_set: v })} label="セット商品" />
            </L>
            <L label="商品名" required><Input value={f.product_name} onChange={(e) => set({ product_name: e.target.value })} /></L>
            <L label="セット商品名"><Input value={f.set_product_name} onChange={(e) => set({ set_product_name: e.target.value })} /></L>
            <L label="ブランド"><Select value={f.brand_id} onChange={(e) => set({ brand_id: e.target.value })}><option value="">（なし）</option>{(brands.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></L>
            <L label="カテゴリー"><Select value={f.category_id} onChange={(e) => set({ category_id: e.target.value })}><option value="">（なし）</option>{(categories.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></L>
            <L label="商品分類"><Select value={f.product_class_id} onChange={(e) => set({ product_class_id: e.target.value })}><option value="">（なし）</option>{(classes.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></L>
            <L label="カートン入数"><Input right value={f.carton_qty} onChange={(e) => set({ carton_qty: e.target.value })} className="!w-[90px]" /></L>
            {canSeeSensitive && (
              <L label="原価" hint="権限のある方だけに表示">
                <Input right value={f.cost_price} onChange={(e) => set({ cost_price: e.target.value })} className="!w-[120px]" disabled={f.is_cost_undecided} />
                <Check checked={f.is_cost_undecided} onChange={(v) => set({ is_cost_undecided: v })} label="原価未定" />
              </L>
            )}
            {canSeeSensitive && (
              <L label="旧原価" hint="原価を変えたとき、前の値を残しておく欄">
                <Input right value={f.old_cost_price} onChange={(e) => set({ old_cost_price: e.target.value })} className="!w-[120px]" />
              </L>
            )}
            <L label="表示順"><Input right value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} className="!w-[90px]" /></L>
          </div>
          <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="備考" />

          <Section title="SKU（色・サイズ・JAN）" />
          {!editing && <div className="text-[11.5px] text-[var(--color-ink-3)]">SKU は「登録する」で商品と一緒に保存されます。</div>}
          <SkuEditor
            showCost={canSeeSensitive}
            productName={f.product_name}
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
 * 商品の編集画面の SKU 表。
 *
 * 2026-10-09 マスター編②:
 *   - カラー・サイズの欄が、列の幅を決めていなかったため幅 0 に潰れて見えなくなっていた。
 *     すべての列に幅を決め、入りきらなければ表を横にずらせるようにした
 *   - 行ごとに「コピー」（その行を写して下に足す。SKUコード・JAN などコードの欄は空にする）と「削除」
 *     （未保存の行はその場で外す。保存済みは使われていなければ消す。使われていれば理由を出して断る）
 *   - SKU ごとの商品名（空なら商品の商品名）
 */
function SkuEditor({ skus, colors, sizes, onChange, onSave, onError, error, showCost, productName, canDelete }: {
  skus: Sku[];
  colors: { id: number; name: string }[];
  sizes: { id: number; name: string }[];
  onChange: (skus: Sku[]) => void;
  /** 「SKU を保存」。商品が未登録のときは無い（商品の「登録する」で一緒に保存する） */
  onSave?: () => Promise<void>;
  onError: (e: unknown) => void;
  error: unknown;
  /** 原価を見てよい人か。見せない人には欄ごと出さない */
  showCost: boolean;
  /** SKU の商品名が空のときに使われる商品名（入力欄の薄い字で見せる） */
  productName: string;
  /** 保存済みの SKU を消してよい人か */
  canDelete: boolean;
}) {
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [busy, setBusy] = useState(false);
  const upd = (key: number, patch: Partial<Sku>) => onChange(skus.map((k) => (k._key === key ? { ...k, ...patch, _dirty: true } : k)));
  const dirty = skus.some((k) => k._dirty);

  /** その行を写して下に足す。SKUコード・JAN・FBA用JAN・ショップ商品コードは SKU ごとに違うものなので空にする */
  const copy = (k: Sku) => {
    const i = skus.findIndex((x) => x._key === k._key);
    const dup: Sku = { ...k, id: undefined, _key: skuKeySeq++, sku_code: '', jan: '', fba_jan: '', shop_product_code: '', is_active: true, _dirty: true };
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
          <b>{k.sku_code}</b> を完全に消します。元に戻せません。
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
      toast(`SKU ${k.sku_code} を削除しました`, 'good');
    } catch (e) {
      // 使われている場所（在庫表・受注 など）がサーバーの文言に入っているので、そのまま出す
      onError(e);
    }
  };

  // 列の幅。画面幅 1440・1280 のどちらでも、原価・有効まで横にずらさずに見える合計（約 1170px）にしてある
  // （M-07「原価・有効の列が横にずらさないと見えない」）。カラーは「シフォンピンク」が切れない幅。
  // SKUの商品名（widths[2]）は表の残りの幅を使う（ここの値は最低の幅）。
  // 合計より狭い画面（タブレットなど）では表を横にずらす（列が潰れて見えなくならないように）
  const widths = [62, 140, 170, 150, 90, 124, 124, 120, 64, ...(showCost ? [94] : []), 40];
  return (
    <div className="flex flex-col gap-2">
      {element}
      {error ? <ErrorBox error={error} onClose={() => onError(null)} /> : null}
      <div className="tbl-wrap">
        <table className="tbl tbl-fit" style={{ minWidth: widths.reduce((a, b) => a + b, 0) }}>
          <thead>
            <tr>
              <th style={{ width: widths[0] }}></th>
              <th style={{ width: widths[1] }}>SKUコード</th>
              <th>SKUの商品名</th>
              <th style={{ width: widths[3] }}>カラー</th>
              <th style={{ width: widths[4] }}>サイズ</th>
              <th style={{ width: widths[5] }}>JAN</th>
              <th style={{ width: widths[6] }}>FBA用JAN</th>
              <th style={{ width: widths[7] }}>ショップ<br />商品コード</th>
              <th style={{ width: widths[8] }}>入数区分</th>
              {showCost && <th style={{ width: widths[9] }}>原価</th>}
              <th style={{ width: widths[widths.length - 1] }}>有効</th>
            </tr>
          </thead>
          <tbody>
            {skus.length === 0 && <tr><td colSpan={widths.length} className="text-center py-4 text-[var(--color-ink-3)]">SKU がありません</td></tr>}
            {skus.map((k) => (
              <tr key={k._key}>
                <td>
                  <span className="tbl-acts">
                    <Button size="sm" onClick={() => copy(k)} title="この行を写して下に足す">コピー</Button>
                    {(!k.id || canDelete) && (
                      <Button size="sm" variant="danger" onClick={() => remove(k)} title={k.id ? 'この SKU を削除する' : 'この行を外す'}>削除</Button>
                    )}
                  </span>
                </td>
                <td><Input value={k.sku_code} onChange={(e) => upd(k._key, { sku_code: e.target.value })} /></td>
                {/* 空なら商品の商品名を使う。薄い字で商品名を見せておく */}
                <td><Input value={k.sku_name} onChange={(e) => upd(k._key, { sku_name: e.target.value })} placeholder={productName || '商品と同じ'} title={k.sku_name || productName} /></td>
                <td><Select value={k.color_id} onChange={(e) => upd(k._key, { color_id: e.target.value })}><option value="">（なし）</option>{colors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></td>
                <td><Select value={k.size_id} onChange={(e) => upd(k._key, { size_id: e.target.value })}><option value="">（なし）</option>{sizes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></td>
                <td><Input value={k.jan} onChange={(e) => upd(k._key, { jan: e.target.value })} placeholder="13桁" /></td>
                <td><Input value={k.fba_jan} onChange={(e) => upd(k._key, { fba_jan: e.target.value })} placeholder="13桁" /></td>
                <td><Input value={k.shop_product_code} onChange={(e) => upd(k._key, { shop_product_code: e.target.value })} /></td>
                <td><Input value={k.pack_division} onChange={(e) => upd(k._key, { pack_division: e.target.value })} /></td>
                {/* サイズで原価が変わるとき用。空欄なら商品の原価を使う（1001 ご要望） */}
                {showCost && <td><Input right value={k.cost_price} onChange={(e) => upd(k._key, { cost_price: e.target.value })} placeholder="商品と同じ" /></td>}
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
