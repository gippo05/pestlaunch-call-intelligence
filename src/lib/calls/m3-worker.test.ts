import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  M3ProcessingError,
  M3_PROVIDER_UTTERANCE_CONTRACT_VERSION,
  segmentM3Transcript,
  type M3PersistedAnalysis,
} from "../../../supabase/functions/_shared/m3-analysis";
import {
  createM3WorkerHandler,
  createM3WorkerSignature,
  summarizeM3RuntimeConfig,
  isValidM3JobSource,
  type ClaimedM3Job,
  type M3JobSource,
  type M3WorkerDependencies,
} from "../../../supabase/functions/_shared/m3-worker";
import type { M3ProviderDiagnostic } from "../../../supabase/functions/_shared/m3-provider";
import { parseGeminiGeneration } from "../../../supabase/functions/_shared/m3-analysis";

const workerSecret = "m3-test-worker-secret-32-byte-minimum-9876543";
const workspace = "20000000-0000-4000-8000-000000000001";
const call = "30000000-0000-4000-8000-000000000001";
const intent = "40000000-0000-4000-8000-000000000001";
const fixtureSha256 = "ebe65a9c5ad0b181428f0db22c3a4d03e78d99fe7582c226b1b576faa0b6f1b2";
const fixtureAudio = new Uint8Array(readFileSync("supabase/tests/fixtures/synthetic-tone.mp3"));

describe("M3 runtime configuration diagnostics", () => {
  it("reports provider readiness and gates without returning the key", () => {
    const secret = "do-not-return-this-provider-key";
    const status = summarizeM3RuntimeConfig(secret, "gemini-3.8-flash", false, true);

    expect(status).toEqual({
      apiKeyPresent: true,
      providerConfigured: true,
      model: "gemini-3.8-flash",
      processingEnabled: false,
      syntheticOnly: true,
    });
    expect(JSON.stringify(status)).not.toContain(secret);
  });

  it("does not report provider readiness when either required value is missing", () => {
    expect(summarizeM3RuntimeConfig("", "gemini-3.8-flash", true, true).providerConfigured).toBe(false);
    expect(summarizeM3RuntimeConfig("some-key", "", true, true).providerConfigured).toBe(false);
  });
});
const job: ClaimedM3Job = {
  id: "10000000-0000-4000-8000-000000000001",
  workspace_id: workspace,
  call_id: call,
  processor_kind: "pending_m3",
  attempt_owner: "50000000-0000-4000-8000-000000000001",
};
const source: M3JobSource = {
  job_status: "leased",
  processor_kind: "pending_m3",
  workspace_id: workspace,
  call_id: call,
  attempt_owner: job.attempt_owner,
  lease_expires_at: new Date(Date.now() + 90_000).toISOString(),
  call_status: "processing",
  call_workspace_id: workspace,
  call_storage_path: `${workspace}/${intent}.mp3`,
  upload_intent_id: intent,
  call_brand: "abc",
  call_uploader_user_id: "60000000-0000-4000-8000-000000000001",
  intent_id: intent,
  intent_workspace_id: workspace,
  intent_user_id: "60000000-0000-4000-8000-000000000001",
  intent_object_path: `${workspace}/${intent}.mp3`,
  intent_status: "finalized",
  intent_finalized_call_id: call,
  intent_mime_type: "audio/mpeg",
  intent_expected_size: 4284,
  synthetic_fixture_ref: "synthetic-tone",
  synthetic_fixture_sha256: fixtureSha256,
};

function deps(override: Partial<M3WorkerDependencies> = {}): M3WorkerDependencies {
  return {
    workerSecret, processingEnabled: true, syntheticOnly: true,
    providerConfigured: true, model: "gemini-test", stepTimeoutMs: 5000,
    consumeNonce: vi.fn(async () => true),
    claimNextJob: vi.fn(async () => null),
    getJobSource: vi.fn(async () => source),
    loadAudio: vi.fn(async () => fixtureAudio.slice()),
    transcribe: vi.fn(async () => parseGeminiGeneration({ candidates: [] })),
    completeJob: vi.fn(async () => true),
    failJob: vi.fn(async () => true),
    getJobOutcome: vi.fn(async () => ({
      status: "failed", completion_kind: null, attempt_owner: null,
      lease_expires_at: null, next_retry_at: new Date(Date.now() + 20_000).toISOString(),
      completed_at: null, safe_error_code: "JOB_LINK_INVALID",
    })),
    log: vi.fn(),
    ...override,
  };
}

async function signedRequest(secret = workerSecret, issuedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), callId?: string) {
  const nonce = crypto.randomUUID();
  const signature = await createM3WorkerSignature(secret, issuedAt, nonce, callId);
  const headers = new Headers({ authorization: `Bearer ${signature}`, "x-m3-timestamp": issuedAt, "x-m3-nonce": nonce });
  if (callId) headers.set("x-m3-call-id", callId);
  return new Request("https://example.test/functions/v1/m3-process-queue", {
    method: "POST",
    headers,
  });
}

describe("M3 HMAC worker guard and queue integrity", () => {
  it("does not use M2 domain signatures for M3", async () => {
    const invalid = await createM3WorkerHandler(deps())(await signedRequest("another-secure-worker-secret-with-enough-bytes"));
    expect(invalid.status).toBe(401);
  });
  it("rejects expired signature before any DB access", async () => {
    const dependency = deps();
    const response = await createM3WorkerHandler(dependency)(await signedRequest(workerSecret, new Date(Date.now() - 180_000).toISOString().replace(/\.\d{3}Z$/, "Z")));
    expect(response.status).toBe(401);
    expect(dependency.consumeNonce).not.toHaveBeenCalled();
  });
  it("rejects replay when DB nonce was already consumed", async () => {
    const dependency = deps({ consumeNonce: vi.fn(async () => false) });
    const response = await createM3WorkerHandler(dependency)(await signedRequest());
    expect(response.status).toBe(401);
    expect(dependency.claimNextJob).not.toHaveBeenCalled();
  });
  it("binds an authenticated call target into HMAC and claims only that job", async () => {
    const targetCall = "70000000-0000-4000-8000-000000000007";
    const claimNextJob = vi.fn(async (leaseSeconds: number, callId?: string) => {
      void leaseSeconds;
      void callId;
      return null;
    });
    const dependency = deps({ claimNextJob });
    const response = await createM3WorkerHandler(dependency)(await signedRequest(workerSecret, undefined, targetCall));
    expect(response.status).toBe(200);
    expect(claimNextJob).toHaveBeenCalledWith(600, targetCall);
  });
  it("rejects a changed call target even when the original request HMAC is valid", async () => {
    const targetCall = "70000000-0000-4000-8000-000000000007";
    const request = await signedRequest(workerSecret, undefined, targetCall);
    const headers = new Headers(request.headers);
    headers.set("x-m3-call-id", "70000000-0000-4000-8000-000000000008");
    const tampered = new Request(request.url, { method: "POST", headers });
    const dependency = deps();
    expect((await createM3WorkerHandler(dependency)(tampered)).status).toBe(401);
    expect(dependency.claimNextJob).not.toHaveBeenCalled();
  });
  it("never claims when M3 is disabled or synthetic-only gate absent", async () => {
    const dependency = deps({ processingEnabled: false });
    const disabled = await createM3WorkerHandler(dependency)(await signedRequest());
    expect(disabled.status).toBe(200);
    expect(dependency.claimNextJob).not.toHaveBeenCalled();
    const missingSynthetic = deps({ syntheticOnly: false });
    const denied = await createM3WorkerHandler(missingSynthetic)(await signedRequest());
    expect(denied.status).toBe(503);
    expect(missingSynthetic.claimNextJob).not.toHaveBeenCalled();
  });
  it("requires explicit synthetic-approved source and exact tenant linkage", () => {
    expect(isValidM3JobSource(job, source)).toBe(true);
    expect(isValidM3JobSource(job, { ...source, synthetic_fixture_ref: null })).toBe(false);
    expect(isValidM3JobSource(job, { ...source, intent_workspace_id: "70000000-0000-4000-8000-000000000001" })).toBe(false);
    expect(isValidM3JobSource(job, { ...source, call_storage_path: `untrusted/${intent}.mp3` })).toBe(false);
    expect(isValidM3JobSource(job, { ...source, lease_expires_at: new Date(Date.now() - 10_000).toISOString() })).toBe(false);
    expect(isValidM3JobSource(job, { ...source, synthetic_fixture_sha256: "untrusted" })).toBe(false);
  });
  it("will not download audio or call Gemini when job linkage fails", async () => {
    const dependency = deps({ claimNextJob: vi.fn(async () => job), getJobSource: vi.fn(async () => null) });
    const res = await createM3WorkerHandler(dependency)(await signedRequest());
    expect(res.status).toBe(200);
    expect(dependency.loadAudio).not.toHaveBeenCalled();
    expect(dependency.transcribe).not.toHaveBeenCalled();
    expect(dependency.completeJob).not.toHaveBeenCalled();
  });

  it("will not download audio when the claimed lease has expired", async () => {
    const dependency = deps({
      claimNextJob: vi.fn(async () => job),
      getJobSource: vi.fn(async () => ({ ...source, lease_expires_at: new Date(Date.now() - 1_000).toISOString() })),
    });
    await createM3WorkerHandler(dependency)(await signedRequest());
    expect(dependency.loadAudio).not.toHaveBeenCalled();
    expect(dependency.transcribe).not.toHaveBeenCalled();
    expect(dependency.failJob).toHaveBeenCalledWith(job, "JOB_LINK_INVALID", null);
  });
  it("does not claim a non-M3 job as eligible processing work", async () => {
    const dependency = deps({ claimNextJob: vi.fn(async () => ({ ...job, processor_kind: "m2_synthetic_test" })) });
    const res = await createM3WorkerHandler(dependency)(await signedRequest());
    expect(res.status).toBe(200);
    expect(dependency.loadAudio).not.toHaveBeenCalled();
    expect(dependency.transcribe).not.toHaveBeenCalled();
  });

  it("rejects audio bytes whose digest differs from the approved fixture before Gemini", async () => {
    const changedAudio = fixtureAudio.slice();
    changedAudio[changedAudio.length - 1] ^= 1;
    const dependency = deps({
      claimNextJob: vi.fn(async () => job),
      loadAudio: vi.fn(async () => changedAudio),
    });
    await createM3WorkerHandler(dependency)(await signedRequest());
    expect(dependency.transcribe).not.toHaveBeenCalled();
    expect(dependency.failJob).toHaveBeenCalledWith(job, "SOURCE_INVALID", null);
  });

  it("passes provider 429/503 retry hints into the bounded queue retry RPC", async () => {
    const dependency = deps({
      claimNextJob: vi.fn(async () => job),
      transcribe: vi.fn(async () => { throw new M3ProcessingError("PROVIDER_503", 30); }),
      getJobOutcome: vi.fn(async () => ({
        status: "failed", completion_kind: null, attempt_owner: null,
        lease_expires_at: null, next_retry_at: new Date(Date.now() + 30_000).toISOString(),
        completed_at: null, safe_error_code: "PROVIDER_503",
      })),
    });
    await createM3WorkerHandler(dependency)(await signedRequest());
    expect(dependency.failJob).toHaveBeenCalledWith(job, "PROVIDER_503", 30);
  });

  it("correlates provider timeout and database failure recording diagnostics per worker attempt", async () => {
    const logDiagnostic = vi.fn();
    const dependency = deps({
      claimNextJob: vi.fn(async () => job),
      transcribe: vi.fn(async (
        _audio: Uint8Array,
        _timeoutMs: number,
        context?: { correlationId: string; onDiagnostic(event: M3ProviderDiagnostic): void },
      ) => {
        context?.onDiagnostic({
          operation: "generation_request",
          phase: "finish",
          classification: "timeout",
          elapsedMs: 123,
          remainingBudgetMs: 0,
          retryClassification: "none",
        });
        throw new M3ProcessingError("PROVIDER_TIMEOUT");
      }),
      getJobOutcome: vi.fn(async () => ({
        status: "failed", completion_kind: null, attempt_owner: null,
        lease_expires_at: null, next_retry_at: new Date(Date.now() + 20_000).toISOString(),
        completed_at: null, safe_error_code: "PROVIDER_TIMEOUT",
      })),
      logDiagnostic,
    });
    await createM3WorkerHandler(dependency)(await signedRequest());

    const events = logDiagnostic.mock.calls.map(([event]) => event);
    const correlationIds = events.map((event) => event.correlationId);
    expect(correlationIds.length).toBeGreaterThan(0);
    expect(new Set(correlationIds).size).toBe(1);
    expect(correlationIds[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: "provider", operation: "generation_request", classification: "timeout" }),
      expect.objectContaining({ component: "worker", operation: "provider_execution", classification: "timeout" }),
      expect.objectContaining({ component: "worker", operation: "database_failure_recording", classification: "success" }),
      expect.objectContaining({ component: "worker", operation: "failure_reconciliation", classification: "success" }),
    ]));
    expect(dependency.log).toHaveBeenCalledWith("job", "retry_scheduled", correlationIds[0]);
    expect(JSON.stringify(events)).not.toContain("PROVIDER_TIMEOUT");
    expect(JSON.stringify(events)).not.toContain("Bearer");
  });

  it("returns an immediate acknowledgement and schedules authenticated work in the background", async () => {
    let scheduled: Promise<unknown> | undefined;
    const scheduleBackground = vi.fn((task: Promise<unknown>) => { scheduled = task; });
    const dependency = {
      ...deps({ claimNextJob: vi.fn(async () => null) }),
      scheduleBackground,
    } as M3WorkerDependencies;
    const response = await createM3WorkerHandler(dependency)(await signedRequest());
    expect(response.status).toBe(202);
    expect(scheduleBackground).toHaveBeenCalledOnce();
    await scheduled;
    expect(dependency.log).toHaveBeenCalledWith("claim", "empty");
  });

  it("passes a full long transcript to the atomic persistence boundary", async () => {
    const repeated = "The customer asks about quarterly ant service. ";
    const transcript = `Hello, I need an estimate for ants. ${repeated.repeat(2_900)} We can visit Tuesday.`;
    const sentences = segmentM3Transcript(transcript);
    const utterances = sentences.map((sentence) => ({
      text: sentence.text,
      speaker: "caller",
      speechAct: "statement",
      confirmedFacts: [] as string[],
      customerConcerns: [] as string[],
      supportsIntent: false,
      supportsOutcome: false,
    }));
    const fact = utterances.find((utterance) => utterance.text.includes("estimate for ants"))!;
    const outcome = utterances.find((utterance) => utterance.text.includes("visit Tuesday"))!;
    fact.confirmedFacts = ["I need an estimate for ants."];
    fact.supportsIntent = true;
    outcome.supportsOutcome = true;
    const payload = {
      providerContractVersion: M3_PROVIDER_UTTERANCE_CONTRACT_VERSION,
      utterances,
      intent: "sales",
      outcome: { status: "observed" },
      uncertainty: { facts: false, speaker: false },
      confidence: null,
    };
    const canonicalTranscript = utterances.map((utterance) => utterance.text).join("\n\n");
    let persistedTranscript: string | undefined;
    const completeJob = vi.fn(async (_claimed: ClaimedM3Job, analysis: M3PersistedAnalysis) => {
      persistedTranscript = analysis.transcript;
      return true;
    });
    const dependency = deps({
      claimNextJob: vi.fn(async () => job),
      completeJob,
      transcribe: vi.fn(async () => parseGeminiGeneration({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(payload) }] } }],
      })),
    });
    await createM3WorkerHandler(dependency)(await signedRequest());
    expect(completeJob).toHaveBeenCalledOnce();
    expect(persistedTranscript).toBe(canonicalTranscript);
  });
});
