import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Remote chain/identity verification can require several serial RPC reads.
  experimental: { proxyTimeout: 120_000 },
  async rewrites() {
    const apiOrigin = (process.env.API_PROXY_ORIGIN || "http://127.0.0.1:4000").replace(/\/$/, "");
    return [{ source: "/api/v1/:path*", destination: `${apiOrigin}/v1/:path*` }];
  },
};

export default nextConfig;
