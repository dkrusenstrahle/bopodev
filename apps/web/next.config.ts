import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  async redirects() {
    return [
      { source: "/ask", destination: "/chat", permanent: true },
      { source: "/loops", destination: "/routines", permanent: true },
      { source: "/loops/:path*", destination: "/routines/:path*", permanent: true }
    ];
  }
};

export default nextConfig;
