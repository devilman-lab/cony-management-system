'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import { plainDecimal } from '@/lib/format';
import { OrderForm, emptyOrder, emptyLine, partnerProductNote, type LineDraft, type LineType, type OrderDraft } from '@/components/orders/OrderForm';
import { ErrorBox, Loading } from '@/components/ui';

interface OrderDetail {
  id: number;
  status: string;
  order_type: OrderDraft['order_type'];
  /** サンプル・社内移動は取引先・販売カテゴリーが空のことがある（2026-10-13 受注処理編 O-02・O-14） */
  partner_id: number | null;
  partner_code: string | null;
  partner_name: string | null;
  partner_is_overseas?: boolean;
  /** 海外の得意先の消費税の表記（取引先の消費税免税区分、無ければシステム設定。2026-10-16 M3-07） */
  overseas_tax_label?: string | null;
  /** 受注の通貨（取引先の通貨で固定。2026-10-12 No.39） */
  currency?: string;
  delivery_destination_id: number | null;
  sales_category_id: number | null;
  trade_type: '委託' | '買取';
  sales_staff_id: number | null;
  po_no: string | null;
  order_date: string;
  ship_date: string | null;
  delivery_date: string | null;
  /** 納品時間（区分値 DELIVERY_TIME。O-03） */
  delivery_time_code_id?: number | null;
  ship_from_warehouse_id: number | null;
  /** 委託の入庫倉庫（O-12） */
  consignment_warehouse_id?: number | null;
  direct_name: string | null;
  direct_postal_code: string | null;
  direct_address1: string | null;
  direct_address2: string | null;
  direct_tel: string | null;
  shipping_remarks: string | null;
  delivery_note_remarks: string | null;
  shipping_fee_adjustment: string | null;
  /** 納品書に送料を記載する（O-10） */
  print_shipping_fee?: boolean;
  lines: {
    line_no: number;
    parent_line_no: number | null;
    line_type: LineType;
    sku_id: number | null;
    sku_code: string | null;
    /** SKU の品名（SKU の商品名か商品名＋カラー・サイズ）。商品の欄はこの名前で出す（受注入力と同じ） */
    sku_item_name?: string | null;
    /** マスタの品名（得意先別商品の販売名があれば販売名、無ければ SKU の名前。＋カラー＋サイズ。O-35 の入れ直し用） */
    master_item_name?: string | null;
    color_name?: string | null;
    size_name?: string | null;
    jan?: string | null;
    // 明細が使った得意先別商品の行（同じ SKU に複数あるときに選んだ行。2026-10-16 マスター編_3 M3-26）
    partner_product_id: number | null;
    partner_product_code: string | null;
    partner_jan: string | null;
    shipping_jan: string | null;
    item_name: string;
    qty: string;
    unit_price: string;
    tax_rate: string;
    /** 出荷依頼書適用・納品書適用（O-09） */
    shipping_note?: string | null;
    delivery_slip_note?: string | null;
  }[];
}

const s = (v: string | null | undefined) => v ?? '';
const idText = (v: number | null | undefined) => (v ? String(v) : '');

/**
 * 修正画面。受注を読み込んで入力画面と同じ形にする。
 * 返品の受注はマイナスで登録してあるので、数量を正の数にして出す（保存するとサーバーがまたマイナスにする。O-44）。
 */
export default function EditOrderPage() {
  const { id } = useParams<{ id: string }>();
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<OrderDetail>(`/orders/${id}`)
      .then((o) => {
        const base = emptyOrder();
        const isReturn = o.order_type === '返品';
        const lines: LineDraft[] = o.lines.map((l) => ({
          ...emptyLine(),
          line_type: l.line_type,
          // 取込で作った明細の種別（販促品・送料・値引・内訳商品）は、その行だけ選択肢に残す（O-11）
          orig_type: l.line_type,
          // 商品の欄は受注入力と同じ「商品コード　SKU の品名」。明細の品名（販売名）で出すと、得意先別商品の行を
          // 選び直しても古い販売名のまま残っていた（2026-10-19 受入 X2）。販売名は品名の欄に出る
          sku: l.sku_id
            ? {
                id: l.sku_id,
                label: `${l.sku_code ?? ''}　${l.sku_item_name || l.item_name}`,
                raw: { sku_id: l.sku_id, sku_code: l.sku_code, color_name: l.color_name ?? null, size_name: l.size_name ?? null, jan: l.jan ?? null },
              }
            : null,
          item_name: l.item_name,
          // 販売名の無い得意先別商品の行に選び直したときの品名（受注入力で SKU を選んだときと同じ）
          base_name: l.sku_item_name ?? undefined,
          master_name: l.sku_id ? (l.master_item_name ?? undefined) : undefined,
          // 入力欄には "3.00"・"1200.0000" ではなく "3"・"1200" で入れる（受注入力と同じ。数値には通さないので桁落ちしない）
          qty: plainDecimal(isReturn ? l.qty.replace(/^-/, '') : l.qty),
          unit_price: plainDecimal(l.unit_price),
          tax_rate: Number(l.tax_rate).toFixed(2),
          // 使っていた得意先別商品の行と、その先方コード・出荷JAN の補足（入力画面と同じ表示）
          partner_product_id: l.sku_id ? l.partner_product_id : null,
          note: l.sku_id && l.partner_product_id ? partnerProductNote(l) : undefined,
          shipping_note: s(l.shipping_note),
          delivery_slip_note: s(l.delivery_slip_note),
        }));
        // 内訳商品の親は行番号で返る。行番号は保存のときに付け直すので、行の key でつなぐ
        const keyByLineNo = new Map(o.lines.map((l, i) => [l.line_no, lines[i].key]));
        o.lines.forEach((l, i) => {
          if (l.parent_line_no) lines[i].parent_key = keyByLineNo.get(l.parent_line_no) ?? null;
        });
        setDraft({
          ...base,
          order_type: o.order_type,
          partner: o.partner_id
            ? { id: o.partner_id, label: o.partner_name ?? '', sub: o.partner_code ?? '', raw: { id: o.partner_id, is_overseas: o.partner_is_overseas ?? false, overseas_tax_label: o.overseas_tax_label ?? null, currency: o.currency ?? 'JPY' } }
            : null,
          delivery_destination_id: idText(o.delivery_destination_id),
          sales_category_id: idText(o.sales_category_id),
          trade_type: o.trade_type,
          sales_staff_id: idText(o.sales_staff_id),
          po_no: s(o.po_no),
          order_date: o.order_date,
          ship_date: s(o.ship_date),
          delivery_date: s(o.delivery_date),
          delivery_time_code_id: idText(o.delivery_time_code_id),
          ship_from_warehouse_id: idText(o.ship_from_warehouse_id),
          consignment_warehouse_id: idText(o.consignment_warehouse_id),
          direct_name: s(o.direct_name),
          direct_postal_code: s(o.direct_postal_code),
          direct_address1: s(o.direct_address1),
          direct_address2: s(o.direct_address2),
          direct_tel: s(o.direct_tel),
          shipping_remarks: s(o.shipping_remarks),
          delivery_note_remarks: s(o.delivery_note_remarks),
          // 「800.0000」ではなく「800」の形で欄に入れる（2026-10-20 受入テスト T4）
          shipping_fee_adjustment: o.shipping_fee_adjustment ? plainDecimal(o.shipping_fee_adjustment) : '',
          print_shipping_fee: o.print_shipping_fee === true,
          lines,
        });
      })
      .catch(setError);
  }, [id]);

  if (error) return <div className="page-body"><ErrorBox error={error} /></div>;
  if (!draft) return <Loading />;
  return <OrderForm initial={draft} orderId={Number(id)} />;
}
