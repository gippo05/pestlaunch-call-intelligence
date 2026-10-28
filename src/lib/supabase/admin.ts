import "server-only";

import { createClient } from "@supabase/supabase-js";
import { getServerSupabaseConfig } from "@/lib/env/server";

export function createSupabaseAdminClient() {
  const { supabaseUrl, secretKey } = getServerSupabaseConfig();
  return createClient(supabaseUrl, secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
