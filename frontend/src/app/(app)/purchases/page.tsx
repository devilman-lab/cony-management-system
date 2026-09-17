'use client';

import { useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch, useList, useSimpleMaster } from '@/lib/hooks';
import { money, qty, today, ymd } from '@/lib/format';
import { Badge, Button, Card, DataTable, ErrorBox, FormRow, Input, Modal, Num, PageHead, Pager, Select, Textarea, Toolbar } from '@/components/ui';
import { SearchSelect, fetchPartners, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface PurchaseRow extends Record<string, unknown> {
  id: number;
  purchase_no: string;
  division: string;
  purchase_date: string;
  total_amount: string;
  status: string;
  supplier_name: string;
}

interface PurchaseDetail extends PurchaseRow {
  note: string | null;
  lines: { line_no: number; item_name: string; qty: string | null; unit_cost: string; subtotal: string; tax_rate: string; target_product_name: string | null; target_brand_name: string | null }[];
}

interface PurchaseItem {
  id: number;
  code: string;
  name: string;
}

interface ProductOpt {
  id: number;
  product_code: string;
  product_name: string;
}

interface LineDraft {
  key: number;
  purchase_item_id: string;
  item_name: string;
  qty: string;
  unit_cost: string;
  target: 'none' | 'product' | 'brand' | 'class';
  product: Option | null;
  brand_id: string;
  class_id: string;
  tax_rate: string;
}
let seq = 1;
const newLine = (): LineDraft => ({ key: seq++, purchase_item_id: '', item_name: '', qty: '1', unit_cost: '', target: 'none', product: null, brand_id: '', class_id: '', tax_rate: '10.00' });

const fetchProducts = async (q: string): Promise<Option[]> => {
  const r = await api.get<{ items: ProductOpt[] }>('/masters/products', { q: q || undefined, limit: 20 });
  return r.items.map((p) => ({ id: p.id, label: p.product_name, sub: p.product_code }));
};

/** 仕入・経費登録（P-01）。経費は SKU ではなく商品（品番）単位で、紐づけ先は 商品／商品分類／ブランド／指定なし。 */
export default function PurchasesPage() {
  const { can } = useAuth();
  const toast = useToast();
  const fetchSuppliers = useMemo(() => fetchPartners('supplier'), []);
  const items = useFetch<{ items: PurchaseItem[] }>('/masters/purchase-items', { limit: 200 });
  const brands = useSimpleMaster('brands');
  const classes = useSimpleMaster('product_classes');

  const [division, setDivision] = useState('');
  const [supplier, setSupplier] = useState<Option | null>(null);
  const list = useList<PurchaseRow>('/purchases', { division: division || undefined, supplier_partner_id: supplier?.id });

  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ division: '仕入', supplier: null as Option | null, date: today(), delivery_date: '', payment_date1: '', note: '' });
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const setLine = (key: number, p: Partial<LineDraft>) => setLines((s) => s.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const [detailId, setDetailId] = useState<number | null>(null);
  const detail = useFetch<PurchaseDetail>(detailId ? `/purchases/${detailId}` : null);

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.post('/purchases', {
        division: f.division,
        supplier_partner_id: f.supplier?.id,
        purchase_date: f.date,
        delivery_date: f.delivery_date || null,
        payment_date1: f.payment_date1 || null,
        note: f.note || null,
        lines: lines.map((l, i) => ({
          line_no: i + 1,
          purchase_item_id: l.purchase_item_id ? Number(l.purchase_item_id) : null,
          item_name: l.item_name || items.data?.items.find((x) => String(x.id) === l.purchase_item_id)?.name || '',
          qty: l.qty || undefined,
          unit_cost: l.unit_cost,
          target_product_id: l.target === 'product' ? l.product?.id ?? null : null,
          target_brand_id: l.target === 'brand' && l.brand_id ? Number(l.brand_id) : null,
          target_product_class_id: l.target === 'class' && l.class_id ? Number(l.class_id) : null,
          tax_rate: l.tax_rate,
        })),
      });
      toast('登録しました', 'good');
      setOpen(false);
      setLines([newLine()]);
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const total = lines.reduce((a, l) => a + Number(l.qty || 1) * Number(l.unit_cost || 0), 0);

  return (
    <div className="page-body">
      <PageHead
        title="仕入・経費"
        sub="仕入と経費を登録します。経費は商品（品番）・商品分類・ブランドのいずれかに紐づけられます"
        right={can('P-01', 'create') && <Button variant="primary" icon="plus" onClick={() => { setError(null); setOpen(true); }}>仕入・経費を登録</Button>}
      />
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.total}</Num> 件</span>}>
          <Select value={division} onChange={(e) => setDivision(e.target.value)} className="!w-[110px]">
            <option value="">区分：すべて</option>
            <option>仕入</option>
            <option>経費</option>
          </Select>
          <SearchSelect value={supplier} onChange={setSupplier} fetchOptions={fetchSuppliers} placeholder="仕入先で絞る" width={220} />
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<PurchaseRow>
          columns={[
            { key: 'purchase_no', label: '番号', width: 140, render: (r) => <button type="button" className="num font-semibold text-[var(--color-brand-700)] underline" onClick={() => setDetailId(r.id)}>{r.purchase_no}</button> },
            { key: 'purchase_date', label: '日付', width: 100, render: (r) => <Num>{ymd(r.purchase_date)}</Num> },
            { key: 'division', label: '区分', width: 70 },
            { key: 'supplier_name', label: '仕入先' },
            { key: 'total_amount', label: '金額', r: true, width: 120, render: (r) => money(r.total_amount) },
            { key: 'status', label: '状態', width: 80, render: (r) => <Badge status={r.status} /> },
          ]}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>

      <Modal open={open} title="仕入・経費の登録" onClose={() => setOpen(false)} width={960} footer={<><span className="mr-auto text-[12px]">合計 <b className="num">{money(total)}</b> 円</span><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} onClick={save}>登録する</Button></>}>
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <div className="master-grid-2">
          <FormRow label="区分" required>
            <Select value={f.division} onChange={(e) => setF({ ...f, division: e.target.value })} className="!w-[110px]"><option>仕入</option><option>経費</option></Select>
          </FormRow>
          <FormRow label="日付" required><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} className="!w-[150px]" /></FormRow>
          <FormRow label="仕入先" required><SearchSelect value={f.supplier} onChange={(o) => setF({ ...f, supplier: o })} fetchOptions={fetchSuppliers} placeholder="仕入先を検索" width="100%" /></FormRow>
          <FormRow label="支払予定日"><Input type="date" value={f.payment_date1} onChange={(e) => setF({ ...f, payment_date1: e.target.value })} className="!w-[150px]" /></FormRow>
        </div>
        <div className="mt-2"><Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="備考" /></div>
        <div className="mt-3 tbl-wrap">
          <table className="tbl" style={{ minWidth: 880 }}>
            <thead>
              <tr>
                <th style={{ width: 160 }}>仕入項目</th>
                <th>内容</th>
                <th className="r" style={{ width: 70 }}>数量</th>
                <th className="r" style={{ width: 100 }}>単価</th>
                <th style={{ width: 110 }}>紐づけ先</th>
                <th style={{ width: 220 }}>対象</th>
                <th style={{ width: 70 }}>税率</th>
                <th style={{ width: 36 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    <Select value={l.purchase_item_id} onChange={(e) => setLine(l.key, { purchase_item_id: e.target.value })} className="!h-[26px]">
                      <option value="">（自由入力）</option>
                      {(items.data?.items ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </Select>
                  </td>
                  <td><Input value={l.item_name} onChange={(e) => setLine(l.key, { item_name: e.target.value })} className="!h-[26px]" placeholder="品名・内容" /></td>
                  <td className="r"><Input right value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} className="!h-[26px] !w-[60px]" /></td>
                  <td className="r"><Input right value={l.unit_cost} onChange={(e) => setLine(l.key, { unit_cost: e.target.value })} className="!h-[26px] !w-[90px]" /></td>
                  <td>
                    <Select value={l.target} onChange={(e) => setLine(l.key, { target: e.target.value as LineDraft['target'] })} className="!h-[26px]">
                      <option value="none">指定なし</option>
                      <option value="product">商品</option>
                      <option value="class">商品分類</option>
                      <option value="brand">ブランド</option>
                    </Select>
                  </td>
                  <td>
                    {l.target === 'product' && <SearchSelect value={l.product} onChange={(o) => setLine(l.key, { product: o })} fetchOptions={fetchProducts} placeholder="商品コード・商品名" width="100%" />}
                    {l.target === 'brand' && <Select value={l.brand_id} onChange={(e) => setLine(l.key, { brand_id: e.target.value })} className="!h-[26px]"><option value="">選んでください</option>{(brands.data?.items ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}
                    {l.target === 'class' && <Select value={l.class_id} onChange={(e) => setLine(l.key, { class_id: e.target.value })} className="!h-[26px]"><option value="">選んでください</option>{(classes.data?.items ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}
                  </td>
                  <td><Select value={l.tax_rate} onChange={(e) => setLine(l.key, { tax_rate: e.target.value })} className="!h-[26px]"><option value="10.00">10%</option><option value="8.00">8%</option><option value="0.00">0%</option></Select></td>
                  <td className="c"><button type="button" className="btn btn-quiet !px-1.5 !h-6" disabled={lines.length === 1} onClick={() => setLines((s) => s.filter((x) => x.key !== l.key))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2"><Button size="sm" icon="plus" onClick={() => setLines((s) => [...s, newLine()])}>行を追加</Button></div>
      </Modal>

      <Modal open={detailId !== null} title={detail.data ? `${detail.data.purchase_no}　${detail.data.supplier_name}` : ''} onClose={() => setDetailId(null)} width={800}>
        {detail.data && (
          <>
            <div className="text-[12px] text-[var(--color-ink-2)] mb-2">{detail.data.division}　{ymd(detail.data.purchase_date)}　<Badge status={detail.data.status} />　{detail.data.note ?? ''}</div>
            <table className="tbl">
              <thead><tr><th style={{ width: 36 }}>行</th><th>内容</th><th className="r" style={{ width: 70 }}>数量</th><th className="r" style={{ width: 100 }}>単価</th><th className="r" style={{ width: 110 }}>小計</th><th style={{ width: 160 }}>紐づけ先</th></tr></thead>
              <tbody>
                {detail.data.lines.map((l) => <tr key={l.line_no}><td className="num">{l.line_no}</td><td>{l.item_name}</td><td className="r num">{qty(l.qty)}</td><td className="r num">{money(l.unit_cost)}</td><td className="r num">{money(l.subtotal)}</td><td>{l.target_product_name ?? l.target_brand_name ?? ''}</td></tr>)}
              </tbody>
            </table>
            <div className="text-right mt-2 text-[12.5px]">合計 <b className="num text-[14px]">{money(detail.data.total_amount)}</b> 円</div>
          </>
        )}
      </Modal>
    </div>
  );
}
