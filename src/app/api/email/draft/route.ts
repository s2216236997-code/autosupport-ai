import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// 防止上游卡死
const withTimeout = <T,>(p: Promise<T>, ms = 15000) =>
  Promise.race<T>([
    p,
    new Promise<T>((_, r) => setTimeout(() => r(new Error("UPSTREAM_TIMEOUT")), ms)),
  ]);

const Body = z.object({
  originalEmail: z.string().min(5, "originalEmail required"),
  style: z.enum(["friendly", "formal", "brief"]).optional().default("friendly"),
  locale: z.enum(["en", "zh"]).optional().default("en"),
});

const SYSTEM = `
你是商家客服邮件写手，目标是生成可直接发送的高质量回复。
- 用 locale 指定的语言写（en/zh）
- 语气根据 style（friendly/formal/brief）
- 开头回应客户核心诉求；随后给出解决方案或下一步
- 如需信息，列出清单（如订单号/收件信息/照片）
- 不要编造事实或无依据承诺
`;

export async function POST(req: NextRequest) {
  try {
    const { originalEmail, style, locale } = Body.parse(await req.json());

    const r = await withTimeout(
      client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM.trim() },
          {
            role: "user",
            content:
              `Customer email:\n${originalEmail}\n\n` +
              `Please reply in locale: ${locale}. Tone: ${style}. ` +
              `Output only the email body text.`,
          },
        ],
        temperature: 0.2,
        max_tokens: 500,
      }),
      15000
    );

    return NextResponse.json({ ok: true, draft: r.choices?.[0]?.message?.content ?? "" });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return NextResponse.json({ error: err?.issues?.[0]?.message }, { status: 400 });
    }
    const msg = String(err?.message || err);
    const isTimeout = /UPSTREAM_TIMEOUT|timeout|aborted/i.test(msg);
    return NextResponse.json({ error: "Upstream failed", detail: msg }, { status: isTimeout ? 504 : 502 });
  }
}
