'use client';

import { useSimpleMaster } from '@/lib/hooks';
import { money } from '@/lib/format';
import { Badge, Input, Num, Select, Textarea } from '@/components/ui';
import { MasterPage, numOrNull, strOrNull } from '@/components/masters/MasterPage';
import { L } from '@/components/masters/Form';

interface ItemRow extends Record<string, unknown> {
  id: number;
  purchase_code: string;
  item_name: string;
  unit_cost: string;
  brand_id: number | null;
  category_id: number | null;
  product_class_id: number | null;
  new_tax_rate: string | null;
  sort_order: number | null;
  note: string | null;
  is_active: boolean;
}

interface Form {
  purchase_code: string;
  item_name: string;
  unit_cost: string;
  brand_id: string;
  category_id: string;
  product_class_id: string;
  new_tax_rate: string;
  sort_order: string;
  note: string;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
/** 数値を末尾の 0 なしで（3000.0000 → 3000） */
const dec = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));

/** 仕入マスタ（M-15）。仕入入力で選ぶ品目と単価。商品マスタとは別（資材・経費なども含む）。 */
export default function PurchaseItemsPage() {
  const brands = useSimpleMaster('brands');
  const categories = useSimpleMaster('categories');
  const classes = useSimpleMaster('product_classes');
  return (
    <MasterPage<ItemRow, Form>
      title="仕入品目"
      sub="仕入入力で選ぶ品目と標準の仕入単価です。商品以外（資材・外注費など）も登録できます"
      functionId="M-15"
      listPath="/masters/purchase-items"
      writePath="/masters/purchase-items"
      columns={[
        { key: 'purchase_code', label: 'コード', width: 120, render: (r) => <Num className="font-semibold">{r.purchase_code}</Num> },
        { key: 'item_name', label: '品目名' },
        { key: 'unit_cost', label: '単価', r: true, width: 110, render: (r) => money(r.unit_cost) },
        { key: 'new_tax_rate', label: '税率', r: true, width: 70, render: (r) => (r.new_tax_rate ? `${Number(r.new_tax_rate)}%` : '') },
        { key: 'is_active', label: '', width: 60, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
      ]}
      rowKey={(r) => r.id}
      empty={() => ({ purchase_code: '', item_name: '', unit_cost: '0', brand_id: '', category_id: '', product_class_id: '', new_tax_rate: '10.00', sort_order: '', note: '' })}
      toForm={(r) => ({ purchase_code: r.purchase_code, item_name: r.item_name, unit_cost: dec(r.unit_cost), brand_id: s(r.brand_id), category_id: s(r.category_id), product_class_id: s(r.product_class_id), new_tax_rate: s(r.new_tax_rate), sort_order: s(r.sort_order), note: s(r.note) })}
      toBody={(f) => ({
        purchase_code: f.purchase_code.trim(),
        item_name: f.item_name.trim(),
        unit_cost: f.unit_cost.trim() || '0',
        brand_id: numOrNull(f.brand_id),
        category_id: numOrNull(f.category_id),
        product_class_id: numOrNull(f.product_class_id),
        new_tax_rate: f.new_tax_rate || null,
        sort_order: numOrNull(f.sort_order),
        note: strOrNull(f.note),
      })}
      renderForm={(f, set) => (
        <div className="flex flex-col gap-3">
          <div className="master-grid-2">
            <L label="仕入コード" required><Input value={f.purchase_code} onChange={(e) => set({ purchase_code: e.target.value })} className="!w-[160px]" /></L>
            <L label="単価" required><Input right value={f.unit_cost} onChange={(e) => set({ unit_cost: e.target.value })} className="!w-[130px]" /></L>
            <L label="品目名" required><Input value={f.item_name} onChange={(e) => set({ item_name: e.target.value })} /></L>
            <L label="税率"><Select value={f.new_tax_rate} onChange={(e) => set({ new_tax_rate: e.target.value })} className="!w-[100px]"><option value="">（なし）</option><option value="10.00">10%</option><option value="8.00">8%</option><option value="0.00">0%</option></Select></L>
            <L label="ブランド"><Select value={f.brand_id} onChange={(e) => set({ brand_id: e.target.value })}><option value="">（なし）</option>{(brands.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></L>
            <L label="カテゴリー"><Select value={f.category_id} onChange={(e) => set({ category_id: e.target.value })}><option value="">（なし）</option>{(categories.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></L>
            <L label="商品分類"><Select value={f.product_class_id} onChange={(e) => set({ product_class_id: e.target.value })}><option value="">（なし）</option>{(classes.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></L>
            <L label="表示順"><Input right value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} className="!w-[90px]" /></L>
          </div>
          <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="備考" />
        </div>
      )}
    />
  );
}
