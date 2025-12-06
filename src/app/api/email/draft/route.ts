// src/app/api/email/draft/route.ts

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/email/draft
// 保存邮件草稿
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const { userId, to, subject, content } = body;

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 }
      );
    }
