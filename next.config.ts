import type { NextConfig } from "next";
const nextConfig = {
  reactStrictMode: true,
  experimental: { serverActions: {} },
} satisfies NextConfig;
export default nextConfig;
