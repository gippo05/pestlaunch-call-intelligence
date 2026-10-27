"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getPublicSupabaseConfig } from "@/lib/env/public";

export function createSupabaseBrowserClient() {
  const { supabaseUrl, publishableKey } = getPublicSupabaseConfig();
  return createBrowserClient(supabaseUrl, publishableKey);
}
