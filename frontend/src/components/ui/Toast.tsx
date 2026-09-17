'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type Tone = 'good' | 'bad' | 'info';
interface ToastItem {
  id: number;
  text: string;
  tone: Tone;
}

const ToastContext = createContext<((text: string, tone?: Tone) => void) | null>(null);

/** 画面右下の短い知らせ。保存しました／失敗しました、の類。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((text: string, tone: Tone = 'info') => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, text, tone }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), tone === 'bad' ? 7000 : 3500);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 no-print" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={
              'rounded-lg px-3.5 py-2.5 text-[12.5px] font-semibold shadow-lg border max-w-[360px] anim-fade-up ' +
              (t.tone === 'good'
                ? 'bg-[#e8f4ee] text-[#1f6b45] border-[#bfe0cc]'
                : t.tone === 'bad'
                  ? 'bg-[var(--color-crit-50)] text-[var(--color-crit-500)] border-[#e8b4a8]'
                  : 'bg-white text-[var(--color-ink)] border-[var(--color-line)]')
            }
          >
            {t.text}
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
