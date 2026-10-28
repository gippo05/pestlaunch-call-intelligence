import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createM2UploadService,
  type UploadIntentRow,
  type UploadRepository,
} from "./upload-service";

const actor = { userId: "10000000-0000-4000-8000-000000000001" };
const workspaceId = "20000000-0000-4000-8000-000000000001";
const intentId = "30000000-0000-4000-8000-000000000001";
const objectPath = `${workspaceId}/${intentId}.mp3`;
const idempotencyKey = "40000000-0000-4000-8000-000000000001";
const audioBytes = new Uint8Array(readFileSync(fileURLToPath(new URL("../../../supabase/tests/fixtures/synthetic-tone.mp3", import.meta.url))));

function makeIntent(overrides: Partial<UploadIntentRow> = {}): UploadIntentRow {
  return {
    id: intentId,
    workspace_id: workspaceId,
    user_id: actor.userId,
    idempotency_key: idempotencyKey,
    brand: "abc",
    original_filename: "synthetic-call.mp3",
    mime_type: "audio/mpeg",
    expected_size: audioBytes.byteLength,
    object_path: objectPath,
    status: "issued",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    upload_lease_token: null,
    upload_lease_expires_at: null,
    finalized_call_id: null,
    ...overrides,
  };
}

function makeRepository(overrides: Partial<UploadRepository> = {}) {
  const repository: UploadRepository = {
    listWritableWorkspaces: vi.fn(async () => [{ workspace_id: workspaceId, role: "reviewer" }]),
    getWritableWorkspaceRole: vi.fn(async () => "reviewer"),
    findIntentByIdempotency: vi.fn(async () => null),
    insertIntent: vi.fn(async () => true),
    getIntentForUser: vi.fn(async () => makeIntent()),
    beginUpload: vi.fn(async () => "50000000-0000-4000-8000-000000000001"),
    downloadObject: vi.fn(async () => null),
    finalizeCallUpload: vi.fn(async () => "60000000-0000-4000-8000-000000000001"),
    ...overrides,
  };
  return repository;
}

const validIntentBody = {
  brand: "abc",
  filename: "synthetic-call.mp3",
  contentType: "audio/mpeg",
  fileSize: audioBytes.byteLength,
  idempotencyKey,
};

describe("M2 upload service", () => {
  let repository: UploadRepository;
  let service: ReturnType<typeof createM2UploadService>;

  beforeEach(() => {
    repository = makeRepository();
    service = createM2UploadService(repository, () => intentId, () => new Date("2026-10-27T00:00:00.000Z"));
  });

  it("denies anonymous upload-intent creation before database access", async () => {
    await expect(service.createIntent(null, validIntentBody)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      status: 401,
    });
    expect(repository.listWritableWorkspaces).not.toHaveBeenCalled();
  });

  it("denies users without an upload-capable workspace", async () => {
    vi.mocked(repository.listWritableWorkspaces).mockResolvedValue([{ workspace_id: workspaceId, role: "member" }]);
    await expect(service.createIntent(actor, validIntentBody)).rejects.toMatchObject({ code: "WORKSPACE_FORBIDDEN" });
    expect(repository.insertIntent).not.toHaveBeenCalled();
  });

  it("rejects forged workspace and object-path fields", async () => {
    await expect(service.createIntent(actor, { ...validIntentBody, workspaceId, objectPath })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
    });
    expect(repository.insertIntent).not.toHaveBeenCalled();
  });

  it("returns the same intent for a repeated matching idempotency key", async () => {
    vi.mocked(repository.findIntentByIdempotency).mockResolvedValue(makeIntent());
    const result = await service.createIntent(actor, validIntentBody);
    expect(result).toMatchObject({ intentId, reused: true, status: "issued" });
    expect(repository.insertIntent).not.toHaveBeenCalled();
  });

  it("rejects reuse of an idempotency key with different metadata", async () => {
    vi.mocked(repository.findIntentByIdempotency).mockResolvedValue(makeIntent({ original_filename: "other.mp3" }));
    await expect(service.createIntent(actor, validIntentBody)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      status: 409,
    });
  });

  it("creates workspace-scoped server paths without returning them", async () => {
    const result = await service.createIntent(actor, validIntentBody);
    expect(repository.insertIntent).toHaveBeenCalledWith(expect.objectContaining({
      id: intentId,
      workspace_id: workspaceId,
      user_id: actor.userId,
      object_path: objectPath,
    }));
    expect(result).toEqual({ intentId, status: "issued", expiresAt: "2026-10-27T02:00:00.000Z", reused: false });
  });

  it("prepares a direct Storage upload without returning the server lease token", async () => {
    const prepareUpload = (service as unknown as {
      prepareUpload: (actor: { userId: string }, intentId: string) => Promise<Record<string, unknown>>;
    }).prepareUpload;
    const result = await prepareUpload.call(service, actor, intentId);

    expect(result).toEqual({ status: "ready", objectPath });
    expect(repository.beginUpload).toHaveBeenCalledWith(intentId, actor.userId);
    expect(JSON.stringify(result)).not.toContain("50000000-0000-4000-8000-000000000001");
  });

  it("reuses the current upload lease for a retried prepare request", async () => {
    vi.mocked(repository.getIntentForUser).mockResolvedValue(makeIntent({
      status: "uploading",
      upload_lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      upload_lease_token: "50000000-0000-4000-8000-000000000001",
    }));
    const prepareUpload = (service as unknown as {
      prepareUpload: (actor: { userId: string }, intentId: string) => Promise<Record<string, unknown>>;
    }).prepareUpload;

    await expect(prepareUpload.call(service, actor, intentId)).resolves.toEqual({ status: "ready", objectPath });
    expect(repository.beginUpload).not.toHaveBeenCalled();
  });

  it("rejects another user's intent before preparing Storage access", async () => {
    vi.mocked(repository.getIntentForUser).mockResolvedValue(null);
    await expect(service.prepareUpload(actor, intentId)).rejects.toMatchObject({
      code: "INTENT_NOT_FOUND",
      status: 404,
    });
  });

  it("refuses a stored intent whose path does not match its generated workspace and id", async () => {
    vi.mocked(repository.getIntentForUser).mockResolvedValue(makeIntent({
      status: "uploading",
      object_path: `${workspaceId}/90000000-0000-4000-8000-000000000001.mp3`,
      upload_lease_token: "50000000-0000-4000-8000-000000000001",
      upload_lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }));

    await expect(service.prepareUpload(actor, intentId)).rejects.toMatchObject({ code: "UPLOAD_NOT_AVAILABLE" });
    expect(repository.beginUpload).not.toHaveBeenCalled();
  });

  it("verifies stored bytes before idempotent finalization", async () => {
    vi.mocked(repository.getIntentForUser).mockResolvedValue(makeIntent({ status: "uploaded" }));
    vi.mocked(repository.downloadObject).mockResolvedValue({ bytes: audioBytes, contentType: "audio/mpeg" });
    const result = await service.finalize(actor, intentId);
    expect(result).toEqual({ callId: "60000000-0000-4000-8000-000000000001" });
    expect(repository.finalizeCallUpload).toHaveBeenCalledWith(intentId, actor.userId, null);
  });

  it("atomically finalizes a verified direct upload with its server-held lease", async () => {
    const leaseToken = "50000000-0000-4000-8000-000000000001";
    vi.mocked(repository.getIntentForUser).mockResolvedValue(makeIntent({
      status: "uploading",
      upload_lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      upload_lease_token: leaseToken,
    }));
    vi.mocked(repository.downloadObject).mockResolvedValue({ bytes: audioBytes, contentType: "audio/mpeg" });

    const result = await service.finalize(actor, intentId);

    expect(result).toEqual({ callId: "60000000-0000-4000-8000-000000000001" });
    expect(repository.finalizeCallUpload).toHaveBeenCalledWith(intentId, actor.userId, leaseToken);
  });

  it("does not finalize an upload after its lease expires", async () => {
    vi.mocked(repository.getIntentForUser).mockResolvedValue(makeIntent({
      status: "uploading",
      upload_lease_expires_at: "2026-10-26T23:59:00.000Z",
      upload_lease_token: "50000000-0000-4000-8000-000000000001",
    }));

    await expect(service.finalize(actor, intentId)).rejects.toMatchObject({ code: "UPLOAD_LEASE_EXPIRED" });
    expect(repository.downloadObject).not.toHaveBeenCalled();
    expect(repository.finalizeCallUpload).not.toHaveBeenCalled();
  });

  it("does not create a call when uploaded object verification fails", async () => {
    vi.mocked(repository.getIntentForUser).mockResolvedValue(makeIntent({ status: "uploaded" }));
    vi.mocked(repository.downloadObject).mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), contentType: "audio/mpeg" });
    await expect(service.finalize(actor, intentId)).rejects.toMatchObject({ code: "OBJECT_VERIFICATION_FAILED" });
    expect(repository.finalizeCallUpload).not.toHaveBeenCalled();
  });
});
