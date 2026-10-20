'use client';

import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@/lib/auth';
import { useDebounce, useList, useWarehouses } from '@/lib/hooks';
import { qty, ymdhm } from '@/lib/format';
import { composeItemName } from '@/lib/item-name';
import { Card, DataTable, ErrorBox, Input, Num, PageHead, Pager, Select, Toolbar, type Column } from '@/components/ui';

interface MoveRow extends Record<string, unknown> {
  id: number;
  moved_at: string;
  movement_type: string;
  /** 画面に出す種別。在庫調整は「在庫調整（再生）」「在庫調整（返品）」のように理由を添える（API が作る。2026-10-18 受入 W3） */
  movement_label?: string;
  ref_table: string;
  ref_id: number;
  /** 元伝票の番号（在庫調整の調整番号・入荷番号・出荷番号・返品番号・受注番号） */
  ref_no?: string | null;
  qty: string;
  /** 実在庫そのもの。在庫を更新できない人には API が返さない（在庫編 Z-02） */
  qty_before?: string;
  qty_after?: string;
  sku_code: string;
  /** 品名（商品名＋カラー＋サイズ。API が作る。2026-10-13 受注処理編 O-01・O-40） */
  product_name: string;
  color_name?: string | null;
  size_name?: string | null;
  warehouse_name: string;
  user_name: string | null;
}

const TYPES = ['入荷', '出荷', '出荷取消', '引当', '引当解除', '返品入庫', '再生', '不良振替', '倉庫間移動', '棚卸調整', '廃棄'];
/** 在庫調整は記録の上では「棚卸調整」。画面の呼び方の「在庫調整」で出す */
const typeLabel = (t: string) => (t === '棚卸調整' ? '在庫調整' : t);
const REF: Record<string, string> = { shipments: '出荷', sales_order_lines: '受注', receipts: '入荷', returns: '返品', stock_adjustments: '在庫調整', refurbishments: '再生' };

/**
 * 種別の絞り込み。チェックの一覧のドロップダウンで、いくつでも選べる
 * （2026-10-13 受注処理編 O-41「一つのみ指定でなく、複数指定したい」）。何も選んでいなければすべて。
 */
function TypeFilter({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  // 選んだ順ではなく、一覧の並び（TYPES の順）で持つ。全部選んだら「すべて」と同じにする
  const toggle = (t: string) => {
    const next = TYPES.filter((x) => (x === t ? !value.includes(t) : value.includes(x)));
    onChange(next.length === TYPES.length ? [] : next);
  };
  const names = value.map(typeLabel);
  const label = names.length === 0 ? 'すべて' : names.length <= 2 ? names.join('・') : `${names[0]} ほか${names.length - 1}`;

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        className="inp !w-[170px] truncate text-left font-medium"
        // 「種別：すべて ▼」の見た目は他の絞り込み（select）と同じにする
        style={{
          backgroundImage: 'linear-gradient(45deg,#0000 50%,#5f6368 50%),linear-gradient(135deg,#5f6368 50%,#0000 50%)',
          backgroundPosition: 'calc(100% - 14px) calc(50% - 2px),calc(100% - 9px) calc(50% - 2px)',
          backgroundRepeat: 'no-repeat',
          backgroundSize: '5px 5px,5px 5px',
          paddingRight: 28,
        }}
        title={names.length > 0 ? `種別：${names.join('・')}` : undefined}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        種別：{label}
      </button>
      {open && (
        <div
          className="absolute left-0 top-[calc(100%+4px)] z-50 w-[200px] rounded-md border border-[var(--color-line-strong)] bg-white p-1"
          style={{ boxShadow: '0 10px 28px rgb(18 36 45 / .18)' }}
        >
          <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12.5px] font-semibold hover:bg-[#f4f7f8]">
            <input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} />
            すべて
          </label>
          <div className="my-1 border-t border-[var(--color-line)]" />
          {TYPES.map((t) => (
            <label key={t} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[12.5px] hover:bg-[#f4f7f8]">
              <input type="checkbox" checked={value.includes(t)} onChange={() => toggle(t)} />
              {typeLabel(t)}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MovesPage() {
  const { can } = useAuth();
  // 「前」「後」は実在庫そのもの。在庫表で実在庫を隠す人（在庫を更新できない人）には列ごと出さない
  // （在庫編 Z-02。在庫表と同じ条件。API もこの人には返さない）
  const showQty = can('S-01', 'update');
  const warehouses = useWarehouses();
  const [types, setTypes] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const dq = useDebounce(q.trim(), 300);
  const [warehouseId, setWarehouseId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const list = useList<MoveRow>('/inventory/stocks/movements', {
    // 種別は複数（カンマ区切り。O-41）、キーワードは商品コード・品名・JAN・元伝票の番号・担当（O-42）
    movement_types: types.length > 0 ? types.join(',') : undefined,
    q: dq || undefined,
    warehouse_id: warehouseId || undefined,
    from: from || undefined,
    to: to || undefined,
  }, 100);

  return (
    <div className="page-body">
      {/* 引当・引当解除の行は前・後が有効在庫（2026-10-20 受入テスト T5。前＋増減＝後で読めるよう、増減も有効在庫の増減で出す） */}
      <PageHead title="入出荷履歴" sub="在庫が動いた記録です。追記だけで、消したり直したりはできません。前・増減・後は実在庫（引当・引当解除の行だけは有効在庫＝実在庫−引当済）です" />
      <Card>
        <Toolbar right={<span className="text-[11.5px] text-[var(--color-ink-2)]"><Num className="text-[13px] text-[var(--color-ink)]">{list.total}</Num> 件</span>}>
          <TypeFilter value={types} onChange={setTypes} />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="商品コード・品名・JAN・伝票番号・担当で検索" className="!w-[280px]" />
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="!w-[140px]">
            <option value="">倉庫：すべて</option>
            {(warehouses.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.short_name}</option>)}
          </Select>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="!w-[140px]" />
          <span className="text-[var(--color-ink-3)]">〜</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="!w-[140px]" />
        </Toolbar>
        {list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : null}
        <DataTable<MoveRow>
          wide
          fit
          columns={[
            // 1280 幅でも担当まで見える幅。日時は日付と時刻の2行に折り返す。
            // 並びは …倉庫・前・増減・後・元伝票・担当（2026-10-13 受注処理編 O-43「前・増減・後の並びが良い」）
            { key: 'moved_at', label: '日時', width: 84, render: (r) => <Num>{ymdhm(r.moved_at)}</Num> },
            {
              key: 'movement_type',
              label: '種別',
              width: 92,
              // 在庫調整の理由は2行目に（「在庫調整」／「（返品）」。かっこの途中で折り返さないように）
              render: (r) => {
                const label = r.movement_label ?? typeLabel(r.movement_type);
                const m = /^(.+?)(（.+）)$/.exec(label);
                return m ? <>{m[1]}<span className="block text-[11.5px] text-[var(--color-ink-2)]">{m[2]}</span></> : label;
              },
            },
            { key: 'sku_code', label: '商品コード', width: 124, render: (r) => <Num>{r.sku_code}</Num> },
            // 商品の欄は品名（商品名＋カラー＋サイズ。O-01・O-40）。API が品名で返す（重ねない決まりなのでもう一度通しても同じ）
            { key: 'product_name', label: '商品', render: (r) => composeItemName(r.product_name, r.color_name, r.size_name) },
            { key: 'warehouse_name', label: '倉庫', width: 72 },
            ...(showQty ? ([{ key: 'qty_before', label: '前', r: true, width: 58, render: (r) => qty(r.qty_before) }] as Column<MoveRow>[]) : []),
            { key: 'qty', label: '増減', r: true, width: 62, render: (r) => <span className={Number(r.qty) < 0 ? 'text-[var(--color-crit-500)]' : ''}>{Number(r.qty) > 0 ? '+' : ''}{qty(r.qty)}</span> },
            ...(showQty ? ([{ key: 'qty_after', label: '後', r: true, width: 58, render: (r) => qty(r.qty_after) }] as Column<MoveRow>[]) : []),
            { key: 'ref_table', label: '元伝票', width: 112, render: (r) => (r.ref_no ? <>{REF[r.ref_table] ?? r.ref_table} <Num>{r.ref_no}</Num></> : `${REF[r.ref_table] ?? r.ref_table} #${r.ref_id}`) },
            { key: 'user_name', label: '担当', width: 72, render: (r) => r.user_name ?? '' },
          ]}
          rows={list.items}
          rowKey={(r) => r.id}
          loading={list.loading}
        />
        <Pager total={list.total} limit={list.limit} offset={list.offset} onChange={list.setOffset} />
      </Card>
    </div>
  );
}
