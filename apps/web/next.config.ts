import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Our /api/* rewrite proxies the Day-2 pipeline, whose LLM calls run 2+ minutes.
  // Next's dev proxy otherwise hard-kills proxied requests after 30s
  // (proxyTimeout default in next/dist/server/lib/router-utils/proxy-request.js),
  // which destroys the socket before the generated kit can be returned.
  experimental: {
    proxyTimeout: 600_000,
  },
  async rewrites() {
    const api = process.env.API_URL ?? "http://localhost:4000";
    return [
      // Proxy /api/* to the Express backend so the browser only ever talks to this
      // same-origin server. Cookie handling and CORS simply disappear.
      { source: "/api/:path*", destination: `${api}/api/:path*` },
    ];
  },
};

export default nextConfig;