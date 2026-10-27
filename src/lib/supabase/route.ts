import "server-only";

import { createServerClient } from "@supabase/ssr";
import { type NextRequest, type NextResponse } from "next/server";
import { getPublicSupabaseConfig } from "@/lib/env/public";

export function createSupabaseRouteClient(request: NextRequest, response: NextResponse) {
  const { supabaseUrl, publishableKey } = getPublicSupabaseConfig();

  return createServerClient(supabaseUrl, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headersToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        });
        Object.entries(headersToSet).forEach(([name, value]) => response.headers.set(name, value));
      },
    },
  });
}
