import {
  M3_MAX_AUDIO_BYTES,
  M3_PROVIDER_UTTERANCE_CONTRACT_VERSION,
  M3_RESPONSE_SCHEMA,
  M3ProcessingError,
  parseGeminiGeneration,
  type M3ModelOutput,
  type M3ValidationFailure,
} from "./m3-analysis.ts";

const API_ORIGIN = "https://generativelanguage.googleapis.com";
export const M3_PROVIDER_TIMEOUT_MS = 110_000;
export const M3_PROVIDER_CLEANUP_TIMEOUT_MS = 5_000;
const FILE_POLL_INTERVAL_MS = 1_000;
const MAX_RETRY_AFTER_SECONDS = 3_600;

export type M3ProviderTransport = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type M3ProviderOperation =
  | "upload_session_start"
  | "audio_upload_finalize"
  | "upload_response_body"
  | "upload_response_validation"
  | "files_api_polling"
  | "generation_request"
  | "generation_response_body"
  | "structured_response_validation"
  | "temporary_file_cleanup";

export type M3ProviderClassification =
  | "success"
  | "timeout"
  | "network_failure"
  | "retryable_provider_response"
  | "provider_unavailable"
  | "invalid_response"
  | "safety_blocked"
  | "processing_failure"
  | "cleanup_failure"
  | "cleanup_not_possible";

export type M3ProviderDiagnostic = {
  correlationId?: string;
  operation: M3ProviderOperation;
  phase: "start" | "finish";
  classification?: M3ProviderClassification;
  elapsedMs?: number;
  remainingBudgetMs: number;
  httpStatus?: number;
  retryClassification: "none" | "retryable_429" | "retryable_503";
  fileState?: "PROCESSING" | "ACTIVE" | "FAILED" | "UNKNOWN";
  pollCount?: number;
  cleanupOutcome?: "attempted" | "succeeded" | "failed" | "not_possible";
  validationFailure?: M3ValidationFailure;
};

export type M3ProviderOptions = {
  apiKey: string;
  model: string;
  audio: Uint8Array;
  transport?: M3ProviderTransport;
  timeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  correlationId?: string;
  onDiagnostic?: (event: M3ProviderDiagnostic) => void;
};

type UploadedFile = { name: string; uri: string; mimeType: string; state: string };
type ProviderResponse = {
  response: Response;
  signal: AbortSignal;
  abort(): void;
  dispose(cancelBody?: boolean): void;
};
type ProviderStageMetadata = Partial<Pick<
  M3ProviderDiagnostic,
  "classification" | "httpStatus" | "retryClassification" | "fileState" | "pollCount" | "cleanupOutcome" | "validationFailure"
>>;

export async function transcribeSyntheticAudio(options: M3ProviderOptions): Promise<M3ModelOutput> {
  if (!options.apiKey.trim() || !/^[A-Za-z0-9._-]{1,100}$/.test(options.model)) {
    throw new M3ProcessingError("PROVIDER_UNAVAILABLE");
  }
  if (options.audio.byteLength < 4 || options.audio.byteLength > M3_MAX_AUDIO_BYTES) {
    throw new M3ProcessingError("SOURCE_INVALID");
  }

  const transport = options.transport ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const budgetMs = Math.max(1, Math.min(options.timeoutMs ?? M3_PROVIDER_TIMEOUT_MS, M3_PROVIDER_TIMEOUT_MS));
  const deadline = now() + budgetMs;
  const uploadState: { name: string | null } = { name: null };
  let uploadFinalizeAttempted = false;
  let modelOutput: M3ModelOutput | null = null;
  let failure: M3ProcessingError | null = null;

  try {
    const uploadSession = await runProviderStage(options, "upload_session_start", deadline, now, (metadata) =>
      startResumableUpload(transport, options, deadline, now, metadata));
    uploadFinalizeAttempted = true;
    const uploadResponse = await runProviderStage(options, "audio_upload_finalize", deadline, now, (metadata) =>
      finishResumableUpload(transport, options, uploadSession, deadline, now, metadata));
    const uploadPayload = await runProviderStage(options, "upload_response_body", deadline, now, (metadata) =>
      readJson(uploadResponse, deadline, now, metadata), { httpStatus: uploadResponse.response.status, retryClassification: "none" });
    const uploaded = await runProviderStage(options, "upload_response_validation", deadline, now, (metadata) => {
      const file = parseUploadedFile(uploadPayload, (name) => { uploadState.name = name; });
      metadata.fileState = safeFileState(file.state);
      return file;
    }, { httpStatus: uploadResponse.response.status, retryClassification: "none" });
    const pollMetadata: ProviderStageMetadata = { pollCount: 0, fileState: safeFileState(uploaded.state) };
    const activeFile = await runProviderStage(options, "files_api_polling", deadline, now, (metadata) =>
      waitForActiveFile(transport, options, uploaded, deadline, now, sleep, metadata), pollMetadata);
    const generationMetadata: ProviderStageMetadata = { retryClassification: "none" };
    const response = await runProviderStage(options, "generation_request", deadline, now, (metadata) =>
      fetchProvider(
        transport,
        `${API_ORIGIN}/v1beta/models/${encodeURIComponent(options.model)}:generateContent?key=${encodeURIComponent(options.apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [
                { text: M3_TRANSCRIPTION_INSTRUCTIONS },
                { fileData: { mimeType: "audio/mpeg", fileUri: activeFile.uri } },
              ],
            }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: M3_RESPONSE_SCHEMA,
              maxOutputTokens: 16_384,
            },
          }),
        },
        deadline,
        now,
        metadata,
      ), generationMetadata);
    const generationPayload = await runProviderStage(options, "generation_response_body", deadline, now, (metadata) =>
      readJson(response, deadline, now, metadata), { httpStatus: response.response.status, retryClassification: "none" });
    modelOutput = await runProviderStage(options, "structured_response_validation", deadline, now, () =>
      parseGeminiGeneration(generationPayload), { httpStatus: response.response.status, retryClassification: "none" });
  } catch (error) {
    failure = toSafeProviderError(error);
  } finally {
    if (uploadState.name) {
      const cleanupMetadata: ProviderStageMetadata = { cleanupOutcome: "attempted", retryClassification: "none" };
      try {
        const cleanupDeadline = now() + M3_PROVIDER_CLEANUP_TIMEOUT_MS;
        await runProviderStage(options, "temporary_file_cleanup", cleanupDeadline, now, async (metadata) => {
          metadata.cleanupOutcome = "attempted";
          const response = await fetchProvider(
            transport,
            `${API_ORIGIN}/v1beta/${uploadState.name!.split("/").map(encodeURIComponent).join("/")}?key=${encodeURIComponent(options.apiKey)}`,
            { method: "DELETE" },
            cleanupDeadline,
            now,
            metadata,
          );
          try {
            if (!response.response.ok) throw new M3ProcessingError("PROVIDER_CLEANUP_FAILED");
            metadata.cleanupOutcome = "succeeded";
          } finally {
            response.dispose(true);
          }
        }, cleanupMetadata);
      } catch {
        failure = new M3ProcessingError("PROVIDER_CLEANUP_FAILED");
      }
    } else if (uploadFinalizeAttempted) {
      emitProviderDiagnostic(options, {
        operation: "temporary_file_cleanup",
        phase: "finish",
        classification: "cleanup_not_possible",
        remainingBudgetMs: 0,
        retryClassification: "none",
        cleanupOutcome: "not_possible",
      });
    }
  }

  if (failure) throw failure;
  if (!modelOutput) throw new M3ProcessingError("PROVIDER_RESPONSE_INVALID");
  return modelOutput;
}

export const M3_TRANSCRIPTION_INSTRUCTIONS = [
  "Return providerContractVersion exactly as " + M3_PROVIDER_UTTERANCE_CONTRACT_VERSION + ".",
  "Transcribe this synthetic, non-confidential pest-service call in full, preserving the spoken wording.",
  "Use only content clearly audible in the recording. Do not add a representative, date, price, appointment, booking, speaker identity, or timestamp that is not explicitly spoken.",
  "Return one ordered utterances array as the sole source of transcript text. Each utterance contains one contiguous spoken text chunk plus speaker, speechAct, confirmedFacts, customerConcerns, supportsIntent, and supportsOutcome. Do not also return a separate transcript, sentence annotations, sentence IDs, evidence IDs, timestamps, or copied evidence strings.",
  "Prefer short utterances below 2000 characters, splitting at actual speaker changes and complete sentence boundaries. Preserve all audible spoken words even if an utterance must be longer. Keep utterance text in audio order, without speaker labels, and do not overlap or repeat spoken words. The server joins utterance text with a blank line and assigns sentence IDs deterministically.",
  "Classify intent from the caller's stated purpose using these categories:",
  "sales: the caller seeks or considers new pest-service work, inspection, treatment, an estimate, or a possible visit. A booking or price quote is not required; a caller may defer or decline booking and still have sales intent. Do not infer that the caller is a new customer unless stated.",
  "general_office: administrative questions such as office information, directions, operating hours, or paperwork, when no new-service request or existing-customer service issue is expressed.",
  "retention: an existing-customer follow-up, renewal, complaint, cancellation, or continued-service matter.",
  "other: the transcript does not provide enough information to reasonably determine one of the categories. Preserve uncertainty; do not force a category or infer intent only from the business name.",
  "Classify facts and customer concerns by meaning, not by topic words; keep the categories distinct. A factual observation may provide context for a concern, but it is not itself a concern unless the caller also expresses a separate worry, risk, objection, hesitation, dependency, or service-affecting constraint.",
  "Extract each independent fact explicitly stated by the caller as a source word span. Facts include observable conditions, what was heard or seen, where or when it happened, frequency or duration, relevant circumstances, corrections, and explicitly observed absence. For example, 'I have not seen an animal' and 'The noise happened on three evenings' are facts, not concerns by themselves. Preserve negation and every time, frequency, location, amount, conditional, or uncertainty qualifier that changes the meaning. Never reverse a negative observation or drop its qualifying context. Do not introduce names, dates, times, prices, bookings, pest identifications, or outcomes absent from that text. Do not repeat a fact or combine unrelated facts.",
  "A customer concern must be explicitly supported by the caller's words and represent a worry, risk, objection, hesitation, dependency, or service-affecting constraint. Qualifying examples include concern for a child's or pet's safety, treatment risk or cost, disruption or timing, and a permission or authorization constraint. Do not require emotion words: 'I need my landlord's permission before anyone visits' can be a concern. A reported problem or observation is not automatically a customer concern; scratching, ordinary location or frequency detail, or a service question alone does not establish a concern. Do not invent an emotional state or infer a concern from general context.",
  "Put each confirmed fact or customer concern directly inside the single utterance that supports it. Each item must be a complete, contiguous span of spoken words from that utterance. Preserve every word and its order; do not paraphrase, change speaker perspective, add qualifiers, or combine separate spans. You may add sentence punctuation to close a complete spoken clause. Use only complete caller assertions with speaker caller and speechAct statement; exclude greetings, self-identification, questions, agent statements, offers, advice, and instructions. If speaker or speech act is uncertain, mark it unknown and leave the claim arrays empty. The server accepts a claim only when its full word sequence appears contiguously in that utterance.",
  "When one utterance contains both a factual observation and an independently stated concern, put each complete source span in its matching array and prefer the smallest complete span that preserves its meaning. Do not duplicate the observation as a concern. Do not use keywords alone to decide the category.",
  "Set supportsIntent true on at most one utterance: a complete caller statement that supports the selected intent. Set it false on all other utterances. If no safe caller statement supports the intent, set intent to other and supportsIntent false everywhere.",
  "Set supportsOutcome true on at most one utterance containing a complete, explicit outcome statement; set it false elsewhere. Return outcome with status only. Use observed only for a concrete outcome explicitly stated, unresolved when a service need remains open or a booking is deferred, and unknown when the recording does not establish an outcome. An offer or recommendation is not a confirmed booking. If no one utterance provides safe outcome evidence, use unknown. The server derives outcome summary and evidence from the marked utterance.",
  "Return empty confirmedFacts and customerConcerns arrays whenever complete source-word claims cannot be copied safely. Do not invent punctuation, infer a booking, or paraphrase claims. Bad optional claims will be discarded and flagged for human review; preserve the full spoken transcript even when extraction is uncertain.",
  "Set uncertainty.facts true when a relevant fact or concern may be missing, its meaning/category cannot be established safely, or a qualifier or source span is uncertain; set it false only when the available extraction is clear. Set uncertainty.speaker true when speaker attribution cannot be established safely.",
  "Do not choose transcript anchors. The server derives beginning, middle, and ending anchors from canonical sentence positions. Do not claim source completeness; the system marks it unverified until a human compares the source.",
].join(" ");

async function startResumableUpload(
  transport: M3ProviderTransport,
  options: M3ProviderOptions,
  deadline: number,
  now: () => number,
  metadata: ProviderStageMetadata,
) {
  const response = await fetchProvider(
    transport,
    `${API_ORIGIN}/upload/v1beta/files?key=${encodeURIComponent(options.apiKey)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(options.audio.byteLength),
        "x-goog-upload-header-content-type": "audio/mpeg",
      },
      body: JSON.stringify({ file: { display_name: "m3-synthetic-audio.mp3" } }),
    },
    deadline,
    now,
    metadata,
  );
  try {
    const uploadUrl = response.response.headers.get("x-goog-upload-url");
    if (!uploadUrl || !isProviderUploadUrl(uploadUrl)) {
      throw new M3ProcessingError("PROVIDER_RESPONSE_INVALID");
    }
    return uploadUrl;
  } finally {
    response.dispose(true);
  }
}

async function finishResumableUpload(
  transport: M3ProviderTransport,
  options: M3ProviderOptions,
  uploadUrl: string,
  deadline: number,
  now: () => number,
  metadata: ProviderStageMetadata,
): Promise<ProviderResponse> {
  const body = options.audio.slice().buffer as ArrayBuffer;
  return await fetchProvider(
    transport,
    uploadUrl,
    {
      method: "POST",
      headers: {
        "content-type": "audio/mpeg",
        "x-goog-upload-command": "upload, finalize",
        "x-goog-upload-offset": "0",
      },
      body,
    },
    deadline,
    now,
    metadata,
  );
}

function parseUploadedFile(payload: unknown, onFileCreated: (name: string) => void): UploadedFile {
  const file = isRecord(payload) ? payload.file : null;
  const candidateName = isRecord(file) ? file.name : isRecord(payload) ? payload.name : null;
  if (typeof candidateName === "string" && /^files\/[A-Za-z0-9_-]+$/.test(candidateName)) {
    // Record a plausible returned file name before validating the response so
    // finally cleanup still runs if the upload response contract is malformed.
    onFileCreated(candidateName);
  }
  if (
    !isRecord(file) ||
    typeof file.name !== "string" ||
    !/^files\/[A-Za-z0-9_-]+$/.test(file.name) ||
    typeof file.uri !== "string" ||
    file.uri.length === 0 ||
    typeof file.mimeType !== "string" ||
    file.mimeType !== "audio/mpeg" ||
    typeof file.state !== "string"
  ) {
    throw new M3ProcessingError("PROVIDER_RESPONSE_INVALID");
  }
  return { name: file.name, uri: file.uri, mimeType: file.mimeType, state: file.state };
}

async function waitForActiveFile(
  transport: M3ProviderTransport,
  options: M3ProviderOptions,
  uploaded: UploadedFile,
  deadline: number,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
  metadata: ProviderStageMetadata,
) {
  let file = uploaded;
  while (file.state === "PROCESSING") {
    const remaining = deadline - now();
    if (remaining <= FILE_POLL_INTERVAL_MS) throw new M3ProcessingError("PROVIDER_TIMEOUT");
    await sleep(FILE_POLL_INTERVAL_MS);
    const response = await fetchProvider(
      transport,
      `${API_ORIGIN}/v1beta/${file.name.split("/").map(encodeURIComponent).join("/")}?key=${encodeURIComponent(options.apiKey)}`,
      { method: "GET" },
      deadline,
      now,
      metadata,
    );
    const payload = await readJson(response, deadline, now);
    metadata.pollCount = (metadata.pollCount ?? 0) + 1;
    metadata.fileState = isRecord(payload) ? safeFileState(payload.state) : "UNKNOWN";
    const updated = parseFileResource(payload);
    if (updated.name !== file.name || updated.uri !== file.uri || updated.mimeType !== "audio/mpeg") {
      throw new M3ProcessingError("PROVIDER_RESPONSE_INVALID");
    }
    file = updated;
    metadata.fileState = safeFileState(file.state);
  }
  if (file.state !== "ACTIVE") throw new M3ProcessingError("PROVIDER_RESPONSE_INVALID");
  return file;
}

function parseFileResource(value: unknown): UploadedFile {
  // files.get returns a File resource directly. A `file` wrapper is the
  // media.upload response shape and is not accepted while polling.
  if (!isRecord(value) || Object.hasOwn(value, "file")) {
    throw new M3ProcessingError("PROVIDER_RESPONSE_INVALID");
  }
  if (
    typeof value.name !== "string" ||
    !/^files\/[A-Za-z0-9_-]+$/.test(value.name) ||
    typeof value.uri !== "string" ||
    value.uri.length === 0 ||
    value.mimeType !== "audio/mpeg" ||
    (value.state !== "PROCESSING" && value.state !== "ACTIVE")
  ) {
    throw new M3ProcessingError("PROVIDER_RESPONSE_INVALID");
  }
  return { name: value.name, uri: value.uri, mimeType: value.mimeType, state: value.state };
}

async function fetchProvider(
  transport: M3ProviderTransport,
  input: RequestInfo | URL,
  init: RequestInit,
  deadline: number,
  now: () => number,
  metadata?: ProviderStageMetadata,
) {
  const remaining = deadline - now();
  if (remaining <= 0) throw new M3ProcessingError("PROVIDER_TIMEOUT");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remaining);
  let response: Response;
  try {
    response = await transport(input, { ...init, signal: controller.signal });
  } catch (error) {
    clearTimeout(timeout);
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      if (metadata) metadata.classification = "timeout";
      throw new M3ProcessingError("PROVIDER_TIMEOUT");
    }
    if (metadata) metadata.classification = "network_failure";
    throw new M3ProcessingError("PROVIDER_UNAVAILABLE");
  }
  if (metadata) metadata.httpStatus = response.status;
  if (controller.signal.aborted) {
    clearTimeout(timeout);
    void response.body?.cancel().catch(() => undefined);
    if (metadata) metadata.classification = "timeout";
    throw new M3ProcessingError("PROVIDER_TIMEOUT");
  }
  if (!response.ok) {
    clearTimeout(timeout);
    controller.abort();
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 429) {
      if (metadata) {
        metadata.classification = "retryable_provider_response";
        metadata.retryClassification = "retryable_429";
      }
      throw new M3ProcessingError("PROVIDER_429", retryAfterSeconds(response.headers.get("retry-after"), now()));
    }
    if (response.status === 503) {
      if (metadata) {
        metadata.classification = "retryable_provider_response";
        metadata.retryClassification = "retryable_503";
      }
      throw new M3ProcessingError("PROVIDER_503", retryAfterSeconds(response.headers.get("retry-after"), now()));
    }
    if (response.status >= 500) {
      if (metadata) metadata.classification = "provider_unavailable";
      throw new M3ProcessingError("PROVIDER_UNAVAILABLE");
    }
    if (metadata) metadata.classification = "invalid_response";
    throw new M3ProcessingError("PROVIDER_RESPONSE_INVALID");
  }
  return {
    response,
    signal: controller.signal,
    abort() {
      controller.abort();
    },
    dispose(cancelBody = false) {
      clearTimeout(timeout);
      if (cancelBody) void response.body?.cancel().catch(() => undefined);
    },
  } satisfies ProviderResponse;
}

async function runProviderStage<T>(
  options: M3ProviderOptions,
  operation: M3ProviderOperation,
  deadline: number,
  now: () => number,
  run: (metadata: ProviderStageMetadata) => Promise<T> | T,
  metadata: ProviderStageMetadata = { retryClassification: "none" },
): Promise<T> {
  const startedAt = now();
  emitProviderDiagnostic(options, {
    ...metadata,
    operation,
    phase: "start",
    remainingBudgetMs: Math.max(0, deadline - startedAt),
    retryClassification: metadata.retryClassification ?? "none",
  });
  try {
    const result = await run(metadata);
    emitProviderDiagnostic(options, {
      ...metadata,
      operation,
      phase: "finish",
      classification: "success",
      elapsedMs: Math.max(0, now() - startedAt),
      remainingBudgetMs: Math.max(0, deadline - now()),
      retryClassification: metadata.retryClassification ?? "none",
    });
    return result;
  } catch (error) {
    const safeError = toSafeProviderError(error);
    if (operation === "structured_response_validation" && safeError.validationFailure) {
      metadata.validationFailure = safeError.validationFailure;
    }
    if (operation === "temporary_file_cleanup" && metadata.cleanupOutcome === "attempted") {
      metadata.cleanupOutcome = "failed";
    }
    emitProviderDiagnostic(options, {
      ...metadata,
      operation,
      phase: "finish",
      classification: metadata.classification ?? classifyProviderFailure(safeError),
      elapsedMs: Math.max(0, now() - startedAt),
      remainingBudgetMs: Math.max(0, deadline - now()),
      retryClassification: metadata.retryClassification ?? "none",
    });
    throw error;
  }
}

function emitProviderDiagnostic(options: M3ProviderOptions, event: M3ProviderDiagnostic) {
  if (!options.onDiagnostic) return;
  try {
    const correlationId = options.correlationId && /^[0-9a-f-]{36}$/i.test(options.correlationId)
      ? options.correlationId
      : undefined;
    options.onDiagnostic(correlationId ? { ...event, correlationId } : event);
  } catch {
    // A diagnostic sink must never affect provider work or cleanup.
  }
}

function classifyProviderFailure(error: M3ProcessingError): M3ProviderClassification {
  switch (error.code) {
    case "PROVIDER_TIMEOUT": return "timeout";
    case "PROVIDER_429":
    case "PROVIDER_503": return "retryable_provider_response";
    case "PROVIDER_UNAVAILABLE": return "provider_unavailable";
    case "PROVIDER_SAFETY_BLOCKED": return "safety_blocked";
    case "PROVIDER_CLEANUP_FAILED": return "cleanup_failure";
    case "PROVIDER_RESPONSE_INVALID":
    case "PROVIDER_FINISH_REASON_INVALID":
    case "PROVIDER_CANDIDATE_COUNT_INVALID": return "invalid_response";
    default: return "processing_failure";
  }
}

function safeFileState(value: unknown): M3ProviderDiagnostic["fileState"] {
  return value === "PROCESSING" || value === "ACTIVE" || value === "FAILED" ? value : "UNKNOWN";
}

async function readJson(
  providerResponse: ProviderResponse,
  deadline: number,
  now: () => number,
  metadata?: ProviderStageMetadata,
): Promise<unknown> {
  const remaining = deadline - now();
  if (remaining <= 0) {
    providerResponse.abort();
    providerResponse.dispose(true);
    if (metadata) metadata.classification = "timeout";
    throw new M3ProcessingError("PROVIDER_TIMEOUT");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      providerResponse.response.json() as Promise<unknown>,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new M3ProcessingError("PROVIDER_TIMEOUT")), remaining);
      }),
    ]);
  } catch (error) {
    if (
      providerResponse.signal.aborted ||
      error instanceof Error && error.name === "AbortError" ||
      error instanceof M3ProcessingError && error.code === "PROVIDER_TIMEOUT"
    ) {
      providerResponse.abort();
      try {
        const cancellation = providerResponse.response.body?.cancel();
        if (cancellation) void cancellation.catch(() => undefined);
      } catch {
        // A body consumer may have acquired the stream reader already.
      }
      if (metadata) metadata.classification = "timeout";
      throw error instanceof M3ProcessingError ? error : new M3ProcessingError("PROVIDER_TIMEOUT");
    }
    if (metadata) metadata.classification = error instanceof SyntaxError ? "invalid_response" : "network_failure";
    if (!(error instanceof SyntaxError)) {
      providerResponse.abort();
      throw new M3ProcessingError("PROVIDER_UNAVAILABLE");
    }
    throw new M3ProcessingError("PROVIDER_RESPONSE_INVALID");
  } finally {
    if (timeout) clearTimeout(timeout);
    providerResponse.dispose();
  }
}

function toSafeProviderError(error: unknown) {
  return error instanceof M3ProcessingError
    ? error
    : new M3ProcessingError("PROVIDER_UNAVAILABLE");
}

function retryAfterSeconds(value: string | null, now: number) {
  if (!value) return null;
  const seconds = Number(value);
  const parsed = Number.isFinite(seconds) ? seconds : (Date.parse(value) - now) / 1_000;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(parsed));
}

function isProviderUploadUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.origin === API_ORIGIN &&
      !url.username &&
      !url.password;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
