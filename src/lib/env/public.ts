export type PublicSupabaseConfig = {
  supabaseUrl: string;
  publishableKey: string;
};

type PublicEnvironment = Record<string, string | undefined>;

const INVALID_PUBLIC_CONFIG = "Supabase public configuration is invalid.";

export function parsePublicEnv(environment: PublicEnvironment): PublicSupabaseConfig {
  const supabaseUrl = environment.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!supabaseUrl || !publishableKey || !publishableKey.startsWith("sb_publishable_")) {
    throw new Error(INVALID_PUBLIC_CONFIG);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch {
    throw new Error(INVALID_PUBLIC_CONFIG);
  }

  const allowIsolatedLocalHttp =
    environment.NODE_ENV === "development" &&
    environment.NEXT_PUBLIC_ALLOW_LOCAL_SUPABASE_HTTP === "true" &&
    parsedUrl.protocol === "http:" &&
    parsedUrl.hostname === "127.0.0.1" &&
    parsedUrl.port === "54321";

  if (
    (parsedUrl.protocol !== "https:" && !allowIsolatedLocalHttp) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.search ||
    parsedUrl.hash ||
    parsedUrl.pathname !== "/"
  ) {
    throw new Error(INVALID_PUBLIC_CONFIG);
  }

  return { supabaseUrl: parsedUrl.origin, publishableKey };
}

export function getPublicSupabaseConfig(): PublicSupabaseConfig {
  return parsePublicEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_ALLOW_LOCAL_SUPABASE_HTTP: process.env.NEXT_PUBLIC_ALLOW_LOCAL_SUPABASE_HTTP,
    NODE_ENV: process.env.NODE_ENV,
  });
}
