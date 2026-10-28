import { describe, expect, it, vi } from "vitest";
import {
  createM2WorkerHandler,
  createM2WorkerSignature,
  type ClaimedM2Job,
  type M2WorkerDependencies,
} from "../../../supabase/functions/_shared/m2-worker";

const workerSecret = "m2-worker-test-secret-with-at-least-32-bytes";
const fixtureJob: ClaimedM2Job = {
  id: "10000000-0000-4000-8000-000000000001",
  workspace_id: "20000000-0000-4000-8000-000000000001",
  call_id: "30000000-0000-4000-8000-000000000001",
  processor_kind: "m2_synthetic_test",
  attempt_owner: "40000000-0000-4000-8000-000000000001",
};

type TestJobOutcome = {
  status: string;
  completion_kind: string | null;
  attempt_owner: string | null;
  lease_expires_at: string | null;
  safe_error_code: string | null;
};

type TestWorkerDependencies = M2WorkerDependencies & {
  getJobOutcome(jobId: string): Promise<TestJobOutcome | null>;
  stepTimeoutMs: number;
};

function makeDependencies(overrides: Partial<TestWorkerDependencies> = {}) {
  const deps: TestWorkerDependencies = {
    workerSecret,
    syntheticProcessorEnabled: true,
    stepTimeoutMs: 12_000,
    consumeNonce: vi.fn(async () => true),
    cleanAbandonedUploads: vi.fn(async () => ({ removed: 0, failed: 0 })),
    claimNextJob: vi.fn(async () => null),
    verifyJobLink: vi.fn(async () => true),
    completeJob: vi.fn(async () => true),
    failJob: vi.fn(async () => true),
    getJobOutcome: vi.fn(async () => ({
      status: "leased",
      completion_kind: null,
      attempt_owner: fixtureJob.attempt_owner,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      safe_error_code: null,
    })),
    log: vi.fn(),
    ...overrides,
  };
  return deps;
}

async function authorizedRequest(secret = workerSecret, method = "POST") {
  const issuedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const nonce = crypto.randomUUID();
  const signature = await createM2WorkerSignature(secret, issuedAt, nonce);
  return new Request("https://worker.example.test", {
    method,
    headers: {
      authorization: `Bearer ${signature}`,
      "x-m2-timestamp": issuedAt,
      "x-m2-nonce": nonce,
    },
  });
}

describe("M2 queue worker", () => {
  it("rejects missing or invalid worker secrets without touching the queue", async () => {
    const deps = makeDependencies();
    const handler = createM2WorkerHandler(deps);
    const missing = await handler(new Request("https://worker.example.test", { method: "POST" }));
    const invalid = await handler(await authorizedRequest("wrong-worker-secret-value-that-is-long-enough"));
    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(deps.claimNextJob).not.toHaveBeenCalled();
  });

  it("fails closed when the worker secret is missing or too short", async () => {
    const handler = createM2WorkerHandler(makeDependencies({ workerSecret: "" }));
    const response = await handler(await authorizedRequest());
    expect(response.status).toBe(503);
  });

  it("rejects a replayed signed request before cleanup or queue access", async () => {
    const deps = makeDependencies({ consumeNonce: vi.fn(async () => false) });
    const response = await createM2WorkerHandler(deps)(await authorizedRequest());
    expect(response.status).toBe(401);
    expect(deps.consumeNonce).toHaveBeenCalledOnce();
    expect(deps.cleanAbandonedUploads).not.toHaveBeenCalled();
    expect(deps.claimNextJob).not.toHaveBeenCalled();
  });

  it("rejects an otherwise valid but expired signed request", async () => {
    const deps = makeDependencies();
    const issuedAt = new Date(Date.now() - 180_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const nonce = crypto.randomUUID();
    const signature = await createM2WorkerSignature(workerSecret, issuedAt, nonce);
    const request = new Request("https://worker.example.test", {
      method: "POST",
      headers: {
        authorization: `Bearer ${signature}`,
        "x-m2-timestamp": issuedAt,
        "x-m2-nonce": nonce,
      },
    });
    const response = await createM2WorkerHandler(deps)(request);
    expect(response.status).toBe(401);
    expect(deps.consumeNonce).not.toHaveBeenCalled();
  });

  it("rejects methods other than POST", async () => {
    const deps = makeDependencies();
    const response = await createM2WorkerHandler(deps)(await authorizedRequest(workerSecret, "GET"));
    expect(response.status).toBe(405);
    expect(deps.claimNextJob).not.toHaveBeenCalled();
  });

  it("returns a safe no-op for an empty queue", async () => {
    const deps = makeDependencies();
    const response = await createM2WorkerHandler(deps)(await authorizedRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ processed: 0, outcome: "empty" });
    expect(deps.claimNextJob).toHaveBeenCalledOnce();
    expect(deps.completeJob).not.toHaveBeenCalled();
  });

  it("does not claim jobs while the synthetic processor is disabled", async () => {
    const deps = makeDependencies({ syntheticProcessorEnabled: false });
    const response = await createM2WorkerHandler(deps)(await authorizedRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ processed: 0, outcome: "disabled" });
    expect(deps.cleanAbandonedUploads).toHaveBeenCalledOnce();
    expect(deps.claimNextJob).not.toHaveBeenCalled();
  });

  it("completes only a linked explicit synthetic test job", async () => {
    const deps = makeDependencies({ claimNextJob: vi.fn(async () => fixtureJob) });
    const response = await createM2WorkerHandler(deps)(await authorizedRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ processed: 1, outcome: "synthetic_test" });
    expect(deps.verifyJobLink).toHaveBeenCalledWith(fixtureJob);
    expect(deps.completeJob).toHaveBeenCalledWith(fixtureJob.id, fixtureJob.attempt_owner);
    expect(deps.failJob).not.toHaveBeenCalled();
  });

  it("fails an unlinked claim safely instead of completing another workspace's call", async () => {
    const deps = makeDependencies({
      claimNextJob: vi.fn(async () => fixtureJob),
      verifyJobLink: vi.fn(async () => false),
    });
    const response = await createM2WorkerHandler(deps)(await authorizedRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ processed: 0, outcome: "rejected_linkage" });
    expect(deps.failJob).toHaveBeenCalledWith(fixtureJob.id, fixtureJob.attempt_owner, "INTERNAL_ERROR");
    expect(deps.completeJob).not.toHaveBeenCalled();
  });

  it("does not issue a contradictory failure when completion has an ambiguous error", async () => {
    const deps = makeDependencies({
      claimNextJob: vi.fn(async () => fixtureJob),
      completeJob: vi.fn(async () => { throw new Error("private detail must not be returned"); }),
    });
    const response = await createM2WorkerHandler(deps)(await authorizedRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ processed: 0, outcome: "completion_unknown" });
    expect(deps.failJob).not.toHaveBeenCalled();
    expect(deps.getJobOutcome).toHaveBeenCalledWith(fixtureJob.id);
    expect(await response.text().catch(() => "")).not.toContain("private detail");
  });

  it("does not fail a timed-out completion that can still commit later", async () => {
    let state: TestJobOutcome = {
      status: "leased",
      completion_kind: null,
      attempt_owner: fixtureJob.attempt_owner,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      safe_error_code: null,
    };
    const lateCompletion = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        state = { ...state, status: "succeeded", completion_kind: "synthetic_test", attempt_owner: null, lease_expires_at: null };
        resolve(true);
      }, 75);
    });
    const deps = makeDependencies({
      stepTimeoutMs: 15,
      claimNextJob: vi.fn(async () => fixtureJob),
      completeJob: vi.fn(() => lateCompletion),
      getJobOutcome: vi.fn(async () => state),
    });

    const response = await createM2WorkerHandler(deps)(await authorizedRequest());

    expect(await response.json()).toMatchObject({ processed: 0, outcome: "completion_unknown" });
    expect(deps.completeJob).toHaveBeenCalledOnce();
    expect(deps.failJob).not.toHaveBeenCalled();
    await lateCompletion;
    expect(state.status).toBe("succeeded");
  });

  it("reconciles a completion whose database commit succeeded before its response timed out", async () => {
    let state: TestJobOutcome = {
      status: "leased",
      completion_kind: null,
      attempt_owner: fixtureJob.attempt_owner,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      safe_error_code: null,
    };
    const deps = makeDependencies({
      stepTimeoutMs: 15,
      claimNextJob: vi.fn(async () => fixtureJob),
      completeJob: vi.fn(async () => {
        state = { ...state, status: "succeeded", completion_kind: "synthetic_test", attempt_owner: null, lease_expires_at: null };
        await new Promise((resolve) => setTimeout(resolve, 75));
        return true;
      }),
      getJobOutcome: vi.fn(async () => state),
    });

    const response = await createM2WorkerHandler(deps)(await authorizedRequest());

    await expect(response.json()).resolves.toMatchObject({ processed: 1, outcome: "synthetic_test" });
    expect(deps.getJobOutcome).toHaveBeenCalledOnce();
    expect(deps.failJob).not.toHaveBeenCalled();
  });

  it("does not issue a failure when completion arrives after lease expiry", async () => {
    const deps = makeDependencies({
      claimNextJob: vi.fn(async () => fixtureJob),
      completeJob: vi.fn(async () => false),
      getJobOutcome: vi.fn(async () => ({
        status: "leased",
        completion_kind: null,
        attempt_owner: fixtureJob.attempt_owner,
        lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
        safe_error_code: null,
      })),
    });

    const response = await createM2WorkerHandler(deps)(await authorizedRequest());

    await expect(response.json()).resolves.toMatchObject({ processed: 0, outcome: "lease_lost" });
    expect(deps.failJob).not.toHaveBeenCalled();
  });

  it("does not mutate a job after a newer attempt owns it", async () => {
    const deps = makeDependencies({
      claimNextJob: vi.fn(async () => fixtureJob),
      completeJob: vi.fn(async () => false),
      getJobOutcome: vi.fn(async () => ({
        status: "leased",
        completion_kind: null,
        attempt_owner: "50000000-0000-4000-8000-000000000001",
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        safe_error_code: null,
      })),
    });

    const response = await createM2WorkerHandler(deps)(await authorizedRequest());

    await expect(response.json()).resolves.toMatchObject({ processed: 0, outcome: "lease_lost" });
    expect(deps.completeJob).toHaveBeenCalledWith(fixtureJob.id, fixtureJob.attempt_owner);
    expect(deps.failJob).not.toHaveBeenCalled();
  });

  it("does not claim or complete a normal pending M3 job", async () => {
    const pendingM3 = { ...fixtureJob, processor_kind: "pending_m3" as const };
    const deps = makeDependencies({ claimNextJob: vi.fn(async () => pendingM3) });
    const response = await createM2WorkerHandler(deps)(await authorizedRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: "rejected_job_kind" });
    expect(deps.completeJob).not.toHaveBeenCalled();
    expect(deps.failJob).not.toHaveBeenCalled();
  });

  it("reconciles a delayed failure commit without issuing a duplicate failure", async () => {
    let state: TestJobOutcome = {
      status: "leased",
      completion_kind: null,
      attempt_owner: fixtureJob.attempt_owner,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      safe_error_code: null,
    };
    const deps = makeDependencies({
      stepTimeoutMs: 15,
      claimNextJob: vi.fn(async () => fixtureJob),
      verifyJobLink: vi.fn(async () => false),
      failJob: vi.fn(async () => {
        state = { ...state, status: "queued", attempt_owner: null, lease_expires_at: null, safe_error_code: "INTERNAL_ERROR" };
        await new Promise((resolve) => setTimeout(resolve, 75));
        return true;
      }),
      getJobOutcome: vi.fn(async () => state),
    });

    const response = await createM2WorkerHandler(deps)(await authorizedRequest());

    await expect(response.json()).resolves.toMatchObject({ processed: 0, outcome: "retry_scheduled" });
    expect(deps.failJob).toHaveBeenCalledOnce();
    expect(deps.getJobOutcome).toHaveBeenCalledWith(fixtureJob.id);
  });
});
