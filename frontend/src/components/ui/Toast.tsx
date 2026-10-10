'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type Tone = 'good' | 'bad' | 'info';
interface ToastItem {
  id: number;
  text: string;
  tone: Tone;
}

const ToastContext = createContext<((text: string, tone?: Tone) => void) | null>(null);

/**
 * 表示しておく時間（ミリ秒）。
 * エラーは文の長さに応じて延ばす（7秒＋1文字あたり0.1秒、上限30秒）。
 * 削除を断る理由のように、使われている場所を並べた長い文を読み切れるように。
 * どの知らせも右上の×で閉じられる。
 */
function lifetime(text: string, tone: Tone): number {
  if (tone !== 'bad') return 3500;
  return Math.min(30000, 7000 + text.length * 100);
}

/** 画面右下の短い知らせ。保存しました／失敗しました、の類。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const close = useCallback((id: number) => {
    const tm = timers.current.get(id);
    if (tm) clearTimeout(tm);
    timers.current.delete(id);
    setItems((s) => s.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (text: string, tone: Tone = 'info') => {
      const id = Date.now() + Math.random();
      setItems((s) => [...s, { id, text, tone }]);
      timers.current.set(
        id,
        setTimeout(() => close(id), lifetime(text, tone)),
      );
    },
    [close],
  );

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 no-print" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'bad' ? 'alert' : 'status'}
            className={
              'flex items-start gap-2 rounded-lg pl-3.5 pr-1.5 py-2 text-[12.5px] font-semibold shadow-lg border max-w-[420px] anim-fade-up ' +
              (t.tone === 'good'
                ? 'bg-[#e8f4ee] text-[#1f6b45] border-[#bfe0cc]'
                : t.tone === 'bad'
                  ? 'bg-[var(--color-crit-50)] text-[var(--color-crit-500)] border-[#e8b4a8]'
                  : 'bg-white text-[var(--color-ink)] border-[var(--color-line)]')
            }
          >
            <div className="py-0.5 whitespace-pre-wrap break-words min-w-0 flex-1">{t.text}</div>
            <button
              type="button"
              onClick={() => close(t.id)}
              aria-label="閉じる"
              title="閉じる"
              className="shrink-0 w-6 h-6 rounded-md inline-flex items-center justify-center text-[15px] leading-none opacity-70 hover:opacity-100 hover:bg-black/5 cursor-pointer"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastContext);
  if (!push) throw new Error('ToastProvider の中で使ってください');
  return push;
}
