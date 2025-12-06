// src/app/api/ask/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";

/**
 * 运行时/渲染方式
 * - nodejs：可用到 Node 包与环境变量
 * - force-dynamic：避免被静态化，从而确保 API Route 始终存在
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* ----------------------------- 环境变量与常量 ---------------------------- */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const USE_RAG = process.env.USE_RAG === "1";
const HEALTH_TABLE = process.env.HEALTH_TABLE || "documents";

/** 允许跨域访问的来源（逗号分隔）。不配置则默认只允许同源。 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

/** OpenAI 客户端 */
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* --------------------------------- 工具函数 -------------------------------- */

function pickAllowedOrigin(req: NextRequest): string | null {
  if (ALLOWED_ORIGINS.length === 0) return null;
  const origin = req.headers.get("origin");
  if (!origin) return null;
  return ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function withCors(req: NextRequest, res: NextResponse) {
  const origin = pickAllowedOrigin(req);
  if (origin) res.headers.set("Access-Control-Allow-Origin", origin);
  // 若你希望允许凭证携带（cookies/headers），再打开下面两行：
  // if (origin) res.headers.set("Vary", "Origin");
  // res.headers.set("Access-Control-Allow-Credentials", "true");
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  return res;
}

/** 动态按需加载 supabase admin（只有 env 齐备时才加载，避免构建期失败） */
async function getSupabaseAdminSafe() {
  const hasEnv =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.SUPABASE_SERVICE_ROLE; // 建议 admin 端使用 service_role
  if (!hasEnv) return null;
  try {
    const mod = await import("@/lib/supabaseAdmin");
    return (mod as any).supabaseAdmin ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------ GET ----------------------------------- */
/**
 * 健康检查：
 * - 检查关键 env 是否存在
 * - 若能连上数据库（有配置时），简单做一次 SELECT
 */
export async function GET(req: NextRequest) {
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

  const res = NextResponse.json({
    ok: true,
    env: {
      hasOpenAIKey: Boolean(OPENAI_API_KEY),
      hasSupabaseUrl: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      hasSupabaseAnon: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      ragEnabled: USE_RAG,
    },
    dbOk,
    ts: Date.now(),
  });

  return withCors(req, res);
}

/* ---------------------------------- OPTIONS --------------------------------- */
/** CORS 预检 */
export async function OPTIONS(req: NextRequest) {
  return withCors(req, new NextResponse(null, { status: 204 }));
}

/* ------------------------------------ POST ---------------------------------- */

const BodySchema = z.object({
  question: z.string().min(1).max(4000),
  userId: z.string().uuid().optional(),
  topK: z.number().int().min(1).max(10).optional().default(6),
});

export async function POST(req: NextRequest) {
  // 解析与校验
  let body: z.infer<typeof BodySchema>;
  try {
    const json = await req.json().catch(() => ({}));
    body = BodySchema.parse(json);
  } catch (err: any) {
    const message = err?.issues?.[0]?.message ?? "Invalid body";
    return withCors(
      req,
      NextResponse.json({ ok: false, error: message }, { status: 400 })
    );
  }

  if (!OPENAI_API_KEY) {
    return withCors(
      req,
      NextResponse.json({ ok: false, error: "OPENAI_API_KEY is missing" }, { status: 500 })
    );
  }

  const { question, userId, topK } = body;

  // —— 可选 RAG（仅当 env 齐备时激活）——
  let contextBlocks: string[] = [];
  if (USE_RAG) {
    try {
      const supabaseAdmin = await getSupabaseAdminSafe();
      const emb = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: question,
      });
      const queryVec = emb.data[0].embedding as unknown as number[];
      if (supabaseAdmin) {
        // 先按 user 召回
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
        // 兜底：全局召回
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
      // 避免上游失败拖垮回答
      console.warn("RAG skipped:", e);
    }
  }

  // Prompt 组装
  const system = USE_RAG
    ? "你是企业客服助手。只使用“相关知识库片段”提供的信息来回答；如果片段里没有答案，就说明需要更多信息。"
    : "你是企业客服助手，请用简洁中文回答；不确定就说明需要更多信息。";

  const userContent = USE_RAG
    ? `客户问题：${question}\n\n相关片段：\n${
        contextBlocks.length
          ? contextBlocks.map((c, i) => `[${i + 1}] ${c}`).join("\n")
          : "（无）"
      }`
    : question;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
      max_tokens: 256,
    });

    const answer = completion.choices?.[0]?.message?.content ?? "";

    return withCors(
      req,
      NextResponse.json({
        ok: true,
        answer,
        usedRag: USE_RAG,
        contextCount: contextBlocks.length,
      })
    );
  } catch (err: any) {
    return withCors(
      req,
      NextResponse.json(
        { ok: false, error: "Upstream failed", detail: String(err?.message || err) },
        { status: 502 }
      )
    );
  }
}
