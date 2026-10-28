import { withSupabase } from "npm:@supabase/server@1";
import {
  createM2WorkerHandler,
  type ClaimedM2Job,
  type M2JobOutcome,
  type SafeWorkerErrorCode,
} from "../_shared/m2-worker.ts";

const AUDIO_BUCKET = "pestlaunch-call-audio";
const objectPathPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp3$/i;

// The older local Supabase CLI injects legacy key names rather than the
// default-key environment expected by @supabase/server. Tests may provide a
// dedicated local-only override; hosted runtimes retain normal auto-discovery.
const localCompat = Deno.env.get("M2_LOCAL_SUPABASE_COMPAT") === "true";
const localOverrides = localCompat
  ? {
    env: {
      publishableKeys: { default: Deno.env.get("M2_LOCAL_PUBLISHABLE_KEY") ?? "" },
      secretKeys: { default: Deno.env.get("M2_LOCAL_SECRET_KEY") ?? "" },
    },
  }
  : {};

const m2ProcessQueue = {
  fetch: withSupabase({ auth: "none", ...localOverrides }, async (request: Request, context) => {
    const admin = context.supabaseAdmin;
    const handler = createM2WorkerHandler({
      workerSecret: Deno.env.get("M2_WORKER_AUTH_SECRET") ?? null,
      syntheticProcessorEnabled: Deno.env.get("M2_TEST_PROCESSOR_ENABLED") === "true",

      async consumeNonce(nonce, issuedAt) {
        const { data, error } = await admin.rpc("consume_m2_worker_nonce", {
          p_nonce: nonce,
          p_issued_at: issuedAt,
        });
        if (error) throw new Error("WORKER_NONCE_CONSUME_FAILED");
        return data === true;
      },

      async cleanAbandonedUploads(limit) {
        const { data, error } = await admin.rpc("claim_abandoned_call_uploads", { p_limit: limit });
        if (error) throw new Error("CLEANUP_CLAIM_FAILED");

        let removed = 0;
        let failed = 0;
        for (const item of (data ?? []) as Array<{ id: string; object_path: string; cleanup_lease_token: string }>) {
          const releaseLease = async () => {
            await admin.rpc("release_call_upload_cleanup", {
              p_intent_id: item.id,
              p_cleanup_lease_token: item.cleanup_lease_token,
            });
          };
          if (!objectPathPattern.test(item.object_path)) {
            failed += 1;
            await releaseLease();
            continue;
          }
          const { error: removeError } = await admin.storage.from(AUDIO_BUCKET).remove([item.object_path]);
          if (removeError) {
            failed += 1;
            await releaseLease();
            continue;
          }
          const { data: markedClean, error: markError } = await admin.rpc("mark_call_upload_cleaned", {
            p_intent_id: item.id,
            p_cleanup_lease_token: item.cleanup_lease_token,
          });
          if (markError || markedClean !== true) {
            failed += 1;
            await releaseLease();
            continue;
          }
          removed += 1;
        }
        return { removed, failed };
      },

      async claimNextJob() {
        const { data, error } = await admin.rpc("claim_m2_job", { p_lease_seconds: 180 });
        if (error) throw new Error("QUEUE_CLAIM_FAILED");
        if (!Array.isArray(data) || data.length === 0) return null;
        if (data.length !== 1) throw new Error("QUEUE_CLAIM_RETURNED_MULTIPLE_ROWS");

        const row = data[0] as Record<string, unknown>;
        if (
          typeof row.id !== "string" ||
          typeof row.workspace_id !== "string" ||
          typeof row.call_id !== "string" ||
          typeof row.processor_kind !== "string" ||
          typeof row.attempt_owner !== "string"
        ) {
          throw new Error("QUEUE_CLAIM_RETURNED_INVALID_ROW");
        }
        return row as ClaimedM2Job;
      },

      async getJobOutcome(jobId) {
        const { data, error } = await admin
          .from("analysis_jobs")
          .select("status, completion_kind, attempt_owner, lease_expires_at, safe_error_code")
          .eq("id", jobId)
          .maybeSingle();
        if (error) throw new Error("JOB_OUTCOME_LOOKUP_FAILED");
        return data as M2JobOutcome | null;
      },

      async verifyJobLink(job) {
        const { data, error } = await admin
          .from("calls")
          .select("id")
          .eq("id", job.call_id)
          .eq("workspace_id", job.workspace_id)
          .eq("status", "processing")
          .maybeSingle();
        if (error) throw new Error("CALL_LINK_LOOKUP_FAILED");
        return data?.id === job.call_id;
      },

      async completeJob(jobId, attemptOwner) {
        const { data, error } = await admin.rpc("complete_m2_job", {
          p_job_id: jobId,
          p_attempt_owner: attemptOwner,
        });
        if (error) throw new Error("JOB_COMPLETION_FAILED");
        return data === true;
      },

      async failJob(jobId, attemptOwner, safeErrorCode: SafeWorkerErrorCode) {
        const { data, error } = await admin.rpc("fail_m2_job", {
          p_job_id: jobId,
          p_attempt_owner: attemptOwner,
          p_safe_error_code: safeErrorCode,
        });
        if (error) throw new Error("JOB_FAILURE_PERSIST_FAILED");
        return data === true;
      },

      log(event, outcome) {
        console.info(JSON.stringify({ component: "m2-process-queue", event, outcome }));
      },
    });

    return handler(request);
  }),
};

export default m2ProcessQueue;
