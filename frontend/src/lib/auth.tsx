'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import { api, getToken, setToken, setUnauthorizedHandler } from './api';

export interface SessionUser {
  id: number;
  login_id: string;
  name: string;
}

interface AuthState {
  user: SessionUser | null;
  roles: string[];
  permissions: Set<string>;
  /** 起動直後にトークンを確かめている間は true */
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (loginId: string, password: string) => Promise<void>;
  logout: () => void;
  /** 「機能ID:操作」を持っているか。画面のボタンやメニューの出し分けに使う。 */
  can: (functionId: string, action?: 'view' | 'create' | 'update' | 'delete' | 'print') => boolean;
  /** 原価・仕入単価・ロイヤリティ・利益を見てよいか */
  canSeeSensitive: boolean;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface LoginResponse {
  access_token: string;
  user: SessionUser & { roles: string[]; permissions: string[] };
}

interface MeResponse {
  user: SessionUser;
  roles: string[];
  permissions: string[];
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({ user: null, roles: [], permissions: new Set(), loading: true });

  const clear = useCallback(() => {
    setToken(null);
    setState({ user: null, roles: [], permissions: new Set(), loading: false });
  }, []);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    try {
      const me = await api.get<MeResponse>('/auth/me');
      setState({ user: me.user, roles: me.roles, permissions: new Set(me.permissions), loading: false });
    } catch {
      clear();
    }
  }, [clear]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clear();
      router.replace('/login');
    });
    void refresh();
    return () => setUnauthorizedHandler(null);
  }, [clear, refresh, router]);

  const login = useCallback(async (loginId: string, password: string) => {
    const r = await api.post<LoginResponse>('/auth/login', { login_id: loginId, password });
    setToken(r.access_token);
    setState({
      user: { id: r.user.id, login_id: r.user.login_id, name: r.user.name },
      roles: r.user.roles,
      permissions: new Set(r.user.permissions),
      loading: false,
    });
  }, []);

  const logout = useCallback(() => {
    clear();
    router.replace('/login');
  }, [clear, router]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login,
      logout,
      refresh,
      can: (functionId, action = 'view') => state.permissions.has(`${functionId}:${action}`),
      canSeeSensitive: state.permissions.has('SENSITIVE:view'),
    }),
    [state, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('AuthProvider の中で使ってください');
  return ctx;
}
