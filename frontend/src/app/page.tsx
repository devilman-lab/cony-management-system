'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useAuth } from '@/lib/auth';

/** 入口。ログイン済みならダッシュボード、そうでなければログイン画面へ。 */
export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (loading) return;
    router.replace(user ? '/dashboard' : '/login');
  }, [user, loading, router]);
  return null;
}
