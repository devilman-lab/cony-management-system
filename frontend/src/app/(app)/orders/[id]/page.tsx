'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';

import { api, fileToBase64 } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch } from '@/lib/hooks';
import { money, qty, ymd, ymdhm } from '@/lib/format';
import { Badge, Button, Card, CardHead, DataTable, ErrorBox, Loading, Num, PageHead, useConfirm } from '@/components/ui';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';

interface Line extends Record<string, unknown> {
  id: number;
  line_no: number;
  line_type: string;
  sku_code: string | null;
  item_name: string;
  qty: string;
  unit_price: string;
  tax_rate: string;
  amount: string;
  allocated_qty: string;
  is_stock_target: boolean;
}

interface OrderDetail {
  id: number;
  order_no: string;
  order_type: string;
  status: string;
  is_cancelled: boolean;
  is_billable: boolean;
  partner_code: string;
  partner_name: string;
  delivery_name: string | null;
  delivery_code: string | null;
  sales_category_name: string;
  warehouse_name: string | null;
  staff_name: string | null;
  trade_type: string;
  po_no: string | null;
  order_date: string;
  ship_date: string | null;
  delivery_date: string | null;
  requested_delivery_date: string | null;
  direct_name: string | null;
  direct_postal_code: string | null;
  direct_address1: string | null;
  direct_address2: string | null;
  direct_tel: string | null;
  shipping_remarks: string | null;
  delivery_note_remarks: string | null;
  shipping_fee_adjustment: string | null;
  shipment_id: number | null;
  shipment_no: string | null;
  shipment_status: string | null;
  channel: string | null;
  created_at: string;
  lines: Line[];
}

interface Attachment extends Record<string, unknown> {
  id: number;
  file_name: string;
  mime_type: string | null;
  byte_size: number | null;
  is_print_target: boolean;
  created_at: string;
  created_by_name: string | null;
}

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const order = useFetch<OrderDetail>(`/orders/${id}`);
  const attachments = useFetch<Attachment[]>(can('D-01') ? '/attachments' : null, { ref_table: 'sales_orders', ref_id: id });
  const [busy, setBusy] = useState<string | null>(null);

  const o = order.data;
  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
      await order.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusy(null);
    }
  };

  const editable = o && ['未確定', '引当待ち', '引当済'].includes(o.status);

  return (
    <div className="page-body">
      {element}
      {order.error ? <ErrorBox error={order.error} /> : null}
      {!o ? (
        <Loading />
      ) : (
        <>
          <PageHead
            title={
              <span className="flex items-center gap-2">
                受注 <Num>{o.order_no}</Num> <Badge status={o.status} />
                {!o.is_billable && <span className="bdg bg-[#fbf3e2] text-[#7a5407] border border-[#e8c88a]">サンプル（売上計上なし）</span>}
              </span>
            }
            sub={`${o.order_type}　${o.partner_code} ${o.partner_name}${o.channel ? `　取込元：${o.channel}` : ''}　登録 ${ymdhm(o.created_at)}`}
            right={
              <>
                <Link href="/orders" className="btn btn-ghost btn-sm">一覧へ</Link>
                {o.status === '引当待ち' && can('D-01', 'create') && (
                  <Button variant="primary" size="sm" loading={busy === 'alloc'} onClick={() => run('alloc', async () => {
                    const r = await api.post<{ status: string; shortages: string[] }>(`/orders/${o.id}/allocate`);
                    toast(r.status === '引当済' ? '引き当てました' : `まだ足りません：${r.shortages.join('、')}`, r.status === '引当済' ? 'good' : 'info');
                  })}>
                    引き当て直す
                  </Button>
                )}
                {editable && can('O-01', 'update') && (
                  <Link href={`/orders/${o.id}/edit`} className="btn btn-ghost btn-sm">修正</Link>
                )}
                {editable && can('O-01', 'delete') && (
                  <Button variant="danger" size="sm" loading={busy === 'cancel'} onClick={async () => {
                    if (!(await confirm('この受注を取り消しますか', '引当は戻ります。取り消した受注は元に戻せません。', true))) return;
                    await run('cancel', async () => {
                      await api.post(`/orders/${o.id}/cancel`);
                      toast('取り消しました', 'good');
                    });
                  }}>
                    取消
                  </Button>
                )}
                {o.shipment_id && o.status === '引当済' && can('D-01', 'update') && (
                  <Link href={`/shipping?focus=${o.shipment_id}`} className="btn btn-primary btn-sm">出荷確定・印刷へ</Link>
                )}
                {o.shipment_id && o.status === '出荷済' && can('D-01', 'update') && (
                  <Button variant="danger" size="sm" loading={busy === 'unconfirm'} onClick={async () => {
                    if (!(await confirm('出荷確定を取り消しますか', '実在庫が戻り、受注を修正できる状態になります。請求に含めた出荷は取り消せません。', true))) return;
                    await run('unconfirm', async () => {
                      await api.post(`/shipments/${o.shipment_id}/unconfirm`);
                      toast('出荷確定を取り消しました。修正してから、もう一度出荷確定してください', 'good');
                    });
                  }}>
                    出荷確定を取り消す
                  </Button>
                )}
                {o.shipment_id && can('D-03', 'print') && (
                  <Button size="sm" icon="print" loading={busy === 'print'} onClick={() => run('print', async () => {
                    await api.download('/reports/shipping-instructions', { query: { shipment_ids: o.shipment_id }, open: true });
                  })}>
                    出荷指示書
                  </Button>
                )}
              </>
            }
          />

          <div className="detail-grid-2">
            <Card>
              <CardHead title="受注内容" />
              <div className="px-3.5">
                <Row k="納品先" v={o.delivery_name ? `${o.delivery_code ?? ''} ${o.delivery_name}` : '（直送）'} />
                <Row k="販売カテゴリー" v={o.sales_category_name} />
                <Row k="取引条件" v={o.trade_type} />
                <Row k="販売担当" v={o.staff_name ?? '—'} />
                <Row k="先方発注番号" v={o.po_no ?? '—'} />
                <Row k="受注日 / 出荷日 / 納品日" v={`${ymd(o.order_date)} / ${ymd(o.ship_date) || '—'} / ${ymd(o.delivery_date) || '—'}`} />
                <Row k="納品希望日" v={ymd(o.requested_delivery_date) || '—'} />
                <Row k="出荷倉庫" v={o.warehouse_name ?? '（納品先の既定）'} />
                {(o.direct_name || o.direct_address1) && (
                  <Row k="お届け先" v={`${o.direct_name ?? ''}　〒${o.direct_postal_code ?? ''} ${o.direct_address1 ?? ''}${o.direct_address2 ?? ''}　${o.direct_tel ?? ''}`} />
                )}
                <Row k="出荷備考" v={o.shipping_remarks ?? '—'} />
                <Row k="納品書備考" v={o.delivery_note_remarks ?? '—'} />
                <Row k="送料調整" v={o.shipping_fee_adjustment ? `${money(o.shipping_fee_adjustment)} 円` : '（自動）'} />
              </div>
            </Card>
            <Card>
              <CardHead title="出荷" sub="出荷確定で実在庫が減ります" />
              <div className="px-3.5">
                <Row k="出荷指示番号" v={o.shipment_no ?? '（引当が完了すると付きます）'} />
                <Row k="出荷の状態" v={o.shipment_status ? <Badge status={o.shipment_status} /> : '—'} />
                <Row k="引当" v={o.status === '引当待ち' ? '有効在庫が足りない明細があります。在庫が空いたあとに「引き当て直す」を押してください' : o.status === '引当済' ? '全量を引き当てています' : o.status} />
              </div>
              {can('D-01') && (
                <>
                  <CardHead
                    title="添付ファイル"
                    sub="PDF・画像は出荷確定のときに帳票と一緒に印刷されます"
                    right={
                      can('D-01', 'update') && (
                        <label className="btn btn-ghost btn-sm cursor-pointer">
                          <Icon name="clip" size={13} />
                          追加
                          <input type="file" className="hidden" onChange={async (e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            try {
                              await api.post('/attachments', { ref_table: 'sales_orders', ref_id: o.id, file_name: f.name, mime_type: f.type || null, content_base64: await fileToBase64(f) });
                              toast('添付しました', 'good');
                              await attachments.reload();
                            } catch (err) {
                              toast(err instanceof Error ? err.message : '添付できませんでした', 'bad');
                            } finally {
                              e.target.value = '';
                            }
                          }} />
                        </label>
                      )
                    }
                  />
                  <DataTable<Attachment>
                    columns={[
                      { key: 'file_name', label: 'ファイル', render: (a) => <button type="button" className="text-[var(--color-brand-700)] underline" onClick={() => api.download(`/attachments/${a.id}/content`, { open: true }).catch((err) => toast(err.message, 'bad'))}>{a.file_name}</button> },
                      { key: 'byte_size', label: 'サイズ', r: true, render: (a) => (a.byte_size ? `${Math.ceil(a.byte_size / 1024)} KB` : '') },
                      { key: 'is_print_target', label: '印刷', c: true, render: (a) => (a.is_print_target ? '同梱' : '—') },
                      { key: 'created_by_name', label: '登録', render: (a) => `${a.created_by_name ?? ''} ${ymdhm(a.created_at)}` },
                      { key: '_x', label: '', width: 50, render: (a) => can('D-01', 'delete') && <button type="button" className="btn btn-quiet btn-sm !text-[var(--color-crit-500)]" onClick={async () => { if (!(await confirm('添付を削除しますか', undefined, true))) return; await api.delete(`/attachments/${a.id}`); await attachments.reload(); }}>削除</button> },
                    ]}
                    rows={attachments.data ?? []}
                    rowKey={(a) => a.id}
                    empty="添付はありません"
                  />
                </>
              )}
            </Card>
          </div>

          <Card>
            <CardHead title="明細" />
            <DataTable<Line>
              columns={[
                { key: 'line_no', label: '行', c: true, width: 40 },
                { key: 'line_type', label: '種別', width: 80 },
                { key: 'sku_code', label: 'SKU', width: 150, render: (l) => <Num>{l.sku_code ?? ''}</Num> },
                { key: 'item_name', label: '品名' },
                { key: 'qty', label: '数量', r: true, width: 70, render: (l) => qty(l.qty) },
                { key: 'allocated_qty', label: '引当', r: true, width: 70, render: (l) => (l.is_stock_target ? qty(l.allocated_qty) : '—') },
                { key: 'unit_price', label: '単価', r: true, width: 90, render: (l) => money(l.unit_price) },
                { key: 'tax_rate', label: '税率', c: true, width: 60, render: (l) => `${Number(l.tax_rate)}%` },
                { key: 'amount', label: '金額', r: true, width: 100, render: (l) => money(l.amount) },
              ]}
              rows={o.lines}
              rowKey={(l) => l.id}
            />
            <div className="px-3.5 py-2 text-right text-[12.5px] border-t border-[var(--color-line)]">
              合計（税抜）　<b className="num text-[14px]">{money(o.lines.reduce((a, l) => a + Number(l.amount), 0))} 円</b>
            </div>
          </Card>
          <div>
            <Button variant="quiet" onClick={() => router.back()}>← 戻る</Button>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="form-row">
      <div className="form-row-label field-label h-full flex items-center px-3 py-1.5">{k}</div>
      <div className="px-3 py-1.5 text-[12.5px] min-w-0 break-words">{v}</div>
    </div>
  );
}
