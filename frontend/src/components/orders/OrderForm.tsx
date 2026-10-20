'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { api, ApiError } from '@/lib/api';
import { useCodes, useFetch, useSalesCategories, useSimpleMaster, useWarehouses, type Warehouse } from '@/lib/hooks';
import { isYen, moneyIn, moneyWithCurrency, plainDecimal, today } from '@/lib/format';
import { composeItemName } from '@/lib/item-name';
import { Button, Card, CardHead, ErrorBox, FormRow, Input, Select, Textarea } from '@/components/ui';
import { Icon } from '@/components/ui/Icon';
import { SearchSelect, fetchDestinations, fetchPartners, fetchSkusFor, skuItemName, type DestinationRow, type Option, type PartnerRow, type SkuRow } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';
import { RecordStamp } from '@/components/ui/RecordStamp';
import { ProductPicker, pickerItemName, pickerJan, type PickerRow } from './ProductPicker';

/**
 * 受注区分（2026-10-13 受注処理編 O-02）。
 * 受注入力で選べるのは 卸・直送・社内移動・サンプル・返品。通販は通販CSVの取込で作る受注の区分で、
 * 通販の受注を直すときだけ選択肢に出す。
 */
export type OrderType = '卸' | '直送' | '通販' | '社内移動' | 'サンプル' | '返品';
const ENTRY_TYPES: OrderType[] = ['卸', '直送', '社内移動', 'サンプル', '返品'];

/**
 * 明細の種別。受注入力で選べるのは 商品・セット商品・非商品（O-11）。
 * 販促品・送料・値引・内訳商品は取込で作る明細の種別で、その行を直すときだけ、その行の選択肢に残す。
 */
export type LineType = '商品' | 'セット商品' | '非商品' | '販促品' | '送料' | '値引' | '内訳商品';
const ENTRY_LINE_TYPES: LineType[] = ['商品', 'セット商品', '非商品'];
/** 商品（SKU）を選ぶ行の種別。ここはサーバーの SKU_REQUIRED（02-schema.sql の ck_sol_sku）と同じ */
const needsSku = (t: LineType) => t === '商品' || t === 'セット商品' || t === '内訳商品';
/**
 * 得意先別商品の行（単価・販売名）を当てる行か。内訳商品（取込で作るセットの構成品の行）は当てない。
 * 構成品の単価は 0 で、セット商品の行で請求する。卸単価を入れると二重に請求してしまう。
 */
const usesPartnerProduct = (t: LineType) => t === '商品' || t === 'セット商品';

export interface LineDraft {
  key: number;
  line_type: LineType;
  /** 取込で作った明細の元の種別（販促品・送料・値引・内訳商品）。その行だけ選択肢に残す（O-11） */
  orig_type?: LineType;
  /** 内訳商品の親（セット商品の行）の key。行番号は登録のときに付け直すので key で持つ */
  parent_key?: number | null;
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
  /** SKU の品名（販売名の無い行を選び直したときに戻す名前） */
  base_name?: string;
  /**
   * マスタの品名（得意先別商品の販売名があれば販売名、無ければ SKU の名前。＋カラー＋サイズ。O-01）。
   * 修正画面の「品名をマスタから入れ直す」で品名をこれにする（O-35）。
   */
  master_name?: string;
  /** 出荷依頼書適用・納品書適用（商品ごとの入力。O-09） */
  shipping_note: string;
  delivery_slip_note: string;
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
  order_type: OrderType;
  partner: Option | null;
  delivery_destination_id: string;
  sales_category_id: string;
  trade_type: '委託' | '買取';
  sales_staff_id: string;
  po_no: string;
  order_date: string;
  ship_date: string;
  delivery_date: string;
  /** 納品時間（区分値 DELIVERY_TIME）。納品希望日の欄の代わり（O-03）。空は指定なし */
  delivery_time_code_id: string;
  ship_from_warehouse_id: string;
  /** 委託の入庫倉庫（O-12） */
  consignment_warehouse_id: string;
  direct_name: string;
  direct_postal_code: string;
  direct_address1: string;
  direct_address2: string;
  direct_tel: string;
  shipping_remarks: string;
  delivery_note_remarks: string;
  shipping_fee_adjustment: string;
  /** 納品書に送料を記載する（O-10） */
  print_shipping_fee: boolean;
  lines: LineDraft[];
}

let keySeq = 1;

/** 取引先・納品先・販売カテゴリー・取引条件の欄を出すか。サンプルは出さない（O-14） */
const hasPartnerFields = (t: OrderType) => t !== 'サンプル';
/** 取引先・販売カテゴリーが必須か。社内移動は任意（O-02）、サンプルは欄なし */
const partnerRequired = (t: OrderType) => t !== 'サンプル' && t !== '社内移動';
/**
 * 納品先が必須か。卸だけ（サーバーの checkHeader と同じ）。直送・通販はお届け先へ送るので任意
 * （通販CSVの取込で作る受注には納品先が無い）。返品・社内移動も任意（O-02・O-44）
 */
const destinationRequired = (t: OrderType) => t === '卸';
/** 取引条件を選べるか。返品は買取に決まる（委託にすると返品額が請求から消えるため。サーバーの KAITORI_ONLY_TYPES） */
const tradeSelectable = (t: OrderType) => t !== '返品' && t !== 'サンプル';
/** お届け先の欄を出すか（直送・通販・サンプル・社内移動） */
const hasRecipient = (t: OrderType) => t === '直送' || t === '通販' || t === 'サンプル' || t === '社内移動';
/** お届け先のお名前が必須か（直送・サンプル。社内移動は納品先が無いときだけ） */
const recipientRequired = (t: OrderType) => t === '直送' || t === 'サンプル';

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
/** 得意先別商品の行を当てたときの品名。販売名があれば販売名＋カラー＋サイズ、無ければ SKU の品名（O-01） */
const partnerProductItemName = (l: LineDraft, pp: Pick<PartnerProductChoice, 'sales_name'>): string => {
  const raw = l.sku?.raw as Partial<SkuRow> | undefined;
  return pp.sales_name?.trim() ? composeItemName(pp.sales_name, raw?.color_name, raw?.size_name) : l.base_name || l.item_name;
};

export const emptyLine = (): LineDraft => ({
  key: keySeq++,
  line_type: '商品',
  sku: null,
  item_name: '',
  qty: '1',
  unit_price: '0',
  tax_rate: '10.00',
  partner_product_id: null,
  shipping_note: '',
  delivery_slip_note: '',
});

/** 行が空か（商品も品名も入っていない）。見出しの「絞り込んで選ぶ」は、最後の行が空ならそこから入れる */
const isBlankLine = (l: LineDraft) => !l.sku && !l.item_name.trim() && needsSku(l.line_type);

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
  delivery_time_code_id: '',
  ship_from_warehouse_id: '',
  consignment_warehouse_id: '',
  direct_name: '',
  direct_postal_code: '',
  direct_address1: '',
  direct_address2: '',
  direct_tel: '',
  shipping_remarks: '',
  delivery_note_remarks: '',
  shipping_fee_adjustment: '',
  print_shipping_fee: false,
  lines: [emptyLine()],
});

interface WriteResult {
  id: number;
  order_no: string;
  status: string;
  shipment_id: number | null;
  shortages: string[];
}

/** 倉庫マスタの1行（/masters/warehouses は全列を返す）。委託先・取引先の倉庫を見分けるのに使う */
type WarehouseRow = Warehouse & { is_consignment?: boolean; partner_id?: number | null };

const nn = (v: string) => (v.trim() === '' ? null : v.trim());

/**
 * 送る形にする。欄を出していない項目は空で送る（サンプルの取引先、卸のお届け先など）。
 * 納品希望日は送らない（納品時間に替えた。O-03。修正のときは今の値のまま残る）。
 * 委託は単価 0（O-12。サーバーでも 0 にする）。返品の数量は正の数のまま送る（サーバーがマイナスで登録する。O-44）。
 */
function toBody(d: OrderDraft) {
  const partnerFields = hasPartnerFields(d.order_type);
  const partner = partnerFields ? d.partner : null;
  const consignment = tradeSelectable(d.order_type) && d.trade_type === '委託';
  const recipient = hasRecipient(d.order_type);
  const lineNo = new Map(d.lines.map((l, i) => [l.key, i + 1]));
  return {
    order_type: d.order_type,
    partner_id: partner?.id ?? null,
    delivery_destination_id: partner && d.delivery_destination_id ? Number(d.delivery_destination_id) : null,
    sales_category_id: partnerFields && d.sales_category_id ? Number(d.sales_category_id) : null,
    trade_type: tradeSelectable(d.order_type) ? d.trade_type : '買取',
    sales_staff_id: d.sales_staff_id ? Number(d.sales_staff_id) : null,
    po_no: nn(d.po_no),
    order_date: d.order_date,
    ship_date: nn(d.ship_date),
    delivery_date: nn(d.delivery_date),
    delivery_time_code_id: d.delivery_time_code_id ? Number(d.delivery_time_code_id) : null,
    ship_from_warehouse_id: d.ship_from_warehouse_id ? Number(d.ship_from_warehouse_id) : null,
    consignment_warehouse_id: consignment && d.consignment_warehouse_id ? Number(d.consignment_warehouse_id) : null,
    direct_name: recipient ? nn(d.direct_name) : null,
    direct_postal_code: recipient ? (nn(d.direct_postal_code)?.replace(/[^0-9]/g, '') ?? null) : null,
    direct_address1: recipient ? nn(d.direct_address1) : null,
    direct_address2: recipient ? nn(d.direct_address2) : null,
    direct_tel: recipient ? nn(d.direct_tel) : null,
    shipping_remarks: nn(d.shipping_remarks),
    delivery_note_remarks: nn(d.delivery_note_remarks),
    // 委託は請求に載せない（送料も付けない）ので、送料の欄は出さず空で送る
    shipping_fee_adjustment: consignment ? null : nn(d.shipping_fee_adjustment),
    print_shipping_fee: consignment ? false : d.print_shipping_fee,
    lines: d.lines.map((l, i) => {
      const goods = needsSku(l.line_type);
      return {
        line_no: i + 1,
        parent_line_no: l.line_type === '内訳商品' && l.parent_key != null ? (lineNo.get(l.parent_key) ?? null) : null,
        line_type: l.line_type,
        sku_id: goods ? (l.sku?.id ?? null) : null,
        // 使った得意先別商品の行（同じ SKU に複数あるときは選んだ行。M3-26）。商品の無い行・取引先の無い受注は持たない
        partner_product_id: goods && l.sku && partner ? l.partner_product_id : null,
        // 得意先別商品に販売名が無いと undefined が入りうるので、必ず文字列として扱う
        item_name: (l.item_name ?? '').trim() || (goods ? l.sku?.label.split('　')[1] : '') || l.line_type,
        qty: l.qty.trim() || '0',
        unit_price: consignment ? '0' : l.unit_price.trim() || '0',
        tax_rate: l.tax_rate,
        shipping_note: nn(l.shipping_note),
        delivery_slip_note: nn(l.delivery_slip_note),
      };
    }),
  };
}

/**
 * 絞り込みのダイアログで選んだ行から作る SKU の選択（商品の欄に出す）。
 * 出荷JAN・専用コードは品名の下の補足に出るので、欄の右には出さない（狭い欄で商品コードが切れないように）
 */
const pickerOption = (r: PickerRow): Option => ({
  id: r.sku_id,
  label: `${r.sku_code}　${r.item_name}`,
  sub: r.is_set ? 'セット' : r.partner_product_id ? undefined : pickerJan(r) || undefined,
  raw: {
    sku_id: r.sku_id,
    sku_code: r.sku_code,
    jan: r.jan,
    product_name: r.product_name,
    sku_name: r.sku_name,
    is_set: r.is_set,
    tax_rate: r.tax_rate,
    color_name: r.color_name,
    size_name: r.size_name,
    partner_jan: r.partner_jan,
    shipping_jan: r.shipping_jan,
    partner_product_code: r.partner_product_code,
    partner_product_id: r.partner_product_id,
  } satisfies Partial<SkuRow>,
});

/**
 * 受注入力（登録・修正の両方）。
 * 取引先を選ぶと、納品先・取引条件・販売担当が取引先マスタから入る。
 * 商品を選ぶと、得意先別商品の単価と専用コードが自動で入る。
 * 登録しただけでは在庫は引き当てない（2026-10-13 受注処理編 O-06。受注一覧の「引当」で引き当てる）。
 */
export function OrderForm({ initial, orderId }: { initial?: OrderDraft; orderId?: number }) {
  const router = useRouter();
  const toast = useToast();
  const [d, setD] = useState<OrderDraft>(initial ?? emptyOrder());
  const [destinations, setDestinations] = useState<DestinationRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  /** 取引先に得意先別商品が1件も無いとき true（O-05 の案内を出す） */
  const [noRegistered, setNoRegistered] = useState(false);
  /** 絞り込みのダイアログ。target は「押した行」の key（見出しから開いたときは null） */
  const [picker, setPicker] = useState<{ target: number | null } | null>(null);
  const categories = useSalesCategories();
  const warehouses = useWarehouses();
  const staff = useSimpleMaster('sales_staff');
  const deliveryTimes = useCodes('DELIVERY_TIME');
  const fetchCustomers = useMemo(() => fetchPartners('customer'), []);
  // 海外の得意先の消費税の表記（免税（税抜扱い）／課税対象外）。取引先の消費税免税区分（取引先の検索結果の
  // overseas_tax_label）があればそれ、無ければシステム設定（2026-10-16 マスター編_3 M3-07）
  const overseasTax = useFetch<{ tax_rate: string; label: string }>('/orders/overseas-tax');

  const type = d.order_type;
  const partnerFields = hasPartnerFields(type);
  /** 受注に使う取引先（サンプルは取引先なし） */
  const partner = partnerFields ? d.partner : null;
  const overseas = isOverseasPartner(partner);
  const overseasLabel = (partner?.raw as { overseas_tax_label?: string | null } | undefined)?.overseas_tax_label ?? overseasTax.data?.label;
  const currency = partnerCurrency(partner);
  const consignment = tradeSelectable(type) && d.trade_type === '委託';
  const isReturn = type === '返品';
  const destination = destinations.find((x) => String(x.id) === d.delivery_destination_id) ?? null;
  const allWarehouses = (warehouses.data ?? []) as WarehouseRow[];

  const set = <K extends keyof OrderDraft>(k: K, v: OrderDraft[K]) => setD((s) => ({ ...s, [k]: v }));
  const setLine = (key: number, patch: Partial<LineDraft>) =>
    setD((s) => ({ ...s, lines: s.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));

  /**
   * 明細に得意先別商品の行を当てる。単価・品名（販売名＋カラー＋サイズ）・補足（先方コード・出荷JAN）がその行に従う。
   * 返事を待つ間に商品を選び直していたら当てない（skuId で確かめる）。
   */
  const applyPartnerProduct = useCallback((key: number, skuId: number, pp: PartnerProductChoice) => {
    setD((s) => ({
      ...s,
      lines: s.lines.map((l) => {
        if (l.key !== key || l.sku?.id !== skuId) return l;
        // 販売名が未登録（null・空）なら SKU の品名にする。undefined を入れると品名が失われ、
        // 送信時に item_name.trim() で落ちて受注が登録できなくなる。
        const name = partnerProductItemName(l, pp);
        return {
          ...l,
          // 得意先別の単価は "12.5000" の形で返るので、入力欄には "12.5" で入れる（再テスト R4）
          unit_price: plainDecimal(pp.unit_price),
          partner_product_id: pp.id,
          item_name: name,
          master_name: name,
          note: partnerProductNote(pp),
        };
      }),
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
          // この取引先に得意先別商品の行が無ければ、マスタの品名は SKU の品名
          master_name: l.base_name ?? l.master_name,
          note: choices ? `この商品は得意先別商品が ${choices.length} 件あります。先方コード・単価を選んでください` : undefined,
        };
      };
      setD((s) => ({ ...s, lines: s.lines.map((l) => (l.key === key && l.sku?.id === skuId ? patch(l) : l)) }));
      if (picked && !keepCurrent) applyPartnerProduct(key, skuId, picked);
    },
    [applyPartnerProduct],
  );

  /** 取引先に得意先別商品（使っている行）があるか。無ければ明細に案内を出す（O-05） */
  const checkRegistered = useCallback(async (partnerId: number | null) => {
    setNoRegistered(false);
    if (!partnerId) return;
    try {
      const rows = await api.get<SkuRow[]>('/masters/skus', { partner_id: partnerId, registered_only: 'true', limit: 1 });
      setNoRegistered(rows.length === 0);
    } catch {
      /* 分からないときは案内を出さない */
    }
  }, []);

  /** 委託の入庫倉庫の初期値。その取引先の倉庫（倉庫マスタの取引先）が1つならそれ（O-12） */
  const defaultConsignmentWarehouse = useCallback(
    (partnerId: number | null | undefined): string => {
      if (!partnerId) return '';
      const own = ((warehouses.data ?? []) as WarehouseRow[]).filter((w) => Number(w.partner_id) === partnerId);
      return own.length === 1 ? String(own[0].id) : '';
    },
    [warehouses.data],
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
      if (l.sku && usesPartnerProduct(l.line_type)) void loadPartnerProducts(l.key, initial.partner.id, l.sku.id, l.partner_product_id, true);
    }
  }, [initial, loadPartnerProducts]);

  // 販売カテゴリーの初期値（新しく入れるときだけ。修正で空の受注（社内移動）に勝手に入れない）
  useEffect(() => {
    if (!initial && !draftRef.current.sales_category_id && categories.data && categories.data.length > 0) {
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
    void checkRegistered(o?.id ?? null);
    if (!o) return;
    if (o.id !== prev.partner?.id) {
      for (const l of prev.lines) {
        if (l.sku && usesPartnerProduct(l.line_type)) void loadPartnerProducts(l.key, o.id, l.sku.id, null);
      }
    }
    const p = o.raw as PartnerRow;
    setD((s) => {
      // 受注の取引条件は委託・買取の2つ。取引先の既定値が仕入先向けの「仕入」のときは持ち込まない
      const trade = p.default_trade_type === '委託' || p.default_trade_type === '買取' ? p.default_trade_type : s.trade_type;
      return {
        ...s,
        trade_type: trade,
        // 委託の入庫倉庫は取引先ごと。取引先を替えたら、その取引先の倉庫（1つなら）に入れ直す（O-12）
        consignment_warehouse_id: trade === '委託' ? defaultConsignmentWarehouse(o.id) : s.consignment_warehouse_id,
        // 取引先を変えたら販売担当も必ずその取引先の既定にそろえる（前の取引先の担当を残さない）
        sales_staff_id: p.sales_staff_id ? String(p.sales_staff_id) : '',
      };
    });
    try {
      const dests = await fetchDestinations(o.id);
      setDestinations(dests);
      if (dests.length === 1) {
        setD((s) => ({ ...s, delivery_destination_id: String(dests[0].id), ship_from_warehouse_id: dests[0].default_warehouse_id ? String(dests[0].default_warehouse_id) : s.ship_from_warehouse_id }));
      }
    } catch {
      /* 納品先なしでも入力は続けられる */
    }
  }, [loadPartnerProducts, checkRegistered, defaultConsignmentWarehouse]);

  // 修正のときは納品先一覧を先に取る
  useEffect(() => {
    if (initial?.partner) void fetchDestinations(initial.partner.id).then(setDestinations).catch(() => undefined);
    void checkRegistered(initial?.partner?.id ?? null);
  }, [initial, checkRegistered]);

  /** 受注区分を替える。サンプルは取引先を持たない（O-14）ので、取引先・納品先を外す */
  const onType = (t: OrderType) => {
    set('order_type', t);
    if (!hasPartnerFields(t) && draftRef.current.partner) void onPartner(null);
  };

  /** 取引条件を替える。委託にしたら入庫倉庫の初期値を入れる（O-12） */
  const onTrade = (t: '委託' | '買取') =>
    setD((s) => ({
      ...s,
      trade_type: t,
      consignment_warehouse_id: t === '委託' && !s.consignment_warehouse_id ? defaultConsignmentWarehouse(s.partner?.id) : s.consignment_warehouse_id,
    }));

  // 商品の欄の候補。取引先を選んでいるときは、その取引先の得意先別商品に登録した SKU だけ（O-05）。
  // その取引先の先方JAN・出荷JAN・専用コードでも引ける（取引先が変わったときだけ作り直す）
  const partnerId = partner?.id ?? null;
  const fetchSkusForPartner = useMemo(() => fetchSkusFor(partnerId, { registeredOnly: true }), [partnerId]);

  const onSku = async (key: number, o: Option | null) => {
    if (!o) {
      setLine(key, { sku: null, partner_product_id: null, note: undefined, pp_choices: undefined, master_name: undefined });
      return;
    }
    const s = o.raw as SkuRow;
    // 品名は「SKU の商品名があればそれ、無ければ商品名」＋カラー＋サイズ（O-01。composeItemName）
    const skuName = skuItemName(s);
    setD((st) => ({
      ...st,
      lines: st.lines.map((l) =>
        l.key === key
          ? {
              ...l,
              sku: o,
              item_name: skuName,
              base_name: skuName,
              master_name: skuName,
              tax_rate: overseas ? '0.00' : Number(s.tax_rate).toFixed(2),
              // 内訳商品の行は内訳商品のまま（親のセット商品の行とのつながりを残す）
              line_type: l.line_type === '内訳商品' ? l.line_type : s.is_set ? 'セット商品' : '商品',
              partner_product_id: null,
              note: undefined,
              pp_choices: undefined,
            }
          : l,
      ),
    }));
    // 先方JAN・先方の商品コードで探して選んだときは、当たった行を使う（partner_product_id。M3-26）。内訳商品の行は当てない
    const breakdown = draftRef.current.lines.find((l) => l.key === key)?.line_type === '内訳商品';
    if (partner && !breakdown && (s.partner_product_count ?? 1) > 0) await loadPartnerProducts(key, partner.id, o.id, s.partner_product_id ?? null);
  };

  /**
   * 絞り込みのダイアログで選んだ商品を明細に入れる（O-04）。押した行に1つ目、その下に残りを行として足す。
   * 見出しから開いたときは、最後の行が空ならそこから、空でなければ末尾に足す。
   * 得意先別商品の行がそのまま決まる（単価・品名（販売名＋カラー＋サイズ）・先方コードの補足）。
   */
  const applyPicked = (target: number | null, picked: PickerRow[], all: PickerRow[]) => {
    if (picked.length === 0) return;
    const fill = (l: LineDraft, r: PickerRow): LineDraft => {
      const option = pickerOption(r);
      // 内訳商品の行は商品だけ入れ替える（得意先別商品の単価・販売名は当てない。usesPartnerProduct）
      if (l.line_type === '内訳商品') {
        return { ...l, sku: option, item_name: r.item_name, base_name: r.item_name, master_name: r.item_name, partner_product_id: null, note: undefined, pp_choices: undefined };
      }
      const name = pickerItemName(r);
      // 同じ SKU に得意先別商品が複数あれば、あとで行から選び直せるよう選択肢を持たせる（M3-26）
      const same = r.partner_product_id ? all.filter((x) => x.sku_id === r.sku_id && x.partner_product_id) : [];
      return {
        ...l,
        line_type: r.is_set ? 'セット商品' : '商品',
        sku: option,
        item_name: name,
        base_name: r.item_name,
        master_name: name,
        tax_rate: overseas ? '0.00' : Number(r.tax_rate).toFixed(2),
        partner_product_id: r.partner_product_id,
        unit_price: r.partner_product_id && r.unit_price != null ? plainDecimal(r.unit_price) : l.unit_price,
        note: r.partner_product_id ? partnerProductNote(r) : undefined,
        pp_choices:
          same.length > 1
            ? same.map((x) => ({
                id: x.partner_product_id as number,
                partner_product_code: x.partner_product_code,
                partner_jan: x.partner_jan,
                shipping_jan: x.shipping_jan,
                sales_name: x.sales_name,
                unit_price: x.unit_price ?? '0',
                retail_price: x.retail_price,
                note: null,
              }))
            : undefined,
      };
    };
    setD((s) => {
      const lines = [...s.lines];
      let at = target === null ? -1 : lines.findIndex((l) => l.key === target);
      if (at < 0) {
        const last = lines[lines.length - 1];
        if (last && isBlankLine(last)) at = lines.length - 1;
      }
      const [first, ...rest] = picked;
      const added = rest.map((r) => fill(emptyLine(), r));
      if (at < 0) return { ...s, lines: [...lines, fill(emptyLine(), first), ...added] };
      lines[at] = fill(lines[at], first);
      lines.splice(at + 1, 0, ...added);
      return { ...s, lines };
    });
    setPicker(null);
    toast(`${picked.length} 件の商品を明細に入れました`, 'good');
  };

  /** 同じ内容の行を1つ下に足す（O-08） */
  const copyLine = (key: number) =>
    setD((s) => {
      const i = s.lines.findIndex((l) => l.key === key);
      if (i < 0) return s;
      const copy: LineDraft = { ...s.lines[i], key: keySeq++ };
      return { ...s, lines: [...s.lines.slice(0, i + 1), copy, ...s.lines.slice(i + 1)] };
    });

  /** 修正画面: 商品のある行の品名をマスタの品名に入れ直す（O-35。保存は「修正を保存する」） */
  const reloadItemNames = () => {
    const targets = d.lines.filter((l) => l.sku && l.master_name && l.item_name !== l.master_name);
    if (targets.length === 0) {
      toast('商品のある行の品名は、すべてマスタの品名と同じです', 'info');
      return;
    }
    setD((s) => ({ ...s, lines: s.lines.map((l) => (l.sku && l.master_name ? { ...l, item_name: l.master_name } : l)) }));
    toast(`${targets.length} 行の品名をマスタから入れ直しました。「修正を保存する」で保存します`, 'good');
  };

  // 委託の入庫倉庫の選択肢。倉庫マスタの「委託先」を先に（O-12）。出荷倉庫（空なら当てる既定の倉庫）と同じ倉庫は出さない
  const shipFromId = d.ship_from_warehouse_id
    ? Number(d.ship_from_warehouse_id)
    : destination?.default_warehouse_id ?? (allWarehouses.find((w) => w.short_name === 'コニー倉庫') ?? allWarehouses[0])?.id ?? null;
  const consignmentChoices = allWarehouses.filter((w) => w.id !== shipFromId || String(w.id) === d.consignment_warehouse_id);
  const consignmentFirst = consignmentChoices.filter((w) => w.is_consignment);
  const consignmentOthers = consignmentChoices.filter((w) => !w.is_consignment);

  const lineAmount = (l: LineDraft) => (consignment ? 0 : Number(l.qty || 0) * Number(l.unit_price || 0)) * (isReturn ? -1 : 1);
  const total = d.lines.reduce((a, l) => a + lineAmount(l), 0);

  /** 登録前の確かめ。サーバーと同じ決まりを先に画面で見て、欄の近くの言葉で知らせる */
  const check = (): string | null => {
    if (partnerFields && partnerRequired(type) && !d.partner) return '取引先を選んでください';
    if (partnerFields && destinationRequired(type) && !d.delivery_destination_id) return `${type}の受注では納品先を選んでください`;
    if (partnerFields && partnerRequired(type) && !d.sales_category_id) return '販売カテゴリーを選んでください';
    if (recipientRequired(type) && !d.direct_name.trim()) return `${type}の受注ではお届け先のお名前を入れてください`;
    if (type === '社内移動' && !(partner && d.delivery_destination_id) && !d.direct_name.trim()) {
      return '社内移動の受注では、納品先を選ぶか、お届け先のお名前を入れてください';
    }
    if (consignment && !d.consignment_warehouse_id) return '委託の受注では入庫倉庫を選んでください';
    if (consignment && Number(d.consignment_warehouse_id) === shipFromId) return '入庫倉庫は出荷倉庫と別の倉庫を選んでください';
    for (const [i, l] of d.lines.entries()) {
      const no = i + 1;
      if (needsSku(l.line_type) && !l.sku) return `${no}行目：商品を選んでください`;
      if (l.line_type === '非商品' && !l.item_name.trim()) return `${no}行目：非商品の行は品名を入れてください`;
      if (l.line_type === '内訳商品' && !d.lines.some((x) => x.key === l.parent_key)) {
        return `${no}行目：内訳商品の親のセット商品の行がありません。この行も外すか、種別を「商品」にしてください`;
      }
      // 同じ商品に得意先別商品が複数ある行は、どれかを選んでから登録する（単価・販売名・出荷JAN が行で違うため。M3-26）
      if (l.sku && l.pp_choices && l.pp_choices.length > 1 && !l.partner_product_id) {
        return `${no}行目：この商品は得意先別商品（先方コード・単価）が複数あります。どれかを選んでください`;
      }
      if (isReturn && needsSku(l.line_type) && Number(l.qty) < 0) return `${no}行目：返品の数量は正の数で入れてください（マイナスで登録します）`;
    }
    return null;
  };

  const submit = async () => {
    setError(null);
    const problem = check();
    if (problem) {
      setError(new ApiError(400, problem));
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setBusy(true);
    try {
      const body = toBody(d);
      const r = orderId ? await api.patch<WriteResult>(`/orders/${orderId}`, body) : await api.post<WriteResult>('/orders', body);
      const done = orderId ? '修正しました' : '登録しました';
      if (r.status === '引当待ち' && r.shortages.length > 0) {
        toast(`${r.order_no} を${done}。在庫が足りない分は引当待ちです（${r.shortages.join('、')}）`, 'info');
      } else if (r.status === '引当待ち' || r.status === '未確定') {
        // 登録しただけでは引き当てない（O-06）。返品は在庫を押さえず、「引当」で引当済になる（O-44）
        toast(
          isReturn
            ? `${r.order_no} を${done}（引当待ち）。受注一覧で「引当」を押すと引当済になり、出荷確定・印刷に出ます（返品は在庫を押さえません）`
            : `${r.order_no} を${done}（引当待ち）。受注一覧で選んで「引当」を押すと在庫を引き当てます`,
          'good',
        );
      } else {
        toast(`${r.order_no} を${done}（${r.status}）`, 'good');
      }
      router.push(`/orders/${r.id}`);
    } catch (e) {
      setError(e);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBusy(false);
    }
  };

  const typeChoices: OrderType[] = ENTRY_TYPES.includes(type) ? ENTRY_TYPES : [...ENTRY_TYPES, type];
  const lineTypeChoices = (l: LineDraft): LineType[] =>
    l.orig_type && !ENTRY_LINE_TYPES.includes(l.orig_type) ? [...ENTRY_LINE_TYPES, l.orig_type] : ENTRY_LINE_TYPES;
  const workInstruction = destination && (destination.work_instruction_name || destination.work_instruction_body) ? destination : null;
  // 明細の列（委託は単価・金額の欄を出さない。O-12）
  const colCount = consignment ? 7 : 9;

  return (
    <div className="page-body">
      {error ? <ErrorBox error={error} onClose={() => setError(null)} /> : null}
      <div className="grid-split-sidebar">
        <div className="flex flex-col gap-3.5 min-w-0">
          <Card>
            <CardHead
              title={orderId ? '受注の修正' : '受注入力'}
              sub={partnerFields ? '取引先を選ぶと納品先・取引条件・販売担当がマスタから入ります' : 'サンプルは取引先を選ばず、お届け先を入れます（売上・請求に計上しません）'}
            />
            <div className="master-grid-2 px-3.5">
              <FormRow label="受注区分" required>
                <Stack>
                  <Select value={type} onChange={(e) => onType(e.target.value as OrderType)} className="!w-full max-w-[140px]" aria-label="受注区分">
                    {typeChoices.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </Select>
                  {(type === 'サンプル' || type === '社内移動') && <Note>売上・請求に計上しません</Note>}
                  {isReturn && <Note className="font-semibold !text-[var(--color-crit-500)]">マイナスで登録し、請求から差し引きます</Note>}
                </Stack>
              </FormRow>
              <FormRow label="受注日" required>
                <Input type="date" value={d.order_date} onChange={(e) => set('order_date', e.target.value)} className="!w-[150px]" />
              </FormRow>
              {partnerFields && (
                <>
                  <FormRow label="取引先" required={partnerRequired(type)}>
                    <SearchSelect value={d.partner} onChange={onPartner} fetchOptions={fetchCustomers} placeholder="取引先コード・名称で検索" width="100%" />
                  </FormRow>
                  <FormRow label="納品先" required={destinationRequired(type)}>
                    <Select
                      value={d.delivery_destination_id}
                      onChange={(e) => {
                        const id = e.target.value;
                        const dest = destinations.find((x) => String(x.id) === id);
                        setD((s) => ({ ...s, delivery_destination_id: id, ship_from_warehouse_id: dest?.default_warehouse_id ? String(dest.default_warehouse_id) : s.ship_from_warehouse_id }));
                      }}
                      disabled={!d.partner}
                      aria-label="納品先"
                    >
                      <option value="">{d.partner ? (destinations.length ? (destinationRequired(type) ? '選んでください' : '（なし）') : '納品先が登録されていません') : '先に取引先を選択してください'}</option>
                      {destinations.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.delivery_code}　{x.name}
                        </option>
                      ))}
                    </Select>
                  </FormRow>
                  {/* 納品先の作業指示（名称と本文）。読むだけ（O-07）。本文が長いので2列ぶんの幅で出す */}
                  {workInstruction && (
                    <div className="col-[1/-1]">
                      <FormRow label="作業指示">
                        <div className="flex flex-col gap-0.5 py-0.5 min-w-0 text-[12px] leading-[1.5]">
                          {workInstruction.work_instruction_name && <b className="text-[var(--color-ink)]">{workInstruction.work_instruction_name}</b>}
                          {workInstruction.work_instruction_body && (
                            <span className="whitespace-pre-wrap break-words text-[var(--color-ink-2)]">{workInstruction.work_instruction_body}</span>
                          )}
                        </div>
                      </FormRow>
                    </div>
                  )}
                  <FormRow label="販売カテゴリー" required={partnerRequired(type)}>
                    <Select value={d.sales_category_id} onChange={(e) => set('sales_category_id', e.target.value)} className="!w-[180px]" aria-label="販売カテゴリー">
                      {(!partnerRequired(type) || !d.sales_category_id) && <option value="">{partnerRequired(type) ? '選んでください' : '（なし）'}</option>}
                      {(categories.data ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </FormRow>
                  <FormRow label="取引条件">
                    {tradeSelectable(type) ? (
                      <Stack>
                        <Select value={d.trade_type} onChange={(e) => onTrade(e.target.value as '委託' | '買取')} className="!w-full max-w-[110px]" aria-label="取引条件">
                          <option>買取</option>
                          <option>委託</option>
                        </Select>
                        {consignment && <Note>単価なし（請求に載せません）</Note>}
                      </Stack>
                    ) : (
                      <Stack>
                        <b className="text-[12.5px]">買取</b>
                        <Note>返品は買取で登録します（請求から差し引くため）</Note>
                      </Stack>
                    )}
                  </FormRow>
                </>
              )}
              <FormRow label="販売担当">
                <Select value={d.sales_staff_id} onChange={(e) => set('sales_staff_id', e.target.value)} className="!w-[180px]" aria-label="販売担当">
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
              {/* 納品希望日の欄は納品時間に替えた（O-03。全受注処理共通） */}
              <FormRow label="納品時間">
                <Select value={d.delivery_time_code_id} onChange={(e) => set('delivery_time_code_id', e.target.value)} className="!w-[160px]" aria-label="納品時間">
                  <option value="">指定なし</option>
                  {(deliveryTimes.data?.values ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </FormRow>
              {/* 空のときの当て先はサーバー（allocation.service の resolveWarehouse）と同じ順（2026-10-19 受入 X1-1）。
                  説明は欄の下に出す（横に並べると、画面幅 1280 では1文字ずつの縦書きに潰れていた） */}
              <FormRow label="出荷倉庫">
                <Stack>
                  <Select value={d.ship_from_warehouse_id} onChange={(e) => set('ship_from_warehouse_id', e.target.value)} className="!w-full max-w-[180px]" aria-label="出荷倉庫">
                    <option value="">（既定）</option>
                    {allWarehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.short_name}
                      </option>
                    ))}
                  </Select>
                  <Note>空なら納品先の既定倉庫。納品先に既定が無ければコニー倉庫</Note>
                </Stack>
              </FormRow>
              {/* 通貨は取引先マスタの通貨で固定（2026-10-12 No.39）。円以外の取引先のときだけ出す */}
              {partner && !isYen(currency) && (
                <FormRow label="通貨">
                  <Stack>
                    <b className="num">{currency}</b>
                    <Note>取引先の通貨です。単価・金額はこの通貨で入れます（変えるときは取引先マスタで）</Note>
                  </Stack>
                </FormRow>
              )}
              {/* 委託の入庫倉庫（O-12）。出荷倉庫の下に出す（出荷確定で出荷倉庫からこの倉庫へ在庫が移る） */}
              {consignment && (
                <div className={partner && !isYen(currency) ? '' : 'min-[1024px]:col-start-2'}>
                  <FormRow label="入庫倉庫" required>
                    <Stack>
                    <Select value={d.consignment_warehouse_id} onChange={(e) => set('consignment_warehouse_id', e.target.value)} className="!w-full max-w-[180px]" aria-label="入庫倉庫">
                      <option value="">選んでください</option>
                      {consignmentFirst.length > 0 && (
                        <optgroup label="委託先の倉庫">
                          {consignmentFirst.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.short_name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {consignmentOthers.length > 0 && (
                        <optgroup label={consignmentFirst.length > 0 ? 'そのほかの倉庫' : '倉庫'}>
                          {consignmentOthers.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.short_name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </Select>
                    <Note>委託先の倉庫。出荷確定で出荷倉庫からこの倉庫へ在庫が移ります</Note>
                    </Stack>
                  </FormRow>
                </div>
              )}
            </div>
          </Card>

          {hasRecipient(type) && (
            <Card>
              <CardHead
                title="お届け先"
                sub={
                  type === 'サンプル'
                    ? 'サンプルを送る相手先を入力します'
                    : type === '社内移動'
                      ? '納品先を選ばないときは、送り先のお名前を入れてください'
                      : '納品先マスタにない相手先に送るときに入力します'
                }
              />
              <div className="master-grid-2 px-3.5">
                {/* フリガナの欄は出さない（O-13。列は残す） */}
                <FormRow label="お名前" required={recipientRequired(type) || (type === '社内移動' && !d.delivery_destination_id)}>
                  <Input value={d.direct_name} onChange={(e) => set('direct_name', e.target.value)} aria-label="お名前" />
                </FormRow>
                <FormRow label="電話番号">
                  <Input value={d.direct_tel} onChange={(e) => set('direct_tel', e.target.value)} className="!w-[160px]" />
                </FormRow>
                {/* 住所1・住所2 を横に並べるため、郵便番号は1行に置く */}
                <div className="col-[1/-1]">
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
                </div>
                <FormRow label="住所1">
                  <Input value={d.direct_address1} onChange={(e) => set('direct_address1', e.target.value)} />
                </FormRow>
                <FormRow label="住所2">
                  <Input value={d.direct_address2} onChange={(e) => set('direct_address2', e.target.value)} />
                </FormRow>
              </div>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-3.5 max-[1024px]:order-last">
          <Card>
            <CardHead title="備考" />
            <div className="p-3.5 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[10.5px] font-semibold text-[var(--color-ink-3)]">出荷依頼書備考（出荷依頼書に印字）</span>
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
                {orderId ? '修正を保存する' : '登録する'}
              </Button>
              <Button onClick={() => router.back()}>戻る</Button>
              {/* 登録しただけでは引き当てない（O-06。設定 ALLOCATION_TIMING=manual） */}
              <div className="text-[11px] text-[var(--color-ink-3)] leading-relaxed mt-1">
                {orderId
                  ? '引当済の受注を直すと、いったん引当を戻して引き当て直します（足りない分は引当待ち）。まだ引き当てていない受注は、保存しても引き当てません。'
                  : '登録しただけでは在庫は引き当てません。受注一覧で選んで「引当」を押すと引き当てます（足りない分は引当待ちのまま）。'}
              </div>
            </div>
          </Card>
        </div>

        {/* 明細は列が多いので、画面の幅いっぱいに出す（2026-10-13 受注処理編。出荷依頼書適用・納品書適用・コピーを足した） */}
        <Card className="col-[1/-1] min-w-0">
          <CardHead
            title="明細"
            sub={
              partner
                ? '商品の欄は、この取引先の得意先別商品に登録した商品から選べます。単価・専用コードは得意先別商品マスタから入ります'
                : 'すべての商品から選べます（取引先が無い受注）'
            }
            right={
              <>
                <Button size="sm" icon="filter" onClick={() => setPicker({ target: null })}>
                  絞り込んで選ぶ
                </Button>
                {orderId && (
                  <Button size="sm" icon="refresh" onClick={reloadItemNames} title="商品のある行の品名を、マスタの品名（販売名＋カラー＋サイズ）に入れ直します">
                    品名をマスタから入れ直す
                  </Button>
                )}
                <Button size="sm" icon="plus" onClick={() => set('lines', [...d.lines, emptyLine()])}>
                  行を追加
                </Button>
              </>
            }
          />
          {partner && noRegistered && (
            <div className="mx-3.5 mt-3 rounded-md border border-[#e8c88a] bg-[#fbf3e2] text-[#7a5407] px-3 py-2 text-[12px]">
              この取引先の得意先別商品が登録されていません（得意先別商品マスタで登録してください）
            </div>
          )}
          {/* 返品は数量を正の数で入れる（サーバーがマイナスで登録する。O-44・O-45） */}
          {isReturn && (
            <div className="mx-3.5 mt-3 rounded-md border border-[#e8b4a8] bg-[var(--color-crit-50)] text-[var(--color-crit-500)] px-3 py-2 text-[12px] leading-relaxed">
              <b>返品</b>：数量は返品の数を入れます（マイナスで登録され、請求から差し引かれます）。
              在庫に戻すときは<Link href="/adjustments" className="underline mx-0.5">在庫調整</Link>（理由：返品）で入れてください。
            </div>
          )}
          {/* 画面幅 1280 でも横に流れないよう、セルの左右の余白を詰める（列が増えたため） */}
          <div className="tbl-wrap-wide">
            <table className="tbl tbl-form [&_td]:!px-1.5 [&_th]:!px-1.5" style={{ minWidth: consignment ? 800 : 980 }}>
              <thead>
                <tr>
                  <th className="c" style={{ width: 30 }}>行</th>
                  <th style={{ width: 106 }}>種別</th>
                  <th style={{ width: 246 }}>商品</th>
                  <th>品名</th>
                  <th className="r" style={{ width: 72 }}>{isReturn ? '返品数' : '数量'}</th>
                  {!consignment && <th className="r" style={{ width: 92 }}>単価</th>}
                  <th className="c" style={{ width: 76 }}>税率</th>
                  {!consignment && <th className="r" style={{ width: 88 }}>金額</th>}
                  <th className="c" style={{ width: 84 }} />
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l, i) => {
                  const goods = needsSku(l.line_type);
                  const pickedPp = l.pp_choices?.find((x) => x.id === l.partner_product_id);
                  return [
                    <tr key={l.key} className="[&>td]:!border-b-0">
                      <td className="c num">{i + 1}</td>
                      <td>
                        <Select
                          value={l.line_type}
                          aria-label={`${i + 1}行目の種別`}
                          onChange={(e) => {
                            const next = e.target.value as LineType;
                            // 商品でない種別にしたら商品と得意先別商品の行を外す（商品を指さない明細が行を指したまま残らないように）
                            setLine(l.key, needsSku(next) ? { line_type: next } : { line_type: next, sku: null, partner_product_id: null, pp_choices: undefined, note: undefined });
                          }}
                        >
                          {lineTypeChoices(l).map((t) => (
                            <option key={t}>{t}</option>
                          ))}
                        </Select>
                      </td>
                      <td>
                        {goods ? (
                          <>
                            <SearchSelect value={l.sku} onChange={(o) => onSku(l.key, o)} fetchOptions={fetchSkusForPartner} placeholder={partner ? 'SKU・JAN・先方JAN・先方コード・商品名で検索' : 'SKU・JAN・商品名で検索'} width="100%" />
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
                          <span className="text-[11px] text-[var(--color-ink-3)]">{l.line_type === '非商品' ? '（商品なし。品名を入れてください）' : '—'}</span>
                        )}
                      </td>
                      <td>
                        <Input
                          value={l.item_name}
                          title={l.item_name}
                          onChange={(e) => setLine(l.key, { item_name: e.target.value })}
                          placeholder={goods ? '（商品名）' : l.line_type === '非商品' ? '品名を入れてください（必須）' : l.line_type}
                          aria-label={`${i + 1}行目の品名`}
                        />
                        {/* 長い品名は欄で切れて (W)・カラー・サイズが見えないので、欄の下に全文を出す（3回目の全面テスト） */}
                        {l.item_name.length > 18 && <div className="text-[10.5px] text-[var(--color-ink-2)] mt-0.5 whitespace-normal leading-snug">{l.item_name}</div>}
                        {/* 専用コード・出荷JAN は欄の下に出す（欄の右に並べると、はみ出して「…」になり読めなかった） */}
                        {l.note && <div className="text-[10.5px] text-[var(--color-brand-600)] mt-0.5 whitespace-normal">{l.note}</div>}
                      </td>
                      <td className="r">
                        <Input right value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} aria-label={`${i + 1}行目の数量`} />
                      </td>
                      {!consignment && (
                        <td className="r">
                          <Input right value={l.unit_price} onChange={(e) => setLine(l.key, { unit_price: e.target.value })} aria-label={`${i + 1}行目の単価`} />
                        </td>
                      )}
                      <td className="c">
                        <Select value={overseas ? '0.00' : l.tax_rate} onChange={(e) => setLine(l.key, { tax_rate: e.target.value })} disabled={overseas} title={overseas ? `消費税免税区分が「${overseasLabel ?? ''}」の得意先は 0% です` : undefined}>
                          <option value="10.00">10%</option>
                          <option value="8.00">8%</option>
                          <option value="0.00">0%</option>
                        </Select>
                      </td>
                      {!consignment && <td className="r num font-semibold">{moneyIn(lineAmount(l), currency)}</td>}
                      <td className="c whitespace-nowrap">
                        <button type="button" className="btn btn-quiet btn-sm !px-1.5" onClick={() => copyLine(l.key)} title="同じ内容の行を1つ下に足します">
                          コピー
                        </button>
                        <button type="button" className="btn btn-quiet !px-1.5 !h-6" onClick={() => set('lines', d.lines.filter((x) => x.key !== l.key))} aria-label="行を削除" disabled={d.lines.length === 1}>
                          ×
                        </button>
                      </td>
                    </tr>,
                    // 下の段：絞り込んで選ぶ・出荷依頼書適用・納品書適用（O-04・O-09）
                    <tr key={`${l.key}-sub`} className="[&>td]:!pt-0">
                      <td />
                      <td />
                      <td>
                        {goods && (
                          <button type="button" className="btn btn-quiet btn-sm !h-[24px] !px-1.5 !text-[11.5px] text-[var(--color-brand-700)]" onClick={() => setPicker({ target: l.key })}>
                            <Icon name="filter" size={12} />
                            絞り込んで選ぶ
                          </button>
                        )}
                      </td>
                      <td colSpan={colCount - 3}>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[10.5px] font-semibold text-[var(--color-ink-3)] whitespace-nowrap">出荷依頼書適用</span>
                          <Input value={l.shipping_note} onChange={(e) => setLine(l.key, { shipping_note: e.target.value })} maxLength={200} className="!h-[26px] !text-[12px] min-w-0 flex-1" aria-label={`${i + 1}行目の出荷依頼書適用`} />
                          <span className="text-[10.5px] font-semibold text-[var(--color-ink-3)] whitespace-nowrap ml-1">納品書適用</span>
                          <Input value={l.delivery_slip_note} onChange={(e) => setLine(l.key, { delivery_slip_note: e.target.value })} maxLength={200} className="!h-[26px] !text-[12px] min-w-0 flex-1" aria-label={`${i + 1}行目の納品書適用`} />
                        </div>
                      </td>
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 mx-3.5 mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11.5px] bg-[#f4f7f8] border border-[var(--color-line)] rounded-md px-3 py-2">
            <span className="text-[var(--color-ink-3)]">明細</span>
            <b className="num">{d.lines.length} 行</b>
            {consignment ? (
              <span className="text-[var(--color-ink-3)]">委託のため単価・金額はありません（0 円で登録し、請求には載せません）</span>
            ) : (
              <>
                <span className="text-[var(--color-ink-3)]">{isReturn ? '返品の合計（税抜）' : '合計（税抜）'}</span>
                <b className={`num ${isReturn ? 'text-[var(--color-crit-500)]' : ''}`}>{moneyWithCurrency(total, currency)}</b>
              </>
            )}
            {overseas && (
              <>
                <span className="text-[var(--color-ink-3)]">消費税</span>
                <b>{overseasLabel ?? '0%'}</b>
                {/* 「海外」ではなく取引先マスタの呼び方（消費税免税区分）で出す。国内の免税先もある（2026-10-18 受入 W1 N3） */}
                <span className="text-[10.5px] text-[var(--color-ink-3)]">消費税免税区分が「{overseasLabel ?? ''}」の取引先のため税率 0%（請求書・納品書も同じ）</span>
              </>
            )}
            {!consignment && (
              <>
                <span className="text-[var(--color-ink-3)]">送料調整</span>
                <Input right value={d.shipping_fee_adjustment} onChange={(e) => set('shipping_fee_adjustment', e.target.value)} className="!h-[24px] !w-[90px]" placeholder="自動" aria-label="送料調整" />
                {/* 納品書に送料を記載するか（O-10）。請求の送料はチェックに関係なく今までどおり */}
                <label className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--color-ink-2)] cursor-pointer">
                  <input type="checkbox" checked={d.print_shipping_fee} onChange={(e) => set('print_shipping_fee', e.target.checked)} />
                  納品書に送料を記載する
                </label>
                <span className="text-[10.5px] text-[var(--color-ink-3)]">送料調整を入れると自動計算の送料を上書きします（直送はここに入力）</span>
              </>
            )}
          </div>
        </Card>
      </div>
      <ProductPicker
        open={picker !== null}
        partnerId={partnerId}
        partnerName={partner?.label ?? null}
        onClose={() => setPicker(null)}
        onPick={(picked, all) => applyPicked(picker?.target ?? null, picked, all)}
      />
      {/* 登録日・更新日（2026-10-16 マスター編3 M3-01）。修正のときだけ */}
      {orderId ? <RecordStamp table="sales_orders" id={orderId} /> : null}
    </div>
  );
}

/**
 * 欄と、その下の説明を縦に積む。画面幅 1280 では1つの欄の幅が 170px ほどしかなく、
 * 説明を欄の横に並べると1文字ずつの縦書きに潰れていた。
 */
function Stack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-0.5 min-w-0 w-full">{children}</div>;
}

function Note({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`text-[10.5px] leading-snug text-[var(--color-ink-3)] ${className}`}>{children}</span>;
}
