'use client';

import { useEffect, useState, type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

import { ApiError } from '@/lib/api';
import { statusTone } from '@/lib/format';
import { Icon } from './Icon';

/* ---------- カードと見出し ---------- */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function CardHead({
  title,
  sub,
  right,
}: {
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="card-head flex items-center gap-3 px-3.5 py-2.5 border-b border-[var(--color-line)]">
      <div className="min-w-0">
        <h2 className="text-[13.5px] font-bold text-[var(--color-ink)] truncate">{title}</h2>
        {sub && <div className="text-[11px] text-[var(--color-ink-3)] mt-0.5">{sub}</div>}
      </div>
      {right && <div className="ml-auto flex items-center gap-2 flex-wrap">{right}</div>}
    </div>
  );
}

/** 画面の一番上。見出し＋右側の操作。 */
export function PageHead({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 flex-wrap">
      <div className="min-w-0">
        <h1 className="text-[17px] font-bold text-[var(--color-brand-700)] tracking-wide">{title}</h1>
        {sub && <div className="text-[11.5px] text-[var(--color-ink-3)] mt-0.5">{sub}</div>}
      </div>
      {right && <div className="ml-auto flex items-center gap-2 flex-wrap">{right}</div>}
    </div>
  );
}

/** 一覧の上の絞り込み欄。 */
export function Toolbar({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <div className="toolbar flex items-center gap-2 px-3.5 py-2.5 border-b border-[var(--color-line)] flex-wrap">
      {children}
      {right && <div className="toolbar-actions ml-auto flex items-center gap-2 flex-wrap">{right}</div>}
    </div>
  );
}

/* ---------- 数値・状態 ---------- */

export function Num({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`num ${className}`}>{children}</span>;
}

export function Badge({ status, children, className = '' }: { status?: string | null; children?: ReactNode; className?: string }) {
  return <span className={`bdg ${statusTone(status)} ${className}`}>{children ?? status ?? ''}</span>;
}

export function KpiTile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'warn' | 'crit' | 'info' }) {
  const border = tone === 'crit' ? 'border-[#e8b4a8]' : tone === 'warn' ? 'border-[#e8c88a]' : 'border-[var(--color-line)]';
  return (
    <div className={`card ${border} px-3.5 py-3`}>
      <div className="text-[11px] text-[var(--color-ink-3)] font-semibold tracking-wide">{label}</div>
      <div className="num text-[20px] font-bold text-[var(--color-ink)] mt-0.5 leading-tight">{value}</div>
      {sub && <div className="text-[11px] text-[var(--color-ink-3)] mt-1">{sub}</div>}
    </div>
  );
}

/* ---------- 入力 ---------- */

export function Input(props: InputHTMLAttributes<HTMLInputElement> & { right?: boolean }) {
  const { className = '', right, ...rest } = props;
  return <input {...rest} className={`inp ${right ? 'num rt' : ''} ${className}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', ...rest } = props;
  return <select {...rest} className={`inp ${className}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props;
  return <textarea {...rest} className={`inp ${className}`} />;
}

/** 表形式のフォームの1行（ラベル｜入力）。 */
export function FormRow({ label, hint, required, children }: { label: ReactNode; hint?: ReactNode; required?: boolean; children: ReactNode }) {
  return (
    <div className="form-row">
      <div className="form-row-label field-label h-full flex items-center px-3 py-1.5 gap-1">
        {label}
        {required && <span className="text-[var(--color-crit-500)] text-[10px]">必須</span>}
      </div>
      <div className="px-3 py-1.5 flex items-center gap-2 min-w-0">
        {children}
        {hint && <span className="form-row-hint text-[10.5px] text-[var(--color-ink-3)]">{hint}</span>}
      </div>
    </div>
  );
}

/** ラベルを上に置く小さめの入力欄（絞り込みなどに）。 */
export function Field({ label, children, className = '' }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-[10.5px] font-semibold text-[var(--color-ink-3)]">{label}</span>
      {children}
    </label>
  );
}

/* ---------- ボタン ---------- */

export function Button({
  children,
  variant = 'ghost',
  size,
  loading,
  icon,
  className = '',
  type = 'button',
  ...rest
}: {
  children?: ReactNode;
  variant?: 'primary' | 'ghost' | 'quiet' | 'danger';
  size?: 'sm' | 'lg';
  loading?: boolean;
  icon?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      {...rest}
      disabled={rest.disabled || loading}
      className={`btn btn-${variant} ${size ? `btn-${size}` : ''} ${className}`}
    >
      {icon && <Icon name={icon} size={14} />}
      {loading ? '処理中…' : children}
    </button>
  );
}

/* ---------- エラー表示 ---------- */

export function ErrorBox({ error, onClose }: { error: unknown; onClose?: () => void }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const message = e ? e.message : error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-lg border border-[#e8b4a8] bg-[var(--color-crit-50)] text-[var(--color-crit-500)] px-3.5 py-2.5 text-[12.5px]">
      <div className="flex items-start gap-2">
        <Icon name="warn" size={16} className="mt-0.5 flex-none" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{message}</div>
          {e && e.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {e.errors.map((x, i) => (
                <li key={i}>
                  {x.field}：{x.reason}
                </li>
              ))}
            </ul>
          )}
          {e && e.details.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {e.details.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          )}
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="btn btn-quiet btn-sm !text-[var(--color-crit-500)]">
            閉じる
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- 表 ---------- */

export interface Column<T> {
  key: string;
  label: ReactNode;
  /** 右寄せ（数値） */
  r?: boolean;
  c?: boolean;
  width?: number | string;
  render?: (row: T, index: number) => ReactNode;
}

export function DataTable<T extends Record<string, unknown>>({
  columns,
  rows,
  rowKey,
  empty = 'データがありません',
  onRowClick,
  selectedKey,
  loading,
  wide,
  stickyLast,
  rowClassName,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  selectedKey?: string | number | null;
  loading?: boolean;
  wide?: boolean;
  /** 列が多い表で、いちばん右の列（操作ボタン）を右端に貼り付ける。 */
  stickyLast?: boolean;
  rowClassName?: (row: T) => string;
}) {
  // 列幅の合計より狭い画面では横スクロールにする（列が1文字に潰れないように）
  const fixed = columns.reduce((a, c) => a + (typeof c.width === 'number' ? c.width : 0), 0);
  const autos = columns.filter((c) => typeof c.width !== 'number').length;
  const minWidth = Math.max(wide ? 960 : 520, fixed + autos * 150);
  return (
    <div className={wide ? 'tbl-wrap-wide' : 'tbl-wrap'}>
      <table className={`tbl${stickyLast ? ' tbl-stick-last' : ''}`} style={{ minWidth }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.r ? 'r' : c.c ? 'c' : ''} style={c.width ? { width: c.width } : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="text-center py-8 text-[var(--color-ink-3)]">
                読み込み中…
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="text-center py-8 text-[var(--color-ink-3)]">
                {empty}
              </td>
            </tr>
          )}
          {rows.map((row, i) => {
            const k = rowKey(row);
            return (
              <tr
                key={k}
                className={`${selectedKey === k ? 'sel' : ''} ${onRowClick ? 'cursor-pointer' : ''} ${rowClassName ? rowClassName(row) : ''}`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.r ? 'r num' : c.c ? 'c' : ''}>
                    {c.render ? c.render(row, i) : ((row[c.key] as ReactNode) ?? '')}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  if (total <= limit && offset === 0) {
    return <div className="px-3.5 py-2 text-[11.5px] text-[var(--color-ink-3)]">{total} 件</div>;
  }
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex items-center gap-2 px-3.5 py-2 text-[11.5px] text-[var(--color-ink-2)] border-t border-[var(--color-line)]">
      <span className="num">
        {total} 件中 {Math.min(offset + 1, total)}〜{Math.min(offset + limit, total)}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <button type="button" className="btn btn-ghost btn-sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          前へ
        </button>
        <span className="num px-1">
          {page} / {pages}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
          次へ
        </button>
      </div>
    </div>
  );
}

/* ---------- モーダル ---------- */

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 640,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop fixed inset-0 z-[80] bg-[#12242d66] flex items-center justify-center no-print" onClick={onClose}>
      <div
        className="modal-panel card w-full flex flex-col max-h-[92vh]"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className="flex items-center gap-2 px-4 h-[46px] border-b border-[var(--color-line)]">
          <div className="text-[13.5px] font-bold truncate">{title}</div>
          <button type="button" onClick={onClose} className="ml-auto shell-icon-btn !w-8 !h-8" aria-label="閉じる">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body overflow-auto p-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--color-line)]">{footer}</div>}
      </div>
    </div>
  );
}

/** 「本当に行いますか」の確認。 */
export function useConfirm() {
  const [state, setState] = useState<{ title: string; body?: ReactNode; danger?: boolean; resolve: (ok: boolean) => void } | null>(null);
  const confirm = (title: string, body?: ReactNode, danger = false) =>
    new Promise<boolean>((resolve) => setState({ title, body, danger, resolve }));
  const element = state ? (
    <Modal
      open
      title={state.title}
      width={420}
      onClose={() => {
        state.resolve(false);
        setState(null);
      }}
      footer={
        <>
          <Button
            onClick={() => {
              state.resolve(false);
              setState(null);
            }}
          >
            やめる
          </Button>
          <Button
            variant={state.danger ? 'danger' : 'primary'}
            onClick={() => {
              state.resolve(true);
              setState(null);
            }}
          >
            実行する
          </Button>
        </>
      }
    >
      <div className="text-[12.5px] text-[var(--color-ink-2)]">{state.body ?? 'この操作を行います。よろしいですか。'}</div>
    </Modal>
  ) : null;
  return { confirm, element };
}

/* ---------- 読み込み中 ---------- */

export function Loading({ text = '読み込み中…' }: { text?: string }) {
  return <div className="px-3.5 py-6 text-center text-[12px] text-[var(--color-ink-3)]">{text}</div>;
}

export function Empty({ text = 'データがありません' }: { text?: string }) {
  return <div className="px-3.5 py-6 text-center text-[12px] text-[var(--color-ink-3)]">{text}</div>;
}
