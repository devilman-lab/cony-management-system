'use client';

import { useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useSimpleMaster } from '@/lib/hooks';
import { money } from '@/lib/format';
import { Badge, Button, ErrorBox, Input, Num, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { MasterPage, numOrNull, strOrNull } from '@/components/masters/MasterPage';
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
  is_cost_undecided: boolean;
  sku_count?: number;
  is_active: boolean;
}

interface Sku {
  id?: number;
  sku_code: string;
  jan: string;
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
  is_cost_undecided: boolean;
  tax_rate: string;
  is_set: boolean;
  sort_order: string;
  note: string;
  skus: Sku[];
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
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

  /** SKU は商品と別の経路で保存する（商品の更新後に呼ぶ）。 */
  const saveSkus = async (productId: number, skus: Sku[]) => {
    for (const k of skus) {
      if (!k._dirty || !k.sku_code.trim()) continue;
      const body = { product_id: productId, sku_code: k.sku_code.trim(), jan: strOrNull(k.jan), color_id: numOrNull(k.color_id), size_id: numOrNull(k.size_id), pack_division: strOrNull(k.pack_division) };
      if (k.id) await api.patch(`/masters/skus/${k.id}`, { ...body, is_active: k.is_active });
      else await api.post('/masters/skus', body);
    }
  };

  return (
    <MasterPage<ProductRow, Form>
      title="商品"
      sub="商品（品番）と、その下の SKU（色・サイズ・JAN）。原価は権限のある方にだけ表示されます"
      functionId="M-08"
      listPath="/masters/products"
      writePath="/masters/products"
      extraFilters={{ brand_id: brandId || undefined }}
      modalWidth={860}
      headRight={can('M-09', 'print') && <Button icon="download" onClick={() => api.download('/masters/skus/jan-export').catch((e) => toast(e instanceof Error ? e.message : '失敗しました', 'bad'))}>JANコード一覧CSV</Button>}
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
      empty={() => ({ product_code: '', product_name: '', set_product_name: '', brand_id: '', category_id: '', product_class_id: '', carton_qty: '', cost_price: '0', is_cost_undecided: false, tax_rate: '10.00', is_set: false, sort_order: '', note: '', skus: [] })}
      toForm={async (r) => {
        const d = await api.get<Record<string, unknown> & { skus: Record<string, unknown>[]; brand_id?: number; category_id?: number; product_class_id?: number }>(`/masters/products/${r.id}`);
        return {
          product_code: s(d.product_code), product_name: s(d.product_name), set_product_name: s(d.set_product_name),
          brand_id: s(d.brand_id), category_id: s(d.category_id), product_class_id: s(d.product_class_id),
          carton_qty: s(d.carton_qty), cost_price: dec(d.cost_price ?? '0'), is_cost_undecided: Boolean(d.is_cost_undecided),
          tax_rate: s(d.tax_rate || '10.00'), is_set: Boolean(d.is_set), sort_order: s(d.sort_order), note: s(d.note),
          skus: (d.skus ?? []).map((k) => ({ id: Number(k.id), sku_code: s(k.sku_code), jan: s(k.jan), color_id: s(k.color_id), size_id: s(k.size_id), pack_division: s(k.pack_division), is_active: k.is_active !== false })),
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
        ...(canSeeSensitive ? { cost_price: f.cost_price.trim() || '0', is_cost_undecided: f.is_cost_undecided } : {}),
        tax_rate: f.tax_rate,
        is_set: f.is_set,
        sort_order: numOrNull(f.sort_order),
        note: strOrNull(f.note),
      })}
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
            <L label="表示順"><Input right value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} className="!w-[90px]" /></L>
          </div>
          <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="備考" />

          <Section title="SKU（色・サイズ・JAN）" />
          {!editing && <div className="text-[11.5px] text-[var(--color-ink-3)]">商品を登録したあと、もう一度「編集」を開くと SKU を追加できます。</div>}
          {editing && (
            <SkuEditor
              skus={f.skus}
              colors={colors.data?.items ?? []}
              sizes={sizes.data?.items ?? []}
              onChange={(skus) => set({ skus })}
              onSave={async () => {
                setSkuError(null);
                try {
                  await saveSkus(editing.id, f.skus);
                  const d = await api.get<{ skus: Record<string, unknown>[] }>(`/masters/products/${editing.id}`);
                  set({ skus: d.skus.map((k) => ({ id: Number(k.id), sku_code: s(k.sku_code), jan: s(k.jan), color_id: s(k.color_id), size_id: s(k.size_id), pack_division: s(k.pack_division), is_active: k.is_active !== false })) });
                  toast('SKU を保存しました', 'good');
                } catch (e) {
                  setSkuError(e);
                }
              }}
              error={skuError}
            />
          )}
        </div>
      )}
    />
  );
}

function SkuEditor({ skus, colors, sizes, onChange, onSave, error }: {
  skus: Sku[];
  colors: { id: number; name: string }[];
  sizes: { id: number; name: string }[];
  onChange: (skus: Sku[]) => void;
  onSave: () => Promise<void>;
  error: unknown;
}) {
  const [busy, setBusy] = useState(false);
  const upd = (i: number, patch: Partial<Sku>) => onChange(skus.map((k, idx) => (idx === i ? { ...k, ...patch, _dirty: true } : k)));
  const dirty = skus.some((k) => k._dirty);
  return (
    <div className="flex flex-col gap-2">
      {error ? <ErrorBox error={error} /> : null}
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th style={{ width: 150 }}>SKUコード</th><th style={{ width: 140 }}>JAN</th><th>カラー</th><th>サイズ</th><th style={{ width: 90 }}>入数区分</th><th style={{ width: 60 }}>有効</th></tr></thead>
          <tbody>
            {skus.length === 0 && <tr><td colSpan={6} className="text-center py-4 text-[var(--color-ink-3)]">SKU がありません</td></tr>}
            {skus.map((k, i) => (
              <tr key={k.id ?? `new-${i}`}>
                <td><Input value={k.sku_code} onChange={(e) => upd(i, { sku_code: e.target.value })} /></td>
                <td><Input value={k.jan} onChange={(e) => upd(i, { jan: e.target.value })} placeholder="13桁" /></td>
                <td><Select value={k.color_id} onChange={(e) => upd(i, { color_id: e.target.value })}><option value="">（なし）</option>{colors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></td>
                <td><Select value={k.size_id} onChange={(e) => upd(i, { size_id: e.target.value })}><option value="">（なし）</option>{sizes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></td>
                <td><Input value={k.pack_division} onChange={(e) => upd(i, { pack_division: e.target.value })} /></td>
                <td className="c"><input type="checkbox" checked={k.is_active} onChange={(e) => upd(i, { is_active: e.target.checked })} disabled={!k.id} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <Button size="sm" icon="plus" onClick={() => onChange([...skus, { sku_code: '', jan: '', color_id: '', size_id: '', pack_division: '', is_active: true, _dirty: true }])}>SKU を追加</Button>
        <Button size="sm" variant="primary" disabled={!dirty} loading={busy} onClick={async () => { setBusy(true); try { await onSave(); } finally { setBusy(false); } }}>SKU を保存</Button>
        <span className="text-[10.5px] text-[var(--color-ink-3)] self-center">SKU は商品本体とは別に保存します</span>
      </div>
    </div>
  );
}
