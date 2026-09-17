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

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const pick = (o: Option) => {
    onChange(o);
    setOpen(false);
    setQ('');
  };

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
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, options.length - 1));
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
            else if (e.key === 'Enter' && options[active]) {
              e.preventDefault();
              pick(options[active]);
            } else if (e.key === 'Escape') setOpen(false);
          }}
        />
      )}
      {open && !disabled && (
        <div className="absolute z-30 mt-1 w-full min-w-[260px] card overflow-hidden" style={{ boxShadow: "0 10px 28px rgb(18 36 45 / .18)" }}>
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
                    <span className="truncate flex-1">{o.label}</span>
                    {o.sub && <span className="text-[10.5px] text-[var(--color-ink-3)] truncate">{o.sub}</span>}
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

/* ---------- よく使う候補の取り方 ---------- */

export interface PartnerRow {
  id: number;
  partner_code: string;
  name1: string;
  short_name?: string | null;
  default_trade_type?: string | null;
  closing_day?: number | null;
  sales_staff_id?: number | null;
}

export const fetchPartners =
  (role?: 'customer' | 'supplier') =>
  async (q: string): Promise<Option[]> => {
    const r = await api.get<Paged<PartnerRow>>('/masters/partners', { q: q || undefined, role, limit: 20 });
    return r.items.map((p) => ({ id: p.id, label: p.name1, sub: p.partner_code, raw: p }));
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
