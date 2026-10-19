'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, ApiError } from '@/lib/api';
import { useFetch, useSalesCategories, useSimpleMaster, useWarehouses } from '@/lib/hooks';
import { isYen, moneyIn, moneyWithCurrency, plainDecimal, today } from '@/lib/format';
import { Button, Card, CardHead, ErrorBox, FormRow, Input, Select, Textarea } from '@/components/ui';
import { SearchSelect, fetchDestinations, fetchPartners, fetchSkusFor, skuItemName, type DestinationRow, type Option, type PartnerRow, type SkuRow } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';
import { RecordStamp } from '@/components/ui/RecordStamp';

const LINE_TYPES = ['商品', 'セット商品', '販促品', '送料', '値引', '非商品'] as const;
type LineType = (typeof LINE_TYPES)[number];

export interface LineDraft {
  key: number;
  line_type: LineType;
  sku: Option | null;
  item_name: string;
  qty: string;
  unit_price: string;
  tax_rate: string;
  partner_product_id: number | null;
  /** 得意先別商品からの補足表示 */
  note?: string;
  /**
   * 同じ SKU にこの取引先の得意先別商品が複数あるときの選択肢（先方コード・販売名・卸単価で選ぶ。
   * 2026-10-16 マスター編_3 M3-26）。1つ以下なら持たない。
   */
  pp_choices?: PartnerProductChoice[];
  /** SKU の品名（販売名の無い行を選び直したときに戻す名前）。修正画面で開いた明細は持たない */
  base_name?: string;
}

/** 得意先別商品の1行（/masters/partner-products/lookup の戻り） */
export interface PartnerProductChoice {
  id: number;
  partner_product_code: string | null;
  partner_jan: string | null;
  shipping_jan: string | null;
  sales_name: string | null;
  unit_price: string;
  retail_price: string | null;
  note: string | null;
}

/** 明細の品名の下に出す補足（先方コード・出荷JAN）。出荷JANが無ければ先方JANを出す（1001 ご要望） */
export const partnerProductNote = (pp: Pick<PartnerProductChoice, 'partner_product_code' | 'shipping_jan' | 'partner_jan'>): string =>
  [
    pp.partner_product_code ? `専用コード ${pp.partner_product_code}` : '',
    pp.shipping_jan ? `出荷JAN ${pp.shipping_jan}` : pp.partner_jan ? `先方JAN ${pp.partner_jan}` : '',
  ]
    .filter(Boolean)
    .join('　') || '得意先別単価';

/** 選ぶときの見出し。先方コード・卸単価・販売名で見分ける（閉じた欄は幅が狭いので、短い先方コードと単価を先に） */
const choiceLabel = (pp: PartnerProductChoice): string =>
  [
    pp.partner_product_code ? `先方コード ${pp.partner_product_code}` : '先方コードなし',
    `卸単価 ${Number(pp.unit_price).toLocaleString('ja-JP', { maximumFractionDigits: 4 })}`,
    pp.sales_name?.trim() || '',
    pp.note?.trim() ? `（${pp.note.replace(/\s+/g, ' ').trim()}）` : '',
  ]
    .filter(Boolean)
    .join('　');

export interface OrderDraft {
  order_type: '卸' | '直送' | '通販' | 'サンプル';
  partner: Option | null;
  delivery_destination_id: string;
  sales_category_id: string;
  trade_type: '委託' | '買取';
  sales_staff_id: string;
  po_no: string;
  order_date: string;
  ship_date: string;
  delivery_date: string;
  requested_delivery_date: string;
  ship_from_warehouse_id: string;
  direct_name: string;
  direct_kana: string;
  direct_postal_code: string;
  direct_address1: string;
  direct_address2: string;
  direct_tel: string;
  shipping_remarks: string;
  delivery_note_remarks: string;
  shipping_fee_adjustment: string;
  lines: LineDraft[];
}

let keySeq = 1;

/**
 * 海外の得意先（取引先マスタの「海外」）か。海外の得意先は消費税 0%（請求書・納品書と同じ。2026-10-12 M-02）。
 * サーバーも海外の得意先の明細は 0% で登録する。
 */
const isOverseasPartner = (o: Option | null) => Boolean((o?.raw as { is_overseas?: boolean } | undefined)?.is_overseas);
/**
 * 取引先の通貨（2026-10-12 No.39）。受注の通貨は取引先の通貨で固定（サーバーの引き金が入れる）。
 * 1つの請求書に違う通貨が混ざらないよう、受注入力では変えられない。
 */
const partnerCurrency = (o: Option | null) => (o?.raw as { currency?: string } | undefined)?.currency || 'JPY';
/** 国内に戻したときの税率。商品の税率、無ければ 10%。 */
const domesticRate = (l: LineDraft) => {
  const r = (l.sku?.raw as Partial<SkuRow> | undefined)?.tax_rate;
  return r !== undefined && r !== null ? Number(r).toFixed(2) : '10.00';
};
export const emptyLine = (): LineDraft => ({ key: keySeq++, line_type: '商品', sku: null, item_name: '', qty: '1', unit_price: '0', tax_rate: '10.00', partner_product_id: null });

export const emptyOrder = (): OrderDraft => ({
  order_type: '卸',
  partner: null,
  delivery_destination_id: '',
  sales_category_id: '',
  trade_type: '買取',
  sales_staff_id: '',
  po_no: '',
  order_date: today(),
  ship_date: '',
  delivery_date: '',
  requested_delivery_date: '',
  ship_from_warehouse_id: '',
  direct_name: '',
  direct_kana: '',
  direct_postal_code: '',
  direct_address1: '',
  direct_address2: '',
  direct_tel: '',
  shipping_remarks: '',
  delivery_note_remarks: '',
  shipping_fee_adjustment: '',
  lines: [emptyLine()],
});

interface WriteResult {
  id: number;
  order_no: string;
  status: string;
  shipment_id: number | null;
  shortages: string[];
}

const nn = (v: string) => (v.trim() === '' ? null : v.trim());

function toBody(d: OrderDraft) {
  return {
    order_type: d.order_type,
    partner_id: d.partner?.id,
    delivery_destination_id: d.delivery_destination_id ? Number(d.delivery_destination_id) : null,
    sales_category_id: Number(d.sales_category_id),
    trade_type: d.trade_type,
    sales_staff_id: d.sales_staff_id ? Number(d.sales_staff_id) : null,
    po_no: nn(d.po_no),
    order_date: d.order_date,
    ship_date: nn(d.ship_date),
    delivery_date: nn(d.delivery_date),
    requested_delivery_date: nn(d.requested_delivery_date),
    ship_from_warehouse_id: d.ship_from_warehouse_id ? Number(d.ship_from_warehouse_id) : null,
    direct_name: nn(d.direct_name),
    direct_kana: nn(d.direct_kana),
    direct_postal_code: nn(d.direct_postal_code)?.replace(/[^0-9]/g, '') ?? null,
    direct_address1: nn(d.direct_address1),
    direct_address2: nn(d.direct_address2),
    direct_tel: nn(d.direct_tel),
    shipping_remarks: nn(d.shipping_remarks),
    delivery_note_remarks: nn(d.delivery_note_remarks),
    shipping_fee_adjustment: nn(d.shipping_fee_adjustment),
    lines: d.lines.map((l, i) => ({
      line_no: i + 1,
      line_type: l.line_type,
      sku_id: l.sku?.id ?? null,
      // 使った得意先別商品の行（同じ SKU に複数あるときは選んだ行。M3-26）。商品の無い行は持たない
      partner_product_id: l.sku ? l.partner_product_id : null,
      // 得意先別商品に販売名が無いと undefined が入りうるので、必ず文字列として扱う
      item_name: (l.item_name ?? '').trim() || l.sku?.label.split('　')[1] || l.line_type,
      qty: l.qty.trim() || '0',
      unit_price: l.unit_price.trim() || '0',
      tax_rate: l.tax_rate,
    })),
  };
}

/**
 * 受注入力（登録・修正の両方）。
 * 取引先を選ぶと、納品先・取引条件・販売担当が取引先マスタから入る。
 * 商品を選ぶと、得意先別商品の単価と専用コードが自動で入る。
 */
export function OrderForm({ initial, orderId }: { initial?: OrderDraft; orderId?: number }) {
  const router = useRouter();
  const toast = useToast();
  const [d, setD] = useState<OrderDraft>(initial ?? emptyOrder());
  const [destinations, setDestinations] = useState<DestinationRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const categories = useSalesCategories();
  const warehouses = useWarehouses();
  const staff = useSimpleMaster('sales_staff');
  const fetchCustomers = useMemo(() => fetchPartners('customer'), []);
  // 海外の得意先の消費税の表記（免税（税抜扱い）／課税対象外）。取引先の消費税免税区分（取引先の検索結果の
  // overseas_tax_label）があればそれ、無ければシステム設定（2026-10-16 マスター編_3 M3-07）
  const overseasTax = useFetch<{ tax_rate: string; label: string }>('/orders/overseas-tax');
  const overseas = isOverseasPartner(d.partner);
  const overseasLabel = (d.partner?.raw as { overseas_tax_label?: string | null } | undefined)?.overseas_tax_label ?? overseasTax.data?.label;
  const currency = partnerCurrency(d.partner);

  const set = <K extends keyof OrderDraft>(k: K, v: OrderDraft[K]) => setD((s) => ({ ...s, [k]: v }));
  const setLine = (key: number, patch: Partial<LineDraft>) =>
    setD((s) => ({ ...s, lines: s.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));

  /**
   * 明細に得意先別商品の行を当てる。単価・品名（販売名）・補足（先方コード・出荷JAN）がその行に従う。
   * 返事を待つ間に商品を選び直していたら当てない（skuId で確かめる）。
   */
  const applyPartnerProduct = useCallback((key: number, skuId: number, pp: PartnerProductChoice) => {
    setD((s) => ({
      ...s,
      lines: s.lines.map((l) =>
        l.key === key && l.sku?.id === skuId
          ? {
              ...l,
              // 得意先別の単価は "12.5000" の形で返るので、入力欄には "12.5" で入れる（再テスト R4）
              unit_price: plainDecimal(pp.unit_price),
              partner_product_id: pp.id,
              // 販売名が未登録（null・空）なら SKU の品名にする。undefined を入れると品名が失われ、
              // 送信時に item_name.trim() で落ちて受注が登録できなくなる。
              item_name: pp.sales_name?.trim() || l.base_name || l.item_name,
              note: partnerProductNote(pp),
            }
          : l,
      ),
    }));
  }, []);

  /**
   * 取引先×SKU の得意先別商品を引いて明細に当てる（2026-10-16 マスター編_3 M3-26）。
   * 行が1つならその行。複数あるときは preferredId の行（先方JAN・先方の商品コードで探して選んだ行、
   * 修正画面で開いた明細が使っていた行）。決まらなければ選択肢を出し、先方コード・販売名・卸単価で選んでもらう。
   * keepCurrent は修正画面で開いたとき。単価・品名は変えずに、選び直せるよう選択肢だけ用意する。
   */
  const loadPartnerProducts = useCallback(
    async (key: number, partnerId: number, skuId: number, preferredId: number | null, keepCurrent = false) => {
      let list: PartnerProductChoice[];
      try {
        list = await api.get<PartnerProductChoice[]>('/masters/partner-products/lookup', { partner_id: partnerId, sku_id: skuId });
      } catch {
        return; /* 得意先別商品がなければ手入力 */
      }
      const choices = list.length > 1 ? list : undefined;
      const picked = list.find((x) => x.id === preferredId) ?? (list.length === 1 ? list[0] : undefined);
      const patch = (l: LineDraft): LineDraft => {
        if (keepCurrent || picked) return { ...l, pp_choices: choices };
        return {
          ...l,
          pp_choices: choices,
          partner_product_id: null,
          note: choices ? `この商品は得意先別商品が ${choices.length} 件あります。先方コード・単価を選んでください` : undefined,
        };
      };
      setD((s) => ({ ...s, lines: s.lines.map((l) => (l.key === key && l.sku?.id === skuId ? patch(l) : l)) }));
      if (picked && !keepCurrent) applyPartnerProduct(key, skuId, picked);
    },
    [applyPartnerProduct],
  );

  // 取引先を替えたときに明細の得意先別商品を引き直すため、今の入力を覚えておく
  const draftRef = useRef(d);
  useEffect(() => {
    draftRef.current = d;
  }, [d]);

  // 修正画面: 同じ SKU に得意先別商品が複数ある明細は、選び直せるよう選択肢を用意する（単価・品名は変えない）
  useEffect(() => {
    if (!initial?.partner) return;
    for (const l of initial.lines) {
      if (l.sku) void loadPartnerProducts(l.key, initial.partner.id, l.sku.id, l.partner_product_id, true);
    }
  }, [initial, loadPartnerProducts]);

  // 販売カテゴリーの初期値
  useEffect(() => {
    if (!d.sales_category_id && categories.data && categories.data.length > 0) {
      set('sales_category_id', String(categories.data[0].id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories.data]);

  // 取引先を選んだら納品先・取引条件・販売担当を引き継ぐ
  const onPartner = useCallback(async (o: Option | null) => {
    const prev = draftRef.current;
    setD((s) => {
      // 海外の得意先にしたら明細の税率を 0% に、海外から国内に戻したら商品の税率に戻す
      const toOverseas = isOverseasPartner(o);
      const fromOverseas = isOverseasPartner(s.partner);
      const taxed = toOverseas
        ? s.lines.map((l) => ({ ...l, tax_rate: '0.00' }))
        : fromOverseas
          ? s.lines.map((l) => ({ ...l, tax_rate: domesticRate(l) }))
          : s.lines;
      // 得意先別商品は取引先ごと。取引先を替えたら前の取引先の行を外す（下で新しい取引先の行を引き直す。M3-26）
      const changed = (o?.id ?? null) !== (s.partner?.id ?? null);
      const lines = changed ? taxed.map((l) => ({ ...l, partner_product_id: null, pp_choices: undefined, note: undefined })) : taxed;
      return { ...s, partner: o, delivery_destination_id: '', lines };
    });
    setDestinations([]);
    if (!o) return;
    if (o.id !== prev.partner?.id) {
      for (const l of prev.lines) {
        if (l.sku) void loadPartnerProducts(l.key, o.id, l.sku.id, null);
      }
    }
    const p = o.raw as PartnerRow;
    setD((s) => ({
      ...s,
      // 受注の取引条件は委託・買取の2つ。取引先の既定値が仕入先向けの「仕入」のときは持ち込まない
      trade_type: p.default_trade_type === '委託' || p.default_trade_type === '買取' ? p.default_trade_type : s.trade_type,
      // 取引先を変えたら販売担当も必ずその取引先の既定にそろえる（前の取引先の担当を残さない）
      sales_staff_id: p.sales_staff_id ? String(p.sales_staff_id) : '',
    }));
    try {
      const dests = await fetchDestinations(o.id);
      setDestinations(dests);
      if (dests.length === 1) {
        setD((s) => ({ ...s, delivery_destination_id: String(dests[0].id), ship_from_warehouse_id: dests[0].default_warehouse_id ? String(dests[0].default_warehouse_id) : s.ship_from_warehouse_id }));
      }
    } catch {
      /* 納品先なしでも入力は続けられる */
    }
  }, [loadPartnerProducts]);

  // 修正のときは納品先一覧を先に取る
  useEffect(() => {
    if (initial?.partner) void fetchDestinations(initial.partner.id).then(setDestinations).catch(() => undefined);
  }, [initial]);

  // 商品を選んだら得意先別商品の単価を引く
  // 選んでいる取引先の先方JAN・出荷JANでも商品を引けるようにする（取引先が変わったときだけ作り直す）
  const partnerId = d.partner?.id ?? null;
  const fetchSkusForPartner = useMemo(() => fetchSkusFor(partnerId), [partnerId]);

  const onSku = async (key: number, o: Option | null) => {
    if (!o) {
      setLine(key, { sku: null, partner_product_id: null, note: undefined, pp_choices: undefined });
      return;
    }
    const s = o.raw as SkuRow;
    // 品名は「SKU の商品名があればそれ、無ければ商品名」＋カラー＋サイズ（2026-10-09 マスター編②）
    const skuName = skuItemName(s);
    setLine(key, {
      sku: o,
      item_name: skuName,
      base_name: skuName,
      tax_rate: isOverseasPartner(d.partner) ? '0.00' : Number(s.tax_rate).toFixed(2),
      line_type: s.is_set ? 'セット商品' : '商品',
      partner_product_id: null,
      note: undefined,
      pp_choices: undefined,
    });
    // 先方JAN・先方の商品コードで探して選んだときは、当たった行を使う（partner_product_id。M3-26）
    if (d.partner && (s.partner_product_count ?? 1) > 0) await loadPartnerProducts(key, d.partner.id, o.id, s.partner_product_id ?? null);
  };

  const total = d.lines.reduce((a, l) => a + Number(l.qty || 0) * Number(l.unit_price || 0), 0);
  const isDirect = d.order_type === '直送' || d.order_type === '通販';

  const submit = async () => {
    setError(null);
    if (!d.partner) return setError(new ApiError(400, '取引先を選んでください'));
    if (d.order_type === '卸' && !d.delivery_destination_id) return setError(new ApiError(400, '卸の受注では納品先を選んでください'));
    if (d.lines.some((l) => ['商品', 'セット商品'].includes(l.line_type) && !l.sku)) return setError(new ApiError(400, '商品の行には商品を選んでください'));
    // 同じ商品に得意先別商品が複数ある行は、どれかを選んでから登録する（単価・販売名・出荷JAN が行で違うため。M3-26）
    const unpicked = d.lines.findIndex((l) => l.sku && l.pp_choices && l.pp_choices.length > 1 && !l.partner_product_id);
    if (unpicked >= 0) return setError(new ApiError(400, `${unpicked + 1}行目：この商品は得意先別商品（先方コード・単価）が複数あります。どれかを選んでください`));
    setBusy(true);
    try {
      const body = toBody(d);
      const r = orderId ? await api.patch<WriteResult>(`/orders/${orderId}`, body) : await api.post<WriteResult>('/orders', body);
      if (r.status === '引当待ち') {
        toast(`${r.order_no} を登録しました。在庫が足りないため引当待ちです（${r.shortages.join('、')}）`, 'info');
      } else {
        toast(`${r.order_no} を${orderId ? '修正' : '登録'}しました（${r.status}）`, 'good');
      }
      router.push(`/orders/${r.id}`);
    } catch (e) {
      setError(e);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-body">
      {error ? <ErrorBox error={error} onClose={() => setError(null)} /> : null}
      <div className="grid-split-sidebar">
        <div className="flex flex-col gap-3.5">
          <Card>
            <CardHead title={orderId ? '受注の修正' : '受注入力'} sub="取引先を選ぶと納品先・取引条件・販売担当がマスタから入ります" />
            <div className="master-grid-2 px-3.5">
              <FormRow label="受注区分" required>
                <Select value={d.order_type} onChange={(e) => set('order_type', e.target.value as OrderDraft['order_type'])} className="!w-[140px]">
                  {['卸', '直送', '通販', 'サンプル'].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
                {d.order_type === 'サンプル' && <span className="text-[10.5px] text-[var(--color-ink-3)]">売上・請求に計上しません</span>}
              </FormRow>
              <FormRow label="受注日" required>
                <Input type="date" value={d.order_date} onChange={(e) => set('order_date', e.target.value)} className="!w-[150px]" />
              </FormRow>
              <FormRow label="取引先" required>
                <SearchSelect value={d.partner} onChange={onPartner} fetchOptions={fetchCustomers} placeholder="取引先コード・名称で検索" width="100%" />
              </FormRow>
              {/* 通貨は取引先マスタの通貨で固定（2026-10-12 No.39）。円以外の取引先のときだけ出す */}
              {d.partner && !isYen(currency) && (
                <FormRow label="通貨">
                  <b className="num">{currency}</b>
                  <span className="text-[10.5px] text-[var(--color-ink-3)]">取引先の通貨です。単価・金額はこの通貨で入れます（変えるときは取引先マスタで）</span>
                </FormRow>
              )}
              <FormRow label="納品先" required={d.order_type === '卸'}>
                <Select value={d.delivery_destination_id} onChange={(e) => {
                  const id = e.target.value;
                  const dest = destinations.find((x) => String(x.id) === id);
                  setD((s) => ({ ...s, delivery_destination_id: id, ship_from_warehouse_id: dest?.default_warehouse_id ? String(dest.default_warehouse_id) : s.ship_from_warehouse_id }));
                }} disabled={!d.partner}>
                  <option value="">{d.partner ? (destinations.length ? '選んでください' : '納品先が登録されていません') : '先に取引先を選択してください'}</option>
                  {destinations.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.delivery_code}　{x.name}
                    </option>
                  ))}
                </Select>
              </FormRow>
              <FormRow label="販売カテゴリー" required>
                <Select value={d.sales_category_id} onChange={(e) => set('sales_category_id', e.target.value)} className="!w-[180px]">
                  {(categories.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </FormRow>
              <FormRow label="取引条件">
                <Select value={d.trade_type} onChange={(e) => set('trade_type', e.target.value as '委託' | '買取')} className="!w-[110px]">
                  <option>買取</option>
                  <option>委託</option>
                </Select>
              </FormRow>
              <FormRow label="販売担当">
                <Select value={d.sales_staff_id} onChange={(e) => set('sales_staff_id', e.target.value)} className="!w-[180px]">
                  <option value="">（なし）</option>
                  {(staff.data?.items ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </FormRow>
              <FormRow label="先方発注番号">
                <Input value={d.po_no} onChange={(e) => set('po_no', e.target.value)} className="!w-[200px]" />
              </FormRow>
              <FormRow label="出荷日">
                <Input type="date" value={d.ship_date} onChange={(e) => set('ship_date', e.target.value)} className="!w-[150px]" />
              </FormRow>
              <FormRow label="納品日">
                <Input type="date" value={d.delivery_date} onChange={(e) => set('delivery_date', e.target.value)} className="!w-[150px]" />
              </FormRow>
              <FormRow label="納品希望日">
                <Input type="date" value={d.requested_delivery_date} onChange={(e) => set('requested_delivery_date', e.target.value)} className="!w-[150px]" />
              </FormRow>
              <FormRow label="出荷倉庫" hint="空なら納品先の既定倉庫">
                <Select value={d.ship_from_warehouse_id} onChange={(e) => set('ship_from_warehouse_id', e.target.value)} className="!w-[180px]">
                  <option value="">（既定）</option>
                  {(warehouses.data ?? []).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.short_name}
                    </option>
                  ))}
                </Select>
              </FormRow>
            </div>
          </Card>

          {isDirect && (
            <Card>
              <CardHead title="お届け先（直送・通販）" sub="納品先マスタにない相手先に送るときに入力します" />
              <div className="master-grid-2 px-3.5">
                <FormRow label="お名前" required={d.order_type === '直送'}>
                  <Input value={d.direct_name} onChange={(e) => set('direct_name', e.target.value)} />
                </FormRow>
                <FormRow label="フリガナ">
                  <Input value={d.direct_kana} onChange={(e) => set('direct_kana', e.target.value)} />
                </FormRow>
                <FormRow label="郵便番号">
                  <Input value={d.direct_postal_code} onChange={(e) => set('direct_postal_code', e.target.value)} className="!w-[120px]" placeholder="1000001" />
                  <Button size="sm" onClick={async () => {
                    const code = d.direct_postal_code.replace(/[^0-9]/g, '');
                    if (code.length !== 7) return toast('郵便番号は7桁で入力してください', 'bad');
                    try {
                      const rows = await api.get<{ prefecture: string; city: string; town: string }[]>(`/postal-codes/${code}`);
                      if (rows.length === 0) return toast('該当する住所がありません', 'info');
                      const a = rows[0];
                      set('direct_address1', `${a.prefecture}${a.city}${a.town}`);
                      if (rows.length > 1) toast(`同じ郵便番号に ${rows.length} 件の町域があります。住所を確かめてください`, 'info');
                    } catch (e) {
                      toast(e instanceof Error ? e.message : '住所を引けませんでした', 'bad');
                    }
                  }}>
                    住所を引く
                  </Button>
                </FormRow>
                <FormRow label="電話番号">
                  <Input value={d.direct_tel} onChange={(e) => set('direct_tel', e.target.value)} className="!w-[160px]" />
                </FormRow>
                <FormRow label="住所1">
                  <Input value={d.direct_address1} onChange={(e) => set('direct_address1', e.target.value)} />
                </FormRow>
                <FormRow label="住所2">
                  <Input value={d.direct_address2} onChange={(e) => set('direct_address2', e.target.value)} />
                </FormRow>
              </div>
            </Card>
          )}

          <Card>
            <CardHead
              title="明細"
              sub="商品を選ぶと、得意先別商品マスタの単価・専用コードが自動で入ります"
              right={<Button size="sm" icon="plus" onClick={() => set('lines', [...d.lines, emptyLine()])}>行を追加</Button>}
            />
            <div className="tbl-wrap-wide">
              <table className="tbl tbl-form" style={{ minWidth: 1040 }}>
                <thead>
                  <tr>
                    <th className="c" style={{ width: 36 }}>行</th>
                    <th style={{ width: 110 }}>種別</th>
                    <th style={{ width: 280 }}>商品</th>
                    <th style={{ minWidth: 200 }}>品名</th>
                    <th className="r" style={{ width: 80 }}>数量</th>
                    <th className="r" style={{ width: 100 }}>単価</th>
                    <th className="c" style={{ width: 80 }}>税率</th>
                    <th className="r" style={{ width: 110 }}>金額</th>
                    <th style={{ width: 44 }} />
                  </tr>
                </thead>
                <tbody>
                  {d.lines.map((l, i) => {
                    const needsSku = l.line_type === '商品' || l.line_type === 'セット商品';
                    const pickedPp = l.pp_choices?.find((x) => x.id === l.partner_product_id);
                    return (
                      <tr key={l.key}>
                        <td className="c num">{i + 1}</td>
                        <td>
                          <Select
                            value={l.line_type}
                            onChange={(e) => {
                              const next = e.target.value as LineType;
                              // 商品でない種別にしたら得意先別商品の行も外す（商品を指さない明細が行を指したまま残らないように）
                              const goods = next === '商品' || next === 'セット商品';
                              setLine(l.key, { line_type: next, sku: needsSku ? l.sku : null, ...(goods ? {} : { partner_product_id: null, pp_choices: undefined }) });
                            }}
                          >
                            {LINE_TYPES.map((t) => (
                              <option key={t}>{t}</option>
                            ))}
                          </Select>
                        </td>
                        <td>
                          {needsSku ? (
                            <>
                              <SearchSelect value={l.sku} onChange={(o) => onSku(l.key, o)} fetchOptions={fetchSkusForPartner} placeholder={d.partner ? 'SKU・JAN・先方JAN・先方コード・商品名で検索' : 'SKU・JAN・商品名で検索'} width="100%" />
                              {/* 同じ商品にこの取引先の得意先別商品が複数あるときは、先方コード・販売名・卸単価で選ぶ（M3-26） */}
                              {l.sku && l.pp_choices && l.pp_choices.length > 1 && (
                                <Select
                                  value={l.partner_product_id ? String(l.partner_product_id) : ''}
                                  onChange={(e) => {
                                    const pp = l.pp_choices?.find((x) => String(x.id) === e.target.value);
                                    if (pp && l.sku) applyPartnerProduct(l.key, l.sku.id, pp);
                                  }}
                                  className="mt-1"
                                  title={pickedPp ? choiceLabel(pickedPp) : undefined}
                                >
                                  <option value="" disabled>得意先別商品を選ぶ（{l.pp_choices.length}件）</option>
                                  {l.pp_choices.map((pp) => (
                                    <option key={pp.id} value={pp.id}>{choiceLabel(pp)}</option>
                                  ))}
                                </Select>
                              )}
                            </>
                          ) : (
                            <span className="text-[11px] text-[var(--color-ink-3)]">—</span>
                          )}
                        </td>
                        <td>
                          <Input value={l.item_name} title={l.item_name} onChange={(e) => setLine(l.key, { item_name: e.target.value })} placeholder={needsSku ? '（商品名）' : l.line_type} />
                          {/* 長い品名は欄で切れて (W)・カラー・サイズが見えないので、欄の下に全文を出す（3回目の全面テスト） */}
                          {l.item_name.length > 18 && <div className="text-[10.5px] text-[var(--color-ink-2)] mt-0.5 whitespace-normal leading-snug">{l.item_name}</div>}
                          {/* 専用コード・出荷JAN は欄の下に出す（欄の右に並べると、はみ出して「…」になり読めなかった） */}
                          {l.note && <div className="text-[10.5px] text-[var(--color-brand-600)] mt-0.5 whitespace-normal">{l.note}</div>}
                        </td>
                        <td className="r">
                          <Input right value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} className="!w-[70px]" />
                        </td>
                        <td className="r">
                          <Input right value={l.unit_price} onChange={(e) => setLine(l.key, { unit_price: e.target.value })} className="!w-[90px]" />
                        </td>
                        <td className="c">
                          <Select value={overseas ? '0.00' : l.tax_rate} onChange={(e) => setLine(l.key, { tax_rate: e.target.value })} disabled={overseas} title={overseas ? `消費税免税区分が「${overseasLabel ?? ''}」の得意先は 0% です` : undefined} className="!w-[72px]">
                            <option value="10.00">10%</option>
                            <option value="8.00">8%</option>
                            <option value="0.00">0%</option>
                          </Select>
                        </td>
                        <td className="r num font-semibold">{moneyIn(Number(l.qty || 0) * Number(l.unit_price || 0), currency)}</td>
                        <td className="c">
                          <button type="button" className="btn btn-quiet !px-1.5 !h-6" onClick={() => set('lines', d.lines.filter((x) => x.key !== l.key))} aria-label="行を削除" disabled={d.lines.length === 1}>
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 mx-3.5 mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11.5px] bg-[#f4f7f8] border border-[var(--color-line)] rounded-md px-3 py-2">
              <span className="text-[var(--color-ink-3)]">明細</span>
              <b className="num">{d.lines.length} 行</b>
              <span className="text-[var(--color-ink-3)]">合計（税抜）</span>
              <b className="num">{moneyWithCurrency(total, currency)}</b>
              {overseas && (
                <>
                  <span className="text-[var(--color-ink-3)]">消費税</span>
                  <b>{overseasLabel ?? '0%'}</b>
                  {/* 「海外」ではなく取引先マスタの呼び方（消費税免税区分）で出す。国内の免税先もある（2026-10-18 受入 W1 N3） */}
                  <span className="text-[10.5px] text-[var(--color-ink-3)]">消費税免税区分が「{overseasLabel ?? ''}」の取引先のため税率 0%（請求書・納品書も同じ）</span>
                </>
              )}
              <span className="text-[var(--color-ink-3)]">送料調整</span>
              <Input right value={d.shipping_fee_adjustment} onChange={(e) => set('shipping_fee_adjustment', e.target.value)} className="!h-[24px] !w-[90px]" placeholder="自動" />
              <span className="text-[10.5px] text-[var(--color-ink-3)]">入れると自動計算の送料を上書きします（直送はここに入力）</span>
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-3.5">
          <Card>
            <CardHead title="備考" />
            <div className="p-3.5 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[10.5px] font-semibold text-[var(--color-ink-3)]">出荷備考（出荷指示書に印字）</span>
                <Textarea rows={3} value={d.shipping_remarks} onChange={(e) => set('shipping_remarks', e.target.value)} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10.5px] font-semibold text-[var(--color-ink-3)]">納品書備考（納品書に印字）</span>
                <Textarea rows={3} value={d.delivery_note_remarks} onChange={(e) => set('delivery_note_remarks', e.target.value)} />
              </label>
            </div>
          </Card>
          <Card>
            <div className="p-3.5 flex flex-col gap-2">
              <Button variant="primary" size="lg" loading={busy} onClick={submit}>
                {orderId ? '修正を保存する' : '登録して引き当てる'}
              </Button>
              <Button onClick={() => router.back()}>戻る</Button>
              <div className="text-[11px] text-[var(--color-ink-3)] leading-relaxed mt-1">
                登録した時点で在庫を引き当てます（有効在庫が減ります）。実在庫を超える数量は登録できません。有効在庫が足りない分は「引当待ち」になり、在庫が空いたあとに一覧から引き当て直せます。
              </div>
            </div>
          </Card>
        </div>
      </div>
      {/* 登録日・更新日（2026-10-16 マスター編3 M3-01）。修正のときだけ */}
      {orderId ? <RecordStamp table="sales_orders" id={orderId} /> : null}
    </div>
  );
}
