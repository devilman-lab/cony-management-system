/**
 * API 呼び出しの窓口。
 *
 * すべての画面はここを通してバックエンド（NestJS）を呼ぶ。
 * トークンの付与、エラーの日本語化、ファイル（PDF・CSV）の受け取りをここで一度だけ書く。
 */

export const API_BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:3001/api';

const TOKEN_KEY = 'cony.token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* プライベートモードなどで保存できないときは、そのセッション限りになる */
  }
}

/** API が返す誤りの内容。画面はこれをそのまま表示できる。 */
export class ApiError extends Error {
  readonly status: number;
  /** 入力項目ごとの誤り（400 のとき） */
  readonly errors: { field: string; reason: string }[];
  /** 在庫不足などの内訳（400/409 のとき） */
  readonly details: string[];

  constructor(status: number, message: string, errors: { field: string; reason: string }[] = [], details: string[] = []) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.details = details;
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const q = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return q ? `${path}${path.includes('?') ? '&' : '?'}${q}` : path;
}

let onUnauthorized: (() => void) | null = null;
/** 401 を受けたときの処理（ログイン画面へ戻す）を登録する。 */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function toError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* 本文なし */
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const message =
    typeof b.message === 'string'
      ? b.message
      : Array.isArray(b.message)
        ? (b.message as string[]).join('、')
        : res.status === 401
          ? 'ログインしてください'
          : res.status === 403
            ? 'この操作を行う権限がありません'
            : `処理できませんでした（${res.status}）`;
  const errors = Array.isArray(b.errors) ? (b.errors as { field: string; reason: string }[]) : [];
  const details = (['shortages', 'over', 'details'] as const).flatMap((k) =>
    Array.isArray(b[k]) ? (b[k] as string[]) : [],
  );
  return new ApiError(res.status, message, errors, details);
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';

  const res = await fetch(`${API_BASE}${withQuery(path, query)}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401) {
    setToken(null);
    onUnauthorized?.();
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),

  /** PDF や CSV を受け取り、ブラウザに保存させる（または新しいタブで開く）。 */
  async download(
    path: string,
    opts: { method?: 'GET' | 'POST'; body?: unknown; query?: Query; open?: boolean } = {},
  ): Promise<{ filename: string; skipped: string[]; confirmed: string[] }> {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';

    const res = await fetch(`${API_BASE}${withQuery(path, opts.query)}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (res.status === 401) {
      setToken(null);
      onUnauthorized?.();
    }
    if (!res.ok) throw await toError(res);

    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const m = /filename\*=UTF-8''([^;]+)/.exec(disposition);
    const filename = m ? decodeURIComponent(m[1]) : 'download';
    const skippedHeader = res.headers.get('X-Skipped-Attachments');
    const skipped = skippedHeader ? decodeURIComponent(skippedHeader).split(',').filter(Boolean) : [];
    const confirmedHeader = res.headers.get('X-Confirmed-Shipments');
    const confirmed = confirmedHeader ? confirmedHeader.split(',').filter(Boolean) : [];

    const url = URL.createObjectURL(blob);
    if (opts.open) {
      window.open(url, '_blank', 'noopener');
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { filename, skipped, confirmed };
  },
};

/** 一覧の共通形。 */
export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** ファイルを base64 にする（CSV取込・添付）。 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
