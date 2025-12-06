import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 千万不要加 experimental.appDir，也不要写 output: 'export'
};

export default nextConfig;
