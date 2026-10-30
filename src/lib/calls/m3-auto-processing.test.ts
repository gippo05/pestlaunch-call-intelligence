import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  authorizeAndDispatchM3,
  type M3AutoProcessingDependencies,
} from "./m3-auto-processing";

const secret = "local-demo-worker-secret-that-is-at-least-thirty-two-bytes";
const callId = "53eecc2c-1341-4bff-9d94-6e4841cd2515";
const nonce = "6cbb8df0-4b1a-4b78-a0f7-8c4f7d21c240";
const issuedAt = "2026-10-29T12:00:00Z";
const bytes = new Uint8Array([1, 2, 3, 4]);

function dependencies(overrides: Partial<M3AutoProcessingDependencies> = {}) {
  return {
    config: {
      supabaseUrl: "http://127.0.0.1:54321",
      publishableKey: "local-publishable-key",
      workerSecret: secret,
      processingEnabled: true,
      syntheticOnly: true,
    },
    authorize: vi.fn(async () => "approved" as const),
    fetcher: vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 })) as unknown as typeof fetch,
    now: () => new Date(issuedAt),
    nonce: () => nonce,
    ...overrides,
  } satisfies M3AutoProcessingDependencies;
}

describe("M3 synthetic demo dispatch", () => {
  it("authorizes server-hashed bytes and sends one HMAC request to the loopback worker", async () => {
    const deps = dependencies();

    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("started");

    expect(deps.authorize).toHaveBeenCalledOnce();
    expect(deps.authorize).toHaveBeenCalledWith(callId, "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a");
    expect(deps.fetcher).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(deps.fetcher).mock.calls[0]!;
    const headers = new Headers(init?.headers);
    const expected = createHmac("sha256", secret)
      .update(`POST\n/functions/v1/m3-process-queue\n${issuedAt}\n${nonce}\n${callId}`)
      .digest("hex");
    expect(url).toBe("http://127.0.0.1:54321/functions/v1/m3-process-queue");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
    expect(headers.get("authorization")).toBe(`Bearer ${expected}`);
    expect(headers.get("x-m3-timestamp")).toBe(issuedAt);
    expect(headers.get("x-m3-nonce")).toBe(nonce);
    expect(headers.get("x-m3-call-id")).toBe(callId);
    expect(headers.get("apikey")).toBe("local-publishable-key");
  });

  it("does not authorize or dispatch to a hosted Supabase URL", async () => {
    const deps = dependencies({
      config: {
        supabaseUrl: "https://project.supabase.co",
        publishableKey: "local-publishable-key",
        workerSecret: secret,
        processingEnabled: true,
        syntheticOnly: true,
      },
    });

    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("disabled");
    expect(deps.authorize).not.toHaveBeenCalled();
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it("permits only explicitly gated dedicated hosted synthetic endpoint, still requiring the exact audio allowlist", async () => {
    const deps = dependencies({
      config: {
        ...dependencies().config,
        supabaseUrl: "https://aznfcxrlpzjnssfatzxi.supabase.co",
        hostedSyntheticEnabled: true,
      },
    });
    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("started");
    expect(deps.authorize).toHaveBeenCalledOnce();
    expect(deps.fetcher).toHaveBeenCalledOnce();
    const [url] = vi.mocked(deps.fetcher).mock.calls[0]!;
    expect(url).toBe("https://aznfcxrlpzjnssfatzxi.supabase.co/functions/v1/m3-process-queue");
  });

  it("never dispatches hosted audio that is not in the exact synthetic registry", async () => {
    const deps = dependencies({
      config: {
        ...dependencies().config,
        supabaseUrl: "https://aznfcxrlpzjnssfatzxi.supabase.co",
        hostedSyntheticEnabled: true,
      },
      authorize: vi.fn(async () => "not_allowlisted" as const),
    });
    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("not_allowlisted");
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it("rejects mismatched hosted projects, even if the opt-in gate is enabled", async () => {
    const deps = dependencies({
      config: {
        ...dependencies().config,
        supabaseUrl: "https://qqfnnamrrkezkdeywsoz.supabase.co",
        hostedSyntheticEnabled: true,
      },
    });
    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("disabled");
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it("allows explicitly enabled, authenticated private-call processing without synthetic fixture approval", async () => {
    const deps = dependencies({
      config: {
        ...dependencies().config,
        syntheticOnly: false,
        generalPrivateEnabled: true,
      },
    });
    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("started");
    expect(deps.authorize).toHaveBeenCalledOnce();
    expect(deps.fetcher).toHaveBeenCalledOnce();
  });

  it("does not process an arbitrary private recording when its private authorization fails", async () => {
    const deps = dependencies({
      config: {
        ...dependencies().config,
        syntheticOnly: false,
        generalPrivateEnabled: true,
      },
      authorize: vi.fn(async () => "not_eligible" as const),
    });
    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("already_handled");
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it("does not enable general private processing merely by turning synthetic mode off", async () => {
    const deps = dependencies({
      config: { ...dependencies().config, syntheticOnly: false, generalPrivateEnabled: false },
    });
    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("disabled");
    expect(deps.authorize).not.toHaveBeenCalled();
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it("does not authorize or dispatch when synthetic-only processing is off", async () => {
    const deps = dependencies({ config: { ...dependencies().config, syntheticOnly: false } });

    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("disabled");
    expect(deps.authorize).not.toHaveBeenCalled();
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it("does not dispatch bytes missing from the server-side fixture registry", async () => {
    const deps = dependencies({ authorize: vi.fn(async () => "not_allowlisted" as const) });

    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("not_allowlisted");
    expect(deps.fetcher).not.toHaveBeenCalled();
  });

  it("redrives an already authorized call through the idempotent targeted worker", async () => {
    const deps = dependencies({
      authorize: vi.fn(async () => "already_authorized" as const),
      fetcher: vi.fn(async () => new Response(JSON.stringify({ processed: 0, outcome: "empty" }), { status: 200 })) as unknown as typeof fetch,
    });

    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("queued");
    expect(deps.authorize).toHaveBeenCalledOnce();
    expect(deps.fetcher).toHaveBeenCalledOnce();
  });

  it("reports a disabled worker without claiming that processing started", async () => {
    const deps = dependencies({
      fetcher: vi.fn(async () => new Response(JSON.stringify({ outcome: "disabled" }), { status: 200 })) as unknown as typeof fetch,
    });

    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("disabled");
    expect(deps.fetcher).toHaveBeenCalledOnce();
  });

  it("reports a safe unavailable state after one failed dispatch request", async () => {
    const deps = dependencies({
      fetcher: vi.fn(async () => new Response("internal details are not exposed", { status: 503 })) as unknown as typeof fetch,
    });

    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("unavailable");
    expect(deps.fetcher).toHaveBeenCalledOnce();
  });

  it("reports a safe authorization error code without exposing the error message", async () => {
    const error = Object.assign(new Error("private database detail"), { code: "PGRST202" });
    const deps = dependencies({ authorize: vi.fn(async () => { throw error; }) });
    const onDiagnostic = vi.fn();
    Object.assign(deps, { onDiagnostic });

    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("unavailable");

    expect(onDiagnostic).toHaveBeenCalledWith({
      stage: "authorization",
      outcome: "failed",
      code: "PGRST202",
    });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("private database detail");
  });

  it("reports a missing Gemini provider as an actionable non-success state", async () => {
    const deps = dependencies({
      fetcher: vi.fn(async () => new Response(JSON.stringify({ error: "PROVIDER_NOT_CONFIGURED" }), { status: 503 })) as unknown as typeof fetch,
    });

    await expect(authorizeAndDispatchM3(callId, bytes, deps)).resolves.toBe("provider_not_configured");
  });
});
