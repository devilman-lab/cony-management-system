'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import { OrderForm, emptyOrder, emptyLine, partnerProductNote, type OrderDraft } from '@/components/orders/OrderForm';
import { ErrorBox, Loading } from '@/components/ui';

interface OrderDetail {
  id: number;
  status: string;
  order_type: OrderDraft['order_type'];
  partner_id: number;
  partner_code: string;
  partner_name: string;
  partner_is_overseas?: boolean;
  /** 海外の得意先の消費税の表記（取引先の消費税免税区分、無ければシステム設定。2026-10-16 M3-07） */
  overseas_tax_label?: string | null;
  /** 受注の通貨（取引先の通貨で固定。2026-10-12 No.39） */
  currency?: string;
  delivery_destination_id: number | null;
  sales_category_id: number;
  trade_type: '委託' | '買取';
  sales_staff_id: number | null;
  po_no: string | null;
  order_date: string;
  ship_date: string | null;
  delivery_date: string | null;
  requested_delivery_date: string | null;
  ship_from_warehouse_id: number | null;
  direct_name: string | null;
  direct_kana: string | null;
  direct_postal_code: string | null;
  direct_address1: string | null;
  direct_address2: string | null;
  direct_tel: string | null;
  shipping_remarks: string | null;
  delivery_note_remarks: string | null;
  shipping_fee_adjustment: string | null;
  lines: {
    line_type: OrderDraft['lines'][number]['line_type'] | '内訳商品';
    sku_id: number | null;
    sku_code: string | null;
    // 明細が使った得意先別商品の行（同じ SKU に複数あるときに選んだ行。2026-10-16 マスター編_3 M3-26）
    partner_product_id: number | null;
    partner_product_code: string | null;
    partner_jan: string | null;
    shipping_jan: string | null;
    item_name: string;
    qty: string;
    unit_price: string;
    tax_rate: string;
  }[];
}

const s = (v: string | null | undefined) => v ?? '';

/** 修正画面。受注を読み込んで入力画面と同じ形にする。 */
export default function EditOrderPage() {
  const { id } = useParams<{ id: string }>();
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<OrderDetail>(`/orders/${id}`)
      .then((o) => {
        const base = emptyOrder();
        setDraft({
          ...base,
          order_type: o.order_type,
          partner: { id: o.partner_id, label: o.partner_name, sub: o.partner_code, raw: { id: o.partner_id, is_overseas: o.partner_is_overseas ?? false, overseas_tax_label: o.overseas_tax_label ?? null, currency: o.currency ?? 'JPY' } },
          delivery_destination_id: o.delivery_destination_id ? String(o.delivery_destination_id) : '',
          sales_category_id: String(o.sales_category_id),
          trade_type: o.trade_type,
          sales_staff_id: o.sales_staff_id ? String(o.sales_staff_id) : '',
          po_no: s(o.po_no),
          order_date: o.order_date,
          ship_date: s(o.ship_date),
          delivery_date: s(o.delivery_date),
          requested_delivery_date: s(o.requested_delivery_date),
          ship_from_warehouse_id: o.ship_from_warehouse_id ? String(o.ship_from_warehouse_id) : '',
          direct_name: s(o.direct_name),
          direct_kana: s(o.direct_kana),
          direct_postal_code: s(o.direct_postal_code),
          direct_address1: s(o.direct_address1),
          direct_address2: s(o.direct_address2),
          direct_tel: s(o.direct_tel),
          shipping_remarks: s(o.shipping_remarks),
          delivery_note_remarks: s(o.delivery_note_remarks),
          shipping_fee_adjustment: s(o.shipping_fee_adjustment),
          lines: o.lines.map((l) => ({
            ...emptyLine(),
            line_type: l.line_type === '内訳商品' ? '商品' : l.line_type,
            sku: l.sku_id ? { id: l.sku_id, label: `${l.sku_code ?? ''}　${l.item_name}`, raw: { sku_id: l.sku_id } } : null,
            item_name: l.item_name,
            qty: l.qty,
            unit_price: l.unit_price,
            tax_rate: Number(l.tax_rate).toFixed(2),
            // 使っていた得意先別商品の行と、その先方コード・出荷JAN の補足（入力画面と同じ表示）
            partner_product_id: l.sku_id ? l.partner_product_id : null,
            note: l.sku_id && l.partner_product_id ? partnerProductNote(l) : undefined,
          })),
        });
      })
      .catch(setError);
  }, [id]);

  if (error) return <div className="page-body"><ErrorBox error={error} /></div>;
  if (!draft) return <Loading />;
  return <OrderForm initial={draft} orderId={Number(id)} />;
}
