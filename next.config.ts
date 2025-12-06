import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // 🔥 必须启用，否则 Vercel 无法找到 src/app/api/*
  experimental: {
    appDir: true,
  },

  // 🔥 告诉 Next：源代码在 /src 下
  srcDir: "src",
};

export default nextConfig;
