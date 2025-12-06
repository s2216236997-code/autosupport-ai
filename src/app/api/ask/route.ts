// src/app/api/ask/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const HEALTH_TABLE = process.env.HEALTH_TABLE ?? "documents";
const USE_RAG = process.env.USE_RAG === "1";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// 仅当 env 齐备时才动态加载 supabaseAdmin，避免构建期爆炸
async function getSupabaseAdminSafe() {
  const hasEnv =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.SUPABASE_SERVICE_ROLE; // admin 客户端建议用 service_role
  if (!hasEnv) return null;
  try {
    const mod = await import("@/lib/supabaseAdmin");
    // 允许模块导出 null，调用端自己判断
    return (mod as any).supabaseAdmin ?? null;
  } catch {
    return null;
  }
}

// ---------- GET: 健康检查 ----------
export async function GET() {
  let dbOk = false;
  try {
    const supabaseAdmin = await getSupabaseAdminSafe();
    if (supabaseAdmin) {
      const { error } = await supabaseAdmin.from(HEALTH_TABLE).select("id").limit(1);
      dbOk = !error;
    }
  } catch {
    dbOk = false;
  }

  return NextResponse.json({
    ok: true,
    env: {
      hasOpenAIKey: !!OPENAI_API_KEY,
      hasSupabaseUrl: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      hasSupabaseAnon: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    },
    dbOk,
    ragEnabled: USE_RAG,
    ts: Date.now(),
  });
}

// ---------- POST: 对话 ----------
const BodySchema = z.object({
  question: z.string().min(1).max(4000),
  userId: z.string().uuid().optional(),
  topK: z.number().int().min(1).max(10).optional(),
});

export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) {
      return NextResponse.json({ error: "OPENAI_API_KEY is missing" }, { status: 500 });
    }

    const json = await req.json().catch(() => ({}));
    const { question, userId, topK = 6 } = BodySchema.parse(json);

    // —— 可选 RAG ——（只有 env 齐备时才会真正触发）
    let contextBlocks: string[] = [];
    if (USE_RAG) {
      try {
        const supabaseAdmin = await getSupabaseAdminSafe();
        const emb = await client.embeddings.create({
          model: "text-embedding-3-small",
          input: question,
        });
        const queryVec = emb.data[0].embedding as unknown as number[];

        if (supabaseAdmin) {
          if (userId) {
            const { data, error } = await supabaseAdmin.rpc("match_doc_chunks", {
              query_embedding: queryVec as any,
              match_count: topK,
              p_user_id: userId,
            });
            if (!error && Array.isArray(data)) {
              contextBlocks = data.map((d: any) => d.content).filter(Boolean);
            }
          }
          if (contextBlocks.length === 0) {
            const { data, error } = await supabaseAdmin
              .from("doc_chunks")
              .select("content")
              .limit(topK);
            if (!error && Array.isArray(data)) {
              contextBlocks = data.map((d: any) => d.content).filter(Boolean);
            }
          }
        }
      } catch (e) {
        console.warn("RAG skipped:", e);
      }
    }

    const system = USE_RAG
      ? "你是企业客服助手。只使用“相关知识库片段”提供的信息来回答；如果片段里没有答案，就说明需要更多信息。"
      : "你是企业客服助手，请用简洁中文回答；不确定就说明需要更多信息。";

    const userContent = USE_RAG
      ? `客户问题：${question}\n\n相关片段：\n${
          contextBlocks.length ? contextBlocks.map((c, i) => `[${i + 1}] ${c}`).join("\n") : "（无）"
        }`
      : question;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
      max_tokens: 256,
    });

    const answer = completion.choices?.[0]?.message?.content ?? "";

    return NextResponse.json({
      ok: true,
      answer,
      usedRag: USE_RAG,
      contextCount: contextBlocks.length,
    });
  } catch (err: any) {
    if (err?.name === "ZodError") {
      return NextResponse.json({ error: err?.issues?.[0]?.message ?? "Invalid body" }, { status: 400 });
    }
    return NextResponse.json({ error: "Upstream failed", detail: String(err?.message || err) }, { status: 502 });
  }
}
