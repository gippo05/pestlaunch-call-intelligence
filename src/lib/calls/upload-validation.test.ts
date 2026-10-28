import { describe, expect, it } from "vitest";
import * as validation from "./upload-validation";

const api = validation as unknown as {
  validateUploadIntent?: (input: unknown) => {
    ok: boolean;
    error?: string;
    data?: Record<string, unknown>;
  };
  isMp3Signature?: (bytes: Uint8Array) => boolean;
};

const validInput = {
  brand: "abc",
  filename: "assessment-call.mp3",
  contentType: "audio/mpeg",
  fileSize: 1_024,
  idempotencyKey: "7c61a20e-1b28-4f09-83dd-2af347cfa6df",
};

describe("M2 upload validation", () => {
  it("accepts the approved MP3 upload shape without accepting a client path", () => {
    expect(api.validateUploadIntent).toBeTypeOf("function");
    if (!api.validateUploadIntent) return;

    expect(api.validateUploadIntent(validInput)).toEqual({
      ok: true,
      data: {
        brand: "abc",
        filename: "assessment-call.mp3",
        contentType: "audio/mpeg",
        fileSize: 1_024,
        idempotencyKey: "7c61a20e-1b28-4f09-83dd-2af347cfa6df",
      },
    });
  });

  it.each([
    ["unsupported brand", { ...validInput, brand: "other" }, "INVALID_BRAND"],
    ["unsupported MIME type", { ...validInput, contentType: "audio/wav" }, "UNSUPPORTED_AUDIO"],
    ["non-MP3 filename", { ...validInput, filename: "recording.wav" }, "UNSUPPORTED_AUDIO"],
    ["path traversal", { ...validInput, filename: "..\\private.mp3" }, "UNSAFE_FILENAME"],
    ["oversized recording", { ...validInput, fileSize: 52_428_801 }, "FILE_TOO_LARGE"],
    ["empty recording", { ...validInput, fileSize: 0 }, "INVALID_FILE_SIZE"],
    ["invalid idempotency key", { ...validInput, idempotencyKey: "repeat" }, "INVALID_IDEMPOTENCY_KEY"],
    ["client-supplied workspace", { ...validInput, workspaceId: "00000000-0000-4000-8000-000000000001" }, "INVALID_REQUEST"],
    ["client-supplied storage path", { ...validInput, objectPath: "workspace/file.mp3" }, "INVALID_REQUEST"],
  ])("rejects %s", (_case, input, errorCode) => {
    expect(api.validateUploadIntent).toBeTypeOf("function");
    if (!api.validateUploadIntent) return;
    expect(api.validateUploadIntent(input)).toEqual({ ok: false, error: errorCode });
  });

  it("accepts the exact 50 MiB maximum and rejects larger values", () => {
    expect(api.validateUploadIntent).toBeTypeOf("function");
    if (!api.validateUploadIntent) return;

    expect(api.validateUploadIntent({ ...validInput, fileSize: 52_428_800 }).ok).toBe(true);
    expect(api.validateUploadIntent({ ...validInput, fileSize: 52_428_801 })).toEqual({
      ok: false,
      error: "FILE_TOO_LARGE",
    });
  });

  it("recognizes ID3 and MPEG frame headers but rejects unrelated bytes", () => {
    expect(api.isMp3Signature).toBeTypeOf("function");
    if (!api.isMp3Signature) return;

    expect(api.isMp3Signature(new Uint8Array([0x49, 0x44, 0x33, 0x04]))).toBe(true);
    expect(api.isMp3Signature(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe(true);
    expect(api.isMp3Signature(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBe(false);
    expect(api.isMp3Signature(new Uint8Array([0x49, 0x44]))).toBe(false);
  });
});
