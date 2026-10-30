"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpFromLine, FileAudio, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { uploadDirectToSupabaseStorage } from "@/lib/calls/direct-storage-upload";
import { MAX_AUDIO_BYTES, type UploadBrand } from "@/lib/calls/upload-validation";
import type { M3AutoProcessingState } from "@/lib/calls/status";

type Phase = "idle" | "creating" | "uploading" | "finalizing" | "complete" | "error";

const errorMessages: Record<string, string> = {
  AUTH_REQUIRED: "Sign in again before uploading.",
  WORKSPACE_FORBIDDEN: "Your workspace role does not allow uploads.",
  WORKSPACE_SELECTION_REQUIRED: "This account has more than one upload workspace. Ask the workspace owner to resolve the access assignment.",
  INVALID_REQUEST: "The upload details are invalid. Review the file and try again.",
  INVALID_BRAND: "Choose one of the available brands.",
  UNSAFE_FILENAME: "This filename contains unsupported characters. Rename the file and try again.",
  UNSUPPORTED_AUDIO: "Choose an MP3 file no larger than 50 MiB.",
  INVALID_MP3: "The file does not contain an MP3 audio signature.",
  INVALID_FILE_SIZE: "The file size is invalid.",
  FILE_TOO_LARGE: "The file exceeds the 50 MiB limit.",
  FILE_SIZE_MISMATCH: "The uploaded bytes do not match the file size declared when upload started.",
  IDEMPOTENCY_CONFLICT: "This upload retry no longer matches its original file details. Select the file again.",
  INTENT_NOT_FOUND: "The upload has expired or is no longer available. Start again with the file selected.",
  UPLOAD_INTENT_EXPIRED: "The upload session expired. Start again with the file selected.",
  UPLOAD_NOT_AVAILABLE: "The upload attempt expired. Retry to create a new upload session.",
  UPLOAD_NOT_PREPARED: "The upload is not ready yet. Retry with the same selected file.",
  UPLOAD_LEASE_EXPIRED: "The upload session expired. Retry with the same selected file.",
  STORAGE_UPLOAD_FAILED: "Private Storage did not accept the upload. Retry with the same selected file.",
  INVALID_STORAGE_PATH: "The upload path was invalid. Start again with the same selected file.",
  OBJECT_VERIFICATION_FAILED: "The stored file could not be verified. The call record was not created.",
  SERVER_CONFIG_UNAVAILABLE: "Call upload is not configured on this app server yet.",
  INTERNAL_ERROR: "The upload could not be completed. Retry or contact the workspace owner.",
  NETWORK_ERROR: "The connection was interrupted. Retry the same selected file.",
};

function messageFor(errorCode: string) {
  return errorMessages[errorCode] ?? "The upload could not be completed. Retry or contact the workspace owner.";
}

export function UploadCallForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const inFlightRef = useRef(false);
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const [file, setFile] = useState<File | null>(null);
  const [brand, setBrand] = useState<UploadBrand>("abc");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [uploadedCallId, setUploadedCallId] = useState<string | null>(null);
  const [m3Processing, setM3Processing] = useState<M3AutoProcessingState | null>(null);

  function selectFile(nextFile: File | null) {
    idempotencyKeyRef.current = crypto.randomUUID();
    setFile(nextFile);
    setProgress(0);
    setErrorMessage(null);
    setUploadedCallId(null);
    setM3Processing(null);
    setPhase("idle");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current) return;
    setErrorMessage(null);
    if (!file) {
      setErrorMessage("Choose a synthetic MP3 recording first.");
      setPhase("error");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".mp3") || file.type !== "audio/mpeg") {
      setErrorMessage(messageFor("UNSUPPORTED_AUDIO"));
      setPhase("error");
      return;
    }
    if (file.size <= 0 || file.size > MAX_AUDIO_BYTES) {
      setErrorMessage(messageFor(file.size > MAX_AUDIO_BYTES ? "FILE_TOO_LARGE" : "UNSUPPORTED_AUDIO"));
      setPhase("error");
      return;
    }

    inFlightRef.current = true;
    try {
      setPhase("creating");
      const intentResponse = await fetch("/api/calls/upload-intents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brand,
          filename: file.name,
          contentType: "audio/mpeg",
          fileSize: file.size,
          idempotencyKey: idempotencyKeyRef.current,
        }),
      });
      const intent = await readJson(intentResponse);
      if (!intentResponse.ok || typeof intent.intentId !== "string") {
        throw new Error(typeof intent.error === "string" ? intent.error : "INTERNAL_ERROR");
      }

      const prepareResponse = await fetch(`/api/calls/upload-intents/${encodeURIComponent(intent.intentId)}/prepare`, {
        method: "POST",
      });
      const prepared = await readJson(prepareResponse);
      if (!prepareResponse.ok || typeof prepared.status !== "string") {
        throw new Error(typeof prepared.error === "string" ? prepared.error : "INTERNAL_ERROR");
      }

      if (prepared.status === "ready") {
        if (typeof prepared.objectPath !== "string") throw new Error("INVALID_STORAGE_PATH");
        setPhase("uploading");
        setProgress(0);
        try {
          await uploadDirectToSupabaseStorage(prepared.objectPath, file, setProgress);
        } catch (uploadError) {
          // A lost response can follow a successful Storage write. Finalization is the safe recovery check.
          const recovered = await finalizeIntent(intent.intentId).catch(() => null);
          if (recovered?.callId) {
            finishUpload(recovered.callId, recovered.m3Processing ?? null);
            return;
          }
          throw uploadError;
        }
      } else if (prepared.status !== "uploaded" && prepared.status !== "finalized") {
        throw new Error("UPLOAD_NOT_PREPARED");
      }

      setPhase("finalizing");
      const finalized = await finalizeIntent(intent.intentId);
      if (!finalized.callId) throw new Error(finalized.error ?? "INTERNAL_ERROR");
      finishUpload(finalized.callId, finalized.m3Processing ?? null);
    } catch (error) {
      setPhase("error");
      const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
      if (["UPLOAD_INTENT_EXPIRED", "UPLOAD_NOT_AVAILABLE", "INTENT_NOT_FOUND"].includes(code)) {
        idempotencyKeyRef.current = crypto.randomUUID();
      }
      setErrorMessage(messageFor(code));
    } finally {
      inFlightRef.current = false;
    }
  }

  function finishUpload(callId: string, processing: M3AutoProcessingState | null) {
    setPhase("complete");
    setProgress(100);
    setUploadedCallId(callId);
    setM3Processing(processing);
    setFile(null);
    if (inputRef.current) inputRef.current.value = "";
    idempotencyKeyRef.current = crypto.randomUUID();
    router.refresh();
  }

  const busy = phase === "creating" || phase === "uploading" || phase === "finalizing";

  return (
    <section id="add-call" className="rounded-2xl border border-line bg-white p-5 shadow-sm sm:p-6" aria-labelledby="upload-call-title">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-900">
          <FileAudio aria-hidden="true" className="size-5" />
        </span>
        <div>
          <h2 id="upload-call-title" className="text-base font-semibold text-ink">Add a synthetic call</h2>
          <p className="mt-1 text-sm leading-6 text-muted">Upload a synthetic MP3 assessment fixture. Files stay private. Automatic M3 processing is considered only for exact fixture hashes in the local demo registry.</p>
        </div>
      </div>

      <form className="mt-5 grid gap-5" onSubmit={submit}>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium text-ink">Brand</legend>
          <div className="flex flex-wrap gap-3">
            {(["abc", "noble_sales"] as const).map((option) => (
              <label key={option} className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm text-ink">
                <input
                  type="radio"
                  name="brand"
                  value={option}
                  checked={brand === option}
                  disabled={busy}
                  onChange={() => {
                    setBrand(option);
                    idempotencyKeyRef.current = crypto.randomUUID();
                  }}
                  className="accent-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700"
                />
                {option === "abc" ? "ABC" : "Noble Sales"}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-2">
          <label htmlFor="call-audio-file" className="text-sm font-medium text-ink">MP3 recording</label>
          <input
            ref={inputRef}
            id="call-audio-file"
            name="audio"
            type="file"
            accept=".mp3,audio/mpeg"
            disabled={busy}
            aria-describedby="call-audio-help"
            onChange={(event) => selectFile(event.currentTarget.files?.[0] ?? null)}
            className="block min-h-11 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink file:mr-3 file:rounded-md file:border-0 file:bg-stone-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700"
          />
          <p id="call-audio-help" className="text-xs leading-5 text-muted">MP3 only · Maximum 50 MiB · Synthetic recordings only</p>
        </div>

        {file && (
          <p className="truncate rounded-lg bg-paper px-3 py-2 text-xs text-muted" title={file.name}>
            Selected: <span className="font-medium text-ink">{file.name}</span> · {(file.size / (1024 * 1024)).toFixed(2)} MiB
          </p>
        )}

        {(phase === "uploading" || phase === "complete") && (
          <div className="grid gap-2" aria-live="polite">
            <div className="flex justify-between text-xs font-medium text-muted">
              <span>{phase === "complete" ? "Upload complete" : "Uploading privately"}</span>
              <span>{progress}%</span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-stone-200"
              role="progressbar"
              aria-label="Upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <div className="h-full rounded-full bg-blue-700 transition-[width]" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {errorMessage && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900" role="alert">{errorMessage}</p>}
        {phase === "complete" && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">
            {processingMessage(m3Processing)}
            {uploadedCallId && <Link href={`/calls/${uploadedCallId}`} className="ml-1 font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">Open call record</Link>}
          </p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button type="submit" disabled={busy}>
            {busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <ArrowUpFromLine aria-hidden="true" className="size-4" />}
            {phase === "creating" ? "Preparing upload…" : phase === "uploading" ? "Uploading…" : phase === "finalizing" ? "Verifying…" : phase === "error" ? "Retry upload" : "Upload call"}
          </Button>
          <span className="text-xs leading-5 text-muted" aria-live="polite">
            {phase === "creating" ? "Checking workspace access…" : phase === "finalizing" ? "Verifying the private object before creating the call record…" : "Your authenticated browser uploads directly to private Storage; the server verifies it before creating a call."}
          </span>
        </div>
      </form>
    </section>
  );
}

function processingMessage(status: M3AutoProcessingState | null) {
  switch (status) {
    case "started": return "The recording is private and the single authorized local M3 run has started. Its transcript and extracted fields remain review candidates.";
    case "queued": return "The recording is private. The local M3 worker has no claimable job yet, so this call remains queued.";
    case "not_allowlisted": return "The recording is private, but its exact audio hash is not in the synthetic demo registry. M3 was not authorized and the call remains queued.";
    case "already_handled": return "The recording is private. M3 authorization was already handled; open the call record to check its current processing state.";
    case "disabled": return "The recording is private. Automatic M3 processing is disabled in this local environment, so the call remains queued.";
    case "provider_not_configured": return "The recording is private and its synthetic fixture is authorized, but the local worker has no Gemini provider configured. No AI request was made; the call remains queued.";
    default: return "The recording was stored privately, but M3 dispatch could not be confirmed. Open the call record to inspect its current state. No transcript or score is assumed.";
  }
}

async function finalizeIntent(intentId: string): Promise<{ callId?: string; error?: string; m3Processing?: M3AutoProcessingState }> {
  const response = await fetch(`/api/calls/upload-intents/${encodeURIComponent(intentId)}/finalize`, { method: "POST" });
  const result = await readJson(response);
  if (!response.ok) return { error: typeof result.error === "string" ? result.error : "INTERNAL_ERROR" };
  return {
    callId: typeof result.callId === "string" ? result.callId : undefined,
    m3Processing: isM3AutoProcessingState(result.m3Processing) ? result.m3Processing : undefined,
  };
}

function isM3AutoProcessingState(value: unknown): value is M3AutoProcessingState {
  return value === "started" || value === "queued" || value === "not_allowlisted" || value === "already_handled" || value === "disabled" || value === "provider_not_configured" || value === "unavailable";
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}
