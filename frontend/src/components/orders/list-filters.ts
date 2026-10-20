/**
 * 受注一覧（2026-10-13 受注処理編 O-15〜O-22）の絞り込みの形と、API（GET /order-list）へ渡す形。
 * 一覧の画面・表・列の絞り込みで共通に使う。
 */

/** 一覧の1行（GET /order-list）。取引先・販売カテゴリーは空のことがある（サンプル・社内移動） */
export interface OrderRow {
  id: number;
  order_no: string;
  order_type: string;
  status: string;
  is_cancelled: boolean;
  is_billable: boolean;
  po_no: string | null;
  partner_id: number | null;
  partner_code: string | null;
  partner_name: string | null;
  delivery_destination_id: number | null;
  delivery_code: string | null;
  /** 納品先名。納品先が無い受注はお届け先のお名前 */
  delivery_name: string | null;
  direct_name: string | null;
  sales_category_id: number | null;
  sales_category_name: string | null;
  sales_staff_id: number | null;
  staff_name: string | null;
  /** 返品はマイナス */
  total_amount: string;
  currency: string;
  ship_date: string | null;
  delivery_date: string | null;
  delivery_time_code_id: number | null;
  delivery_time_name: string | null;
  shipping_remarks: string | null;
  delivery_note_remarks: string | null;
  shipment_id: number | null;
  shipment_status: string | null;
  /** 明細を表示のとき（with_lines） */
  lines?: OrderLine[];
}

export interface OrderLine {
  id: number;
  line_no: number;
  parent_line_no: number | null;
  line_type: string;
  sku_code: string | null;
  item_name: string;
  color_name: string | null;
  size_name: string | null;
  /** 出荷依頼書・納品書と同じ JAN（得意先別商品の出荷JAN、空ならコニーJAN） */
  jan: string | null;
  qty: string;
  unit_price: string;
  amount: string;
  shipping_note: string | null;
  delivery_slip_note: string | null;
}

/** 一覧のまま直す内容（PATCH /order-list/:id。O-22） */
export interface OrderPatch {
  ship_date?: string | null;
  delivery_date?: string | null;
  delivery_time_code_id?: number | null;
  shipping_remarks?: string | null;
  delivery_note_remarks?: string | null;
  lines?: { id: number; shipping_note?: string | null; delivery_slip_note?: string | null }[];
}

/** 値の一覧で絞る列（O-20） */
export type ValueField = 'type' | 'partner' | 'destination' | 'category' | 'staff' | 'status';

export interface Facet {
  value: string;
  label: string;
  code?: string | null;
  count: number;
}

/**
 * 絞り込み。値の一覧は null＝絞り込まない（すべて）。取引先などの値は ID の文字と 'none'（値が空）。
 * 出荷日・納品日は範囲（空はその側を決めない）。
 */
export interface OrderFilters {
  q: string;
  status: string[] | null;
  order_type: string[] | null;
  partner: string[] | null;
  destination: string[] | null;
  category: string[] | null;
  staff: string[] | null;
  ship_from: string;
  ship_to: string;
  delivery_from: string;
  delivery_to: string;
  include_cancelled: boolean;
}

/** 列と絞り込みの項目の対応 */
export const FIELD_KEY: Record<ValueField, 'status' | 'order_type' | 'partner' | 'destination' | 'category' | 'staff'> = {
  type: 'order_type',
  partner: 'partner',
  destination: 'destination',
  category: 'category',
  staff: 'staff',
  status: 'status',
};

export const FIELD_TITLE: Record<ValueField, string> = {
  type: '区分',
  partner: '取引先',
  destination: '納品先',
  category: '販売カテゴリー',
  staff: '販売担当',
  status: '状態',
};

/** 既定の表示は 引当待ち と 引当済 だけ（O-18） */
export const DEFAULT_STATUS = ['引当待ち', '引当済'];

export function defaultFilters(): OrderFilters {
  return {
    q: '',
    status: [...DEFAULT_STATUS],
    order_type: null,
    partner: null,
    destination: null,
    category: null,
    staff: null,
    ship_from: '',
    ship_to: '',
    delivery_from: '',
    delivery_to: '',
    include_cancelled: false,
  };
}

/** API へ渡す絞り込み（GET /order-list・/order-list/facets 共通） */
export function filterQuery(f: OrderFilters): Record<string, string | undefined> {
  const list = (v: string[] | null) => (v && v.length > 0 ? v.join(',') : undefined);
  return {
    q: f.q.trim() || undefined,
    status: list(f.status),
    order_type: list(f.order_type),
    partner_ids: list(f.partner),
    destination_ids: list(f.destination),
    sales_category_ids: list(f.category),
    sales_staff_ids: list(f.staff),
    ship_from: f.ship_from || undefined,
    ship_to: f.ship_to || undefined,
    delivery_from: f.delivery_from || undefined,
    delivery_to: f.delivery_to || undefined,
    include_cancelled: f.include_cancelled ? 'true' : undefined,
  };
}

/** 並び順を問わずに同じ絞り込みか */
export function sameFilters(a: OrderFilters, b: OrderFilters): boolean {
  const norm = (f: OrderFilters) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries({ ...f, q: f.q.trim() }).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v]),
      ),
    );
  return norm(a) === norm(b);
}

/** 保存しておいた絞り込みを読み戻す（形が合わないものは既定に戻す） */
export function restoreFilters(raw: unknown): OrderFilters | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const base = defaultFilters();
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const arr = (v: unknown): string[] | null =>
    Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  return {
    q: str(r.q),
    status: 'status' in r ? arr(r.status) : base.status,
    order_type: arr(r.order_type),
    partner: arr(r.partner),
    destination: arr(r.destination),
    category: arr(r.category),
    staff: arr(r.staff),
    ship_from: str(r.ship_from),
    ship_to: str(r.ship_to),
    delivery_from: str(r.delivery_from),
    delivery_to: str(r.delivery_to),
    include_cancelled: r.include_cancelled === true,
  };
}

/** 一覧の行で引当を選べるか（まだ引き当てていない受注だけ。O-19） */
export function canSelectForAllocation(r: OrderRow): boolean {
  return !r.is_cancelled && (r.status === '引当待ち' || r.status === '未確定');
}
