import { describe, expect, it } from "vitest";
import { parsePublicEnv } from "./public";

const validEnvironment = {
  NEXT_PUBLIC_SUPABASE_URL: "https://assessment.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example-value",
};

describe("parsePublicEnv", () => {
  it("returns only the validated public Supabase configuration", () => {
    expect(parsePublicEnv(validEnvironment)).toEqual({
      supabaseUrl: "https://assessment.supabase.co",
      publishableKey: "sb_publishable_example-value",
    });
  });

  it("rejects missing values with a safe message", () => {
    const secretLikeValue = "sb_secret_never-include-this-in-errors";

    expect(() =>
      parsePublicEnv({
        NEXT_PUBLIC_SUPABASE_URL: validEnvironment.NEXT_PUBLIC_SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secretLikeValue,
      }),
    ).toThrow("Supabase public configuration is invalid.");
  });

  it("rejects non-HTTPS URLs and non-publishable keys", () => {
    expect(() =>
      parsePublicEnv({
        NEXT_PUBLIC_SUPABASE_URL: "http://assessment.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: validEnvironment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      }),
    ).toThrow("Supabase public configuration is invalid.");

    expect(() =>
      parsePublicEnv({
        NEXT_PUBLIC_SUPABASE_URL: validEnvironment.NEXT_PUBLIC_SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "service_role_key",
      }),
    ).toThrow("Supabase public configuration is invalid.");
  });
});
