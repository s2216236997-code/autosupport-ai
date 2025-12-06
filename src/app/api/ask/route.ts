// src/app/api/ask/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const HEALTH_TABLE = process.env.HEALTH_TABLE ?? "documents"; // ← 改用 env 可自定义
const USE_RAG = process.env.USE_RAG === "1";                  // ← 设为 1 启用 RAG

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// 通用超时保护
const withTimeout = <T,>(p: Promise<T>, ms = 15000) =>
  Promise.race<T>([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("UPSTREAM_TIMEOUT")), ms)),
  ]);

// ---------- GET: 健康检查 ----------
export async function GET() {
  let dbOk = false;
  try {
    const { error } = await supabaseAdmin.from(HEALTH_TABLE).select("id").limit(1);
    dbOk = !error;
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

// ---------- POST: 对话（可选 RAG） ----------
const BodySchema = z.object({
  question: z.string().min(1, "question is required").max(4000),
  userId: z.string().uuid().optional(), // RAG 模式下建议传，用于按用户过滤
  topK: z.number().int().min(1).max(10).optional(),
});

export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) {
      return NextResponse.json({ error: "OPENAI_API_KEY is missing" }, { status: 500 });
    }

    const json = await req.json().catch(() => ({}));
    const { question, userId, topK = 6 } = BodySchema.parse(json);

    // —— RAG: 检索知识片段（可选） ——
    let contextBlocks: string[] = [];
    if (USE_RAG) {
      try {
        // 1) embed query
        const emb = await withTimeout(
          client.embeddings.create({
            model: "text-embedding-3-small",
            input: question,
          }),
          12000
        );
        const queryVec = emb.data[0].embedding as unknown as number[];

        // 2) 优先走 RPC（你若已建 match_doc_chunks）
        // create or replace function match_doc_chunks(query_embedding vector(1536), match_count int, p_user_id uuid)
        // returns table(content text) ...
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

        // 3) 没 userId 或 RPC 不存在/失败：兜底检索（示例：不做相似度排序）
        if (contextBlocks.length === 0) {
          const { data, error } = await supabaseAdmin
            .from("doc_chunks") // 若你的表名不同，改这里
            .select("content, embedding")
            .limit(topK);
          if (!error && Array.isArray(data)) {
            contextBlocks = data.map((d: any) => d.content).filter(Boolean);
          }
        }
      } catch (e) {
        // 检索失败不阻断主流程，继续纯对话
        console.warn("RAG step skipped:", e);
      }
    }

    // —— 组织提示词 ——
    const system = USE_RAG
      ? "你是企业客服助手。只使用“相关知识库片段”提供的信息来回答；如果片段里没有答案，就坦诚说明需要更多信息。"
      : "你是企业客服助手，请用简洁、友好的中文回答。若不确定就说明需要更多信息。";

    const userContent = USE_RAG
      ? `客户问题：${question}\n\n相关知识库片段：\n${
          contextBlocks.length
            ? contextBlocks.map((c, i) => `[${i + 1}] ${c}`).join("\n")
            : "（无）"
        }\n\n要求：简短清晰；如需跟进给出下一步。`
      : question;

    // —— 调用 Chat ——
    const completion = await withTimeout(
      client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        max_tokens: 256,
      }),
      15000
    );

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
    const msg = String(err?.message || err);
    const isTimeout = /UPSTREAM_TIMEOUT|timeout|aborted/i.test(msg);
    return NextResponse.json({ error: "Upstream failed", detail: msg }, { status: isTimeout ? 504 : 502 });
  }
}
