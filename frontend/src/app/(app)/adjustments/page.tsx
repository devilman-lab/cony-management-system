'use client';

import { useRef, useState, type ReactNode } from 'react';

import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCodes, useList, useWarehouses } from '@/lib/hooks';
import { qty as fmtQty, today, ymd } from '@/lib/format';
import { Badge, Button, Card, DataTable, ErrorBox, FormRow, Input, Modal, Num, PageHead, Pager, Select, Textarea, useConfirm } from '@/components/ui';
import { InlineText } from '@/components/inventory/InlineEdit';
import { SearchSelect, fetchSkus, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface AdjLine {
  line_no: number;
  sku_id: number;
  sku_code: string;
  jan: string | null;
  product_name: string;
  color_name: string | null;
  size_name: string | null;
  qty: string;
  from_quality: string | null;
  from_quality_name: string | null;
  to_quality: string | null;
  to_quality_name: string | null;
  note: string | null;
}

interface AdjRow {
  id: number;
  adjustment_no: string;
  adjustment_date: string;
  warehouse_id: number;
  warehouse_name: string;
  reason_code: string | null;
  reason_name: string | null;
  note: string | null;
  /** 登録（在庫は未反映）／確定（在庫に反映済み）／取消 */
  status: string;
  lines: AdjLine[];
}

/** 一覧の1行＝調整明細の1行（2026-10-09 在庫編 Z-22「調整した商品の詳細を表示」）。 */
interface FlatRow extends Record<string, unknown> {
  key: string;
  first: boolean;
  adj: AdjRow;
  line: AdjLine | null;
}

interface LineDraft {
  key: number;
  sku: Option | null;
  qty: string;
  from_quality: string;
  to_quality: string;
  note: string;
}
let seq = 1;
const newLine = (): LineDraft => ({ key: seq++, sku: null, qty: '', from_quality: '', to_quality: '', note: '' });
const toDraft = (l: AdjLine): LineDraft => ({
  key: seq++,
  sku: {
    id: l.sku_id,
    label: `${l.sku_code}　${l.product_name}${l.color_name ? ' ' + l.color_name : ''}${l.size_name ? ' ' + l.size_name : ''}`,
    sub: l.jan ?? '',
  },
  qty: String(Number(l.qty)),
  from_quality: l.from_quality ?? '',
  to_quality: l.to_quality ?? '',
  note: l.note ?? '',
});

const QUALITY = [
  { v: '', l: '（変更なし）' },
  { v: 'GOOD', l: '良品' },
  { v: 'DEFECTIVE', l: '不良' },
  { v: 'PENDING', l: '返品検品待ち' },
];

interface ImportResult {
  dry_run: boolean;
  encoding: string;
  rows: number;
  adjustments: {
    adjustment_no?: string;
    adjustment_date: string;
    warehouse_name: string;
    reason_name: string;
    note: string | null;
    lines: { row: number; sku_code: string; product_name: string; qty: string; from_quality: string | null; to_quality: string | null; note: string | null }[];
  }[];
  errors: { row: number; message: string }[];
}

/**
 * 在庫数の調整（ご要望⑫）。棚卸差異・破損・紛失・品質振替をここで直す。
 *
 * 2026-10-09 在庫編 Z-20・Z-21: 登録しただけでは在庫は動かない（状態「登録」）。
 * 一覧の「調整」を押したときに在庫へ反映する（状態「確定」）。確定後の「取消」は在庫を元に戻す。
 */
export default function AdjustmentsPage() {
  const { can } = useAuth();
  const canUpdate = can('S-01', 'update');
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const warehouses = useWarehouses();
  const reasons = useCodes('ADJUSTMENT_REASON');
  const list = useList<AdjRow>('/inventory/adjustments', {});

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AdjRow | null>(null);
  const [warehouseId, setWarehouseId] = useState('');
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('STOCKTAKE');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const setLine = (key: number, p: Partial<LineDraft>) => setLines((s) => s.map((l) => (l.key === key ? { ...l, ...p } : l)));
  /** 行をコピーして、その行のすぐ下に足す（Z-19） */
  const copyLine = (key: number) =>
    setLines((s) => {
      const i = s.findIndex((l) => l.key === key);
      return [...s.slice(0, i + 1), { ...s[i], key: seq++ }, ...s.slice(i + 1)];
    });

  const openNew = () => {
    setEditing(null);
    setWarehouseId('');
    setDate(today());
    setReason('STOCKTAKE');
    setNote('');
    setLines([newLine()]);
    setError(null);
    setOpen(true);
  };

  const openEdit = async (r: AdjRow) => {
    try {
      const d = await api.get<AdjRow>(`/inventory/adjustments/${r.id}`);
      setEditing(d);
      setWarehouseId(String(d.warehouse_id));
      setDate(String(d.adjustment_date).slice(0, 10));
      setReason(d.reason_code ?? 'STOCKTAKE');
      setNote(d.note ?? '');
      setLines(d.lines.length > 0 ? d.lines.map(toDraft) : [newLine()]);
      setError(null);
      setOpen(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : '読み込めませんでした', 'bad');
    }
  };

  const save = async () => {
    setError(null);
    // 候補から選ばずに文字だけ打った行は sku_id が無い。API に送る前に気づかせる
    const missing = lines.findIndex((l) => !l.sku);
    if (missing >= 0) return setError(new ApiError(400, `明細 ${missing + 1} 行目の商品を候補から選んでください（コードを打ったら候補をクリックするか Enter で確定します）`));
    setBusy(true);
    // ロットは画面から外した（Z-18）。API は受け付けるが送らない
    const body = {
      warehouse_id: Number(warehouseId || warehouses.data?.[0]?.id),
      adjustment_date: date,
      reason_code: reason,
      note: note || null,
      lines: lines.map((l, i) => ({
        line_no: i + 1,
        sku_id: l.sku?.id,
        qty: l.qty,
        from_quality: l.from_quality || null,
        to_quality: l.to_quality || null,
        note: l.note || null,
      })),
    };
    try {
      if (editing) {
        await api.patch(`/inventory/adjustments/${editing.id}`, body);
        toast(`${editing.adjustment_no} を直しました`, 'good');
      } else {
        await api.post('/inventory/adjustments', body);
        toast('登録しました。在庫に反映するときは一覧の「調整」を押してください', 'good');
      }
      setOpen(false);
      setLines([newLine()]);
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  /** 一覧で直接直す（Z-23）。失敗したら InlineText が元の値に戻すので、ここは例外をそのまま投げる */
  const patchHeader = async (r: AdjRow, p: Record<string, unknown>) => {
    try {
      await api.patch(`/inventory/adjustments/${r.id}`, p);
      toast(`${r.adjustment_no} を直しました`, 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存できませんでした', 'bad');
      throw e;
    }
  };

  const confirmAdj = async (r: AdjRow) => {
    if (!(await confirm(`${r.adjustment_no} を在庫に反映しますか`, '明細のとおりに在庫を増減します。反映後に直すときは「取消」で元に戻してから登録し直してください。'))) return;
    setRowBusy(r.id);
    try {
      await api.post(`/inventory/adjustments/${r.id}/confirm`);
      toast('在庫に反映しました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '反映できませんでした', 'bad');
    } finally {
      setRowBusy(null);
    }
  };

  const cancelAdj = async (r: AdjRow) => {
    const body = r.status === '確定' ? '在庫に反映済みです。在庫を元に戻してから取り消します。' : 'この在庫調整を取り消します（在庫はまだ動いていません）。';
    if (!(await confirm(`${r.adjustment_no} を取り消しますか`, body, true))) return;
    setRowBusy(r.id);
    try {
      await api.post(`/inventory/adjustments/${r.id}/cancel`);
      toast(r.status === '確定' ? '在庫を元に戻して取り消しました' : '取り消しました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '取り消せませんでした', 'bad');
    } finally {
      setRowBusy(null);
    }
  };

  // ---- CSV 取込（Z-24）。マスタの CSV 取込と同じく、必ず下見を通してから登録する ----
  const fileRef = useRef<HTMLInputElement>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvError, setCsvError] = useState<unknown>(null);
  const [csvContent, setCsvContent] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const resetCsv = () => {
    setPreview(null);
    setCsvContent(null);
    setCsvError(null);
    if (fileRef.current) fileRef.current.value = '';
  };
  const pickCsv = async (f: File) => {
    setCsvError(null);
    setPreview(null);
    setCsvBusy(true);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const base64 = btoa(bin);
      setCsvContent(base64);
      setPreview(await api.post<ImportResult>('/inventory/adjustments/import', { content_base64: base64, dry_run: true }));
    } catch (e) {
      setCsvError(e);
    } finally {
      setCsvBusy(false);
    }
  };
  const commitCsv = async () => {
    if (!csvContent) return;
    setCsvBusy(true);
    setCsvError(null);
    try {
      const r = await api.post<ImportResult>('/inventory/adjustments/import', { content_base64: csvContent, dry_run: false });
      toast(`${r.adjustments.length}件の在庫調整を登録しました。在庫に反映するときは一覧の「調整」を押してください`, 'good');
      setCsvOpen(false);
      resetCsv();
      await list.reload();
    } catch (e) {
      setCsvError(e);
    } finally {
      setCsvBusy(false);
    }
  };

  const rows: FlatRow[] = list.items.flatMap((a): FlatRow[] =>
    a.lines.length === 0
      ? [{ key: `${a.id}`, first: true, adj: a, line: null }]
      : a.lines.map((l, i) => ({ key: `${a.id}-${l.line_no}`, first: i === 0, adj: a, line: l })),
  );
  const head = (r: FlatRow, v: ReactNode) => (r.first ? v : null);
  /** 一覧で直せるのは在庫に反映する前（登録）のものだけ */
  const editable = (a: AdjRow) => canUpdate && a.status === '登録';

  return (
    <div className="page-body">
      {element}
      <PageHead
        title="在庫調整"
        sub="棚卸差異・破損・紛失などで在庫数を直します。登録しただけでは在庫は動きません。一覧の「調整」で在庫に反映します"
        right={
          canUpdate && (
            <span className="flex gap-2">
              <Button icon="upload" onClick={() => { resetCsv(); setCsvOpen(true); }}>CSV取込</Button>
              <Button variant="primary" icon="plus" onClick={openNew}>調整を登録</Button>
            </span>
          )
        }
      />
      <Card>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<FlatRow>
          wide
          stickyLast
          fit
          columns={[
            // 1440・1280 のどちらでも全列が横スクロールなしに見える幅（顧客「見切れているので全部出るように」）
            { key: 'adjustment_no', label: '調整番号', width: 112, nowrap: true, render: (r) => head(r, <Num className="font-semibold text-[var(--color-brand-700)]">{r.adj.adjustment_no}</Num>) },
            {
              key: 'adjustment_date',
              label: '調整日',
              width: 122,
              nowrap: true,
              render: (r) =>
                head(r, editable(r.adj)
                  ? <InlineText type="date" value={String(r.adj.adjustment_date).slice(0, 10)} onSave={(v) => patchHeader(r.adj, { adjustment_date: v })} />
                  : <Num>{ymd(r.adj.adjustment_date)}</Num>),
            },
            { key: 'warehouse_name', label: '倉庫', width: 72, render: (r) => head(r, r.adj.warehouse_name) },
            {
              key: 'reason_name',
              label: '理由',
              width: 100,
              render: (r) =>
                head(r, editable(r.adj)
                  ? (
                    <Select
                      value={r.adj.reason_code ?? ''}
                      className="!h-[26px]"
                      onChange={(e) => void patchHeader(r.adj, { reason_code: e.target.value }).catch(() => undefined)}
                    >
                      {(reasons.data?.values ?? []).map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
                    </Select>
                  )
                  : (r.adj.reason_name ?? '')),
            },
            {
              key: 'note',
              label: '備考',
              width: 120,
              render: (r) =>
                head(r, editable(r.adj)
                  ? <InlineText value={r.adj.note} placeholder="備考" onSave={(v) => patchHeader(r.adj, { note: v || null })} />
                  : (r.adj.note ?? '')),
            },
            { key: 'status', label: '状態', width: 52, render: (r) => head(r, <Badge status={r.adj.status}>{r.adj.status}</Badge>) },
            { key: 'sku_code', label: '商品コード', width: 126, render: (r) => <Num>{r.line?.sku_code ?? ''}</Num> },
            {
              key: 'product_name',
              label: '商品名',
              render: (r) =>
                r.line ? `${r.line.product_name}${r.line.color_name ? ' ' + r.line.color_name : ''}${r.line.size_name ? ' ' + r.line.size_name : ''}` : '',
            },
            {
              key: 'qty',
              label: '数量',
              r: true,
              width: 70,
              render: (r) =>
                r.line ? (
                  <span>
                    {fmtQty(r.line.qty)}
                    {r.line.from_quality_name && r.line.to_quality_name && (
                      <span className="block text-[10.5px] text-[var(--color-ink-3)]">{r.line.from_quality_name}→{r.line.to_quality_name}</span>
                    )}
                  </span>
                ) : '',
            },
            {
              key: '_act',
              label: '',
              width: 100,
              render: (r) =>
                r.first && canUpdate && r.adj.status !== '取消' && (
                  <span className="tbl-acts">
                    {r.adj.status === '登録' && <Button size="sm" variant="primary" loading={rowBusy === r.adj.id} onClick={() => confirmAdj(r.adj)}>調整</Button>}
                    {r.adj.status === '登録' && <Button size="sm" onClick={() => openEdit(r.adj)}>編集</Button>}
                    <Button size="sm" variant="danger" loading={rowBusy === r.adj.id} onClick={() => cancelAdj(r.adj)}>取消</Button>
                  </span>
                ),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.key}
          loading={list.loading}
          rowClassName={(r) => `${r.adj.status === '取消' ? 'opacity-50' : ''} ${r.first ? 'border-t-2 border-[var(--color-line)]' : ''}`}
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>

      <Modal
        open={open}
        title={editing ? `在庫調整の編集（${editing.adjustment_no}）` : '在庫調整の登録'}
        onClose={() => setOpen(false)}
        width={900}
        footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy} onClick={save}>{editing ? '保存する' : '登録する'}</Button></>}
      >
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        <div className="master-grid-2">
          <FormRow label="倉庫" required>
            <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.short_name}</option>)}
            </Select>
          </FormRow>
          <FormRow label="調整日" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="!w-[150px]" />
          </FormRow>
          <FormRow label="理由" required>
            <Select value={reason} onChange={(e) => setReason(e.target.value)} className="!w-[180px]">
              {(reasons.data?.values ?? []).map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
            </Select>
          </FormRow>
          <FormRow label="備考">
            <Textarea rows={1} value={note} onChange={(e) => setNote(e.target.value)} />
          </FormRow>
        </div>
        <div className="mt-3 tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>商品</th>
                <th className="r" style={{ width: 80 }}>増減</th>
                <th style={{ width: 130 }}>品質（前）</th>
                <th style={{ width: 130 }}>品質（後）</th>
                <th>メモ</th>
                <th style={{ width: 96 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td><SearchSelect value={l.sku} onChange={(o) => setLine(l.key, { sku: o })} fetchOptions={fetchSkus} placeholder="商品コード・JAN・商品名" width="100%" /></td>
                  <td className="r"><Input right value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} className="!h-[26px] !w-[70px]" placeholder="-1" /></td>
                  <td><Select value={l.from_quality} onChange={(e) => setLine(l.key, { from_quality: e.target.value })} className="!h-[26px]">{QUALITY.map((q) => <option key={q.v} value={q.v}>{q.l}</option>)}</Select></td>
                  <td><Select value={l.to_quality} onChange={(e) => setLine(l.key, { to_quality: e.target.value })} className="!h-[26px]">{QUALITY.map((q) => <option key={q.v} value={q.v}>{q.l}</option>)}</Select></td>
                  <td><Input value={l.note} onChange={(e) => setLine(l.key, { note: e.target.value })} className="!h-[26px]" /></td>
                  <td className="c whitespace-nowrap">
                    <button type="button" className="btn btn-quiet !px-1.5 !h-6" title="この行をコピーして下に足す" onClick={() => copyLine(l.key)}>コピー</button>
                    <button type="button" className="btn btn-quiet !px-1.5 !h-6" disabled={lines.length === 1} onClick={() => setLines((s) => s.filter((x) => x.key !== l.key))}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <Button size="sm" icon="plus" onClick={() => setLines((s) => [...s, newLine()])}>行を追加</Button>
          <span className="text-[11px] text-[var(--color-ink-3)]">品質の振替（良品→不良など）は「前」「後」を選び、増減には振り替える数を入れます</span>
        </div>
      </Modal>

      <Modal
        open={csvOpen}
        title="在庫調整のCSV取込"
        width={900}
        onClose={() => { setCsvOpen(false); resetCsv(); }}
        footer={
          <>
            <Button onClick={() => { setCsvOpen(false); resetCsv(); }}>やめる</Button>
            <Button variant="primary" loading={csvBusy} disabled={!preview || preview.errors.length > 0 || preview.adjustments.length === 0} onClick={commitCsv}>
              この内容で登録する
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="text-[12px] text-[var(--color-ink-2)]">
            1行目の見出しは <b>調整日,倉庫,理由,商品コード,増減,品質(前),品質(後),メモ,備考</b> にしてください。
            倉庫・理由・品質は名前でもコードでも構いません。同じ調整日・倉庫・理由・備考の行は1件の在庫調整にまとめます。
            ここでは<b>登録だけ</b>を行い、在庫は動きません（一覧の「調整」で反映します）。
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="text-[12px]"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickCsv(f);
            }}
          />
          {csvError ? <ErrorBox error={csvError} onClose={() => setCsvError(null)} /> : null}
          {csvBusy && !preview ? <div className="text-[12px] text-[var(--color-ink-3)]">読み込み中…</div> : null}
          {preview && (
            <>
              <div className="text-[12px]">
                文字コード {preview.encoding}・{preview.rows}行 → 在庫調整 <b>{preview.adjustments.length}</b> 件
                {preview.errors.length > 0 && <span className="ml-2 text-[var(--color-crit-500)] font-semibold">誤り {preview.errors.length} 行（直してから選び直してください）</span>}
              </div>
              {preview.errors.length > 0 && (
                <div className="tbl-wrap max-h-[180px] overflow-auto">
                  <table className="tbl">
                    <thead><tr><th style={{ width: 60 }}>行</th><th>内容</th></tr></thead>
                    <tbody>
                      {preview.errors.slice(0, 200).map((e) => (
                        <tr key={e.row}><td className="num">{e.row}</td><td className="text-[var(--color-crit-500)]">{e.message}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="tbl-wrap max-h-[340px] overflow-auto">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 96 }}>調整日</th>
                      <th style={{ width: 110 }}>倉庫</th>
                      <th style={{ width: 90 }}>理由</th>
                      <th style={{ width: 120 }}>備考</th>
                      <th style={{ width: 140 }}>商品コード</th>
                      <th>商品名</th>
                      <th className="r" style={{ width: 70 }}>増減</th>
                      <th style={{ width: 110 }}>品質</th>
                      <th style={{ width: 110 }}>メモ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.adjustments.flatMap((a, ai) =>
                      a.lines.map((l, li) => (
                        <tr key={`${ai}-${l.row}`} className={li === 0 ? 'border-t-2 border-[var(--color-line)]' : ''}>
                          <td className="num">{li === 0 ? ymd(a.adjustment_date) : ''}</td>
                          <td>{li === 0 ? a.warehouse_name : ''}</td>
                          <td>{li === 0 ? a.reason_name : ''}</td>
                          <td>{li === 0 ? (a.note ?? '') : ''}</td>
                          <td className="num">{l.sku_code}</td>
                          <td>{l.product_name}</td>
                          <td className="r num">{fmtQty(l.qty)}</td>
                          <td>{l.from_quality || l.to_quality ? `${l.from_quality ?? ''}→${l.to_quality ?? ''}` : ''}</td>
                          <td>{l.note ?? ''}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
