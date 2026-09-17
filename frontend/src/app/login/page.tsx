'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';

import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { Icon, Logo } from '@/components/ui/Icon';

const FEATURES = [
  { icon: 'cart', label: '受注出荷', sub: '引当から請求まで一気通貫' },
  { icon: 'box', label: '在庫管理', sub: '実在庫・引当済・有効在庫をリアルタイム把握' },
  { icon: 'chart', label: '販売分析', sub: '取引先・担当者別の実績を即座に可視化' },
];

function LoginForm() {
  const { login, user, loading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/dashboard';

  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!loading && user) router.replace(next);
  }, [loading, user, next, router]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(loginId.trim(), password);
      router.replace(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'ログインできませんでした。時間をおいてお試しください');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <aside className="login-brand anim-fade-up">
        <div className="login-brand-bg">
          <span className="login-orb login-orb-a" />
          <span className="login-orb login-orb-b" />
          <span className="login-orb login-orb-c" />
          <svg className="login-grid" aria-hidden>
            <defs>
              <pattern id="g" width="80" height="80" patternUnits="userSpaceOnUse">
                <path d="M80 0H0V80" fill="none" stroke="rgba(255,255,255,.06)" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#g)" />
          </svg>
        </div>
        <div className="login-brand-body">
          <div className="login-brand-logo">
            <Logo size={52} />
            <div>
              <div className="login-brand-title">販売管理システム</div>
              <div className="login-brand-sub">CONY Sales Management</div>
            </div>
          </div>
          <p className="login-tagline">WELLNESS FOR FUTURE</p>
          <p className="login-lead">ウェルネス製品の受注・在庫・請求をひとつの画面で。テスト版では実際の業務データをお試しいただけます。</p>
          <ul className="login-features">
            {FEATURES.map((f) => (
              <li key={f.label} className="login-feature">
                <span className="login-feature-icon">
                  <Icon name={f.icon} size={18} />
                </span>
                <span className="login-feature-label">{f.label}</span>
                <span className="login-feature-sub">{f.sub}</span>
              </li>
            ))}
          </ul>
          <p className="login-brand-foot">© CONY Co., Ltd. — テスト版</p>
        </div>
      </aside>

      <section className="login-form-side">
        <div className="login-form-card anim-fade-up">
          <div className="login-form-head">
            <Logo size={36} />
            <div>
              <div className="text-[16px] font-bold text-[var(--color-ink)]">ログイン</div>
              <div className="text-[11.5px] text-[var(--color-ink-3)]">ログインIDでサインイン</div>
            </div>
          </div>

          <form className="login-form" onSubmit={submit}>
            <label className="login-field">
              <span className="login-label">ログインID</span>
              <div className="login-input-wrap">
                <Icon name="users" size={15} className="text-[var(--color-ink-3)]" />
                <input
                  className="login-input"
                  autoComplete="username"
                  autoFocus
                  placeholder="例：sakamoto"
                  value={loginId}
                  onChange={(e) => setLoginId(e.target.value)}
                  required
                />
              </div>
            </label>
            <label className="login-field">
              <span className="login-label">パスワード</span>
              <div className="login-input-wrap">
                <Icon name="lock" size={15} className="text-[var(--color-ink-3)]" />
                <input
                  className="login-input"
                  type={show ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="パスワード"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button type="button" className="login-pw-toggle" onClick={() => setShow((v) => !v)} aria-label={show ? 'パスワードを隠す' : 'パスワードを表示'}>
                  {show ? '隠す' : '表示'}
                </button>
              </div>
            </label>
            {error && <div className="login-error">{error}</div>}
            <button type="submit" className="btn btn-primary login-submit" disabled={busy}>
              {busy ? 'ログイン中…' : 'ログイン'}
            </button>
          </form>
          <p className="login-note">ログインIDとパスワードは管理者から配布されます。忘れた場合は管理者に再設定を依頼してください。</p>
        </div>
      </section>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
