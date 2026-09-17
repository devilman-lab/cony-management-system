import type { Metadata, Viewport } from 'next';

import { AuthProvider } from '@/lib/auth';
import { ToastProvider } from '@/components/ui/Toast';

import './globals.css';

export const metadata: Metadata = {
  title: 'コニー販売管理システム',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
