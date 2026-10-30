import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseUploadRepository } from "./supabase-upload-repository";

describe("M3 synthetic authorization diagnostics", () => {
  it("classifies the service-role claim guard without retaining database error text", async () => {
    const adminClient = {
      rpc: vi.fn(async () => ({
        data: null,
        error: {
          code: "42501",
          message: "service role required for M3 demo authorization",
        },
      })),
    } as unknown as SupabaseClient;
    const repository = createSupabaseUploadRepository({} as SupabaseClient, adminClient);

    await expect(repository.authorizeM3DemoCall(
      "60000000-0000-4000-8000-000000000001",
      "ebe65a9c5ad0b181428f0db22c3a4d03e78d99fe7582c226b1b576faa0b6f1b2",
    )).rejects.toMatchObject({
      message: "M3_DEMO_AUTHORIZATION_FAILED",
      m3DiagnosticCode: "SERVICE_ROLE_REQUIRED",
    });
  });

  it("classifies an unexpected authorization response without exposing provider or database text", async () => {
    const adminClient = {
      rpc: vi.fn(async () => ({ data: "unexpected", error: null })),
    } as unknown as SupabaseClient;
    const repository = createSupabaseUploadRepository({} as SupabaseClient, adminClient);

    await expect(repository.authorizeM3DemoCall(
      "60000000-0000-4000-8000-000000000001",
      "ebe65a9c5ad0b181428f0db22c3a4d03e78d99fe7582c226b1b576faa0b6f1b2",
    )).rejects.toMatchObject({
      message: "M3_DEMO_AUTHORIZATION_FAILED",
      m3DiagnosticCode: "UNEXPECTED_RESPONSE",
    });
  });
});
