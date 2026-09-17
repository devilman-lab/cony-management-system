'use client';

import { useState } from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch } from '@/lib/hooks';
import { money, monthRange, qty, thisMonth } from '@/lib/format';
import { Button, Card, CardHead, ErrorBox, Input, Modal, PageHead, Select, Toolbar } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';

interface Options {
  dimensions: string[];
  measures: string[];
}
interface Result {
  dimensions: string[];
  measures: string[];
  rows: Record<string, string | null>[];
}
interface SavedQuery {
  id: number;
  name: string;
  target: string;
  conditions: { from?: string; to?: string; dimensions?: string[]; measures?: string[]; order_type?: string };
  share_scope: string;
  created_by_name?: string | null;
}

const COUNT_MEASURES = new Set(['数量', '件数', '明細数']);

/** 販売実績（A-01）と汎用クエリ集計（A-03）。軸と指標を選んで集計し、条件を保存できる。 */
export default function AnalyticsPage() {
  const { can, canSeeSensitive } = useAuth();
  const toast = useToast();
  const options = useFetch<Options>('/analytics/options');
  const saved = useFetch<SavedQuery[]>(can('A-03') ? '/analytics/saved-queries' : null);

  const r0 = monthRange(thisMonth());
  const [from, setFrom] = useState(r0.from);
  const [to, setTo] = useState(r0.to);
  const [dims, setDims] = useState<string[]>(['月', '取引先']);
  const [measures, setMeasures] = useState<string[]>(['数量', '金額']);
  const [orderType, setOrderType] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveScope, setSaveScope] = useState<'private' | 'shared'>('private');

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await api.post<Result>('/analytics/sales', { from, to, dimensions: dims.filter(Boolean), measures, order_type: orderType || undefined, limit: 2000 });
      setResult(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    try {
      await api.post('/analytics/saved-queries', { name: saveName, target: 'sales', conditions: { from, to, dimensions: dims, measures, order_type: orderType || undefined }, share_scope: saveScope });
      toast('条件を保存しました', 'good');
      setSaveOpen(false);
      await saved.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    }
  };

  const load = (q: SavedQuery) => {
    const c = q.conditions ?? {};
    if (c.from) setFrom(c.from);
    if (c.to) setTo(c.to);
    if (c.dimensions) setDims(c.dimensions);
    if (c.measures) setMeasures(c.measures);
    setOrderType(c.order_type ?? '');
  };

  const setDim = (i: number, v: string) => setDims((s) => { const n = [...s]; n[i] = v; return n.filter((x, idx) => x || idx < 1); });

  return (
    <div className="page-body">
      <PageHead title="販売実績" sub="軸（3つまで）と指標を選んで集計します。出荷済みの実績が対象で、サンプル出荷は含みません" />
      <div className="grid-split-sidebar">
        <div className="flex flex-col gap-3.5">
          <Card>
            <Toolbar right={<Button variant="primary" loading={busy} onClick={run}>集計する</Button>}>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="!w-[140px]" />
              <span className="text-[var(--color-ink-3)]">〜</span>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="!w-[140px]" />
              <Select value={orderType} onChange={(e) => setOrderType(e.target.value)} className="!w-[120px]">
                <option value="">区分：すべて</option>
                {['卸', '直送', '通販'].map((t) => <option key={t}>{t}</option>)}
              </Select>
            </Toolbar>
            <div className="px-3.5 py-3 flex flex-wrap gap-4 items-start">
              <div>
                <div className="text-[10.5px] font-semibold text-[var(--color-ink-3)] mb-1">軸（集計の単位）</div>
                <div className="flex gap-2">
                  {[0, 1, 2].map((i) => (
                    <Select key={i} value={dims[i] ?? ''} onChange={(e) => setDim(i, e.target.value)} className="!w-[130px]">
                      <option value="">{i === 0 ? '選んでください' : '（なし）'}</option>
                      {(options.data?.dimensions ?? []).map((d) => <option key={d} value={d}>{d}</option>)}
                    </Select>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[10.5px] font-semibold text-[var(--color-ink-3)] mb-1">指標{!canSeeSensitive && <span className="ml-2 font-normal">（原価・利益は権限のある方のみ）</span>}</div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {(options.data?.measures ?? []).map((m) => (
                    <label key={m} className="flex items-center gap-1 text-[12px]">
                      <input type="checkbox" checked={measures.includes(m)} onChange={(e) => setMeasures((s) => (e.target.checked ? [...s, m] : s.filter((x) => x !== m)))} />
                      {m}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            {error ? <div className="px-3.5 pb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
          </Card>

          <Card>
            <CardHead title="集計結果" sub={result ? `${result.rows.length} 行` : '条件を選んで「集計する」を押してください'} right={result && can('A-03', 'create') && <Button size="sm" onClick={() => { setSaveName(''); setSaveOpen(true); }}>この条件を保存</Button>} />
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    {(result?.dimensions ?? dims.filter(Boolean)).map((d) => <th key={d}>{d}</th>)}
                    {(result?.measures ?? measures).map((m) => <th key={m} className="r">{m}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {!result && <tr><td colSpan={10} className="text-center py-8 text-[var(--color-ink-3)]">まだ集計していません</td></tr>}
                  {result && result.rows.length === 0 && <tr><td colSpan={10} className="text-center py-8 text-[var(--color-ink-3)]">該当する実績はありません</td></tr>}
                  {result?.rows.map((row, i) => (
                    <tr key={i}>
                      {result.dimensions.map((d) => <td key={d}>{row[d] ?? ''}</td>)}
                      {result.measures.map((m) => <td key={m} className="r num">{COUNT_MEASURES.has(m) ? qty(row[m]) : money(row[m])}</td>)}
                    </tr>
                  ))}
                </tbody>
                {result && result.rows.length > 1 && (
                  <tfoot>
                    <tr>
                      <td colSpan={result.dimensions.length} className="font-bold">合計</td>
                      {result.measures.map((m) => <td key={m} className="r num font-bold">{COUNT_MEASURES.has(m) ? qty(result.rows.reduce((a, r) => a + Number(r[m] ?? 0), 0)) : money(result.rows.reduce((a, r) => a + Number(r[m] ?? 0), 0))}</td>)}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-3.5">
          <Card>
            <CardHead title="保存した条件" sub="次からは選ぶだけで同じ集計が出ます" />
            <div className="p-2 flex flex-col gap-1">
              {(saved.data ?? []).length === 0 && <div className="px-2 py-3 text-[12px] text-[var(--color-ink-3)]">保存した条件はありません</div>}
              {(saved.data ?? []).map((q) => (
                <button key={q.id} type="button" className="text-left px-2.5 py-2 rounded-md hover:bg-[#f4f7f8] text-[12.5px]" onClick={() => load(q)}>
                  <div className="font-semibold">{q.name}</div>
                  <div className="text-[10.5px] text-[var(--color-ink-3)]">{q.share_scope === 'shared' ? '全体' : '本人のみ'}　{(q.conditions?.dimensions ?? []).join('×')}</div>
                </button>
              ))}
            </div>
          </Card>
          <Card>
            <CardHead title="使い方" />
            <div className="p-3.5 text-[11.5px] text-[var(--color-ink-2)] leading-relaxed">
              「月×取引先」で取引先ごとの月次推移、「販売担当」で担当者別、「ブランド×商品」で売れ筋が出ます。
              「利益」は 金額 −（原価 ＋ ロイヤリティ）です（概算。確定値はロイヤリティ計算表）。
            </div>
          </Card>
        </div>
      </div>

      <Modal open={saveOpen} title="集計条件の保存" onClose={() => setSaveOpen(false)} width={460} footer={<><Button onClick={() => setSaveOpen(false)}>やめる</Button><Button variant="primary" disabled={!saveName.trim()} onClick={save}>保存する</Button></>}>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1"><span className="text-[10.5px] font-semibold text-[var(--color-ink-3)]">名前</span><Input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="例：月別・取引先別の売上" /></label>
          <label className="flex flex-col gap-1"><span className="text-[10.5px] font-semibold text-[var(--color-ink-3)]">共有</span><Select value={saveScope} onChange={(e) => setSaveScope(e.target.value as 'private' | 'shared')} className="!w-[160px]"><option value="private">本人のみ</option><option value="shared">全体で共有</option></Select></label>
        </div>
      </Modal>
    </div>
  );
}
