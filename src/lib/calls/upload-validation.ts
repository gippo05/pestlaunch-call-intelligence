export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

const uploadKeys = new Set(["brand", "filename", "contentType", "fileSize", "idempotencyKey"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type UploadBrand = "abc" | "noble_sales";

export type ValidatedUploadIntent = {
  brand: UploadBrand;
  filename: string;
  contentType: "audio/mpeg";
  fileSize: number;
  idempotencyKey: string;
};

export type UploadValidationResult =
  | { ok: true; data: ValidatedUploadIntent }
  | { ok: false; error: string };

export function validateUploadIntent(input: unknown): UploadValidationResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "INVALID_REQUEST" };
  }

  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== uploadKeys.size || keys.some((key) => !uploadKeys.has(key))) {
    return { ok: false, error: "INVALID_REQUEST" };
  }

  if (record.brand !== "abc" && record.brand !== "noble_sales") {
    return { ok: false, error: "INVALID_BRAND" };
  }

  if (typeof record.filename !== "string" || !isSafeMp3Filename(record.filename)) {
    return { ok: false, error: "UNSAFE_FILENAME" };
  }

  if (record.contentType !== "audio/mpeg" || !record.filename.toLowerCase().endsWith(".mp3")) {
    return { ok: false, error: "UNSUPPORTED_AUDIO" };
  }

  if (!Number.isSafeInteger(record.fileSize) || (record.fileSize as number) <= 0) {
    return { ok: false, error: "INVALID_FILE_SIZE" };
  }
  if ((record.fileSize as number) > MAX_AUDIO_BYTES) {
    return { ok: false, error: "FILE_TOO_LARGE" };
  }

  if (typeof record.idempotencyKey !== "string" || !uuidPattern.test(record.idempotencyKey)) {
    return { ok: false, error: "INVALID_IDEMPOTENCY_KEY" };
  }

  return {
    ok: true,
    data: {
      brand: record.brand,
      filename: record.filename,
      contentType: "audio/mpeg",
      fileSize: record.fileSize as number,
      idempotencyKey: record.idempotencyKey,
    },
  };
}

export function isMp3Signature(bytes: Uint8Array): boolean {
  if (bytes.byteLength >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true;
  }

  return bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

function isSafeMp3Filename(filename: string): boolean {
  const nameLength = Array.from(filename).length;
  return (
    nameLength > 0 &&
    nameLength <= 255 &&
    filename === filename.trim() &&
    !filename.startsWith(".") &&
    !/[\\/<>:"|?*\u0000-\u001f\u007f]/.test(filename)
  );
}
