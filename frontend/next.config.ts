import type { NextConfig } from "next";

/**
 * API_PROXY_TARGET を指定すると、画面と同じオリジンの /api/* を API サーバーへ中継する。
 * Docker で動かすときはこれで 1 つのポートだけ公開すればよく、CORS の設定も要らない。
 * 開発時（next dev）は指定せず、NEXT_PUBLIC_API_URL（既定 http://localhost:3001/api）へ直接つなぐ。
 */
const apiProxyTarget = process.env.API_PROXY_TARGET;

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return apiProxyTarget ? [{ source: "/api/:path*", destination: `${apiProxyTarget}/api/:path*` }] : [];
  },
};

export default nextConfig;
