// src/app/api/email/draft/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 可选：GET 用于健康检查
export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/email/draft" });
}

// 保存邮件草稿（示例逻辑；你可按需替换）
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { userId, to, subject, content } = body as {
      userId?: string;
      to?: string;
      subject?: string;
      content?: string;
    };

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    // TODO: 在这里写入数据库/保存草稿
    // 例如：await supabase.from('email_drafts').insert({ user_id: userId, to, subject, content })

    return NextResponse.json({
      ok: true,
      saved: { to, subject, content },
    });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
