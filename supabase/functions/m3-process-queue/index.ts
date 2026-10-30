import { withSupabase } from "npm:@supabase/server@1";
import {
  M3ProcessingError,
  type M3SafeErrorCode,
} from "../_shared/m3-analysis.ts";
import { transcribeSyntheticAudio } from "../_shared/m3-provider.ts";
import { prepareM3ProvisionalAssessment } from "../../../src/lib/scoring/m3-provisional-assessment.ts";
import {
  createM3WorkerHandler,
  summarizeM3RuntimeConfig,
  type ClaimedM3Job,
  type M3DiagnosticEvent,
  type M3JobOutcome,
  type M3ProviderContext,
  type M3JobSource,
} from "../_shared/m3-worker.ts";

const AUDIO_BUCKET = "pestlaunch-call-audio";
const EXPECTED_ALLOWED_MIME_TYPES = ["audio/mpeg"];
const apiKey = Deno.env.get("M3_GEMINI_API_KEY") ?? "";
const model = Deno.env.get("M3_GEMINI_MODEL") ?? "";
const processingEnabled = Deno.env.get("M3_PROCESSING_ENABLED") === "true";
const syntheticOnly = Deno.env.get("M3_SYNTHETIC_ONLY") === "true";
const generalPrivateEnabled = Deno.env.get("M3_GENERAL_PRIVATE_ENABLED") === "true";
const runtimeConfig = summarizeM3RuntimeConfig(apiKey, model, processingEnabled, syntheticOnly);

// This allowlisted diagnostic never logs the API key or any other secret.
console.info(JSON.stringify({
  component: "m3-process-queue",
  event: "runtime_config",
  ...runtimeConfig,
}));

// The local Supabase CLI injects legacy key names. This explicitly opt-in
// branch is test-only; it does not change worker authentication or gates.
const localCompat = Deno.env.get("M3_LOCAL_SUPABASE_COMPAT") === "true";
const localOverrides = localCompat
  ? {
    env: {
      publishableKeys: { default: Deno.env.get("M3_LOCAL_PUBLISHABLE_KEY") ?? "" },
      secretKeys: { default: Deno.env.get("M3_LOCAL_SECRET_KEY") ?? "" },
    },
  }
  : {};

const m3ProcessQueue = {
  fetch: withSupabase({ auth: "none", ...localOverrides }, async (request: Request, context) => {
    const admin = context.supabaseAdmin;
    const logProvisionalAssessment = (outcome: string) => console.info(JSON.stringify({
      component: "m3-process-queue",
      event: "m4_provisional_assessment",
      outcome,
    }));
    const persistProvisionalAssessment = async (callId: string, workspaceId: string) => {
      const { data: callData, error: callError } = await admin.from("calls")
        .select("id,workspace_id,brand,call_type,status")
        .eq("id", callId)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (callError || !callData || callData.status !== "review_required") {
        logProvisionalAssessment("source_unavailable");
        return;
      }

      const { data: analysisData, error: analysisError } = await admin.from("call_analyses")
        .select("id,call_id,transcript,extracted_facts,quality_indicators,review_status,version")
        .eq("call_id", callId)
        .eq("version", 1)
        .maybeSingle();
      if (analysisError || !analysisData || !callData.brand || !callData.call_type) {
        logProvisionalAssessment("analysis_unavailable");
        return;
      }

      const { data: rubricData, error: rubricError } = await admin.from("rubric_versions")
        .select("brand,category,version,definition,calibration_status")
        .eq("brand", callData.brand)
        .eq("category", callData.call_type)
        .eq("is_active", true)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (rubricError || !rubricData) {
        logProvisionalAssessment("rubric_unavailable");
        return;
      }

      const prepared = prepareM3ProvisionalAssessment({
        call: {
          id: callData.id,
          workspaceId: callData.workspace_id,
          brand: callData.brand,
          category: callData.call_type,
          status: callData.status,
        },
        analysis: {
          id: analysisData.id,
          callId: analysisData.call_id,
          transcript: analysisData.transcript,
          extractedFacts: analysisData.extracted_facts,
          qualityIndicators: analysisData.quality_indicators,
          reviewStatus: analysisData.review_status,
          version: analysisData.version,
        },
        rubric: rubricData,
      });
      if (prepared.status !== "prepared") {
        logProvisionalAssessment("assessment_not_persistable");
        return;
      }

      const { error: persistError } = await admin.rpc(prepared.payload.rpcName, {
        p_analysis_id: prepared.payload.analysisId,
        p_scoring_version: prepared.payload.scoringVersion,
        p_calculation: prepared.payload.calculation,
      });
      logProvisionalAssessment(persistError ? "persistence_failed" : "persisted");
    };
    const handler = createM3WorkerHandler({
      workerSecret: Deno.env.get("M3_WORKER_AUTH_SECRET") ?? null,
      processingEnabled: runtimeConfig.processingEnabled,
      syntheticOnly: runtimeConfig.syntheticOnly,
      generalPrivateEnabled,
      providerConfigured: runtimeConfig.providerConfigured,
      model: runtimeConfig.model ?? "",

      async consumeNonce(nonce, issuedAt) {
        const { data, error } = await admin.rpc("consume_m3_worker_nonce", {
          p_nonce: nonce,
          p_issued_at: issuedAt,
        });
        if (error) throw new Error("WORKER_NONCE_CONSUME_FAILED");
        return data === true;
      },

      async claimNextJob(leaseSeconds, callId) {
        const { data, error } = callId
          ? await admin.rpc("claim_m3_demo_job", { p_call_id: callId, p_lease_seconds: leaseSeconds })
          : await admin.rpc("claim_m3_job", { p_lease_seconds: leaseSeconds });
        if (error) throw new Error("M3_QUEUE_CLAIM_FAILED");
        if (!Array.isArray(data) || data.length === 0) return null;
        if (data.length !== 1) throw new Error("M3_QUEUE_CLAIM_RETURNED_MULTIPLE_ROWS");
        const row = data[0] as Record<string, unknown>;
        if (
          typeof row.id !== "string" ||
          typeof row.workspace_id !== "string" ||
          typeof row.call_id !== "string" ||
          typeof row.processor_kind !== "string" ||
          typeof row.attempt_owner !== "string"
        ) {
          throw new Error("M3_QUEUE_CLAIM_RETURNED_INVALID_ROW");
        }
        return row as ClaimedM3Job;
      },

      async getJobSource(job) {
        const { data, error } = await admin.rpc("get_m3_job_source", {
          p_job_id: job.id,
          p_attempt_owner: job.attempt_owner,
        });
        if (error) throw new Error("M3_JOB_SOURCE_LOOKUP_FAILED");
        if (!Array.isArray(data) || data.length !== 1) return null;
        return data[0] as M3JobSource;
      },

      async loadAudio(source, signal) {
        if (signal.aborted) throw new M3ProcessingError("STORAGE_UNAVAILABLE");
        const { data: bucket, error: bucketError } = await admin.storage.getBucket(AUDIO_BUCKET);
        if (
          bucketError ||
          !bucket ||
          bucket.id !== AUDIO_BUCKET ||
          bucket.public !== false ||
          bucket.file_size_limit !== 52_428_800 ||
          JSON.stringify(bucket.allowed_mime_types) !== JSON.stringify(EXPECTED_ALLOWED_MIME_TYPES)
        ) {
          throw new M3ProcessingError("STORAGE_UNAVAILABLE");
        }

        if (signal.aborted) throw new M3ProcessingError("STORAGE_UNAVAILABLE");
        const { data, error } = await admin.storage.from(AUDIO_BUCKET)
          .download(source.call_storage_path, {}, { signal });
        if (error || !data || data.type !== "audio/mpeg") {
          throw new M3ProcessingError("STORAGE_UNAVAILABLE");
        }
        const bytes = new Uint8Array(await data.arrayBuffer());
        if (bytes.byteLength !== source.intent_expected_size) throw new M3ProcessingError("SOURCE_INVALID");
        return bytes;
      },

      async transcribe(audio, timeoutMs, providerContext?: M3ProviderContext) {
        return transcribeSyntheticAudio({
          apiKey,
          model,
          audio,
          timeoutMs,
          correlationId: providerContext?.correlationId,
          onDiagnostic: providerContext?.onDiagnostic,
        });
      },

      async completeJob(job, analysis) {
        const { data, error } = await admin.rpc("complete_m3_job", {
          p_job_id: job.id,
          p_attempt_owner: job.attempt_owner,
          p_transcript: analysis.transcript,
          p_model: model,
          p_call_type: analysis.callType,
          p_extracted_facts: analysis.extractedFacts,
          p_outcome: analysis.outcome,
          p_quality_indicators: analysis.qualityIndicators,
          p_duration_seconds: analysis.durationSeconds,
        });
        if (error) throw new Error("M3_COMPLETION_FAILED");
        if (data === true) {
          await persistProvisionalAssessment(job.call_id, job.workspace_id);
        }
        return data === true;
      },

      async failJob(job, code: M3SafeErrorCode, retryAfterSeconds) {
        const { data, error } = await admin.rpc("fail_m3_job", {
          p_job_id: job.id,
          p_attempt_owner: job.attempt_owner,
          p_safe_error_code: code,
          p_retry_after_seconds: retryAfterSeconds,
        });
        if (error) throw new Error("M3_FAILURE_PERSIST_FAILED");
        return data === true;
      },

      async getJobOutcome(jobId) {
        const { data, error } = await admin
          .from("analysis_jobs")
          .select("status, completion_kind, attempt_owner, lease_expires_at, next_retry_at, completed_at, safe_error_code")
          .eq("id", jobId)
          .maybeSingle();
        if (error) throw new Error("M3_JOB_OUTCOME_LOOKUP_FAILED");
        return data as M3JobOutcome | null;
      },

      log(event, outcome, correlationId) {
        console.info(JSON.stringify({
          component: "m3-process-queue",
          event,
          outcome,
          ...(correlationId && /^[0-9a-f-]{36}$/i.test(correlationId) ? { correlation_id: correlationId } : {}),
        }));
      },

      logDiagnostic(event: M3DiagnosticEvent) {
        if (event.component === "provider") {
          console.info(JSON.stringify({
            component: "m3-process-queue",
            event: "provider_stage",
            correlation_id: event.correlationId,
            operation: event.operation,
            phase: event.phase,
            classification: event.classification,
            elapsed_ms: event.elapsedMs,
            remaining_budget_ms: event.remainingBudgetMs,
            http_status: event.httpStatus,
            retry_classification: event.retryClassification,
            file_state: event.fileState,
            poll_count: event.pollCount,
            cleanup_outcome: event.cleanupOutcome,
            validation_failure: event.validationFailure,
          }));
          return;
        }
        console.info(JSON.stringify({
          component: "m3-process-queue",
          event: "worker_stage",
          correlation_id: event.correlationId,
          operation: event.operation,
          phase: event.phase,
          classification: event.classification,
          elapsed_ms: event.elapsedMs,
          remaining_budget_ms: event.remainingBudgetMs,
        }));
      },

      scheduleBackground(task) {
        const edgeRuntime = (globalThis as typeof globalThis & {
          EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
        }).EdgeRuntime;
        if (!edgeRuntime) throw new Error("BACKGROUND_RUNTIME_UNAVAILABLE");
        edgeRuntime.waitUntil(task);
      },
    });

    return handler(request);
  }),
};

export default m3ProcessQueue;
