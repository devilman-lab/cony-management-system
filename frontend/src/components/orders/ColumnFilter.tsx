'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import { api } from '@/lib/api';
import { ymd } from '@/lib/format';
import { Button, Input } from '@/components/ui';
import type { Facet, ValueField } from './list-filters';

/**
 * 受注一覧の列の絞り込み（2026-10-13 受注処理編 O-20「各項目、エクセルのフィルターみたいに絞込みができる仕様に」）。
 *
 * 列の見出しの ▼ を押すと、Excel のフィルターのように
 *   - 区分・取引先・納品先・販売カテゴリー・販売担当・状態 … 値の一覧（件数つき・中を検索・すべて選択／解除）から選ぶ
 *   - 出荷日・納品日 … 範囲（から・まで）
 * を出す。件数は、その列以外の絞り込みを当てた中の件数（GET /order-list/facets）。
 * 「OK」で当て、「キャンセル」・外側のクリック・Esc で何も変えずに閉じる。絞り込んでいる列は ▼ の色を変える。
 * 上の絞り込み欄の「状態」「区分」も同じ部品（trigger='button'）で、列の ▼ と同じ絞り込みを直す。
 */

const EDGE = 8;

/** 見出しのボタンの真下（入らなければ真上）に重ねて出す。表の枠（横スクロール）で切れないよう body に描く */
function Popover({
  anchor,
  onClose,
  children,
  width,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  width: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', left: 0, top: 0, visibility: 'hidden' });

  const place = useCallback(() => {
    const a = anchor.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    const h = box.current?.offsetHeight ?? 320;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(EDGE, Math.min(r.left, vw - EDGE - width));
    const below = vh - r.bottom - EDGE;
    const openUp = below < h && r.top - EDGE > below;
    const next: CSSProperties = {
      position: 'fixed',
      left,
      width: Math.min(width, vw - EDGE * 2),
      ...(openUp ? { bottom: vh - r.top + 4 } : { top: r.bottom + 4 }),
      visibility: 'visible',
    };
    setStyle((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [anchor, width]);

  useLayoutEffect(() => {
    place();
  });

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor, onClose, place]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={box}
      role="dialog"
      className="z-[1000] card text-[12.5px] font-normal text-[var(--color-ink)] text-left normal-case tracking-normal whitespace-normal"
      style={{ ...style, boxShadow: '0 10px 28px rgb(18 36 45 / .18)' }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** 見出しの ▼。絞り込んでいるときは色を付けて漏斗の形にする */
function TriggerIcon({ active }: { active: boolean }) {
  return active ? (
    <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden>
      <path d="M3 4h18l-7 8.5V19l-4 2v-8.5L3 4z" fill="currentColor" />
    </svg>
  ) : (
    <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
      <path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface TriggerProps {
  /** icon＝列の見出しの ▼、button＝上の絞り込み欄のボタン（buttonLabel を出す） */
  trigger?: 'icon' | 'button';
  buttonLabel?: ReactNode;
  title: string;
  active: boolean;
}

function useTrigger({ trigger = 'icon', buttonLabel, title, active }: TriggerProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const button =
    trigger === 'button' ? (
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`inp !w-auto inline-flex items-center gap-1.5 text-left !pr-2 ${active ? '!border-[var(--color-brand-500)] !bg-[var(--color-brand-50)]' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="text-[12px] whitespace-nowrap">{buttonLabel}</span>
        <span className={active ? 'text-[var(--color-brand-700)]' : 'text-[var(--color-ink-3)]'}>
          <TriggerIcon active={false} />
        </span>
      </button>
    ) : (
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={active ? `${title}で絞り込んでいます` : `${title}で絞り込む`}
        aria-label={active ? `${title}で絞り込んでいます` : `${title}で絞り込む`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`inline-flex items-center justify-center w-[16px] h-[16px] rounded-[4px] align-middle flex-none border ${
          active
            ? 'bg-[var(--color-brand-700)] border-[var(--color-brand-700)] text-white'
            : 'bg-white border-[var(--color-line-strong)] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] hover:border-[#9fb3bd]'
        }`}
      >
        <TriggerIcon active={active} />
      </button>
    );
  return { open, setOpen, anchor, button };
}

/** 値の一覧で選ぶ絞り込み（区分・取引先・納品先・販売カテゴリー・販売担当・状態） */
export function ValueFilter({
  field,
  title,
  selected,
  onApply,
  query,
  onFacets,
  hint,
  ...trigger
}: {
  field: ValueField;
  title: string;
  /** 今の絞り込み。null＝すべて */
  selected: string[] | null;
  onApply: (next: string[] | null) => void;
  /** ほかの列の絞り込み（件数を数えるため） */
  query: Record<string, string | undefined>;
  /** 読み込んだ値の一覧（絞り込みの説明に名前を出すため、呼び手が覚えておく） */
  onFacets?: (field: ValueField, facets: Facet[]) => void;
  /** 一覧の下に添える説明 */
  hint?: ReactNode;
} & Omit<TriggerProps, 'active' | 'title'>) {
  const active = selected !== null;
  const { open, setOpen, anchor, button } = useTrigger({ ...trigger, title, active });
  const close = useCallback(() => setOpen(false), [setOpen]);
  return (
    <>
      {button}
      {open && (
        <Popover anchor={anchor} onClose={close} width={300}>
          <ValuePanel
            field={field}
            title={title}
            selected={selected}
            query={query}
            onFacets={onFacets}
            hint={hint}
            onCancel={close}
            onApply={(v) => {
              close();
              onApply(v);
            }}
          />
        </Popover>
      )}
    </>
  );
}

function ValuePanel({
  field,
  title,
  selected,
  query,
  onFacets,
  hint,
  onCancel,
  onApply,
}: {
  field: ValueField;
  title: string;
  selected: string[] | null;
  query: Record<string, string | undefined>;
  onFacets?: (field: ValueField, facets: Facet[]) => void;
  hint?: ReactNode;
  onCancel: () => void;
  onApply: (next: string[] | null) => void;
}) {
  const [facets, setFacets] = useState<Facet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set(selected ?? []));
  const [search, setSearch] = useState('');
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    let alive = true;
    api
      .get<Facet[]>('/order-list/facets', { ...JSON.parse(queryKey), field })
      .then((rows) => {
        if (!alive) return;
        // 選んである値が、ほかの列の絞り込みで 0 件になっていても一覧に残す（外せるように）
        const known = new Set(rows.map((r) => r.value));
        const missing = (selected ?? []).filter((v) => !known.has(v)).map((v) => ({ value: v, label: '（いまは該当なし）', count: 0 }));
        const all = [...rows, ...missing];
        setFacets(all);
        // 絞り込んでいない列は、全部に印を付けた状態から始める（Excel と同じ）
        if (selected === null) setChecked(new Set(all.map((r) => r.value)));
        onFacets?.(field, rows);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : '読み込めませんでした'));
    return () => {
      alive = false;
    };
    // 開いたときに一度だけ読む（選んである値・呼び手の関数が変わっても読み直さない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, queryKey]);

  const visible = useMemo(() => {
    const t = search.trim().toLowerCase();
    if (!facets) return [];
    if (!t) return facets;
    return facets.filter((f) => f.label.toLowerCase().includes(t) || (f.code ?? '').toLowerCase().includes(t));
  }, [facets, search]);

  const allVisibleChecked = visible.length > 0 && visible.every((f) => checked.has(f.value));
  const someVisibleChecked = visible.some((f) => checked.has(f.value));
  const toggleAll = () =>
    setChecked((s) => {
      const n = new Set(s);
      for (const f of visible) {
        if (allVisibleChecked) n.delete(f.value);
        else n.add(f.value);
      }
      return n;
    });
  const toggle = (v: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(v)) n.delete(v);
      else n.add(v);
      return n;
    });

  // 探す欄に文字があるときは、Excel と同じく見つかった値のうち印の付いたものだけで絞り込む（2026-10-20 受入テスト T2）
  const picked = (search.trim() ? visible : (facets ?? [])).filter((f) => checked.has(f.value)).map((f) => f.value);
  const apply = () => {
    if (!facets) return;
    // 全部に印が付いていれば絞り込まない（すべて）。並びは一覧の順
    onApply(picked.length === facets.length ? null : picked);
  };

  return (
    <div className="flex flex-col">
      <div className="px-3 pt-2.5 pb-2 border-b border-[var(--color-line)] flex flex-col gap-2">
        <div className="text-[12px] font-bold text-[var(--color-ink-2)]">{title}で絞り込む</div>
        {facets && facets.length > 7 && (
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={field === 'partner' || field === 'destination' ? 'コード・名前で探す' : '探す'}
            className="!h-[28px] !text-[12px]"
            autoFocus
          />
        )}
      </div>
      {error ? (
        <div className="px-3 py-3 text-[12px] text-[var(--color-crit-500)]">{error}</div>
      ) : !facets ? (
        <div className="px-3 py-3 text-[12px] text-[var(--color-ink-3)]">読み込み中…</div>
      ) : (
        <>
          <label className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-line)] cursor-pointer hover:bg-[#f4f7f8]">
            <input
              type="checkbox"
              checked={allVisibleChecked}
              ref={(el) => {
                if (el) el.indeterminate = !allVisibleChecked && someVisibleChecked;
              }}
              onChange={toggleAll}
            />
            <span className="font-semibold">{search.trim() ? '（見つかったものをすべて選択）' : '（すべて選択）'}</span>
          </label>
          <div className="overflow-auto py-1" style={{ maxHeight: 260 }}>
            {visible.length === 0 && <div className="px-3 py-2 text-[12px] text-[var(--color-ink-3)]">見つかりません</div>}
            {visible.map((f) => (
              <label key={f.value} className="flex items-start gap-2 px-3 py-1 cursor-pointer hover:bg-[#f4f7f8]">
                <input type="checkbox" className="mt-[3px]" checked={checked.has(f.value)} onChange={() => toggle(f.value)} />
                <span className={`flex-1 min-w-0 break-words ${f.count === 0 ? 'text-[var(--color-ink-3)]' : ''}`}>
                  {f.code && <span className="num text-[11px] text-[var(--color-ink-3)] mr-1.5">{f.code}</span>}
                  {f.label}
                </span>
                <span className="num text-[11px] text-[var(--color-ink-3)] flex-none">{f.count.toLocaleString('ja-JP')}</span>
              </label>
            ))}
          </div>
        </>
      )}
      {hint && <div className="px-3 pb-1.5 text-[10.5px] text-[var(--color-ink-3)]">{hint}</div>}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--color-line)]">
        {selected !== null && (
          <button type="button" className="text-[11.5px] font-semibold text-[var(--color-brand-600)] hover:underline" onClick={() => onApply(null)}>
            この列の絞り込みを外す
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={onCancel}>
            キャンセル
          </Button>
          <Button size="sm" variant="primary" disabled={!facets || picked.length === 0} onClick={apply} title={picked.length === 0 ? '1つ以上選んでください' : undefined}>
            OK
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 日付の範囲で絞る（出荷日・納品日） */
export function DateRangeFilter({
  title,
  from,
  to,
  onApply,
  ...trigger
}: {
  title: string;
  from: string;
  to: string;
  onApply: (from: string, to: string) => void;
} & Omit<TriggerProps, 'active' | 'title'>) {
  const active = !!(from || to);
  const { open, setOpen, anchor, button } = useTrigger({ ...trigger, title, active });
  const close = useCallback(() => setOpen(false), [setOpen]);
  return (
    <>
      {button}
      {open && (
        <Popover anchor={anchor} onClose={close} width={280}>
          <RangePanel
            title={title}
            from={from}
            to={to}
            onCancel={close}
            onApply={(f, t) => {
              close();
              onApply(f, t);
            }}
          />
        </Popover>
      )}
    </>
  );
}

function RangePanel({
  title,
  from,
  to,
  onCancel,
  onApply,
}: {
  title: string;
  from: string;
  to: string;
  onCancel: () => void;
  onApply: (from: string, to: string) => void;
}) {
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const reversed = !!(f && t && f > t);
  return (
    <div className="flex flex-col">
      <div className="px-3 pt-2.5 pb-1 text-[12px] font-bold text-[var(--color-ink-2)]">{title}で絞り込む</div>
      <div className="px-3 py-2 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
        <span className="text-[11.5px] text-[var(--color-ink-3)]">から</span>
        <Input type="date" value={f} onChange={(e) => setF(e.target.value)} className="!h-[28px]" aria-label={`${title}（から）`} />
        <span className="text-[11.5px] text-[var(--color-ink-3)]">まで</span>
        <Input type="date" value={t} onChange={(e) => setT(e.target.value)} className="!h-[28px]" aria-label={`${title}（まで）`} />
      </div>
      <div className="px-3 pb-1.5 text-[10.5px] text-[var(--color-ink-3)]">
        {reversed ? (
          <span className="text-[var(--color-crit-500)]">「から」が「まで」より後になっています</span>
        ) : f || t ? (
          `${f ? ymd(f) : ''}〜${t ? ymd(t) : ''} の受注を出します（${title}が空の受注は出ません）`
        ) : (
          '片方だけでも絞り込めます'
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--color-line)]">
        {(from || to) && (
          <button type="button" className="text-[11.5px] font-semibold text-[var(--color-brand-600)] hover:underline" onClick={() => onApply('', '')}>
            この列の絞り込みを外す
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={onCancel}>
            キャンセル
          </Button>
          <Button size="sm" variant="primary" disabled={reversed} onClick={() => onApply(f, t)}>
            OK
          </Button>
        </div>
      </div>
    </div>
  );
}
