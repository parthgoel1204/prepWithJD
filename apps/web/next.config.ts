import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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