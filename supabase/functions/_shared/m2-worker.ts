export type ClaimedM2Job = {
  id: string;
  workspace_id: string;
  call_id: string;
  processor_kind: string;
  attempt_owner: string;
};

export type M2WorkerDependencies = {
  workerSecret: string | null;
  stepTimeoutMs?: number;
  syntheticProcessorEnabled: boolean;
  consumeNonce(nonce: string, issuedAt: string): Promise<boolean>;
  cleanAbandonedUploads(limit: number): Promise<{ removed: number; failed: number }>;
  claimNextJob(): Promise<ClaimedM2Job | null>;
  getJobOutcome(jobId: string): Promise<M2JobOutcome | null>;
  verifyJobLink(job: ClaimedM2Job): Promise<boolean>;
  completeJob(jobId: string, attemptOwner: string): Promise<boolean>;
  failJob(jobId: string, attemptOwner: string, safeErrorCode: SafeWorkerErrorCode): Promise<boolean>;
  log(event: string, outcome: string): void;
};

export type SafeWorkerErrorCode = "SYNTHETIC_PROCESSOR_ERROR" | "PROCESSOR_UNAVAILABLE" | "INTERNAL_ERROR";

export type M2JobOutcome = {
  status: string;
  completion_kind: string | null;
  attempt_owner: string | null;
  lease_expires_at: string | null;
  safe_error_code: string | null;
};

class WorkerStepTimeoutError extends Error {
  constructor() {
    super("WORKER_STEP_TIMEOUT");
    this.name = "WorkerStepTimeoutError";
  }
}

const MIN_SECRET_BYTES = 32;
const STEP_TIMEOUT_MS = 12_000;
const CLEANUP_BATCH_SIZE = 10;
const JOB_LEASE_SECONDS = 180;

export function createM2WorkerHandler(dependencies: M2WorkerDependencies) {
  return async function handleM2Worker(request: Request): Promise<Response> {
    const timeoutMs = Math.max(1, dependencies.stepTimeoutMs ?? STEP_TIMEOUT_MS);
    if (request.method !== "POST") return response(405, { error: "METHOD_NOT_ALLOWED" });

    const secret = dependencies.workerSecret;
    if (!secret || new TextEncoder().encode(secret).byteLength < MIN_SECRET_BYTES) {
      return response(503, { error: "WORKER_AUTH_NOT_CONFIGURED" });
    }
    const issuedAt = request.headers.get("x-m2-timestamp");
    const nonce = request.headers.get("x-m2-nonce");
    if (!(await hasValidWorkerAuthorization(request.headers.get("authorization"), issuedAt, nonce, secret, Date.now()))) {
      return response(401, { error: "UNAUTHORIZED" });
    }

    let nonceConsumed: boolean;
    try {
      nonceConsumed = await withTimeout(() => dependencies.consumeNonce(nonce as string, issuedAt as string), timeoutMs);
    } catch {
      return response(503, { error: "WORKER_AUTH_UNAVAILABLE" });
    }
    if (!nonceConsumed) return response(401, { error: "UNAUTHORIZED" });

    let cleanup = { removed: 0, failed: 0 };
    try {
      cleanup = await withTimeout(() => dependencies.cleanAbandonedUploads(CLEANUP_BATCH_SIZE), timeoutMs);
    } catch {
      dependencies.log("cleanup", "deferred");
      cleanup = { removed: 0, failed: CLEANUP_BATCH_SIZE };
    }

    if (!dependencies.syntheticProcessorEnabled) {
      dependencies.log("worker", "disabled");
      return response(200, { processed: 0, outcome: "disabled", cleanup });
    }

    let job: ClaimedM2Job | null;
    try {
      job = await withTimeout(() => dependencies.claimNextJob(), timeoutMs);
    } catch (error) {
      const outcome = isStepTimeout(error) ? "claim_unknown" : "queue_unavailable";
      dependencies.log("claim", outcome);
      return response(503, { processed: 0, outcome, cleanup });
    }
    if (!job) {
      dependencies.log("claim", "empty");
      return response(200, { processed: 0, outcome: "empty", cleanup });
    }

    if (job.processor_kind !== "m2_synthetic_test") {
      dependencies.log("job", "rejected_kind");
      return response(200, { processed: 0, outcome: "rejected_job_kind", cleanup });
    }

    let linked: boolean;
    try {
      linked = await withTimeout(() => dependencies.verifyJobLink(job), timeoutMs);
    } catch (error) {
      if (isStepTimeout(error)) {
        dependencies.log("job", "verification_unknown");
        return response(200, { processed: 0, outcome: "verification_unknown", cleanup });
      }
      linked = false;
    }
    if (!linked) {
      const recorded = await recordFailure(dependencies, job, "INTERNAL_ERROR", timeoutMs);
      const outcome = recorded === "recorded"
        ? "rejected_linkage"
        : recorded === "lease_lost"
          ? "lease_lost"
          : await reconcileFailure(dependencies, job.id, "INTERNAL_ERROR", timeoutMs);
      dependencies.log("job", outcome);
      return response(200, { processed: 0, outcome, cleanup });
    }

    try {
      const completed = await withTimeout(() => dependencies.completeJob(job.id, job.attempt_owner), timeoutMs);
      if (!completed) {
        dependencies.log("job", "lease_lost");
        return response(200, { processed: 0, outcome: "lease_lost", cleanup });
      }
      dependencies.log("job", "synthetic_test");
      return response(200, { processed: 1, outcome: "synthetic_test", cleanup });
    } catch {
      // A timed-out/failed completion response is ambiguous: the RPC may still commit.
      // Reconcile with a read only query and never issue a competing failure write.
      const outcome = await reconcileCompletion(dependencies, job.id, timeoutMs);
      dependencies.log("job", outcome);
      return response(200, { processed: outcome === "synthetic_test" ? 1 : 0, outcome, cleanup });
    }
  };
}

async function recordFailure(
  dependencies: M2WorkerDependencies,
  job: ClaimedM2Job,
  errorCode: SafeWorkerErrorCode,
  timeoutMs: number,
) {
  try {
    const recorded = await withTimeout(() => dependencies.failJob(job.id, job.attempt_owner, errorCode), timeoutMs);
    return recorded ? "recorded" as const : "lease_lost" as const;
  } catch {
    return "unknown" as const;
  }
}

async function reconcileCompletion(
  dependencies: M2WorkerDependencies,
  jobId: string,
  timeoutMs: number,
) {
  try {
    const state = await withTimeout(() => dependencies.getJobOutcome(jobId), timeoutMs);
    return state?.status === "succeeded" &&
      state.completion_kind === "synthetic_test" &&
      state.attempt_owner === null &&
      state.lease_expires_at === null
      ? "synthetic_test"
      : "completion_unknown";
  } catch {
    return "completion_unknown";
  }
}

async function reconcileFailure(
  dependencies: M2WorkerDependencies,
  jobId: string,
  errorCode: SafeWorkerErrorCode,
  timeoutMs: number,
) {
  try {
    const state = await withTimeout(() => dependencies.getJobOutcome(jobId), timeoutMs);
    if (state?.safe_error_code !== errorCode || state.attempt_owner !== null || state.lease_expires_at !== null) {
      return "failure_unknown";
    }
    if (state.status === "queued") return "retry_scheduled";
    if (state.status === "failed") return "failed";
    return "failure_unknown";
  } catch {
    return "failure_unknown";
  }
}

function isStepTimeout(error: unknown): error is WorkerStepTimeoutError {
  return error instanceof WorkerStepTimeoutError;
}

async function hasValidWorkerAuthorization(
  header: string | null,
  issuedAt: string | null,
  nonce: string | null,
  secret: string,
  now: number,
) {
  if (!header) return false;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match) return false;
  if (!issuedAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(issuedAt)) return false;
  if (!nonce || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)) return false;

  const timestampMs = Date.parse(issuedAt);
  if (!Number.isFinite(timestampMs) || timestampMs < now - 120_000 || timestampMs > now + 30_000) return false;
  if (!/^[0-9a-f]{64}$/i.test(match[1])) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(workerCanonicalMessage(issuedAt, nonce)),
  ));
  const provided = hexToBytes(match[1]);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ provided[index];
  }
  return difference === 0;
}

export async function createM2WorkerSignature(secret: string, issuedAt: string, nonce: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(workerCanonicalMessage(issuedAt, nonce)),
  ));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function workerCanonicalMessage(issuedAt: string, nonce: string) {
  return `POST\n/functions/v1/m2-process-queue\n${issuedAt}\n${nonce}`;
}

function hexToBytes(value: string) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
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

function response(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-m2-job-lease-seconds": String(JOB_LEASE_SECONDS),
    },
  });
}
