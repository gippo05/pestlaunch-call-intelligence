import { parsePublicEnv } from "./public";

export type ServerSupabaseConfig = {
  supabaseUrl: string;
  secretKey: string;
};

type ServerEnvironment = Record<string, string | undefined>;

const INVALID_SERVER_CONFIG = "Supabase server configuration is invalid.";

export function parseServerSupabaseEnv(environment: ServerEnvironment): ServerSupabaseConfig {
  let supabaseUrl: string;
  let publishableKey: string;
  try {
    ({ supabaseUrl, publishableKey } = parsePublicEnv(environment));
  } catch {
    throw new Error(INVALID_SERVER_CONFIG);
  }

  const secretKey = environment.SUPABASE_SECRET_KEY?.trim();
  if (!secretKey || !secretKey.startsWith("sb_secret_") || secretKey === publishableKey) {
    throw new Error(INVALID_SERVER_CONFIG);
  }

  return { supabaseUrl, secretKey };
}

export function getServerSupabaseConfig(): ServerSupabaseConfig {
  return parseServerSupabaseEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_ALLOW_LOCAL_SUPABASE_HTTP: process.env.NEXT_PUBLIC_ALLOW_LOCAL_SUPABASE_HTTP,
    NODE_ENV: process.env.NODE_ENV,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  });
}
