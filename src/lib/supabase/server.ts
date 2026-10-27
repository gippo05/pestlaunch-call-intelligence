import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getPublicSupabaseConfig } from "@/lib/env/public";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { supabaseUrl, publishableKey } = getPublicSupabaseConfig();

  return createServerClient(supabaseUrl, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
    },
  });
}
