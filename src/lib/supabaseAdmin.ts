import { createClient } from "@supabase/supabase-js";

export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,            // ← 使用私密 URL
  process.env.SUPABASE_SERVICE_ROLE!,   // ← 使用 service_role
  { auth: { persistSession: false } }
);
