'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { api, type Paged } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebounce, useFetch } from '@/lib/hooks';
import { ymd } from '@/lib/format';
import { Button, Card, ErrorBox, Input, Num, PageHead, Pager, Select, Toolbar, useConfirm } from '@/components/ui';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { AllocateResultDialog, type AllocateResult } from '@/components/orders/AllocateResultDialog';
import { ValueFilter } from '@/components/orders/ColumnFilter';
import { OrderListTable } from '@/components/orders/OrderListTable';
import {
  DEFAULT_STATUS,
  FIELD_KEY,
  FIELD_TITLE,
  defaultFilters,
  filterQuery,
  restoreFilters,
  sameFilters,
  type Facet,
  type OrderFilters,
  type OrderPatch,
  type OrderRow,
  type ValueField,
} from '@/components/orders/list-filters';

/**
 * 受注一覧（2026-10-13 受注処理編 O-15〜O-22 で作り直し）。
 *
 * - 既定は 出荷日の新しい順、状態は 引当待ち・引当済 だけ（O-18）。受注番号の新しい順にもできる。
 * - キーワード（O-16）・出荷日の範囲（O-17）・状態と区分（複数）・取消も表示。列の見出しの ▼ で Excel のように絞り込む（O-20）。
 * - 引当待ちの受注を選んで「引当（N件）」でまとめて引き当て、受注ごとの結果を出す（O-19）。1件ずつの「引当」も残す。
 * - 明細を表示（O-21）、編集モード（O-22）。
 * 絞り込み・並び・表示件数はこのタブの中で覚えておき、受注の詳細から戻っても同じ一覧に戻る。
 * ダッシュボードの「引当待ち」から来たとき（?status=引当待ち）は、その状態で開く。
 */

const STORE_KEY = 'cony.orders.list';
const LIMITS = [20, 50, 100, 200];
const ALLOCATABLE = ['未確定', '引当待ち', '引当済'];

interface ViewPrefs {
  sort: 'ship_date' | 'order_no';
  withLines: boolean;
  limit: number;
}
const DEFAULT_VIEW: ViewPrefs = { sort: 'ship_date', withLines: false, limit: 50 };

/** 最初の絞り込み。URL の ?status= があればそれ、無ければこのタブで覚えておいたもの、無ければ既定 */
function initialState(statusParam: string | null): { filters: OrderFilters; view: ViewPrefs } {
  let stored: { filters?: unknown; view?: unknown } = {};
  try {
    const raw = window.sessionStorage.getItem(STORE_KEY);
    if (raw) stored = JSON.parse(raw) as typeof stored;
  } catch {
    /* 読めなければ既定 */
  }
  const v = (stored.view ?? {}) as Partial<ViewPrefs>;
  const view: ViewPrefs = {
    sort: v.sort === 'order_no' ? 'order_no' : 'ship_date',
    withLines: v.withLines === true,
    limit: LIMITS.includes(Number(v.limit)) ? Number(v.limit) : DEFAULT_VIEW.limit,
  };
  if (statusParam) return { filters: statusFilters(statusParam), view };
  return { filters: restoreFilters(stored.filters) ?? defaultFilters(), view };
}

/** URL の ?status=（カンマ区切り）を、その状態だけの絞り込みにする（ほかは既定） */
function statusFilters(param: string): OrderFilters {
  const status = param.split(',').map((s) => s.trim()).filter(Boolean);
  return { ...defaultFilters(), status: status.length > 0 ? status : [...DEFAULT_STATUS] };
}

/** 値の一覧の絞り込みを短い文にする（上の絞り込み欄のボタンと、絞り込みの説明に使う） */
function summarize(values: string[] | null, label: (v: string) => string, max = 2): string {
  if (!values) return 'すべて';
  const names = values.map(label);
  return names.length <= max ? names.join('・') : `${names.slice(0, max).join('・')} ほか${names.length - max}`;
}

function OrdersList() {
  const params = useSearchParams();
  const router = useRouter();
  const { can } = useAuth();
  const toast = useToast();
  const { confirm, element } = useConfirm();

  const [init] = useState(() => initialState(params.get('status')));
  const [filters, setFilters] = useState<OrderFilters>(init.filters);
  const [view, setView] = useState<ViewPrefs>(init.view);
  const [editMode, setEditMode] = useState(false);
  const [qText, setQText] = useState(init.filters.q);
  const dq = useDebounce(qText, 400);
  const [offset, setOffset] = useState(0);
  /** 引き当てる受注（ページをまたいで選べる。行は結果の画面で出荷日などを添えるために覚えておく） */
  const [selected, setSelected] = useState<Map<number, OrderRow>>(new Map());
  const [busyId, setBusyId] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ results: AllocateResult[]; rows: Map<number, OrderRow> } | null>(null);
  /** 値の一覧で読んだ名前（取引先などの絞り込みの説明に使う） */
  const [labels, setLabels] = useState<Partial<Record<ValueField, Record<string, string>>>>({});

  const canAllocate = can('D-01', 'create');
  const canEdit = can('O-01', 'update');

  // ダッシュボードから ?status= で来たときは、その状態で開いたあと URL から外す
  // （詳細から戻ったときに、直した絞り込みが URL の値で上書きされないように）。一覧を開いたまま来たときも同じ
  const statusParam = params.get('status');
  useEffect(() => {
    if (!statusParam) return;
    setQText('');
    setFilters(statusFilters(statusParam));
    router.replace('/orders', { scroll: false });
  }, [statusParam, router]);

  useEffect(() => {
    setFilters((f) => (f.q === dq ? f : { ...f, q: dq }));
  }, [dq]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORE_KEY, JSON.stringify({ filters, view }));
    } catch {
      /* 覚えておけなくても一覧は使える */
    }
  }, [filters, view]);

  const query = useMemo(() => filterQuery(filters), [filters]);
  // 絞り込み・並び・件数を変えたら1ページ目に戻し、選択も外す（見えていない受注を引き当てないように）
  const resetKey = JSON.stringify([query, view.sort, view.limit]);
  useEffect(() => {
    setOffset(0);
    setSelected(new Map());
  }, [resetKey]);

  const res = useFetch<Paged<OrderRow>>('/order-list', {
    ...query,
    sort: view.sort,
    with_lines: view.withLines ? 'true' : undefined,
    limit: view.limit,
    offset,
  });
  const rows = res.data?.items ?? [];
  const total = res.data?.total ?? 0;
  const times = useFetch<{ id: number; code: string; name: string }[]>(editMode ? '/order-list/delivery-times' : null);

  const patchFilters = useCallback((p: Partial<OrderFilters>) => setFilters((f) => ({ ...f, ...p })), []);
  const resetFilters = () => {
    setQText('');
    setFilters(defaultFilters());
  };
  const onFacets = useCallback((field: ValueField, facets: Facet[]) => {
    setLabels((m) => ({ ...m, [field]: { ...(m[field] ?? {}), ...Object.fromEntries(facets.map((f) => [f.value, f.label])) } }));
  }, []);

  /** 値の名前（読んだ値の一覧、無ければ今の一覧の行から） */
  const labelOf = (field: ValueField, value: string): string => {
    if (field === 'type' || field === 'status') return value;
    const known = labels[field]?.[value];
    if (known) return known;
    if (value === 'none') return field === 'partner' ? '（取引先なし）' : field === 'destination' ? '（納品先なし）' : '（なし）';
    const id = Number(value);
    const row =
      field === 'partner'
        ? rows.find((r) => r.partner_id === id)?.partner_name
        : field === 'destination'
          ? rows.find((r) => r.delivery_destination_id === id)?.delivery_name
          : field === 'category'
            ? rows.find((r) => r.sales_category_id === id)?.sales_category_name
            : rows.find((r) => r.sales_staff_id === id)?.staff_name;
    return row ?? `ID ${value}`;
  };

  // 今の絞り込みの説明（× でその絞り込みだけ外せる）
  const chips: { key: string; text: string; clear: () => void }[] = [];
  if (filters.q.trim()) {
    chips.push({
      key: 'q',
      text: `キーワード「${filters.q.trim()}」`,
      clear: () => {
        setQText('');
        patchFilters({ q: '' });
      },
    });
  }
  if (filters.ship_from || filters.ship_to) {
    chips.push({ key: 'ship', text: `出荷日 ${ymd(filters.ship_from)}〜${ymd(filters.ship_to)}`, clear: () => patchFilters({ ship_from: '', ship_to: '' }) });
  }
  if (filters.delivery_from || filters.delivery_to) {
    chips.push({
      key: 'delivery',
      text: `納品日 ${ymd(filters.delivery_from)}〜${ymd(filters.delivery_to)}`,
      clear: () => patchFilters({ delivery_from: '', delivery_to: '' }),
    });
  }
  for (const field of ['status', 'type', 'partner', 'destination', 'category', 'staff'] as ValueField[]) {
    const v = filters[FIELD_KEY[field]];
    if (v) {
      chips.push({
        key: field,
        text: `${FIELD_TITLE[field]}：${summarize(v, (x) => labelOf(field, x), 3)}`,
        clear: () => patchFilters({ [FIELD_KEY[field]]: null } as Partial<OrderFilters>),
      });
    }
  }
  if (filters.include_cancelled) chips.push({ key: 'cancelled', text: '取消も表示', clear: () => patchFilters({ include_cancelled: false }) });
  const isDefault = sameFilters(filters, defaultFilters());

  const toggle = (r: OrderRow) =>
    setSelected((m) => {
      const n = new Map(m);
      if (n.has(r.id)) n.delete(r.id);
      else n.set(r.id, r);
      return n;
    });
  const toggleAll = (list: OrderRow[], on: boolean) =>
    setSelected((m) => {
      const n = new Map(m);
      for (const r of list) {
        if (on) n.set(r.id, r);
        else n.delete(r.id);
      }
      return n;
    });

  /** 選んだ受注をまとめて引き当てる（出荷日の早い順。O-19） */
  const allocateSelected = async () => {
    if (selected.size === 0) return;
    const snapshot = new Map(selected);
    setBulkBusy(true);
    try {
      const results = await api.post<AllocateResult[]>('/order-list/allocate', { order_ids: [...snapshot.keys()] });
      setBulkResult({ results, rows: snapshot });
      setSelected(new Map());
    } catch (e) {
      toast(e instanceof Error ? e.message : '引き当てられませんでした', 'bad');
    } finally {
      setBulkBusy(false);
      await res.reload();
    }
  };

  const allocateOne = async (row: OrderRow) => {
    setBusyId(row.id);
    try {
      const r = await api.post<{ status: string; shortages: string[] }>(`/orders/${row.id}/allocate`);
      toast(
        r.status === '引当済' ? `${row.order_no} を引き当てました` : `${row.order_no} はまだ在庫が足りません（${r.shortages.join('、')}）`,
        r.status === '引当済' ? 'good' : 'info',
      );
      await res.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (row: OrderRow) => {
    if (!(await confirm(`${row.order_no} を取り消しますか`, '引当は戻ります。取り消した受注は元に戻せません。', true))) return;
    setBusyId(row.id);
    try {
      await api.post(`/orders/${row.id}/cancel`);
      toast(`${row.order_no} を取り消しました`, 'good');
      await res.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : '失敗しました', 'bad');
    } finally {
      setBusyId(null);
    }
  };

  /** 一覧のまま直す（O-22）。直したあとの行で描き直す。失敗したら理由を出して例外（欄は元に戻る） */
  const save = async (row: OrderRow, patch: OrderPatch, what: string) => {
    try {
      const next = await api.patch<OrderRow>(`/order-list/${row.id}`, patch);
      res.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === row.id ? { ...x, ...next } : x)) } : d));
      toast(`${row.order_no}：${what}を保存しました`, 'good');
    } catch (e) {
      toast(`${row.order_no}：${e instanceof Error ? e.message : `${what}を保存できませんでした`}`, 'bad');
      throw e;
    }
  };

  const toggleEdit = () => {
    const next = !editMode;
    setEditMode(next);
    // 備考・適用は明細の下で直すので、編集モードにしたら明細も出す
    if (next && !view.withLines) setView((v) => ({ ...v, withLines: true }));
  };

  const actions = (r: OrderRow) => {
    const open = !r.is_cancelled && ALLOCATABLE.includes(r.status);
    return (
      <div className="tbl-acts">
        {r.status === '引当待ち' && !r.is_cancelled && canAllocate && (
          <Button size="sm" variant="primary" className="!px-[5px]" loading={busyId === r.id} onClick={() => allocateOne(r)}>
            引当
          </Button>
        )}
        {open && canEdit && (
          <Link href={`/orders/${r.id}/edit`} className="btn btn-ghost btn-sm !px-[5px]">
            修正
          </Link>
        )}
        {open && can('O-01', 'delete') && (
          <Button size="sm" variant="quiet" className="!px-[5px] !text-[var(--color-crit-500)]" loading={busyId === r.id} onClick={() => cancel(r)}>
            取消
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="page-body">
      {element}
      {bulkResult && <AllocateResultDialog results={bulkResult.results} rows={bulkResult.rows} onClose={() => setBulkResult(null)} />}
      <PageHead
        title="受注一覧"
        sub="登録しただけでは在庫は引き当てません。引き当てる受注にチェックを付けて「引当」を押してください（出荷日の早い順に引き当てます）"
        right={
          can('O-01', 'create') && (
            <Link href="/orders/new" className="btn btn-primary">
              ＋ 受注入力
            </Link>
          )
        }
      />
      <Card>
        <Toolbar
          right={
            <>
              <Select
                value={view.sort}
                onChange={(e) => setView((v) => ({ ...v, sort: e.target.value === 'order_no' ? 'order_no' : 'ship_date' }))}
                className="!w-[158px]"
                aria-label="並び"
              >
                <option value="ship_date">出荷日の新しい順</option>
                <option value="order_no">受注番号の新しい順</option>
              </Select>
              <label className="flex items-center gap-1 text-[11.5px] text-[var(--color-ink-2)] whitespace-nowrap">
                <input type="checkbox" checked={view.withLines} onChange={(e) => setView((v) => ({ ...v, withLines: e.target.checked }))} />
                明細を表示
              </label>
              {canEdit && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={editMode}
                  onClick={toggleEdit}
                  className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[var(--color-ink-2)] whitespace-nowrap"
                  title="出荷日・納品日・納品時間・備考・適用を一覧のまま直します"
                >
                  <span className={`relative inline-block w-[32px] h-[18px] rounded-full transition-colors ${editMode ? 'bg-[var(--color-brand-700)]' : 'bg-[#c3cbd0]'}`}>
                    <span
                      className={`absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${editMode ? 'translate-x-[14px]' : ''}`}
                    />
                  </span>
                  編集モード
                </button>
              )}
              <Select
                value={view.limit}
                onChange={(e) => setView((v) => ({ ...v, limit: Number(e.target.value) }))}
                className="!w-[90px]"
                aria-label="表示件数"
              >
                {LIMITS.map((n) => (
                  <option key={n} value={n}>
                    {n}件
                  </option>
                ))}
              </Select>
            </>
          }
        >
          <div className="relative">
            <Icon name="search" size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-ink-3)] pointer-events-none" />
            <Input
              value={qText}
              onChange={(e) => setQText(e.target.value)}
              placeholder="受注番号・取引先・納品先・商品コード・品名・JAN・備考"
              className="!w-[272px] !pl-7"
              aria-label="キーワード"
              title="受注番号・先方発注番号・取引先・納品先・お届け先・出荷依頼書備考・納品書備考・明細の商品コード／品名／JAN で探します。空白で区切ると、すべてを含む受注を出します"
            />
          </div>
          <span className="text-[11.5px] text-[var(--color-ink-3)] whitespace-nowrap">出荷日</span>
          <Input type="date" value={filters.ship_from} onChange={(e) => patchFilters({ ship_from: e.target.value })} className="!w-[134px]" aria-label="出荷日（から）" />
          <span className="text-[var(--color-ink-3)]">〜</span>
          <Input type="date" value={filters.ship_to} onChange={(e) => patchFilters({ ship_to: e.target.value })} className="!w-[134px]" aria-label="出荷日（まで）" />
          <ValueFilter
            trigger="button"
            buttonLabel={`状態：${summarize(filters.status, (s) => s)}`}
            field="status"
            title="状態"
            selected={filters.status}
            onApply={(v) => patchFilters({ status: v })}
            query={query}
            onFacets={onFacets}
            hint="取り消した受注は「取消も表示」で出します"
          />
          <ValueFilter
            trigger="button"
            buttonLabel={`区分：${summarize(filters.order_type, (s) => s)}`}
            field="type"
            title="区分"
            selected={filters.order_type}
            onApply={(v) => patchFilters({ order_type: v })}
            query={query}
            onFacets={onFacets}
          />
          <label className="flex items-center gap-1 text-[11.5px] text-[var(--color-ink-2)] whitespace-nowrap">
            <input type="checkbox" checked={filters.include_cancelled} onChange={(e) => patchFilters({ include_cancelled: e.target.checked })} />
            取消も表示
          </label>
        </Toolbar>
        <div className="flex items-center gap-x-2.5 gap-y-1.5 px-3.5 py-2 border-b border-[var(--color-line)] flex-wrap text-[11.5px]">
          <span className="text-[var(--color-ink-2)] whitespace-nowrap">
            <Num className="text-[13px] font-semibold text-[var(--color-ink)]">{total.toLocaleString('ja-JP')}</Num> 件
          </span>
          {chips.map((c) => (
            <span
              key={c.key}
              className="inline-flex items-center gap-1 max-w-full rounded-full border border-[#bcd2dc] bg-[var(--color-brand-50)] text-[var(--color-brand-800)] pl-2.5 pr-1 py-[1px]"
            >
              <span className="truncate">{c.text}</span>
              <button
                type="button"
                onClick={c.clear}
                className="w-[16px] h-[16px] inline-flex items-center justify-center rounded-full hover:bg-[#d5e4eb]"
                aria-label={`${c.text} の絞り込みを外す`}
                title="この絞り込みを外す"
              >
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
          {!isDefault && (
            <button type="button" className="btn btn-quiet btn-sm" onClick={resetFilters} title="最初の表示（状態が引当待ち・引当済）に戻します">
              絞り込みを解除
            </button>
          )}
          {canAllocate && (
            <div className="ml-auto flex items-center gap-2">
              {selected.size > 0 && (
                <>
                  <span className="text-[var(--color-ink-2)] whitespace-nowrap">{selected.size}件を選んでいます</span>
                  <button type="button" className="btn btn-quiet btn-sm" onClick={() => setSelected(new Map())}>
                    選択を外す
                  </button>
                </>
              )}
              <Button
                size="sm"
                variant="primary"
                disabled={selected.size === 0}
                loading={bulkBusy}
                onClick={allocateSelected}
                title={selected.size === 0 ? '引き当てる受注（引当待ち）にチェックを付けてください' : '選んだ受注を出荷日の早い順に引き当てます'}
              >
                引当（{selected.size}件）
              </Button>
            </div>
          )}
        </div>
        {editMode && (
          <div className="px-3.5 py-1.5 text-[11.5px] leading-relaxed bg-[var(--color-sand-100)] border-b border-[var(--color-sand-300)] text-[var(--color-ink-2)]">
            編集モード：出荷日・納品日・納品時間と、明細の下の出荷依頼書備考・納品書備考、各行の出荷依頼書適用・納品書適用を、その場で直せます。
            欄を離れると保存します（引当はそのまま）。出荷済みの受注は出荷日を、取り消した受注はどれも直せません。
          </div>
        )}
        {res.error ? (
          <div className="p-3">
            <ErrorBox error={res.error} />
          </div>
        ) : null}
        <OrderListTable
          rows={rows}
          loading={res.loading}
          withLines={view.withLines}
          editMode={editMode}
          selectable={canAllocate}
          selected={new Set(selected.keys())}
          onToggle={toggle}
          onToggleAll={toggleAll}
          filters={filters}
          query={query}
          onFilter={patchFilters}
          onFacets={onFacets}
          deliveryTimes={times.data ?? []}
          onSave={save}
          actions={actions}
          empty={isDefault ? '引当待ち・引当済の受注はありません' : '該当する受注はありません（「絞り込みを解除」で最初の表示に戻ります）'}
        />
        <Pager total={total} limit={view.limit} offset={offset} onChange={setOffset} />
      </Card>
    </div>
  );
}

export default function OrdersPage() {
  return (
    <Suspense>
      <OrdersList />
    </Suspense>
  );
}
