'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { useAuth } from '@/lib/auth';
import { NAV, findNav } from '@/lib/nav';
import { Icon, Logo } from './ui/Icon';

/**
 * 画面の骨組み。左にメニュー、上に見出し、中に各画面。
 * デモ版と同じ class 名（shell-*）を使い、見た目をそろえている。
 */
export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, roles, loading, can, logout } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [loading, user, pathname, router]);

  useEffect(() => {
    setNavOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.classList.toggle('shell-nav-open', navOpen);
    return () => document.body.classList.remove('shell-nav-open');
  }, [navOpen]);

  // 画面幅で「携帯」「机上」を切り替える（デモ版と同じ。CSS がこの class を見る）
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    const apply = () => {
      document.documentElement.classList.toggle('layout-mobile', mq.matches);
      document.documentElement.classList.toggle('layout-desktop', !mq.matches);
      if (!mq.matches) setNavOpen(false);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  if (loading || !user) {
    return (
      <div className="h-full grid place-items-center text-[12.5px] text-[var(--color-ink-3)]">
        {loading ? '読み込み中…' : 'ログイン画面へ移動します…'}
      </div>
    );
  }

  const current = findNav(pathname);
  const initials = user.name.slice(0, 1);
  const todayLabel = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const roleLabel = roles.includes('ADMIN') ? '管理者' : roles.includes('ACCOUNTING') ? '経理' : roles.includes('OPERATOR') ? '作業者' : roles.includes('VIEWER') ? '閲覧者' : '（ロールなし）';

  return (
    <div className="shell-root">
      <button type="button" className={`shell-overlay no-print ${navOpen ? 'is-open' : ''}`} aria-label="メニューを閉じる" onClick={() => setNavOpen(false)} />

      <nav className={`shell-sidebar no-print text-[#dbe8ee] ${navOpen ? 'is-open' : ''}`} style={{ background: 'linear-gradient(180deg,#22495a 0%,#1b3b49 62%,#163241 100%)' }}>
        <div className="shell-sidebar-head h-[52px] flex items-center gap-2.5 px-4 border-b border-white/10">
          <Logo size={28} />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-bold text-white leading-tight tracking-wide">販売管理システム</div>
            <div className="text-[9.5px] text-[#9fbcc9] leading-tight">CONY Sales Management</div>
          </div>
          <button type="button" className="shell-sidebar-close btn btn-quiet !text-white/80" onClick={() => setNavOpen(false)} aria-label="閉じる">
            <Icon name="x" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {NAV.map((sec) => {
            const items = sec.items.filter((it) => !it.functionId || can(it.functionId));
            if (items.length === 0) return null;
            return (
              <div key={sec.sec || '_top'} className="mb-1">
                {sec.sec && <div className="px-4 pt-2.5 pb-1 text-[10px] font-bold tracking-[.09em] text-[#7ea3b3]">{sec.sec}</div>}
                {items.map((it) => {
                  const active = current?.item.href === it.href;
                  return (
                    <Link
                      key={it.href}
                      href={it.href}
                      className={`relative w-full flex items-center gap-2.5 px-4 h-[36px] text-[12.5px] transition-colors ${
                        active ? 'bg-white/10 text-white font-semibold' : 'hover:bg-white/5 text-[#dbe8ee]'
                      }`}
                    >
                      {active && <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-[#e9e0c4]" />}
                      <Icon name={it.icon} size={15} className="flex-none opacity-80" />
                      <span className="truncate">{it.label}</span>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="px-4 py-2.5 border-t border-white/10 text-[10px] text-[#8fb3c2] leading-relaxed">
          © CONY Co., Ltd.
          <br />
          テスト版（第3段階）
        </div>
      </nav>

      <div className="shell-main">
        <header className="shell-header no-print flex-none bg-white border-b border-[var(--color-line)]">
          <div className="shell-header-row shell-header-primary">
            <button type="button" className="shell-menu-btn shell-icon-btn" onClick={() => setNavOpen(true)} aria-label="メニューを開く">
              <Icon name="menu" size={20} />
            </button>
            <div className="shell-crumb flex items-center gap-1.5 text-[12.5px] min-w-0">
              {current?.sec && (
                <>
                  <span className="shell-crumb-sec text-[var(--color-ink-3)]">{current.sec}</span>
                  <Icon name="chevron" size={12} className="text-[var(--color-ink-3)]" />
                </>
              )}
              <span className="font-bold text-[var(--color-brand-700)] truncate">{current?.item.label ?? ''}</span>
            </div>
            <div className="shell-header-quick ml-auto flex items-center gap-1.5">
              <div className="shell-hide-mobile text-[11.5px] text-[var(--color-ink-2)] mr-1">
                <span className="font-semibold">{user.name}</span>
                <span className="text-[var(--color-ink-3)] ml-1.5">{roleLabel}</span>
              </div>
              <div className="relative">
                <button type="button" className="shell-avatar-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="ユーザーメニュー">
                  <span className="shell-avatar">{initials}</span>
                </button>
                {menuOpen && (
                  <>
                    <button type="button" className="fixed inset-0 z-40 cursor-default" onClick={() => setMenuOpen(false)} aria-label="閉じる" />
                    <div className="shell-user-menu card z-50">
                      <div className="px-3 py-2.5 border-b border-[var(--color-line)]">
                        <div className="text-[13px] font-bold">{user.name}</div>
                        <div className="text-[11px] text-[var(--color-ink-3)] truncate">
                          {user.login_id} ・ {roleLabel}
                        </div>
                      </div>
                      <div className="p-2 flex flex-col gap-1">
                        <button type="button" className="btn btn-ghost w-full mt-1" onClick={logout}>
                          <Icon name="logout" size={14} />
                          ログアウト
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="shell-header-row shell-header-secondary">
            <div className="shell-crumb flex items-center gap-1.5 text-[12.5px] min-w-0">
              {current?.sec && (
                <>
                  <span className="shell-crumb-sec text-[var(--color-ink-3)]">{current.sec}</span>
                  <Icon name="chevron" size={12} className="text-[var(--color-ink-3)]" />
                </>
              )}
              <span className="font-bold text-[var(--color-brand-700)] truncate">{current?.item.label ?? ''}</span>
            </div>
            <div className="shell-header-meta flex items-center gap-2.5 flex-wrap">
              <div className="shell-hide-tablet text-[11.5px] text-[var(--color-ink-2)] num">{todayLabel}</div>
              <div className="shell-user-block flex items-center gap-2 pl-3 border-l border-[var(--color-line)]">
                <div className="w-[26px] h-[26px] rounded-full bg-[var(--color-brand-700)] text-white grid place-items-center text-[11px] font-bold">{initials}</div>
                <div className="leading-tight min-w-0">
                  <div className="text-[12px] font-semibold truncate max-w-[120px]">{user.name}</div>
                  <div className="text-[10px] text-[var(--color-ink-3)] max-w-[140px] truncate">{roleLabel}</div>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
                  <Icon name="logout" size={13} />
                  <span className="shell-hide-tablet">ログアウト</span>
                </button>
              </div>
            </div>
          </div>
        </header>
        <main className="shell-content flex-1">{children}</main>
      </div>
    </div>
  );
}
