import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    const apiOrigin = (process.env.API_PROXY_ORIGIN || "http://127.0.0.1:4000").replace(/\/$/, "");
    return [{ source: "/api/v1/:path*", destination: `${apiOrigin}/v1/:path*` }];
  },
};

export default nextConfig;
