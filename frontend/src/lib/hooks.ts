'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type Paged } from './api';

/** GET を1回行い、結果と再読込を返す。deps が変わると読み直す。 */
export function useFetch<T>(path: string | null, query?: Record<string, string | number | boolean | undefined | null>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const key = JSON.stringify([path, query ?? null]);
  const tick = useRef(0);

  const reload = useCallback(async () => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    const mine = ++tick.current;
    setLoading(true);
    setError(null);
    try {
      const r = await api.get<T>(path, query);
      if (mine === tick.current) setData(r);
    } catch (e) {
      if (mine === tick.current) setError(e);
    } finally {
      if (mine === tick.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

/** 一覧（items/total/limit/offset）を、ページ送りと絞り込みつきで扱う。 */
export function useList<T>(
  path: string,
  filters: Record<string, string | number | boolean | undefined | null>,
  limit = 50,
) {
  const [offset, setOffset] = useState(0);
  const filterKey = JSON.stringify(filters);
  useEffect(() => setOffset(0), [filterKey]);
  const res = useFetch<Paged<T> | T[]>(path, { ...filters, limit, offset });
  // 配列で返す一覧（倉庫など）もそのまま扱えるようにする
  const items = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
  const total = Array.isArray(res.data) ? res.data.length : (res.data?.total ?? 0);
  return {
    items,
    total,
    limit,
    offset,
    setOffset,
    loading: res.loading,
    error: res.error,
    reload: res.reload,
  };
}

/** 値を少し待ってから反映する（検索欄に打つたびに呼ばないため） */
export function useDebounce<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/* ---------- よく使う参照データ ---------- */

export interface SalesCategory {
  id: number;
  code: string;
  name: string;
}
export interface Warehouse {
  id: number;
  warehouse_code: string;
  short_name: string;
}
export interface SimpleRow {
  id: number;
  code: string;
  name: string;
  is_active?: boolean;
  sort_order?: number | null;
  note?: string | null;
}
export interface CodeValue {
  id: number;
  code: string;
  name: string;
}

export function useSalesCategories() {
  return useFetch<SalesCategory[]>('/masters/sales-categories');
}
export function useWarehouses() {
  return useFetch<Warehouse[]>('/masters/warehouses');
}
export function useSimpleMaster(kind: string, includeInactive = false) {
  return useFetch<Paged<SimpleRow>>(`/masters/simple/${kind}`, { limit: 200, include_inactive: includeInactive ? 'true' : undefined });
}
export function useCodes(category: string) {
  return useFetch<{ category: { code: string; name: string }; values: CodeValue[] }>(`/masters/codes/${category}`);
}
