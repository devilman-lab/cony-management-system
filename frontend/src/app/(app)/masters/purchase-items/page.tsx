'use client';

import { useCodes, useSimpleMaster } from '@/lib/hooks';
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
  new_tax_class_code_id: number | null;
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
  new_tax_class_code_id: string;
  sort_order: string;
  note: string;
  /** 開いたときに税区分に合わせて税率を直したら、直す前の税率（保存はしない。画面の案内用） */
  rate_fixed_from: string;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
/** 数値を末尾の 0 なしで（3000.0000 → 3000） */
const dec = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));

/**
 * 税区分から決まる税率（課税10%→10、軽減8%→8、非課税・不課税・免税→0）。
 * 区分値の画面で足した区分は名前で見る。決められない区分は undefined（税率は手で選ぶ）。
 * API（backend の purchase-item-tax.ts）と同じ対応。
 */
const RATE_BY_TAX_DIVISION: Record<string, string> = { TAX10: '10.00', TAX8: '8.00', EXEMPT: '0.00', NON_TAX: '0.00' };
function rateForTaxDivision(c: { code: string; name: string } | undefined): string | undefined {
  if (!c) return undefined;
  if (RATE_BY_TAX_DIVISION[c.code]) return RATE_BY_TAX_DIVISION[c.code];
  if (/非課税|不課税|免税|対象外/.test(c.name)) return '0.00';
  if (/8\s*[%％]/.test(c.name) || c.name.includes('軽減')) return '8.00';
  if (/10\s*[%％]/.test(c.name)) return '10.00';
  return undefined;
}

/** 仕入マスタ（M-15）。仕入入力で選ぶ品目と単価。商品マスタとは別（資材・経費なども含む）。 */
export default function PurchaseItemsPage() {
  const brands = useSimpleMaster('brands');
  const categories = useSimpleMaster('categories');
  const classes = useSimpleMaster('product_classes');
  // 税区分（課税10%／軽減8%／非課税／不課税）。区分値の画面から増やせる。
  const taxClasses = useCodes('TAX_DIVISION');
  // 税区分（区分値の ID）から決まる税率。税区分が空、または決められない区分なら undefined
  const rateOf = (classId: number | string | null | undefined) =>
    rateForTaxDivision((taxClasses.data?.values ?? []).find((c) => String(c.id) === String(classId ?? '')));
  return (
    <MasterPage<ItemRow, Form>
      title="仕入品目"
      sub="仕入入力で選ぶ品目と標準の仕入単価です。商品以外（資材・外注費など）も登録できます"
      functionId="M-15"
      // 一覧で編集・CSV 書き出し／取込（2026-10-12 受入 No.2・No.3）
      csvSlug="purchase-items"
      listPath="/masters/purchase-items"
      writePath="/masters/purchase-items"
      columns={[
        { key: 'purchase_code', label: 'コード', width: 120, render: (r) => <Num className="font-semibold">{r.purchase_code}</Num> },
        { key: 'item_name', label: '品目名' },
        { key: 'unit_cost', label: '単価', r: true, width: 110, render: (r) => money(r.unit_cost) },
        {
          key: 'new_tax_rate',
          label: '税率',
          r: true,
          width: 90,
          render: (r) => {
            const expected = rateOf(r.new_tax_class_code_id);
            const mismatch = expected !== undefined && r.new_tax_rate !== null && Number(r.new_tax_rate) !== Number(expected);
            return (
              <>
                {r.new_tax_rate ? `${Number(r.new_tax_rate)}%` : ''}
                {mismatch && <span title="税区分と税率が食い違っています。開いて「更新する」を押すと税区分に合わせて直ります"> <Badge>要確認</Badge></span>}
              </>
            );
          },
        },
        { key: 'new_tax_class_code_id', label: '税区分', width: 110, render: (r) => (taxClasses.data?.values ?? []).find((c) => c.id === r.new_tax_class_code_id)?.name ?? '' },
        { key: 'is_active', label: '', width: 60, render: (r) => (r.is_active ? '' : <Badge>無効</Badge>) },
      ]}
      rowKey={(r) => r.id}
      // 削除の確認に対象のコードと名前を出す（2026-10-12 受入 No.1 注記「このデータを完全に消します」だけで何を消すか分からない）
      rowLabel={(r) => `仕入品目 ${r.purchase_code}　${r.item_name}`}
      empty={() => ({ purchase_code: '', item_name: '', unit_cost: '0', brand_id: '', category_id: '', product_class_id: '', new_tax_rate: '10.00', new_tax_class_code_id: '', sort_order: '', note: '', rate_fixed_from: '' })}
      toForm={(r) => {
        // 前に「税率 10%・非課税」のような食い違いで登録したものは、開いたときに税区分に合わせて直す（T3 No.32）
        const expected = rateOf(r.new_tax_class_code_id);
        const fixed = expected !== undefined && Number(r.new_tax_rate ?? -1) !== Number(expected);
        return { purchase_code: r.purchase_code, item_name: r.item_name, unit_cost: dec(r.unit_cost), brand_id: s(r.brand_id), category_id: s(r.category_id), product_class_id: s(r.product_class_id), new_tax_rate: fixed ? expected : s(r.new_tax_rate), new_tax_class_code_id: s(r.new_tax_class_code_id), sort_order: s(r.sort_order), note: s(r.note), rate_fixed_from: fixed ? (r.new_tax_rate === null ? '（なし）' : `${Number(r.new_tax_rate)}%`) : '' };
      }}
      toBody={(f) => ({
        purchase_code: f.purchase_code.trim(),
        item_name: f.item_name.trim(),
        unit_cost: f.unit_cost.trim() || '0',
        brand_id: numOrNull(f.brand_id),
        category_id: numOrNull(f.category_id),
        product_class_id: numOrNull(f.product_class_id),
        new_tax_rate: f.new_tax_rate || null,
        new_tax_class_code_id: numOrNull(f.new_tax_class_code_id),
        sort_order: numOrNull(f.sort_order),
        note: strOrNull(f.note),
      })}
      renderForm={(f, set) => (
        <div className="flex flex-col gap-3">
          <div className="master-grid-2">
            <L label="仕入コード" required><Input value={f.purchase_code} onChange={(e) => set({ purchase_code: e.target.value })} className="!w-[160px]" /></L>
            <L label="単価" required><Input right value={f.unit_cost} onChange={(e) => set({ unit_cost: e.target.value })} className="!w-[130px]" /></L>
            <L label="品目名" required><Input value={f.item_name} onChange={(e) => set({ item_name: e.target.value })} /></L>
            <L
              label="税率"
              hint={
                f.rate_fixed_from
                  ? `登録されていた税率 ${f.rate_fixed_from} は税区分と合わないため、税区分に合わせて直しました。「更新する」で保存されます`
                  : rateOf(f.new_tax_class_code_id) !== undefined
                    ? '税区分から決まります'
                    : undefined
              }
            >
              <Select value={f.new_tax_rate} onChange={(e) => set({ new_tax_rate: e.target.value })} className="!w-[100px]" disabled={rateOf(f.new_tax_class_code_id) !== undefined}><option value="">（なし）</option><option value="10.00">10%</option><option value="8.00">8%</option><option value="0.00">0%</option></Select>
            </L>
            <L label="税区分" hint="課税・軽減・非課税・不課税。選ぶと税率が決まります（課税10%→10%、軽減8%→8%、非課税・不課税・免税→0%）。区分値の画面で増やせます">
              <Select
                value={f.new_tax_class_code_id}
                onChange={(e) => {
                  const expected = rateOf(e.target.value);
                  set(expected !== undefined ? { new_tax_class_code_id: e.target.value, new_tax_rate: expected, rate_fixed_from: '' } : { new_tax_class_code_id: e.target.value });
                }}
                className="!w-[150px]"
              >
                <option value="">（なし）</option>
                {(taxClasses.data?.values ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </L>
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
