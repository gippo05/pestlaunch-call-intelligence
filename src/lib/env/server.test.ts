import { describe, expect, it } from "vitest";
import { parseServerSupabaseEnv } from "./server";

const publicConfig = {
  NEXT_PUBLIC_SUPABASE_URL: "https://assessment.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example-value",
};

describe("parseServerSupabaseEnv", () => {
  it("returns the public URL and a server-only modern secret key", () => {
    expect(parseServerSupabaseEnv({
      ...publicConfig,
      SUPABASE_SECRET_KEY: "sb_secret_example-value",
    })).toEqual({
      supabaseUrl: "https://assessment.supabase.co",
      secretKey: "sb_secret_example-value",
    });
  });

  it("rejects missing or legacy elevated keys with a safe message", () => {
    expect(() => parseServerSupabaseEnv(publicConfig)).toThrow("Supabase server configuration is invalid.");
    expect(() => parseServerSupabaseEnv({ ...publicConfig, SUPABASE_SECRET_KEY: "service_role_key" }))
      .toThrow("Supabase server configuration is invalid.");
  });

  it("rejects a publishable key accidentally supplied as the server secret", () => {
    expect(() => parseServerSupabaseEnv({
      ...publicConfig,
      SUPABASE_SECRET_KEY: publicConfig.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    })).toThrow("Supabase server configuration is invalid.");
  });
});
