import { createHash, createHmac, randomUUID } from "node:crypto";
import type { M3AutoProcessingState } from "./status";

const M3_WORKER_PATH = "/functions/v1/m3-process-queue";
const MIN_WORKER_SECRET_BYTES = 32;
const DISPATCH_TIMEOUT_MS = 18_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type M3DemoAuthorization = "approved" | "already_authorized" | "not_allowlisted" | "not_eligible";
export type M3AutoProcessingDiagnostic =
  | { stage: "source_verification"; outcome: "failed"; reason: "path_mismatch" | "object_unavailable" | "object_invalid" | "storage_download_failed" }
  | { stage: "authorization"; outcome: "failed"; code: string }
  | { stage: "dispatch"; outcome: "failed"; httpStatus: number; code: string }
  | { stage: "dispatch"; outcome: "hook_error" }
  | { stage: "dispatch"; outcome: "network_error" }
  | { stage: "dispatch"; outcome: "unexpected_response"; httpStatus: number };

export type M3AutoProcessingConfig = {
  supabaseUrl?: string;
  publishableKey?: string;
  workerSecret?: string;
  processingEnabled: boolean;
  syntheticOnly: boolean;
  /** Explicit hosted synthetic assessment gate; never enables arbitrary customer audio. */
  hostedSyntheticEnabled?: boolean;
  /** Authenticated private-call mode, opt-in and single attempt per upload. */
  generalPrivateEnabled?: boolean;
};

export type M3AutoProcessingDependencies = {
  config: M3AutoProcessingConfig;
  authorize(callId: string, audioSha256: string): Promise<M3DemoAuthorization>;
  fetcher?: typeof fetch;
  now?: () => Date;
  nonce?: () => string;
  onDiagnostic?: (event: M3AutoProcessingDiagnostic) => void;
};

export async function authorizeAndDispatchM3(
  callId: string,
  verifiedBytes: Uint8Array,
  dependencies: M3AutoProcessingDependencies,
): Promise<M3AutoProcessingState> {
  const { config } = dependencies;
  if (!isAuthorizedSyntheticTarget(config.supabaseUrl, config.hostedSyntheticEnabled) ||
      !config.processingEnabled ||
      !(config.syntheticOnly || config.generalPrivateEnabled) ||
      !config.publishableKey ||
      !config.workerSecret ||
      Buffer.byteLength(config.workerSecret, "utf8") < MIN_WORKER_SECRET_BYTES) {
    return "disabled";
  }

  let authorization: M3DemoAuthorization;
  try {
    const audioSha256 = createHash("sha256").update(verifiedBytes).digest("hex");
    authorization = await dependencies.authorize(callId, audioSha256);
  } catch (error) {
    emitDiagnostic(dependencies, {
      stage: "authorization",
      outcome: "failed",
      code: safeErrorCode(error),
    });
    return "unavailable";
  }

  if (authorization === "not_allowlisted") return "not_allowlisted";
  if (authorization !== "approved" && authorization !== "already_authorized") return "already_handled";

  const issuedAt = (dependencies.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const nonce = dependencies.nonce?.() ?? randomUUID();
  const signature = createHmac("sha256", config.workerSecret)
    .update(`POST\n${M3_WORKER_PATH}\n${issuedAt}\n${nonce}\n${callId}`)
    .digest("hex");
  const url = `${new URL(config.supabaseUrl!).origin}${M3_WORKER_PATH}`;

  try {
    const response = await (dependencies.fetcher ?? fetch)(url, {
      method: "POST",
      headers: {
        apikey: config.publishableKey,
        authorization: `Bearer ${signature}`,
        "x-m3-timestamp": issuedAt,
        "x-m3-nonce": nonce,
        "x-m3-call-id": callId,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.status === 202 && payload?.accepted === true) return "started";
    if (response.status === 200 && payload?.outcome === "disabled") return "disabled";
    if (response.status === 200 && payload?.outcome === "empty") return "queued";
    if (response.status === 200 && payload?.processed === 1) return "started";
    if (response.status === 503 && payload?.error === "PROVIDER_NOT_CONFIGURED") {
      emitDiagnostic(dependencies, {
        stage: "dispatch",
        outcome: "failed",
        httpStatus: response.status,
        code: "PROVIDER_NOT_CONFIGURED",
      });
      return "provider_not_configured";
    }
    if (!response.ok) {
      emitDiagnostic(dependencies, {
        stage: "dispatch",
        outcome: "failed",
        httpStatus: response.status,
        code: safeDiagnosticCode(payload?.error),
      });
      return "unavailable";
    }
    emitDiagnostic(dependencies, { stage: "dispatch", outcome: "unexpected_response", httpStatus: response.status });
    return "unavailable";
  } catch {
    emitDiagnostic(dependencies, { stage: "dispatch", outcome: "network_error" });
    return "unavailable";
  }
}

function emitDiagnostic(
  dependencies: M3AutoProcessingDependencies,
  event: M3AutoProcessingDiagnostic,
) {
  try {
    dependencies.onDiagnostic?.(event);
  } catch {
    // Diagnostic reporting must never change upload or queue state.
  }
}

function safeErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "UNKNOWN";
  const record = error as { m3DiagnosticCode?: unknown; code?: unknown };
  return safeDiagnosticCode(record.m3DiagnosticCode ?? record.code);
}

function safeDiagnosticCode(value: unknown) {
  return typeof value === "string" && /^[A-Z0-9_]{1,40}$/.test(value) ? value : "UNKNOWN";
}

function isAuthorizedSyntheticTarget(value: string | undefined, hostedSyntheticEnabled?: boolean) {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return false;
    if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return true;
    // This is the dedicated, isolated PestLaunch evaluation project only.
    // The database allowlist and exact SHA approval still apply to EACH call.
    return hostedSyntheticEnabled === true && url.protocol === "https:" &&
      url.hostname === "aznfcxrlpzjnssfatzxi.supabase.co";
  } catch {
    return false;
  }
}
