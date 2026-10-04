'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { api, type Paged } from '@/lib/api';
import { useDebounce } from '@/lib/hooks';

export interface Option {
  id: number;
  label: string;
  sub?: string;
  /** 呼び手が使う元データ */
  raw?: unknown;
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
      if (box.current && !box.current.contains(e.target as Node)) commitRef.current();
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
        <div
          className="absolute z-30 mt-1 w-max min-w-full card overflow-hidden"
          style={{ maxWidth: 'min(640px, 86vw)', boxShadow: '0 10px 28px rgb(18 36 45 / .18)' }}
        >
          <div className="max-h-[260px] overflow-auto">
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
                ) : (
                  <>
                    {/* 候補は切らずに全部見せる。カラー・サイズまで読めないと選べないため。 */}
                    <span className="flex-1 whitespace-nowrap">{o.label}</span>
                    {o.sub && <span className="text-[10.5px] text-[var(--color-ink-3)] whitespace-nowrap">{o.sub}</span>}
                  </>
                )}
              </button>
            ))}
          </div>
        </div>
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
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
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
        <div
          className="absolute z-30 top-full w-max min-w-full card overflow-hidden"
          style={{ maxWidth: 'min(640px, 86vw)', boxShadow: '0 10px 28px rgb(18 36 45 / .18)' }}
        >
          <div className="max-h-[260px] overflow-auto">
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
          </div>
        </div>
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
  product_name: string;
  is_set: boolean;
  tax_rate: string;
  color_name: string | null;
  size_name: string | null;
}

export const fetchSkus = async (q: string): Promise<Option[]> => {
  const rows = await api.get<SkuRow[]>('/masters/skus', { q: q || undefined, limit: 20 });
  return rows.map((s) => ({
    id: s.sku_id,
    label: `${s.sku_code}　${s.product_name}${s.color_name ? ' ' + s.color_name : ''}${s.size_name ? ' ' + s.size_name : ''}`,
    sub: s.is_set ? 'セット' : (s.jan ?? ''),
    raw: s,
  }));
};

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
 */
export const fetchWorkInstructions = async (q: string): Promise<Option[]> => {
  const r = await api.get<Paged<WorkInstructionRow>>('/masters/simple/work_instructions', {
    q: q || undefined,
    limit: 20,
  });
  return r.items.map((w) => ({
    id: w.id,
    label: `${w.code}　${w.name}`,
    sub: (w.instruction_body ?? '').replace(/\s+/g, ' ').slice(0, 40),
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
