// src/app/api/ping/route.ts
import { NextResponse } from "next/server";

/**
 * 运行在 Node.js 运行时，并强制动态渲染
 *（这样每次请求都会命中函数，便于健康检查）
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ping
 * 健康检查 / 探针
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "/api/ping",
    ts: Date.now(),
  });
}

/**
 * 可选：HEAD /api/ping
 * 有些探针会用 HEAD；复用 GET 的逻辑但不返回 body。
 */
export async function HEAD() {
  return new NextResponse(null, {
    status: 200,
    headers: { "x-ping": "ok" },
  });
}
