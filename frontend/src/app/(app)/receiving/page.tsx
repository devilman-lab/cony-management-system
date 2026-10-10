'use client';

import { useState, type ReactNode } from 'react';

import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFetch, useList } from '@/lib/hooks';
import { qty as fmtQty, today, ymd } from '@/lib/format';
import { Badge, Button, Card, DataTable, ErrorBox, FormRow, Input, Modal, Num, PageHead, Pager, Select, Toolbar, useConfirm } from '@/components/ui';
import { SearchSelect, fetchSkus, type Option } from '@/components/ui/SearchSelect';
import { useToast } from '@/components/ui/Toast';

interface ReceiptLine {
  line_no: number;
  sku_id: number;
  sku_code: string;
  jan: string | null;
  product_name: string;
  color_name: string | null;
  size_name: string | null;
  qty: string;
  expiry_date: string | null;
  note: string | null;
}

interface ReceiptRow {
  id: number;
  receipt_no: string;
  status: string;
  planned_date: string | null;
  received_date: string | null;
  warehouse_name: string;
  note: string | null;
  lines: ReceiptLine[];
}

/** 一覧の1行＝入荷明細の1行（2026-10-09 在庫編 Z-16「入荷内容も一覧に表示」）。 */
interface FlatRow extends Record<string, unknown> {
  key: string;
  /** 入荷の最初の行。入荷番号・日付・ボタンはこの行にだけ出す */
  first: boolean;
  receipt: ReceiptRow;
  line: ReceiptLine | null;
}

interface ReceiptWarehouse {
  id: number;
  warehouse_code: string;
  short_name: string;
}

interface LineDraft {
  key: number;
  sku: Option | null;
  qty: string;
  expiry_date: string;
  note: string;
}

let seq = 1;
const newLine = (): LineDraft => ({ key: seq++, sku: null, qty: '1', expiry_date: '', note: '' });

/** 保存済みの明細を、編集画面の行に戻す。候補の表示は fetchSkus と同じ形にする。 */
const toDraft = (l: ReceiptLine): LineDraft => ({
  key: seq++,
  sku: {
    id: l.sku_id,
    label: `${l.sku_code}　${l.product_name}${l.color_name ? ' ' + l.color_name : ''}${l.size_name ? ' ' + l.size_name : ''}`,
    sub: l.jan ?? '',
  },
  qty: String(Number(l.qty)),
  expiry_date: l.expiry_date ? String(l.expiry_date).slice(0, 10) : '',
  note: l.note ?? '',
});

export default function ReceivingPage() {
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  // 入荷倉庫は「コニー倉庫」に決め打ち（Z-07）。選ばせると別の倉庫に入れる間違いが起きるため、表示だけにする
  const fixedWarehouse = useFetch<ReceiptWarehouse>('/inventory/receipt-warehouse');

  const [status, setStatus] = useState('');
  const list = useList<ReceiptRow>('/inventory/receipts', { status: status || undefined });

  const [open, setOpen] = useState(false);
  /** 編集中の入荷。null なら新規登録 */
  const [editing, setEditing] = useState<ReceiptRow | null>(null);
  const [planned, setPlanned] = useState(today());
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<number | 'new' | null>(null);

  const setLine = (key: number, p: Partial<LineDraft>) => setLines((s) => s.map((l) => (l.key === key ? { ...l, ...p } : l)));
  /** 行をコピーして、その行のすぐ下に足す（Z-13）。カラー違いを続けて入れるとき、商品欄だけ選び直せばよい */
  const copyLine = (key: number) =>
    setLines((s) => {
      const i = s.findIndex((l) => l.key === key);
      return [...s.slice(0, i + 1), { ...s[i], key: seq++ }, ...s.slice(i + 1)];
    });

  const openNew = () => {
    setEditing(null);
    setPlanned(today());
    setNote('');
    setLines([newLine()]);
    setError(null);
    setOpen(true);
  };

  const openEdit = async (r: ReceiptRow) => {
    setError(null);
    try {
      // 一覧の明細は表示用なので、編集は詳細を取り直して始める（他の人が直した直後でも最新から）
      const d = await api.get<ReceiptRow>(`/inventory/receipts/${r.id}`);
      setEditing(d);
      setPlanned(d.planned_date ? String(d.planned_date).slice(0, 10) : '');
      setNote(d.note ?? '');
      setLines(d.lines.length > 0 ? d.lines.map(toDraft) : [newLine()]);
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
    if (!editing && !fixedWarehouse.data) return setError(fixedWarehouse.error ?? new ApiError(400, '入荷倉庫が決まっていません'));
    setBusy('new');
    // 仕入先・仕入単価・ロットは画面から外した（Z-08・Z-09・Z-11）。API は受け付けるが送らない
    const body = {
      planned_date: planned || null,
      note: note || null,
      lines: lines.map((l, i) => ({
        line_no: i + 1,
        sku_id: l.sku?.id,
        qty: l.qty,
        expiry_date: l.expiry_date || null,
        note: l.note || null,
      })),
    };
    try {
      if (editing) {
        await api.patch(`/inventory/receipts/${editing.id}`, body);
        toast(`${editing.receipt_no} を直しました`, 'good');
      } else {
        await api.post('/inventory/receipts', { ...body, warehouse_id: fixedWarehouse.data?.id });
        toast('入荷予定を登録しました。届いたら「入荷確定」を押してください', 'good');
      }
      setOpen(false);
      setLines([newLine()]);
      await list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  // 入荷確定すると実在庫が増えているので、取り消せるのは予定（指示）のままのものだけ
  const [cancelId, setCancelId] = useState<number | null>(null);
  const cancel = async (r: ReceiptRow) => {
    if (!(await confirm(`${r.receipt_no} を取り消しますか`, '入荷予定を取り消します。入荷済のものは取り消せません。', true))) return;
    setCancelId(r.id);
    try {
      await api.post(`/inventory/receipts/${r.id}/cancel`);
      toast('取り消しました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '取り消せませんでした', 'bad');
    } finally {
      setCancelId(null);
    }
  };

  const receive = async (r: ReceiptRow) => {
    if (!(await confirm(`${r.receipt_no} を入荷確定しますか`, '実在庫が増えます。'))) return;
    setBusy(r.id);
    try {
      await api.post(`/inventory/receipts/${r.id}/receive`, { received_date: today() });
      toast('入荷を計上し、在庫に反映しました', 'good');
      await list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusy(null);
    }
  };

  const rows: FlatRow[] = list.items.flatMap((r): FlatRow[] =>
    r.lines.length === 0
      ? [{ key: `${r.id}`, first: true, receipt: r, line: null }]
      : r.lines.map((l, i) => ({ key: `${r.id}-${l.line_no}`, first: i === 0, receipt: r, line: l })),
  );
  const head = (r: FlatRow, v: ReactNode) => (r.first ? v : null);

  return (
    <div className="page-body">
      {element}
      <PageHead
        title="入荷登録"
        sub="入荷予定を登録し、届いた時点で「入荷確定」を押すと実在庫が増えます。確定前なら「編集」で直せます"
        right={can('S-03', 'create') && <Button variant="primary" icon="plus" onClick={openNew}>入荷を登録</Button>}
      />
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.total}</Num> 件</span>}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="!w-[130px]">
            <option value="">状態：取消を除く</option>
            <option value="指示">入荷予定</option>
            <option value="入荷済">入荷済</option>
            <option value="取消">取消</option>
          </Select>
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<FlatRow>
          wide
          stickyLast
          fit
          columns={[
            // 1440・1280 のどちらでも全列が横スクロールなしに見える幅（顧客「見切れているので全部出るように」）
            { key: 'receipt_no', label: '入荷番号', width: 112, nowrap: true, render: (r) => head(r, <Num className="font-semibold text-[var(--color-brand-700)]">{r.receipt.receipt_no}</Num>) },
            // 入荷予定日の列は外した（Z-14）。確定前は登録した日、確定後は確定した日を入荷日として出す
            { key: 'received_date', label: '入荷日', width: 84, nowrap: true, render: (r) => head(r, <Num>{ymd(r.receipt.received_date ?? r.receipt.planned_date)}</Num>) },
            { key: 'warehouse_name', label: '倉庫', width: 72, render: (r) => head(r, r.receipt.warehouse_name) },
            { key: 'status', label: '状態', width: 70, render: (r) => head(r, <Badge status={r.receipt.status}>{r.receipt.status === '指示' ? '入荷予定' : r.receipt.status}</Badge>) },
            { key: 'sku_code', label: '商品コード', width: 126, render: (r) => <Num>{r.line?.sku_code ?? ''}</Num> },
            { key: 'product_name', label: '商品名', render: (r) => r.line?.product_name ?? '' },
            { key: 'color_name', label: 'カラー', width: 80, render: (r) => r.line?.color_name ?? '' },
            { key: 'size_name', label: 'サイズ', width: 56, render: (r) => r.line?.size_name ?? '' },
            { key: 'qty', label: '数量', r: true, width: 58, render: (r) => fmtQty(r.line?.qty) },
            { key: 'note', label: '備考', width: 120, render: (r) => r.line?.note ?? '' },
            {
              key: '_act',
              label: '',
              width: 122,
              render: (r) => r.first && r.receipt.status === '指示' && (
                <span className="tbl-acts">
                  {can('S-03', 'update') && <Button size="sm" onClick={() => openEdit(r.receipt)}>編集</Button>}
                  {can('S-03', 'update') && <Button size="sm" variant="primary" loading={busy === r.receipt.id} onClick={() => receive(r.receipt)}>入荷確定</Button>}
                  {can('S-03', 'delete') && <Button size="sm" variant="danger" loading={cancelId === r.receipt.id} onClick={() => cancel(r.receipt)}>取消</Button>}
                </span>
              ),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.key}
          loading={list.loading}
          // 入荷の区切りが分かるように、2件目以降の入荷の最初の行に線を引く
          rowClassName={(r) => `${r.receipt.status === '取消' ? 'opacity-50' : ''} ${r.first ? 'border-t-2 border-[var(--color-line)]' : ''}`}
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>

      <Modal
        open={open}
        title={editing ? `入荷の編集（${editing.receipt_no}）` : '入荷の登録'}
        onClose={() => setOpen(false)}
        width={900}
        footer={<><Button onClick={() => setOpen(false)}>やめる</Button><Button variant="primary" loading={busy === 'new'} disabled={!editing && !fixedWarehouse.data} onClick={save}>{editing ? '保存する' : '登録する'}</Button></>}
      >
        {error ? <div className="mb-3"><ErrorBox error={error} onClose={() => setError(null)} /></div> : null}
        {!editing && fixedWarehouse.error ? <div className="mb-3"><ErrorBox error={fixedWarehouse.error} /></div> : null}
        <div className="master-grid-2">
          <FormRow label="入荷倉庫">
            <span className="px-1 text-[12.5px] font-semibold">{editing ? editing.warehouse_name : (fixedWarehouse.data?.short_name ?? '')}</span>
          </FormRow>
          <FormRow label="入荷日">
            <Input type="date" value={planned} onChange={(e) => setPlanned(e.target.value)} className="!w-[150px]" />
          </FormRow>
          <FormRow label="備考">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </FormRow>
        </div>
        <div className="mt-3 tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>商品</th>
                <th className="r" style={{ width: 80 }}>数量</th>
                <th style={{ width: 140 }}>賞味期限</th>
                <th style={{ width: 200 }}>備考</th>
                <th style={{ width: 96 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td><SearchSelect value={l.sku} onChange={(o) => setLine(l.key, { sku: o })} fetchOptions={fetchSkus} placeholder="商品コード・JAN・商品名" width="100%" /></td>
                  <td className="r"><Input right value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} className="!h-[26px] !w-[70px]" /></td>
                  <td><Input type="date" value={l.expiry_date} onChange={(e) => setLine(l.key, { expiry_date: e.target.value })} className="!h-[26px]" /></td>
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
        <div className="mt-2"><Button size="sm" icon="plus" onClick={() => setLines((s) => [...s, newLine()])}>行を追加</Button></div>
      </Modal>
    </div>
  );
}
