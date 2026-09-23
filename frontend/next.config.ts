import type { NextConfig } from "next";

/**
 * API_PROXY_TARGET を指定すると、画面と同じオリジンの /api/* を API サーバーへ中継する。
 * Docker で動かすときはこれで 1 つのポートだけ公開すればよく、CORS の設定も要らない。
 * 開発時（next dev）は指定せず、NEXT_PUBLIC_API_URL（既定 http://localhost:3001/api）へ直接つなぐ。
 *
 * Vercel では中継を使わない。Vercel の関数は本文 4.5MB までで、
 * CSV取込（base64 で最大 20MB）が通らないため、ブラウザから API へ直接つなぐ
 * （API 側の CORS_ORIGINS に Vercel のURLを入れる）。
 */
const apiProxyTarget = process.env.API_PROXY_TARGET;

/** 自前のコンテナで動かすときだけ standalone 出力にする（Dockerfile が 1 に設定）。 */
const standalone = process.env.NEXT_OUTPUT_STANDALONE === "1";

const nextConfig: NextConfig = {
  ...(standalone ? { output: "standalone" as const } : {}),
  async rewrites() {
    return apiProxyTarget ? [{ source: "/api/:path*", destination: `${apiProxyTarget}/api/:path*` }] : [];
  },
};

export default nextConfig;
