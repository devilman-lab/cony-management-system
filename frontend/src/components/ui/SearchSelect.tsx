'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { api, type Paged } from '@/lib/api';
import { useDebounce } from '@/lib/hooks';

export interface Option {
  id: number;
  label: string;
  sub?: string;
  /**
   * 候補の下に折り返して全文を出す説明（作業指示の本文など）。改行もそのまま出す。
   * sub は右に1行で出すため、長い文だと候補の枠で切れて読めなかった（2026-10-09 マスター編②）。
   */
  detail?: string;
  /** 呼び手が使う元データ */
  raw?: unknown;
}

const LIST_MAX_HEIGHT = 260;
const EDGE = 8;

/**
 * 候補の一覧を、入力欄の真下（入らなければ真上）に重ねて出す。
 *
 * 一覧は body の直下に描く。入力欄の中に描くと、明細表のセル（overflow:hidden）や
 * 横スクロールする表の枠、ダイアログの枠で切られて、候補が見えず選べなかった
 * （受注入力・入荷・在庫調整・セット登録の商品欄、得意先別商品の SKU 欄）。
 * 位置は入力欄の画面上の座標から決め、スクロールや画面の大きさが変わるたびに付け直す。
 */
function FloatingList({
  anchor,
  listRef,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden', left: 0, top: 0 });

  const place = useCallback(() => {
    const a = anchor.current;
    const list = listRef.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const listHeight = Math.min(list?.offsetHeight ?? LIST_MAX_HEIGHT, LIST_MAX_HEIGHT + 2);
    const below = vh - r.bottom - EDGE;
    const above = r.top - EDGE;
    const openUp = below < listHeight && above > below;
    // 右端からはみ出す分だけ左へずらす（ダイアログの右端で切れていた）
    const width = list?.offsetWidth ?? r.width;
    const left = Math.max(EDGE, Math.min(r.left, vw - EDGE - width));
    const next: CSSProperties = {
      position: 'fixed',
      left,
      minWidth: r.width,
      maxWidth: `min(640px, ${vw - EDGE * 2}px)`,
      ...(openUp ? { bottom: vh - r.top + 4 } : { top: r.bottom + 4 }),
      visibility: 'visible',
    };
    // 描画のたびに測り直すので、位置が変わったときだけ更新する（同じ値で更新し続けないため）
    setStyle((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [anchor, listRef]);

  useLayoutEffect(() => {
    place();
  });

  useEffect(() => {
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [place]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={listRef}
      className="z-[1000] w-max card overflow-hidden"
      style={{ ...style, boxShadow: '0 10px 28px rgb(18 36 45 / .18)' }}
    >
      <div className="overflow-auto" style={{ maxHeight: LIST_MAX_HEIGHT }}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 文字を打って候補から選ぶ入力（取引先・商品など）。
 * 候補は API から都度取る。マスタが何千件あっても画面が重くならない。
 */
export function SearchSelect({
  value,
  onChange,
  fetchOptions,
  placeholder = '検索…',
  width = 260,
  disabled,
  renderOption,
}: {
  value: Option | null;
  onChange: (o: Option | null) => void;
  fetchOptions: (q: string) => Promise<Option[]>;
  placeholder?: string;
  width?: number | string;
  disabled?: boolean;
  renderOption?: (o: Option) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 250);
  const [options, setOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    fetchOptions(dq)
      .then((o) => alive && setOptions(o))
      .catch(() => alive && setOptions([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [dq, open, fetchOptions]);

  const pick = (o: Option) => {
    onChange(o);
    setOpen(false);
    setQ('');
  };

  /**
   * 候補を選ばずに欄を離れたとき。打った文字に合う候補が1つに絞れていればそれを選ぶ
   * （コードをそのまま打って Tab で抜ける使い方）。絞れなければ文字を消して、
   * 「まだ選んでいない」ことが見た目で分かるようにする。
   */
  const commitTyped = () => {
    if (!open && !q) return;
    const t = q.trim().toLowerCase();
    if (t) {
      const hit =
        options.length === 1
          ? options[0]
          : options.find((o) => o.label.toLowerCase().startsWith(t) || (o.sub ?? '').toLowerCase() === t) ?? null;
      const others = hit ? options.filter((o) => o !== hit && o.label.toLowerCase().startsWith(t)) : [];
      if (hit && others.length === 0) onChange(hit);
    }
    setOpen(false);
    setQ('');
  };
  const commitRef = useRef(commitTyped);
  commitRef.current = commitTyped;

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      // 候補の一覧は body の直下にあるので、入力欄の箱とは別に見る
      if (box.current && !box.current.contains(t) && !list.current?.contains(t)) commitRef.current();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div ref={box} className="relative" style={{ width }}>
      {value && !open ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className="inp text-left flex items-center gap-2 !h-[30px]"
          title={value.label}
        >
          <span className="truncate flex-1">{value.label}</span>
          {value.sub && <span className="text-[10.5px] text-[var(--color-ink-3)] truncate max-w-[45%]">{value.sub}</span>}
          {!disabled && (
            <span
              role="button"
              className="text-[var(--color-ink-3)] hover:text-[var(--color-crit-500)] px-1"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
              aria-label="解除"
            >
              ×
            </span>
          )}
        </button>
      ) : (
        <input
          className="inp"
          disabled={disabled}
          placeholder={placeholder}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // 候補のボタンは mousedown を止めているので、ここに来るのは欄の外へ出たとき
            if (open) commitTyped();
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, options.length - 1));
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
            else if (e.key === 'Enter') {
              e.preventDefault();
              if (options[active]) pick(options[active]);
              else commitTyped();
            } else if (e.key === 'Tab') commitTyped();
            else if (e.key === 'Escape') setOpen(false);
          }}
        />
      )}
      {/*
        候補の一覧は、入力欄より広く出す。
        SKU は「品番-カラーサイズ-入数　商品名 カラー サイズ」と長く、欄の幅に合わせると
        カラー・サイズが切れて見分けられなかった（1001 のご指摘）。
        画面からはみ出さないよう上限を付けてある。
      */}
      {open && !disabled && (
        <FloatingList anchor={box} listRef={list}>
          <>
            {loading && options.length === 0 && <div className="px-3 py-2 text-[11.5px] text-[var(--color-ink-3)]">検索中…</div>}
            {!loading && options.length === 0 && <div className="px-3 py-2 text-[11.5px] text-[var(--color-ink-3)]">見つかりません</div>}
            {options.map((o, i) => (
              <button
                type="button"
                key={o.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
                className={`w-full text-left px-3 py-1.5 text-[12.5px] flex items-center gap-2 ${i === active ? 'bg-[var(--color-brand-50)]' : 'hover:bg-[#f4f7f8]'}`}
              >
                {renderOption ? (
                  renderOption(o)
                ) : o.detail !== undefined ? (
                  // 説明つきの候補は、見出しの下に本文を省略せず折り返して出す（作業指示。2026-10-09 マスター編②）。
                  // 一覧の幅は上限（640px）で止まり、その中で折り返すので、長い本文でも全部読める
                  <span className="flex-1 min-w-0 flex flex-col gap-0.5 py-0.5">
                    <span className="font-semibold">{o.label}</span>
                    {o.detail && (
                      <span className="text-[11.5px] leading-[1.5] text-[var(--color-ink-2)] whitespace-pre-wrap break-words">
                        {o.detail}
                      </span>
                    )}
                  </span>
                ) : (
                  <>
                    {/* 候補は切らずに全部見せる。カラー・サイズまで読めないと選べないため。 */}
                    <span className="flex-1 whitespace-nowrap">{o.label}</span>
                    {o.sub && <span className="text-[10.5px] text-[var(--color-ink-3)] whitespace-nowrap">{o.sub}</span>}
                  </>
                )}
              </button>
            ))}
          </>
        </FloatingList>
      )}
    </div>
  );
}

/**
 * 文字を打って候補から**複数**選ぶ入力。選んだものは札（チップ）で並べる。
 *
 * ロイヤリティ規定の「販売先を20社まで」で使う（1001 ご要望）。
 * 1社ずつ行を足していく形だと、20社のうち2社を外すだけでも大量に入力が要るため。
 */
export function MultiSearchSelect({
  values,
  onChange,
  fetchOptions,
  placeholder = '検索して追加…',
  width = '100%',
  max,
  disabled,
  emptyLabel,
}: {
  values: Option[];
  onChange: (o: Option[]) => void;
  fetchOptions: (q: string) => Promise<Option[]>;
  placeholder?: string;
  width?: number | string;
  /** 選べる上限。達すると入力欄を閉じる */
  max?: number;
  disabled?: boolean;
  /** 1つも選んでいないときに出す説明 */
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 250);
  const [options, setOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const full = max !== undefined && values.length >= max;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    fetchOptions(dq)
      .then((o) => alive && setOptions(o))
      .catch(() => alive && setOptions([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [dq, open, fetchOptions]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current && !box.current.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // すでに選んだものは候補から外す
  const picked = new Set(values.map((v) => v.id));
  const left = options.filter((o) => !picked.has(o.id));

  const add = (o: Option) => {
    if (full) return;
    onChange([...values, o]);
    setQ('');
    setActive(0);
  };
  const drop = (id: number) => onChange(values.filter((v) => v.id !== id));

  return (
    <div ref={box} className="relative flex flex-col gap-1.5" style={{ width }}>
      {values.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {values.map((v) => (
            <span
              key={v.id}
              className="inline-flex items-center gap-1 rounded bg-[var(--color-brand-50)] px-1.5 py-0.5 text-[11.5px]"
              title={v.sub ? `${v.label}（${v.sub}）` : v.label}
            >
              <span className="whitespace-nowrap">{v.label}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => drop(v.id)}
                  className="text-[var(--color-ink-3)] hover:text-[var(--color-crit-500)]"
                  aria-label={`${v.label} を外す`}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      ) : (
        emptyLabel && <div className="text-[11px] text-[var(--color-ink-3)]">{emptyLabel}</div>
      )}

      {/*
        使えないときも欄は出しておく。欄ごと消すと「なぜ追加できないのか」が
        画面から分からなくなるため、灰色の欄に理由（先に媒体を選ぶ、など）を出す。
      */}
      {!full && (
        <input
          ref={input}
          className="inp"
          disabled={disabled}
          placeholder={placeholder}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, left.length - 1));
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
            else if (e.key === 'Enter') {
              e.preventDefault();
              if (left[active]) add(left[active]);
            } else if (e.key === 'Escape') setOpen(false);
            else if (e.key === 'Backspace' && q === '' && values.length > 0) drop(values[values.length - 1].id);
          }}
        />
      )}

      {max !== undefined && (
        <div className="text-[11px] text-[var(--color-ink-3)]">
          {values.length} ／ {max} 社{full && '（上限です）'}
        </div>
      )}

      {open && !disabled && !full && (
        <FloatingList anchor={input} listRef={list}>
          <>
            {loading && left.length === 0 && (
              <div className="px-3 py-2 text-[11.5px] text-[var(--color-ink-3)]">検索中…</div>
            )}
            {!loading && left.length === 0 && (
              <div className="px-3 py-2 text-[11.5px] text-[var(--color-ink-3)]">見つかりません</div>
            )}
            {left.map((o, i) => (
              <button
                type="button"
                key={o.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(o)}
                className={`w-full text-left px-3 py-1.5 text-[12.5px] flex items-center gap-2 ${i === active ? 'bg-[var(--color-brand-50)]' : 'hover:bg-[#f4f7f8]'}`}
              >
                <span className="flex-1 whitespace-nowrap">{o.label}</span>
                {o.sub && <span className="text-[10.5px] text-[var(--color-ink-3)] whitespace-nowrap">{o.sub}</span>}
              </button>
            ))}
          </>
        </FloatingList>
      )}
    </div>
  );
}

/* ---------- よく使う候補の取り方 ---------- */

export interface PartnerRow {
  id: number;
  partner_code: string;
  name1: string;
  short_name?: string | null;
  default_trade_type?: string | null;
  closing_day?: number | null;
  /** 既定の販売担当。一覧APIが必ず返す（省略可にすると欠落に気づけない） */
  sales_staff_id: number | null;
}

export const fetchPartners =
  (role?: 'customer' | 'supplier' | 'royalty_payee') =>
  async (q: string): Promise<Option[]> => {
    const r = await api.get<Paged<PartnerRow>>('/masters/partners', { q: q || undefined, role, limit: 20 });
    return r.items.map((p) => ({ id: p.id, label: p.name1, sub: p.partner_code, raw: p }));
  };

/**
 * 販売先を探す。媒体を渡すと「その媒体の販売先」だけに絞る（1001 ご要望）。
 *
 * 媒体は取引先マスタの欄から取る。1社が複数の媒体で売る場合に取りこぼさないよう、
 * 呼び手の側で「媒体で絞らない」を選べるようにしてある（mediaId を渡さない）。
 */
export const fetchCustomers =
  (mediaId?: number | null) =>
  async (q: string): Promise<Option[]> => {
    const r = await api.get<Paged<PartnerRow & { media_name?: string | null }>>('/masters/partners', {
      q: q || undefined,
      role: 'customer',
      media_id: mediaId ?? undefined,
      limit: 50,
    });
    return r.items.map((p) => ({
      id: p.id,
      label: p.name1,
      sub: [p.partner_code, p.media_name].filter(Boolean).join(' / '),
      raw: p,
    }));
  };

export interface SkuRow {
  sku_id: number;
  sku_code: string;
  jan: string | null;
  product_id: number;
  product_code: string;
  /** 商品（品番）の商品名 */
  product_name: string;
  /** SKU ごとの商品名（空なら null） */
  sku_name?: string | null;
  /** SKU の名前。SKU の商品名があればそれ、無ければ商品名（2026-10-09 マスター編②） */
  item_name?: string;
  is_set: boolean;
  tax_rate: string;
  color_name: string | null;
  size_name: string | null;
  /** 取引先を渡して探したときだけ入る（得意先別商品の値） */
  partner_jan?: string | null;
  shipping_jan?: string | null;
  partner_product_code?: string | null;
}

/**
 * SKU の品名（「SKU の商品名があればそれ、無ければ商品名」＋カラー＋サイズ）。
 * 候補の表示と、受注入力で SKU を選んだときの品名に使う（2026-10-09 マスター編②）。
 */
export const skuItemName = (s: Pick<SkuRow, 'product_name' | 'sku_name' | 'item_name' | 'color_name' | 'size_name'>): string =>
  `${s.item_name || s.sku_name?.trim() || s.product_name}${s.color_name ? ' ' + s.color_name : ''}${s.size_name ? ' ' + s.size_name : ''}`;

/**
 * SKU を探す。取引先を渡すと、その取引先の先方JAN・出荷JAN・専用コードでも引け、
 * 候補に出荷JAN（無ければ先方JAN）を出す（1001 ご要望）。
 * isSet を渡すと、セット商品（商品マスタで「セット商品」にしたもの）の SKU だけ／以外だけに絞る。
 */
export const fetchSkusFor =
  (partnerId?: number | null, opts?: { isSet?: boolean }) =>
  async (q: string): Promise<Option[]> => {
    const rows = await api.get<SkuRow[]>('/masters/skus', {
      q: q || undefined,
      partner_id: partnerId ?? undefined,
      is_set: opts?.isSet === undefined ? undefined : String(opts.isSet),
      limit: 20,
    });
    return rows.map((s) => ({
      id: s.sku_id,
      label: `${s.sku_code}　${skuItemName(s)}`,
      sub: s.is_set
        ? 'セット'
        : s.shipping_jan
          ? `出荷JAN ${s.shipping_jan}`
          : s.partner_jan
            ? `先方JAN ${s.partner_jan}`
            : (s.jan ?? ''),
      raw: s,
    }));
  };

export const fetchSkus = fetchSkusFor();

/**
 * セット登録のセット SKU の欄用。商品マスタで「セット商品」にした商品の SKU だけを出す
 * （2026-10-09 マスター編②「商品マスタでセット登録したものだけ表示するようにしてほしい」）。
 */
export const fetchSetSkus = fetchSkusFor(null, { isSet: true });

export interface WorkInstructionRow {
  id: number;
  code: string;
  name: string;
  instruction_body: string | null;
}

/**
 * 作業指示をキーワードで探して選ぶ。
 *
 * プルダウンだと件数が増えたときに中身で探せなかったため（1001 のご指摘）。
 * コード・名称に加えて、出荷指示書に印字する本文も検索の対象にしてある。
 *
 * 候補には本文を省略せず全文を折り返して出す（detail）。以前は先頭40文字で切っていて、
 * 似た作業指示を見分けられなかった（2026-10-09 マスター編②「切れてしまっているので全て出るように」）。
 * 選んだあとの欄には1行に詰めた本文（sub）を出す。
 */
export const fetchWorkInstructions = async (q: string): Promise<Option[]> => {
  const r = await api.get<Paged<WorkInstructionRow>>('/masters/simple/work_instructions', {
    q: q || undefined,
    limit: 20,
  });
  return r.items.map((w) => ({
    id: w.id,
    label: `${w.code}　${w.name}`,
    sub: (w.instruction_body ?? '').replace(/\s+/g, ' ').trim(),
    detail: (w.instruction_body ?? '').trim(),
    raw: w,
  }));
};

export interface ProductRow {
  id: number;
  product_code: string;
  product_name: string;
  brand_name: string | null;
  product_class_name: string | null;
}

/**
 * 商品（品番）を検索して選ぶ。
 *
 * ロイヤリティ規定の「対象の商品」で使う。以前は内部の管理番号を直に打つ欄で、
 * 品番を入れても数字にならず黙って消えていた（1001 のご指摘）。
 */
export const fetchProducts = async (q: string): Promise<Option[]> => {
  const r = await api.get<Paged<ProductRow>>('/masters/products', { q: q || undefined, limit: 20 });
  return r.items.map((p) => ({
    id: p.id,
    label: `${p.product_code}　${p.product_name}`,
    sub: [p.brand_name, p.product_class_name].filter(Boolean).join(' / '),
    raw: p,
  }));
};

export interface DestinationRow {
  id: number;
  delivery_code: string;
  name: string;
  partner_delivery_no: string | null;
  default_warehouse_id: number | null;
}

export async function fetchDestinations(partnerId: number): Promise<DestinationRow[]> {
  return api.get<DestinationRow[]>(`/masters/partners/${partnerId}/delivery-destinations`);
}
