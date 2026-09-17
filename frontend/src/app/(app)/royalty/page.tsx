'use client';

import Link from 'next/link';
import { useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch } from '@/lib/hooks';
import { money, qty, thisMonth, ymd, ymdhm } from '@/lib/format';
import { Badge, Button, Card, CardHead, DataTable, ErrorBox, Input, Modal, Num, PageHead, Toolbar, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

interface CalcRow extends Record<string, unknown> {
  id: number;
  target_month: string;
  payee_name: string;
  calc_base: string;
  total_base_amount: string;
  total_amount: string;
  status: string;
  confirmed_at: string | null;
}

interface CalcDetail extends CalcRow {
  by_customer: { customer_name: string | null; qty: string; base_amount: string; royalty_amount: string }[];
  lines: { customer_name: string | null; brand_name: string | null; sku_code: string; product_name: string; qty: string; base_amount: string; rate: string | null; royalty_amount: string }[];
}

/** ロイヤリティ計算（Y-02）。規定は「ロイヤリティ規定」マスタで。 */
export default function RoyaltyPage() {
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [month, setMonth] = useState(thisMonth());
  const list = useFetch<CalcRow[]>('/billing/royalties', { target_month: month });
  const [busy, setBusy] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const detail = useFetch<CalcDetail>(detailId ? `/billing/royalties/${detailId}` : null);

  const calculate = async () => {
    if (!(await confirm(`${month} のロイヤリティを計算しますか`, '出荷済みの明細に規定を当てて、支払先ごとに計算表を作ります。確定前の計算表は作り直されます。'))) return;
    setBusy(true);
    try {
      const r = await api.post<{ calculations?: unknown[] } | unknown[]>('/billing/royalties/calculate', { target_month: month });
      const n = Array.isArray(r) ? r.length : (r as { calculations?: unknown[] }).calculations?.length ?? 0;
      toast(`計算しました（支払先 ${n} 件）`, 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusy(false);
    }
  };

  const confirmCalc = async (row: CalcRow) => {
    if (!(await confirm(`${row.payee_name} の ${row.target_month.slice(0, 7)} 分を確定しますか`))) return;
    try {
      await api.post(`/billing/royalties/${row.id}/confirm`);
      toast('確定しました', 'good');
      await list.reload();
      if (detailId === row.id) await detail.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    }
  };

  return (
    <div className="page-body">
      {element}
      <PageHead
        title="ロイヤリティ計算"
        sub="出荷金額（販売先への卸金額）に規定の料率をかけて、支払先ごとに月次の計算表を作ります。返品はマイナスで反映、端数は切り捨てです"
        right={
          <>
            <Link href="/masters/royalty-rules" className="btn btn-ghost">規定を確認する</Link>
            {can('Y-02', 'create') && <Button variant="primary" loading={busy} onClick={calculate}>この月を計算する</Button>}
          </>
        }
      />
      <Card>
        <Toolbar>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="!w-[150px]" />
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<CalcRow>
          columns={[
            { key: 'payee_name', label: '支払先', render: (r) => <button type="button" className="font-semibold text-[var(--color-brand-700)] underline" onClick={() => setDetailId(r.id)}>{r.payee_name}</button> },
            { key: 'target_month', label: '対象月', width: 100, render: (r) => <Num>{r.target_month.slice(0, 7)}</Num> },
            { key: 'total_base_amount', label: '対象金額（卸）', r: true, width: 140, render: (r) => money(r.total_base_amount) },
            { key: 'total_amount', label: 'ロイヤリティ', r: true, width: 130, render: (r) => <b>{money(r.total_amount)}</b> },
            { key: 'status', label: '状態', width: 80, render: (r) => <Badge status={r.status} /> },
            { key: 'confirmed_at', label: '確定日時', width: 130, render: (r) => ymdhm(r.confirmed_at) },
            { key: '_act', label: '', width: 90, render: (r) => r.status !== '確定' && can('Y-02', 'update') && <Button size="sm" variant="primary" onClick={() => confirmCalc(r)}>確定</Button> },
          ]}
          rows={list.data ?? []}
          rowKey={(r) => r.id}
          loading={list.loading}
          empty="この月の計算表はありません。「この月を計算する」から作ります"
        />
      </Card>

      <Modal open={detailId !== null} title={detail.data ? `${detail.data.payee_name}　${detail.data.target_month.slice(0, 7)} 分` : ''} onClose={() => setDetailId(null)} width={900}>
        {detail.data && (
          <div className="flex flex-col gap-3">
            <div className="text-[12px] text-[var(--color-ink-2)]">
              <Badge status={detail.data.status} />　対象金額 <b className="num">{money(detail.data.total_base_amount)}</b> 円　ロイヤリティ <b className="num">{money(detail.data.total_amount)}</b> 円
            </div>
            <Card>
              <CardHead title="販売先別の内訳" />
              <table className="tbl">
                <thead><tr><th>販売先</th><th className="r" style={{ width: 90 }}>数量</th><th className="r" style={{ width: 130 }}>対象金額</th><th className="r" style={{ width: 130 }}>ロイヤリティ</th></tr></thead>
                <tbody>{detail.data.by_customer.map((c, i) => <tr key={i}><td>{c.customer_name ?? ''}</td><td className="r num">{qty(c.qty)}</td><td className="r num">{money(c.base_amount)}</td><td className="r num">{money(c.royalty_amount)}</td></tr>)}</tbody>
              </table>
            </Card>
            <Card>
              <CardHead title="明細" />
              <div className="max-h-[320px] overflow-auto">
                <table className="tbl">
                  <thead><tr><th>販売先</th><th>ブランド</th><th>SKU</th><th>商品</th><th className="r">数量</th><th className="r">対象金額</th><th className="r">料率</th><th className="r">ロイヤリティ</th></tr></thead>
                  <tbody>{detail.data.lines.map((l, i) => <tr key={i}><td>{l.customer_name ?? ''}</td><td>{l.brand_name ?? ''}</td><td className="num">{l.sku_code}</td><td className="truncate">{l.product_name}</td><td className="r num">{qty(l.qty)}</td><td className="r num">{money(l.base_amount)}</td><td className="r num">{l.rate ? `${(Number(l.rate) * 100).toFixed(2)}%` : '定額'}</td><td className="r num">{money(l.royalty_amount)}</td></tr>)}</tbody>
                </table>
              </div>
            </Card>
            <div className="text-[11px] text-[var(--color-ink-3)]">{ymd(detail.data.target_month)} 〜 月末の出荷が対象です。</div>
          </div>
        )}
      </Modal>
    </div>
  );
}
