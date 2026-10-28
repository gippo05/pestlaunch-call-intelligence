import {
  isMp3Signature,
  validateUploadIntent,
  type UploadBrand,
} from "./upload-validation";

const UPLOAD_ROLES = new Set(["owner", "reviewer"]);

export class UploadServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "UploadServiceError";
  }
}

export type UploadActor = { userId: string };

export type UploadIntentRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  idempotency_key: string;
  brand: UploadBrand;
  original_filename: string;
  mime_type: "audio/mpeg";
  expected_size: number;
  object_path: string;
  status: "issued" | "uploading" | "uploaded" | "finalized" | "rejected" | "abandoned";
  expires_at: string;
  upload_lease_token: string | null;
  upload_lease_expires_at: string | null;
  finalized_call_id: string | null;
};

export type UploadRepository = {
  listWritableWorkspaces(userId: string): Promise<Array<{ workspace_id: string; role: string }>>;
  getWritableWorkspaceRole(userId: string, workspaceId: string): Promise<string | null>;
  findIntentByIdempotency(userId: string, idempotencyKey: string): Promise<UploadIntentRow | null>;
  insertIntent(row: UploadIntentRow): Promise<boolean>;
  getIntentForUser(userId: string, intentId: string): Promise<UploadIntentRow | null>;
  beginUpload(intentId: string, userId: string): Promise<string | null>;
  downloadObject(objectPath: string): Promise<{ bytes: Uint8Array; contentType: string | null } | null>;
  finalizeCallUpload(intentId: string, userId: string, leaseToken: string | null): Promise<string | null>;
};

export function createM2UploadService(
  repository: UploadRepository,
  createId: () => string = () => crypto.randomUUID(),
  getNow: () => Date = () => new Date(),
) {
  return {
    async createIntent(actor: UploadActor | null, input: unknown) {
      requireActor(actor);
      const validation = validateUploadIntent(input);
      if (!validation.ok) throw new UploadServiceError(validation.error, 400);

      const memberships = await repository.listWritableWorkspaces(actor.userId);
      const allowed = memberships.filter((item) => UPLOAD_ROLES.has(item.role));
      if (allowed.length === 0) throw new UploadServiceError("WORKSPACE_FORBIDDEN", 403);
      if (allowed.length !== 1) throw new UploadServiceError("WORKSPACE_SELECTION_REQUIRED", 409);
      const workspaceId = allowed[0].workspace_id;
      const { brand, filename, contentType, fileSize, idempotencyKey } = validation.data;

      const existing = await repository.findIntentByIdempotency(actor.userId, idempotencyKey);
      if (existing) return reuseIntent(existing, workspaceId, brand, filename, contentType, fileSize);

      const id = createId();
      const expiresAt = new Date(getNow().getTime() + 2 * 60 * 60 * 1000).toISOString();
      const row: UploadIntentRow = {
        id,
        workspace_id: workspaceId,
        user_id: actor.userId,
        idempotency_key: idempotencyKey,
        brand,
        original_filename: filename,
        mime_type: contentType,
        expected_size: fileSize,
        object_path: `${workspaceId}/${id}.mp3`,
        status: "issued",
        expires_at: expiresAt,
        upload_lease_token: null,
        upload_lease_expires_at: null,
        finalized_call_id: null,
      };

      const inserted = await repository.insertIntent(row);
      if (!inserted) {
        const raced = await repository.findIntentByIdempotency(actor.userId, idempotencyKey);
        if (!raced) throw new UploadServiceError("INTERNAL_ERROR", 500);
        return reuseIntent(raced, workspaceId, brand, filename, contentType, fileSize);
      }

      return { intentId: id, status: "issued" as const, expiresAt, reused: false };
    },

    async prepareUpload(actor: UploadActor | null, intentId: string) {
      requireActor(actor);
      const intent = await repository.getIntentForUser(actor.userId, intentId);
      if (!intent) throw new UploadServiceError("INTENT_NOT_FOUND", 404);
      await requireWorkspaceRole(repository, actor.userId, intent.workspace_id);
      if (intent.object_path !== expectedObjectPath(intent.workspace_id, intent.id)) {
        throw new UploadServiceError("UPLOAD_NOT_AVAILABLE", 409);
      }

      if (intent.status === "finalized" || intent.status === "uploaded") {
        return { status: intent.status, objectPath: intent.object_path };
      }
      if (intent.status !== "issued" && intent.status !== "uploading") {
        throw new UploadServiceError("UPLOAD_NOT_AVAILABLE", 409);
      }
      if (Date.parse(intent.expires_at) <= getNow().getTime()) {
        throw new UploadServiceError("UPLOAD_INTENT_EXPIRED", 410);
      }
      if (
        intent.status === "uploading" &&
        intent.upload_lease_token &&
        intent.upload_lease_expires_at &&
        Date.parse(intent.upload_lease_expires_at) > getNow().getTime()
      ) {
        return { status: "ready" as const, objectPath: intent.object_path };
      }

      let leaseToken: string | null;
      try {
        leaseToken = await repository.beginUpload(intentId, actor.userId);
      } catch {
        throw new UploadServiceError("UPLOAD_NOT_AVAILABLE", 409);
      }
      if (!leaseToken) throw new UploadServiceError("UPLOAD_NOT_AVAILABLE", 409);
      return { status: "ready" as const, objectPath: intent.object_path };
    },

    async finalize(actor: UploadActor | null, intentId: string) {
      requireActor(actor);
      const intent = await repository.getIntentForUser(actor.userId, intentId);
      if (!intent) throw new UploadServiceError("INTENT_NOT_FOUND", 404);
      await requireWorkspaceRole(repository, actor.userId, intent.workspace_id);

      if (intent.status === "finalized") {
        const callId = await repository.finalizeCallUpload(intentId, actor.userId, null);
        if (!callId) throw new UploadServiceError("FINALIZATION_FAILED", 500);
        return { callId };
      }
      if (intent.status !== "uploaded" && intent.status !== "uploading") {
        throw new UploadServiceError("UPLOAD_NOT_PREPARED", 409);
      }
      if (intent.object_path !== expectedObjectPath(intent.workspace_id, intent.id)) {
        throw new UploadServiceError("OBJECT_VERIFICATION_FAILED", 409);
      }
      if (intent.status === "uploading" && (
        !intent.upload_lease_token ||
        !intent.upload_lease_expires_at ||
        Date.parse(intent.upload_lease_expires_at) <= getNow().getTime()
      )) {
        throw new UploadServiceError("UPLOAD_LEASE_EXPIRED", 410);
      }

      const stored = await repository.downloadObject(intent.object_path);
      if (
        !stored ||
        stored.contentType !== intent.mime_type ||
        stored.bytes.byteLength !== intent.expected_size ||
        !isMp3Signature(stored.bytes)
      ) {
        throw new UploadServiceError("OBJECT_VERIFICATION_FAILED", 409);
      }

      const callId = await repository.finalizeCallUpload(
        intentId,
        actor.userId,
        intent.status === "uploading" ? intent.upload_lease_token : null,
      );
      if (!callId) throw new UploadServiceError("FINALIZATION_FAILED", 500);
      return { callId };
    },
  };
}

function expectedObjectPath(workspaceId: string, intentId: string) {
  return `${workspaceId}/${intentId}.mp3`;
}

function requireActor(actor: UploadActor | null): asserts actor is UploadActor {
  if (!actor?.userId) throw new UploadServiceError("AUTH_REQUIRED", 401);
}

async function requireWorkspaceRole(repository: UploadRepository, userId: string, workspaceId: string) {
  const role = await repository.getWritableWorkspaceRole(userId, workspaceId);
  if (!role || !UPLOAD_ROLES.has(role)) throw new UploadServiceError("WORKSPACE_FORBIDDEN", 403);
}

function reuseIntent(
  intent: UploadIntentRow,
  workspaceId: string,
  brand: UploadBrand,
  filename: string,
  contentType: "audio/mpeg",
  fileSize: number,
) {
  if (
    intent.workspace_id !== workspaceId ||
    intent.brand !== brand ||
    intent.original_filename !== filename ||
    intent.mime_type !== contentType ||
    intent.expected_size !== fileSize
  ) {
    throw new UploadServiceError("IDEMPOTENCY_CONFLICT", 409);
  }
  return { intentId: intent.id, status: intent.status, expiresAt: intent.expires_at, reused: true };
}

