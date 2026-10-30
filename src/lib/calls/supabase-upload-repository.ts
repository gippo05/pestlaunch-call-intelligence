import type { SupabaseClient } from "@supabase/supabase-js";
import type { UploadIntentRow, UploadRepository } from "./upload-service";

const AUDIO_BUCKET = "pestlaunch-call-audio";
const INTENT_COLUMNS = [
  "id",
  "workspace_id",
  "user_id",
  "idempotency_key",
  "brand",
  "original_filename",
  "mime_type",
  "expected_size",
  "object_path",
  "status",
  "expires_at",
  "upload_lease_token",
  "upload_lease_expires_at",
  "finalized_call_id",
].join(",");

function m3AuthorizationFailure(postgresError: { code?: unknown; message?: unknown }) {
  const failure = new Error("M3_DEMO_AUTHORIZATION_FAILED") as Error & { m3DiagnosticCode: string };
  const message = typeof postgresError.message === "string" ? postgresError.message : "";
  failure.m3DiagnosticCode = message === "service role required for M3 demo authorization"
    ? "SERVICE_ROLE_REQUIRED"
    : message.startsWith("permission denied for function authorize_m3_synthetic_demo_call")
      ? "FUNCTION_EXECUTE_DENIED"
      : typeof postgresError.code === "string" && /^[A-Z0-9_]{1,40}$/.test(postgresError.code)
        ? postgresError.code
        : "UNKNOWN";
  return failure;
}

export function createSupabaseUploadRepository(userClient: SupabaseClient, adminClient: SupabaseClient): UploadRepository {
  return {
    async listWritableWorkspaces(userId) {
      const { data, error } = await userClient
        .from("workspace_members")
        .select("workspace_id, role")
        .eq("user_id", userId)
        .limit(50);
      if (error) throw new Error("MEMBERSHIP_LOOKUP_FAILED");
      return (data ?? []) as Array<{ workspace_id: string; role: string }>;
    },

    async getWritableWorkspaceRole(userId, workspaceId) {
      const { data, error } = await userClient
        .from("workspace_members")
        .select("role")
        .eq("user_id", userId)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (error) throw new Error("MEMBERSHIP_LOOKUP_FAILED");
      return typeof data?.role === "string" ? data.role : null;
    },

    async findIntentByIdempotency(userId, idempotencyKey) {
      const { data, error } = await adminClient
        .from("upload_intents")
        .select(INTENT_COLUMNS)
        .eq("user_id", userId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (error) throw new Error("INTENT_LOOKUP_FAILED");
      return data as UploadIntentRow | null;
    },

    async insertIntent(row) {
      const { error } = await adminClient.from("upload_intents").insert(row);
      if (error?.code === "23505") return false;
      if (error) throw new Error("INTENT_CREATE_FAILED");
      return true;
    },

    async getIntentForUser(userId, intentId) {
      const { data, error } = await adminClient
        .from("upload_intents")
        .select(INTENT_COLUMNS)
        .eq("id", intentId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new Error("INTENT_LOOKUP_FAILED");
      return data as UploadIntentRow | null;
    },

    async beginUpload(intentId, userId) {
      const { data, error } = await adminClient.rpc("begin_call_upload", {
        p_intent_id: intentId,
        p_user_id: userId,
        p_lease_seconds: 600,
      });
      if (error) throw new Error("UPLOAD_LEASE_FAILED");
      return typeof data === "string" ? data : null;
    },

    async downloadObject(objectPath) {
      const { data, error } = await adminClient.storage.from(AUDIO_BUCKET).download(objectPath);
      if (error) {
        const storageError = error as { statusCode?: string; code?: string };
        if (storageError.statusCode === "404" || storageError.code === "NoSuchKey") return null;
        throw new Error("STORAGE_DOWNLOAD_FAILED");
      }
      return {
        bytes: new Uint8Array(await data.arrayBuffer()),
        contentType: data.type || null,
      };
    },

    async finalizeCallUpload(intentId, userId, leaseToken) {
      const { data, error } = await adminClient.rpc("finalize_call_upload", {
        p_intent_id: intentId,
        p_user_id: userId,
        p_lease_token: leaseToken,
      });
      if (error) throw new Error("CALL_FINALIZATION_FAILED");
      return typeof data === "string" ? data : null;
    },

    async authorizeM3PrivateCall(callId, audioSha256) {
      const { data, error } = await adminClient.rpc("authorize_m3_private_upload", {
        p_call_id: callId,
        p_audio_sha256: audioSha256,
      });
      if (error) throw m3AuthorizationFailure(error);
      if (data === "approved" || data === "already_authorized" ||
          data === "not_allowlisted" || data === "not_eligible") return data;
      throw m3AuthorizationFailure({ code: "UNEXPECTED_RESPONSE" });
    },

    async authorizeM3DemoCall(callId, audioSha256) {
      const { data, error } = await adminClient.rpc("authorize_m3_synthetic_demo_call", {
        p_call_id: callId,
        p_audio_sha256: audioSha256,
      });
      if (error) throw m3AuthorizationFailure(error);
      if (data === "approved" || data === "already_authorized" || data === "not_allowlisted" || data === "not_eligible") return data;
      throw m3AuthorizationFailure({ code: "UNEXPECTED_RESPONSE" });
    },
  };
}
