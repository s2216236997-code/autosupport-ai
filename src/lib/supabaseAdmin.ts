// lib/supabaseAdmin.ts
import { createClient } from "@supabase/supabase-js";

// 仅服务端使用 service_role，切勿暴露到浏览器
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE;

export const supabaseAdmin =
  url && serviceRole
    ? createClient(url, serviceRole, { auth: { persistSession: false } })
    : null; // 关键：缺 env 时返回 null，而不是 throw
