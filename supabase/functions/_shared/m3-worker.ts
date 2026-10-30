import {
  M3_MAX_AUDIO_BYTES,
  M3_MAX_AUDIO_SECONDS,
  M3ProcessingError,
  buildM3PersistedAnalysis,
  parseMp3Duration,
  type M3ModelOutput,
  type M3PersistedAnalysis,
  type M3SafeErrorCode,
} from "./m3-analysis.ts";
import {
  M3_PROVIDER_CLEANUP_TIMEOUT_MS,
  M3_PROVIDER_TIMEOUT_MS,
  type M3ProviderDiagnostic,
} from "./m3-provider.ts";

const MIN_SECRET_BYTES = 32;
const STEP_TIMEOUT_MS = 12_000;
const AUDIO_DOWNLOAD_TIMEOUT_MS = 25_000;
const WORKER_RUNTIME_BUDGET_MS = 135_000;
const JOB_LEASE_SECONDS = 600;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_PATH_PATTERN = new RegExp(`^(${UUID_PATTERN.source.slice(1, -1)})/(${UUID_PATTERN.source.slice(1, -1)})\\.mp3$`, "i");

export type ClaimedM3Job = {
  id: string;
  workspace_id: string;
  call_id: string;
  processor_kind: string;
  attempt_owner: string;
};

export type M3JobSource = {
  job_status: string;
  processor_kind: string;
  workspace_id: string;
  call_id: string;
  attempt_owner: string;
  lease_expires_at: string;
  call_status: string;
  call_workspace_id: string;
  call_storage_path: string;
  upload_intent_id: string | null;
  call_brand: string;
  call_uploader_user_id: string | null;
  intent_id: string | null;
  intent_workspace_id: string | null;
  intent_user_id: string | null;
  intent_object_path: string | null;
  intent_status: string | null;
  intent_finalized_call_id: string | null;
  intent_mime_type: string | null;
  intent_expected_size: number | null;
  synthetic_fixture_ref: string | null;
  synthetic_fixture_sha256: string;
};

export type M3JobOutcome = {
  status: string;
  completion_kind: string | null;
  attempt_owner: string | null;
  lease_expires_at: string | null;
  next_retry_at: string | null;
  completed_at: string | null;
  safe_error_code: string | null;
};

export type M3WorkerDiagnostic = {
  correlationId: string;
  operation: "provider_execution" | "database_completion" | "database_failure_recording" | "completion_reconciliation" | "failure_reconciliation";
  phase: "start" | "finish";
  classification?: "success" | "timeout" | "processing_failure" | "database_failure" | "lease_lost" | "unknown";
  elapsedMs?: number;
  remainingBudgetMs: number;
};

export type M3DiagnosticEvent =
  | ({ component: "provider" } & M3ProviderDiagnostic)
  | ({ component: "worker" } & M3WorkerDiagnostic);

export type M3ProviderContext = {
  correlationId: string;
  onDiagnostic(event: M3ProviderDiagnostic): void;
};

export type M3WorkerDependencies = {
  workerSecret: string | null;
  processingEnabled: boolean;
  syntheticOnly: boolean;
  generalPrivateEnabled?: boolean;
  providerConfigured: boolean;
  model: string;
  stepTimeoutMs?: number;
  consumeNonce(nonce: string, issuedAt: string): Promise<boolean>;
  claimNextJob(leaseSeconds: number, callId?: string): Promise<ClaimedM3Job | null>;
  getJobSource(job: ClaimedM3Job): Promise<M3JobSource | null>;
  loadAudio(source: M3JobSource, signal: AbortSignal): Promise<Uint8Array>;
  transcribe(audio: Uint8Array, timeoutMs: number, context?: M3ProviderContext): Promise<M3ModelOutput>;
  completeJob(job: ClaimedM3Job, analysis: M3PersistedAnalysis): Promise<boolean>;
  failJob(job: ClaimedM3Job, code: M3SafeErrorCode, retryAfterSeconds: number | null): Promise<boolean>;
  getJobOutcome(jobId: string): Promise<M3JobOutcome | null>;
  log(event: string, outcome: string, correlationId?: string): void;
  logDiagnostic?(event: M3DiagnosticEvent): void;
  scheduleBackground?(task: Promise<unknown>): void;
};

export type M3RuntimeConfigSummary = {
  apiKeyPresent: boolean;
  providerConfigured: boolean;
  model: string | null;
  processingEnabled: boolean;
  syntheticOnly: boolean;
};

export function summarizeM3RuntimeConfig(
  apiKey: string | null | undefined,
  model: string | null | undefined,
  processingEnabled: boolean,
  syntheticOnly: boolean,
): M3RuntimeConfigSummary {
  const apiKeyPresent = Boolean(apiKey?.trim());
  const normalizedModel = model?.trim() || null;
  return {
    apiKeyPresent,
    providerConfigured: apiKeyPresent && normalizedModel !== null,
    model: normalizedModel,
    processingEnabled,
    syntheticOnly,
  };
}

class WorkerStepTimeoutError extends Error {
  constructor() {
    super("WORKER_STEP_TIMEOUT");
    this.name = "WorkerStepTimeoutError";
  }
}

export function createM3WorkerHandler(dependencies: M3WorkerDependencies) {
  return async function handleM3Worker(request: Request): Promise<Response> {
    const timeoutMs = Math.max(1, dependencies.stepTimeoutMs ?? STEP_TIMEOUT_MS);
    if (request.method !== "POST") return response(405, { error: "METHOD_NOT_ALLOWED" });

    const secret = dependencies.workerSecret;
    if (!secret || new TextEncoder().encode(secret).byteLength < MIN_SECRET_BYTES) {
      return response(503, { error: "WORKER_AUTH_NOT_CONFIGURED" });
    }
    const issuedAt = request.headers.get("x-m3-timestamp");
    const nonce = request.headers.get("x-m3-nonce");
    const targetCallId = request.headers.get("x-m3-call-id");
    const authorized = await hasValidWorkerAuthorization(
      request.headers.get("authorization"),
      issuedAt,
      nonce,
      secret,
      Date.now(),
      targetCallId,
    );
    if (!authorized) return response(401, { error: "UNAUTHORIZED" });

    let nonceConsumed: boolean;
    try {
      nonceConsumed = await withTimeout(() => dependencies.consumeNonce(nonce as string, issuedAt as string), timeoutMs);
    } catch {
      return response(503, { error: "WORKER_AUTH_UNAVAILABLE" });
    }
    if (!nonceConsumed) return response(401, { error: "UNAUTHORIZED" });

    if (!dependencies.processingEnabled) {
      dependencies.log("worker", "disabled");
      return response(200, { processed: 0, outcome: "disabled" });
    }
    if (!dependencies.syntheticOnly && !dependencies.generalPrivateEnabled) {
      dependencies.log("worker", "processing_policy_disabled");
      return response(503, { error: "PROCESSING_POLICY_DISABLED" });
    }
    if (!dependencies.providerConfigured || !dependencies.model) {
      dependencies.log("worker", "provider_not_configured");
      return response(503, { error: "PROVIDER_NOT_CONFIGURED" });
    }

    const deadline = Date.now() + WORKER_RUNTIME_BUDGET_MS;
    const work = processNextM3Job(dependencies, timeoutMs, deadline, targetCallId ?? undefined);
    if (dependencies.scheduleBackground) {
      const scheduledWork = work.then(() => undefined).catch(() => {
        dependencies.log("worker", "background_failed");
      });
      try {
        dependencies.scheduleBackground(scheduledWork);
      } catch {
        dependencies.log("worker", "background_schedule_failed");
        return response(503, { error: "BACKGROUND_WORK_UNAVAILABLE" });
      }
      return response(202, { accepted: true });
    }
    return work;
  };
}

async function processNextM3Job(
  dependencies: M3WorkerDependencies,
  stepTimeoutMs: number,
  deadline: number,
  targetCallId?: string,
): Promise<Response> {
  let job: ClaimedM3Job | null;
  try {
    job = await withTimeout(
      () => dependencies.claimNextJob(JOB_LEASE_SECONDS, targetCallId),
      remainingTimeout(deadline, stepTimeoutMs),
    );
  } catch (error) {
    const outcome = error instanceof WorkerStepTimeoutError ? "claim_unknown" : "queue_unavailable";
    dependencies.log("claim", outcome);
    return response(503, { processed: 0, outcome });
  }
  if (!job) {
    dependencies.log("claim", "empty");
    return response(200, { processed: 0, outcome: "empty" });
  }
  if (job.processor_kind !== "pending_m3") {
    dependencies.log("job", "rejected_kind");
    return response(200, { processed: 0, outcome: "rejected_job_kind" });
  }
  const correlationId = crypto.randomUUID();

  try {
    const source = await withTimeout(
      () => dependencies.getJobSource(job),
      remainingTimeout(deadline, stepTimeoutMs),
    );
    if (!source || !isValidM3JobSource(job, source, Date.now())) {
      const outcome = await failAndReconcile(
        dependencies,
        job,
        "JOB_LINK_INVALID",
        null,
        remainingTimeout(deadline, stepTimeoutMs),
        correlationId,
      );
      dependencies.log("job", outcome, correlationId);
      return response(200, { processed: 0, outcome });
    }

    const audioTimeoutMs = Math.min(
      AUDIO_DOWNLOAD_TIMEOUT_MS,
      deadline - Date.now() - (STEP_TIMEOUT_MS * 2) - M3_PROVIDER_CLEANUP_TIMEOUT_MS,
    );
    if (audioTimeoutMs <= 0) throw new M3ProcessingError("STORAGE_UNAVAILABLE");
    let audio: Uint8Array;
    try {
      audio = await withAbortTimeout((signal) => dependencies.loadAudio(source, signal), audioTimeoutMs);
    } catch {
      throw new M3ProcessingError("STORAGE_UNAVAILABLE");
    }
    if (audio.byteLength !== source.intent_expected_size || audio.byteLength > M3_MAX_AUDIO_BYTES) {
      throw new M3ProcessingError("SOURCE_INVALID");
    }
    if (await sha256Hex(audio) !== source.synthetic_fixture_sha256.toLowerCase()) {
      throw new M3ProcessingError("SOURCE_INVALID");
    }
    if (!isValidM3JobSource(job, source, Date.now())) throw new M3ProcessingError("JOB_LINK_INVALID");

    const duration = parseMp3Duration(audio);
    if (duration.durationSeconds > M3_MAX_AUDIO_SECONDS) throw new M3ProcessingError("SOURCE_TOO_LONG");

    const providerTimeoutMs = Math.min(
      M3_PROVIDER_TIMEOUT_MS,
      deadline - Date.now() - (STEP_TIMEOUT_MS * 2) - M3_PROVIDER_CLEANUP_TIMEOUT_MS,
    );
    if (providerTimeoutMs <= 0) throw new M3ProcessingError("PROVIDER_TIMEOUT");
    const modelOutput = await runWorkerStage(
      dependencies,
      correlationId,
      "provider_execution",
      deadline,
      () => withTimeout(
        () => dependencies.transcribe(audio, providerTimeoutMs, {
          correlationId,
          onDiagnostic(event) {
            emitDiagnostic(dependencies, { component: "provider", ...event, correlationId });
          },
        }),
        providerTimeoutMs + M3_PROVIDER_CLEANUP_TIMEOUT_MS,
      ),
    );
    const analysis = buildM3PersistedAnalysis(modelOutput, dependencies.model, duration.durationSeconds);

    try {
      const completed = await runWorkerStage(
        dependencies,
        correlationId,
        "database_completion",
        deadline,
        () => withTimeout(
          () => dependencies.completeJob(job, analysis),
          remainingTimeout(deadline, stepTimeoutMs),
        ),
      );
      if (!completed) {
        dependencies.log("job", "lease_lost", correlationId);
        return response(200, { processed: 0, outcome: "lease_lost" });
      }
      dependencies.log("job", "transcript_persisted", correlationId);
      return response(200, { processed: 1, outcome: "review_required" });
    } catch {
      const outcome = await reconcileCompletion(
        dependencies,
        job.id,
        remainingTimeout(deadline, stepTimeoutMs),
        correlationId,
      );
      dependencies.log("job", outcome, correlationId);
      return response(200, { processed: outcome === "review_required" ? 1 : 0, outcome });
    }
  } catch (error) {
    const processingError = safeProcessingError(error);
    const outcome = await failAndReconcile(
      dependencies,
      job,
      processingError.code,
      processingError.retryAfterSeconds,
      remainingTimeout(deadline, stepTimeoutMs),
      correlationId,
    );
    dependencies.log("job", outcome, correlationId);
    return response(200, { processed: 0, outcome });
  }
}

export function isValidM3JobSource(job: ClaimedM3Job, source: M3JobSource, now = Date.now()) {
  const objectPath = OBJECT_PATH_PATTERN.exec(source.call_storage_path);
  if (!objectPath) return false;
  return job.processor_kind === "pending_m3" &&
    source.processor_kind === "pending_m3" &&
    source.job_status === "leased" &&
    source.attempt_owner === job.attempt_owner &&
    Date.parse(source.lease_expires_at) > now &&
    source.workspace_id === job.workspace_id &&
    source.call_id === job.call_id &&
    UUID_PATTERN.test(job.id) &&
    UUID_PATTERN.test(job.workspace_id) &&
    UUID_PATTERN.test(job.call_id) &&
    source.call_workspace_id === job.workspace_id &&
    source.call_status === "processing" &&
    ["abc", "noble_sales"].includes(source.call_brand) &&
    source.upload_intent_id !== null &&
    UUID_PATTERN.test(source.upload_intent_id) &&
    source.intent_id === source.upload_intent_id &&
    source.intent_workspace_id === job.workspace_id &&
    source.intent_user_id !== null &&
    source.intent_user_id === source.call_uploader_user_id &&
    source.intent_object_path === source.call_storage_path &&
    source.intent_status === "finalized" &&
    source.intent_finalized_call_id === job.call_id &&
    source.intent_mime_type === "audio/mpeg" &&
    /^[a-f0-9]{64}$/i.test(source.synthetic_fixture_sha256) &&
    typeof source.intent_expected_size === "number" &&
    Number.isInteger(source.intent_expected_size) &&
    source.intent_expected_size >= 1 &&
    source.intent_expected_size <= M3_MAX_AUDIO_BYTES &&
    source.synthetic_fixture_ref !== null &&
    source.synthetic_fixture_ref.trim().length > 0 &&
    objectPath[1].toLowerCase() === job.workspace_id.toLowerCase() &&
    objectPath[2].toLowerCase() === source.upload_intent_id.toLowerCase();
}

async function failAndReconcile(
  dependencies: M3WorkerDependencies,
  job: ClaimedM3Job,
  code: M3SafeErrorCode,
  retryAfterSeconds: number | null,
  timeoutMs: number,
  correlationId: string,
) {
  try {
    const recorded = await runWorkerStage(
      dependencies,
      correlationId,
      "database_failure_recording",
      Date.now() + timeoutMs,
      () => withTimeout(() => dependencies.failJob(job, code, retryAfterSeconds), timeoutMs),
    );
    if (!recorded) return "lease_lost";
  } catch {
    return reconcileFailure(dependencies, job.id, code, timeoutMs, correlationId);
  }
  return reconcileFailure(dependencies, job.id, code, timeoutMs, correlationId);
}

async function reconcileCompletion(
  dependencies: M3WorkerDependencies,
  jobId: string,
  timeoutMs: number,
  correlationId: string,
) {
  try {
    const state = await runWorkerStage(
      dependencies,
      correlationId,
      "completion_reconciliation",
      Date.now() + timeoutMs,
      () => withTimeout(() => dependencies.getJobOutcome(jobId), timeoutMs),
    );
    return state?.status === "succeeded" &&
      state.completion_kind === "m3" &&
      state.attempt_owner === null &&
      state.lease_expires_at === null
      ? "review_required"
      : "completion_unknown";
  } catch {
    return "completion_unknown";
  }
}

async function reconcileFailure(
  dependencies: M3WorkerDependencies,
  jobId: string,
  code: M3SafeErrorCode,
  timeoutMs: number,
  correlationId: string,
) {
  try {
    const state = await runWorkerStage(
      dependencies,
      correlationId,
      "failure_reconciliation",
      Date.now() + timeoutMs,
      () => withTimeout(() => dependencies.getJobOutcome(jobId), timeoutMs),
    );
    if (state?.safe_error_code !== code || state.attempt_owner !== null || state.lease_expires_at !== null) {
      return "failure_unknown";
    }
    if (state.status === "failed" && state.completed_at !== null) return "failed";
    if (state.status === "failed" && state.next_retry_at !== null) return "retry_scheduled";
    return "failure_unknown";
  } catch {
    return "failure_unknown";
  }
}

async function runWorkerStage<T>(
  dependencies: M3WorkerDependencies,
  correlationId: string,
  operation: M3WorkerDiagnostic["operation"],
  deadline: number,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  emitDiagnostic(dependencies, {
    component: "worker",
    correlationId,
    operation,
    phase: "start",
    remainingBudgetMs: Math.max(0, deadline - startedAt),
  });
  try {
    const result = await run();
    const classification = result === false
      ? "lease_lost"
      : result === null && operation.endsWith("reconciliation")
      ? "unknown"
      : "success";
    emitDiagnostic(dependencies, {
      component: "worker",
      correlationId,
      operation,
      phase: "finish",
      classification,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      remainingBudgetMs: Math.max(0, deadline - Date.now()),
    });
    return result;
  } catch (error) {
    const classification = error instanceof WorkerStepTimeoutError ||
        error instanceof M3ProcessingError && error.code === "PROVIDER_TIMEOUT"
      ? "timeout"
      : operation === "provider_execution"
      ? "processing_failure"
      : "database_failure";
    emitDiagnostic(dependencies, {
      component: "worker",
      correlationId,
      operation,
      phase: "finish",
      classification,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      remainingBudgetMs: Math.max(0, deadline - Date.now()),
    });
    throw error;
  }
}

function emitDiagnostic(dependencies: M3WorkerDependencies, event: M3DiagnosticEvent) {
  try {
    dependencies.logDiagnostic?.(event);
  } catch {
    // Diagnostics are best-effort and must not change job processing.
  }
}

function safeProcessingError(error: unknown) {
  if (error instanceof WorkerStepTimeoutError) return new M3ProcessingError("PROVIDER_TIMEOUT");
  return error instanceof M3ProcessingError
    ? error
    : new M3ProcessingError("STORAGE_UNAVAILABLE");
}

function remainingTimeout(deadline: number, ceilingMs: number) {
  return Math.max(1, Math.min(ceilingMs, deadline - Date.now()));
}

async function sha256Hex(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hasValidWorkerAuthorization(
  header: string | null,
  issuedAt: string | null,
  nonce: string | null,
  secret: string,
  now: number,
  targetCallId: string | null,
) {
  if (!header) return false;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match || !issuedAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(issuedAt)) return false;
  if (!nonce || !UUID_PATTERN.test(nonce) || !/^[0-9a-f]{64}$/i.test(match[1])) return false;
  if (targetCallId !== null && !UUID_PATTERN.test(targetCallId)) return false;

  const timestampMs = Date.parse(issuedAt);
  if (!Number.isFinite(timestampMs) || timestampMs < now - 120_000 || timestampMs > now + 30_000) return false;
  const expected = await signM3WorkerSecret(secret, issuedAt, nonce, targetCallId ?? undefined);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected[index] ^ Number.parseInt(match[1].slice(index * 2, index * 2 + 2), 16);
  return difference === 0;
}

export async function createM3WorkerSignature(secret: string, issuedAt: string, nonce: string, targetCallId?: string) {
  const bytes = await signM3WorkerSecret(secret, issuedAt, nonce, targetCallId);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signM3WorkerSecret(secret: string, issuedAt: string, nonce: string, targetCallId?: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`POST\n/functions/v1/m3-process-queue\n${issuedAt}\n${nonce}${targetCallId ? `\n${targetCallId}` : ""}`),
  ));
}

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new WorkerStepTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new WorkerStepTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function response(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-m3-job-lease-seconds": String(JOB_LEASE_SECONDS),
    },
  });
}
