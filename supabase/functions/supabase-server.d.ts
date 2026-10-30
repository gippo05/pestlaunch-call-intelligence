declare module "npm:@supabase/server@1" {
  import type { SupabaseClient } from "@supabase/supabase-js";

  export function withSupabase(
    options: { auth: "none" | "secret" },
    handler: (request: Request, context: { supabaseAdmin: SupabaseClient }) => Response | Promise<Response>,
  ): (request: Request) => Promise<Response>;
}

declare const Deno: {
  env: { get(name: string): string | undefined };
};
