'use client';

import { useState } from 'react';

import { api, fileToBase64 } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch, useList } from '@/lib/hooks';
import { money, ymdhm } from '@/lib/format';
import { Badge, Button, Card, CardHead, DataTable, ErrorBox, FormRow, PageHead, Pager, Select } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

interface Template {
  id: number;
  template_code: string;
  name: string;
  import_type: string;
  file_encoding: string;
  note: string | null;
}
interface BatchRow extends Record<string, unknown> {
  id: number;
  import_type: string;
  template_name: string | null;
  file_name: string;
  total_count: number;
  success_count: number;
  error_count: number;
  imported_at: string;
  imported_by_name: string | null;
}
interface PendingRow extends Record<string, unknown> {
  id: number;
  channel: string;
  external_order_no: string;
  delivery_code: string | null;
  partner_name: string | null;
  status: string;
  error_message: string | null;
  ordered_at: string | null;
}

type Kind = 'partner' | 'oms' | 'amazon' | 'postal';

const KINDS: { k: Kind; label: string; desc: string }[] = [
  { k: 'partner', label: '販社の発注CSV', desc: 'ビックカメラ・ラベルヴィ・白鳩・コネクトなど、販社から届く発注データ。受注として登録し、引当まで行います' },
  { k: 'oms', label: '通販（OMS）受注CSV', desc: '通販システムから出した63列の受注CSV。出荷済みの受注として登録します' },
  { k: 'amazon', label: 'Amazon 決済レポート', desc: 'セラーセントラルのトランザクションレポート。手数料・返金を含めて登録します' },
  { k: 'postal', label: '郵便番号データ', desc: '日本郵便の KEN_ALL.CSV。住所の自動入力に使います' },
];

const TYPE_LABEL: Record<string, string> = { PARTNER_ORDER: '販社発注', OMS_ORDER: '通販受注', AMAZON_TRANSACTION: 'Amazon' };

/** CSV取込（I-01）。まず「確認だけ」で読めるか確かめ、問題なければ取り込む。 */
export default function ImportsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const templates = useFetch<Template[]>('/imports/templates');
  const batches = useList<BatchRow>('/imports/batches', {}, 20);
  const pending = useList<PendingRow>('/imports/pending', {}, 50);

  const [kind, setKind] = useState<Kind>('partner');
  const [template, setTemplate] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<'dry' | 'run' | null>(null);

  const partnerTemplates = (templates.data ?? []).filter((t) => t.import_type === 'PARTNER_ORDER');
  const tpl = template || partnerTemplates[0]?.template_code || '';

  const run = async (dryRun: boolean) => {
    if (!file) return;
    setError(null);
    setBusy(dryRun ? 'dry' : 'run');
    try {
      const content_base64 = await fileToBase64(file);
      let r: Record<string, unknown>;
      if (kind === 'partner') r = await api.post('/imports/partner-orders', { template_code: tpl, file_name: file.name, content_base64, dry_run: dryRun });
      else if (kind === 'oms') r = await api.post('/imports/oms-orders', { file_name: file.name, content_base64, dry_run: dryRun });
      else if (kind === 'amazon') r = await api.post('/imports/amazon-transactions', { file_name: file.name, content_base64, dry_run: dryRun });
      else r = await api.post('/postal-codes/import', { file_name: file.name, content_base64, dry_run: dryRun });
      setResult({ ...r, _dry: dryRun });
      if (!dryRun) {
        toast('取り込みました', 'good');
        await Promise.all([batches.reload(), pending.reload()]);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page-body">
      <PageHead title="CSV取込" sub="販社の発注CSV・通販受注CSV・Amazonレポート・郵便番号データを取り込みます。まず「確認だけ」で読めるか確かめてから取り込むと安全です" />
      <div className="grid-split-sidebar">
        <div className="flex flex-col gap-3.5">
          <Card>
            <CardHead title="取り込む" />
            <div className="p-3.5 flex flex-col gap-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {KINDS.map((k) => (
                  <button
                    key={k.k}
                    type="button"
                    onClick={() => { setKind(k.k); setResult(null); setError(null); }}
                    className={`text-left rounded-lg border px-3 py-2.5 transition ${kind === k.k ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)]' : 'border-[var(--color-line)] hover:bg-[#f7f9fa]'}`}
                  >
                    <div className="text-[12.5px] font-semibold">{k.label}</div>
                    <div className="text-[10.5px] text-[var(--color-ink-3)] mt-0.5 leading-snug">{k.desc}</div>
                  </button>
                ))}
              </div>
              {kind === 'partner' && (
                <FormRow label="販社の書式" required>
                  <Select value={tpl} onChange={(e) => setTemplate(e.target.value)} className="!w-[260px]">
                    {partnerTemplates.map((t) => <option key={t.template_code} value={t.template_code}>{t.name}</option>)}
                  </Select>
                  {partnerTemplates.find((t) => t.template_code === tpl)?.note && <div className="text-[10.5px] text-[var(--color-ink-3)] mt-1 w-full">{partnerTemplates.find((t) => t.template_code === tpl)?.note}</div>}
                </FormRow>
              )}
              <FormRow label="ファイル" required>
                <input type="file" accept=".csv,.txt,.tsv" className="text-[12px]" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); setError(null); }} />
              </FormRow>
              {error ? <ErrorBox error={error} onClose={() => setError(null)} /> : null}
              <div className="flex gap-2">
                <Button disabled={!file || !can('I-01', 'create')} loading={busy === 'dry'} onClick={() => run(true)}>確認だけ（登録しない）</Button>
                <Button variant="primary" disabled={!file || !can('I-01', 'create')} loading={busy === 'run'} onClick={() => run(false)}>取り込む</Button>
              </div>
            </div>
          </Card>

          {result && <ResultCard r={result} kind={kind} />}

          <Card>
            <CardHead title="取込履歴" sub="いつ・誰が・何件取り込んだか" />
            <DataTable<BatchRow>
              columns={[
                { key: 'imported_at', label: '日時', width: 130, render: (r) => ymdhm(r.imported_at) },
                { key: 'import_type', label: '種類', width: 90, render: (r) => TYPE_LABEL[r.import_type] ?? r.import_type },
                { key: 'template_name', label: '書式', width: 150, render: (r) => r.template_name ?? '' },
                { key: 'file_name', label: 'ファイル' },
                { key: 'total_count', label: '行数', r: true, width: 70 },
                { key: 'success_count', label: '成功', r: true, width: 70 },
                { key: 'error_count', label: 'エラー', r: true, width: 70, render: (r) => (r.error_count > 0 ? <span className="text-[var(--color-crit)] font-semibold">{r.error_count}</span> : '0') },
                { key: 'imported_by_name', label: '担当', width: 90, render: (r) => r.imported_by_name ?? '' },
              ]}
              rows={batches.items}
              rowKey={(r) => r.id}
              loading={batches.loading}
            />
            <Pager total={batches.total} limit={batches.limit} offset={batches.offset} onChange={batches.setOffset} />
          </Card>
        </div>

        <div className="flex flex-col gap-3.5">
          <Card>
            <CardHead title="受注にできなかったもの" sub="マスタ登録が済んだら取り込み直してください" />
            {pending.items.length === 0 ? (
              <div className="p-3.5 text-[12px] text-[var(--color-ink-3)]">ありません</div>
            ) : (
              <div className="max-h-[480px] overflow-auto">
                {pending.items.map((p) => (
                  <div key={p.id} className="px-3.5 py-2 border-b border-[var(--color-line)] text-[12px]">
                    <div className="flex items-center gap-2"><Badge status={p.status} /><span className="num font-semibold">{p.external_order_no}</span><span className="text-[var(--color-ink-3)] ml-auto">{p.channel}</span></div>
                    <div className="text-[11px] text-[var(--color-ink-2)]">{p.partner_name ?? ''}{p.delivery_code ? `　納品先 ${p.delivery_code}` : ''}</div>
                    {p.error_message && <div className="text-[11px] text-[var(--color-crit)] mt-0.5">{p.error_message}</div>}
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card>
            <CardHead title="取り込みの流れ" />
            <ol className="p-3.5 pl-7 text-[11.5px] text-[var(--color-ink-2)] leading-relaxed list-decimal">
              <li>販社から届いたCSVをそのまま選びます（Shift-JIS のままで構いません）</li>
              <li>「確認だけ」で列数・商品コードが読めるか確かめます</li>
              <li>「取り込む」で受注が作られ、引当まで行われます</li>
              <li>同じ発注番号は二重に取り込まれません</li>
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}

function ResultCard({ r, kind }: { r: Record<string, unknown>; kind: Kind }) {
  const dry = Boolean(r._dry);
  const n = (k: string) => Number(r[k] ?? 0);
  const errors = (r.errors as { row_no?: number; order_no?: string; reason: string }[] | undefined) ?? [];
  const warnings = (r.warnings as string[] | undefined) ?? [];
  const map = (k: string) => (r[k] as Record<string, number | string> | undefined) ?? {};
  return (
    <Card>
      <CardHead title={dry ? '確認結果（まだ登録していません）' : '取込結果'} />
      <div className="p-3.5 text-[12px] flex flex-col gap-2">
        {kind === 'partner' && (
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <span>行数 <b className="num">{n('total_rows')}</b></span>
            <span>読めた行 <b className="num">{n('success_rows')}</b></span>
            <span>エラー行 <b className={`num ${n('error_rows') ? 'text-[var(--color-crit)]' : ''}`}>{n('error_rows')}</b></span>
            {!dry && <><span>作成した受注 <b className="num">{n('created_orders')}</b></span><span>取込済で除外 <b className="num">{n('skipped_orders')}</b></span></>}
          </div>
        )}
        {kind === 'oms' && (
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <span>明細 <b className="num">{n('total_lines')}</b></span>
            <span>受注 <b className="num">{n('orders')}</b></span>
            {!dry && <><span>作成 <b className="num">{n('created_orders')}</b></span><span>除外 <b className="num">{n('skipped_orders')}</b></span></>}
            <span>商品が見つからない <b className={`num ${n('unresolved_skus') ? 'text-[var(--color-warn)]' : ''}`}>{n('unresolved_skus')}</b></span>
            <span className="text-[var(--color-ink-3)]">種別: {Object.entries(map('line_types')).map(([k, v]) => `${k} ${v}`).join('、')}</span>
          </div>
        )}
        {kind === 'amazon' && (
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <span>行数 <b className="num">{n('total_rows')}</b>（見出しは {n('header_row')} 行目）</span>
            {!dry && <><span>登録 <b className="num">{n('inserted')}</b></span><span>除外 <b className="num">{n('skipped')}</b></span></>}
            <span>合計 <b className="num">{money(r.total_amount as string)}</b> 円</span>
            <span className="text-[var(--color-ink-3)] w-full">種類: {Object.entries(map('transaction_types')).map(([k, v]) => `${k} ${v}`).join('、')}</span>
            {((r.unresolved_skus as string[] | undefined) ?? []).length > 0 && <span className="text-[var(--color-warn)] w-full">商品が見つからないSKU: {(r.unresolved_skus as string[]).join('、')}</span>}
          </div>
        )}
        {kind === 'postal' && (
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {Object.entries(r).filter(([k, v]) => k !== '_dry' && (typeof v === 'number' || typeof v === 'string')).map(([k, v]) => <span key={k}>{k} <b className="num">{String(v)}</b></span>)}
          </div>
        )}
        {errors.length > 0 && (
          <div className="rounded-md border border-[var(--color-crit)]/40 bg-[#fff6f5] p-2.5 max-h-[220px] overflow-auto">
            <div className="font-semibold text-[var(--color-crit)] mb-1">エラー {errors.length} 件</div>
            {errors.map((e, i) => <div key={i} className="text-[11.5px]">{e.row_no !== undefined ? `${e.row_no}行目：` : e.order_no ? `${e.order_no}：` : ''}{e.reason}</div>)}
          </div>
        )}
        {warnings.length > 0 && (
          <div className="rounded-md border border-[var(--color-warn)]/40 bg-[#fffbf0] p-2.5 max-h-[160px] overflow-auto">
            <div className="font-semibold text-[var(--color-warn)] mb-1">注意 {warnings.length} 件</div>
            {warnings.slice(0, 50).map((w, i) => <div key={i} className="text-[11.5px]">{w}</div>)}
          </div>
        )}
      </div>
    </Card>
  );
}
