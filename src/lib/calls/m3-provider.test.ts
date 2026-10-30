import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { M3_TRANSCRIPTION_INSTRUCTIONS, transcribeSyntheticAudio, type M3ProviderTransport } from "../../../supabase/functions/_shared/m3-provider";
import {
  M3ProcessingError,
  M3_PROVIDER_UTTERANCE_CONTRACT_VERSION,
  M3_RESPONSE_SCHEMA,
  parseGeminiGeneration,
  parseMp3Duration,
  segmentM3Transcript,
} from "../../../supabase/functions/_shared/m3-analysis";

const audio = new Uint8Array(readFileSync("supabase/tests/fixtures/synthetic-tone.mp3"));
const spokenTranscript = readFileSync("supabase/tests/fixtures/m3-spoken-v1/m3-spoken-1m-v1.txt", "utf8").trim();
const apiOrigin = "https://generativelanguage.googleapis.com";
const validTranscript = "Hello, I need an estimate for ants. We can visit Tuesday. Please call before arriving.";

type TestUtterance = {
  text: string;
  speaker: "caller" | "agent" | "unknown";
  speechAct: "statement" | "question" | "offer" | "advice" | "instruction" | "self_identification" | "greeting" | "unknown";
  confirmedFacts: string[];
  customerConcerns: string[];
  supportsIntent: boolean;
  supportsOutcome: boolean;
};

function modelPayloadFor(transcript = validTranscript) {
  const sentences = segmentM3Transcript(transcript);
  const utterances: TestUtterance[] = sentences.map((sentence) => ({
    text: sentence.text,
    speaker: "caller" as const,
    speechAct: "statement" as const,
    confirmedFacts: [] as string[],
    customerConcerns: [] as string[],
    supportsIntent: false,
    supportsOutcome: false,
  }));
  const intentUtterance = utterances.find((utterance) => utterance.text.includes("estimate")) ?? utterances[0]!;
  const concernUtterance = utterances.find((utterance) => utterance.text.includes("call")) ?? utterances.at(-1)!;
  intentUtterance.confirmedFacts.push(intentUtterance.text);
  intentUtterance.supportsIntent = true;
  concernUtterance.customerConcerns.push(concernUtterance.text);
  return {
    providerContractVersion: M3_PROVIDER_UTTERANCE_CONTRACT_VERSION,
    utterances,
    intent: "sales",
    outcome: { status: "unknown" as "observed" | "unresolved" | "unknown" },
    uncertainty: { facts: false, speaker: false },
    confidence: null,
  };
}

const validModelPayload = modelPayloadFor();

function wrapModelPayload(payload: unknown) {
  return { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(payload) }] } }] };
}

function canonicalAnalysisFrom(payload: unknown) {
  return JSON.parse(parseGeminiGeneration(wrapModelPayload(payload)).validatedAnalysisJson) as {
    intent: string;
    confirmedFacts: Array<{ fact: string; evidence: string }>;
    customerConcerns: Array<{ concern: string; evidence: string }>;
    outcome: { status: string; summary: string; evidence: string };
    intentEvidence: string | null;
    anchors: { beginning: string; middle: string; ending: string };
    uncertainty: { facts: boolean; speaker: boolean };
  };
}

function fileResource(state: string, extra: Record<string, unknown> = {}) {
  return {
    name: "files/test-upload-1",
    uri: `${apiOrigin}/v1beta/files/test-upload-1`,
    mimeType: "audio/mpeg",
    state,
    ...extra,
  };
}

function fakeProvider(
  finishReason: string = "STOP",
  options: {
    uploadState?: string;
    uploadPayload?: unknown;
    pollResponses?: unknown[];
    pollStatuses?: number[];
    generationStatus?: number;
  } = {},
) {
  const visits: string[] = [];
  let pollIndex = 0;
  let currentFileState = options.uploadState ?? "ACTIVE";
  let generationAfterActive = false;
  const transport: M3ProviderTransport = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    visits.push(`${method} ${new URL(url).pathname}`);
    if (method === "POST" && url.includes("/upload/v1beta/files")) {
      return new Response("{}", {
        status: 200,
        headers: { "x-goog-upload-url": `${apiOrigin}/upload/fake-session` },
      });
    }
    if (method === "POST" && url.includes("/upload/fake-session")) {
      return Response.json(options.uploadPayload ?? { file: fileResource(currentFileState) });
    }
    if (method === "GET" && url.includes("/v1beta/files/test-upload-1")) {
      const status = options.pollStatuses?.[pollIndex];
      const responseBody = options.pollResponses?.[pollIndex];
      pollIndex += 1;
      if (status && status !== 200) return new Response("poll failed", { status });
      const payload = responseBody ?? fileResource("ACTIVE");
      if (
        typeof payload === "object" && payload !== null && !Array.isArray(payload) &&
        !Object.hasOwn(payload, "file") && "state" in payload && typeof payload.state === "string"
      ) currentFileState = payload.state;
      return Response.json(payload);
    }
    if (method === "POST" && url.includes(":generateContent")) {
      generationAfterActive = currentFileState === "ACTIVE";
      if (options.generationStatus && options.generationStatus !== 200) {
        return new Response("generation failed", { status: options.generationStatus });
      }
      return Response.json({
        candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(validModelPayload) }] } }],
      });
    }
    if (method === "DELETE" && url.includes("/files/test-upload-1")) {
      return Response.json({});
    }
    return Response.json({ error: "unexpected" }, { status: 400 });
  };
  return { transport, visits, get generationAfterActive() { return generationAfterActive; } };
}

describe("M3 Gemini provider and audio checks", () => {
  it("pins the response to the versioned utterance-source contract", () => {
    expect(M3_RESPONSE_SCHEMA.required).toContain("providerContractVersion");
    expect(M3_RESPONSE_SCHEMA.properties.providerContractVersion.enum).toEqual([M3_PROVIDER_UTTERANCE_CONTRACT_VERSION]);
    expect(M3_RESPONSE_SCHEMA.required).toContain("utterances");
    expect(M3_RESPONSE_SCHEMA.properties).not.toHaveProperty("transcript");
    expect(M3_RESPONSE_SCHEMA.properties).not.toHaveProperty("sentenceAnnotations");
    expect(M3_RESPONSE_SCHEMA.properties.utterances.items.required).toContain("speaker");
    expect(M3_RESPONSE_SCHEMA.properties.utterances.items.required).toContain("supportsIntent");
    expect(M3_RESPONSE_SCHEMA.properties.utterances.items.required).toContain("supportsOutcome");
    expect(M3_RESPONSE_SCHEMA.properties.utterances.items.properties.confirmedFacts.items.type).toBe("STRING");
    expect(M3_PROVIDER_UTTERANCE_CONTRACT_VERSION).toBe("m3.provider-utterances.v1");
  });

  it("rejects the old clipped span contract at the version boundary", () => {
    for (const fragment of ["a Vale. I", "I will note th", "if permission is granted"]) {
      const payload = {
        providerContractVersion: "m3.provider-spans.v1",
        transcript: spokenTranscript,
        confirmedFacts: [{ fact: fragment, evidence: fragment }],
      };

      expect(() => parseGeminiGeneration(wrapModelPayload(payload)), fragment).toThrowError(
        expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID", validationFailure: "provider_contract_version" }),
      );
    }
  });

  it.each(["I am Mira Vale", "I will note those", "if permission is granted"])(
    "drops a clipped %s claim without losing the transcript",
    (fragment) => {
      const payload = modelPayloadFor(spokenTranscript);
      const utterance = payload.utterances.find((part) => part.text.includes(fragment));
      expect(utterance).toBeDefined();
      utterance!.confirmedFacts = [fragment];
      const sanitized = canonicalAnalysisFrom(payload);
      expect(sanitized.confirmedFacts.some((item) => item.fact === fragment)).toBe(false);
      expect(sanitized.uncertainty.facts).toBe(true);
      expect(JSON.parse(parseGeminiGeneration(wrapModelPayload(payload)).validatedAnalysisJson).transcript).toContain(fragment);
    },
  );

  it("parses the existing synthetic MP3 duration from bytes, without trusting browser metadata", () => {
    const duration = parseMp3Duration(audio);
    expect(duration.durationSeconds).toBeGreaterThan(0.9);
    expect(duration.durationSeconds).toBeLessThan(2.5);
  });

  it("uploads, validates STOP output, and deletes temporary provider file", async () => {
    const fake = fakeProvider();
    const response = await transcribeSyntheticAudio({
      apiKey: "local-test-only",
      model: "gemini-test",
      audio,
      transport: fake.transport,
    });
    expect(response.finishReason).toBe("STOP");
    expect(fake.visits).toEqual([
      "POST /upload/v1beta/files",
      "POST /upload/fake-session",
      "POST /v1beta/models/gemini-test:generateContent",
      "DELETE /v1beta/files/test-upload-1",
    ]);
  });

  it("uses the Gemini 3.5 Flash-Lite GenerateContent contract without unsupported candidateCount", async () => {
    const fake = fakeProvider();
    const generationBodies: Record<string, unknown>[] = [];
    const transport: M3ProviderTransport = async (input, init) => {
      if (String(input).includes(":generateContent")) {
        generationBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      }
      return fake.transport(input, init);
    };

    await transcribeSyntheticAudio({
      apiKey: "local-test-only",
      model: "gemini-3.5-flash-lite",
      audio,
      transport,
    });

    expect(generationBodies).toHaveLength(1);
    const generationBody = generationBodies[0]!;
    const contents = generationBody.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(contents[0]?.parts).toContainEqual({
      fileData: { mimeType: "audio/mpeg", fileUri: `${apiOrigin}/v1beta/files/test-upload-1` },
    });
    expect(contents[0]?.parts).toContainEqual({ text: M3_TRANSCRIPTION_INSTRUCTIONS });
    const generationConfig = generationBody.generationConfig as Record<string, unknown>;
    expect(generationConfig).toEqual(expect.objectContaining({
      responseMimeType: "application/json",
      responseSchema: M3_RESPONSE_SCHEMA,
      maxOutputTokens: 16_384,
    }));
    expect(generationConfig).not.toHaveProperty("candidateCount");
  });

  it("polls a wrapped PROCESSING upload using direct File resources until ACTIVE before generation", async () => {
    const fake = fakeProvider("STOP", {
      uploadState: "PROCESSING",
      pollResponses: [fileResource("PROCESSING"), fileResource("ACTIVE")],
    });
    const response = await transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport: fake.transport,
      sleep: async () => undefined,
    });
    expect(response.finishReason).toBe("STOP");
    expect(fake.visits).toEqual([
      "POST /upload/v1beta/files",
      "POST /upload/fake-session",
      "GET /v1beta/files/test-upload-1",
      "GET /v1beta/files/test-upload-1",
      "POST /v1beta/models/gemini-test:generateContent",
      "DELETE /v1beta/files/test-upload-1",
    ]);
    expect(fake.generationAfterActive).toBe(true);
  });

  it.each([
    ["wrapped files.get body", { file: fileResource("ACTIVE") }],
    ["unexpected body", { name: "unexpected/1", state: "ACTIVE" }],
    ["mismatched URI", fileResource("ACTIVE", { uri: `${apiOrigin}/v1beta/files/other` })],
    ["unknown state", fileResource("QUEUED")],
  ])("fails closed and cleans up after an invalid %s response", async (_label, pollResponse) => {
    const fake = fakeProvider("STOP", { uploadState: "PROCESSING", pollResponses: [pollResponse] });
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport: fake.transport,
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    expect(fake.visits).toContain("DELETE /v1beta/files/test-upload-1");
    expect(fake.visits).not.toContain("POST /v1beta/models/gemini-test:generateContent");
  });

  it("fails closed when files.get reports FAILED and deletes the uploaded file", async () => {
    const fake = fakeProvider("STOP", {
      uploadState: "PROCESSING",
      pollResponses: [fileResource("FAILED")],
    });
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport: fake.transport,
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    expect(fake.visits).toContain("DELETE /v1beta/files/test-upload-1");
    expect(fake.visits).not.toContain("POST /v1beta/models/gemini-test:generateContent");
  });

  it("cleans up after polling HTTP failure and provider-generation failure", async () => {
    const pollFailure = fakeProvider("STOP", { uploadState: "PROCESSING", pollStatuses: [503] });
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport: pollFailure.transport,
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code: "PROVIDER_503" });
    expect(pollFailure.visits).toContain("DELETE /v1beta/files/test-upload-1");
    expect(pollFailure.visits).not.toContain("POST /v1beta/models/gemini-test:generateContent");

    const generationFailure = fakeProvider("STOP", { generationStatus: 503 });
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport: generationFailure.transport,
    })).rejects.toMatchObject({ code: "PROVIDER_503" });
    expect(generationFailure.visits.at(-1)).toBe("DELETE /v1beta/files/test-upload-1");
  });

  it("rejects an invalid wrapped upload response but still cleans up its returned file name", async () => {
    const fake = fakeProvider("STOP", {
      uploadPayload: { file: { name: "files/test-upload-1", mimeType: "audio/mpeg", state: "PROCESSING" } },
    });
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport: fake.transport,
    })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    expect(fake.visits.at(-1)).toBe("DELETE /v1beta/files/test-upload-1");
  });

  it("deletes the temporary file even when Gemini returns MAX_TOKENS", async () => {
    const fake = fakeProvider("MAX_TOKENS");
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only",
      model: "gemini-test",
      audio,
      transport: fake.transport,
    })).rejects.toMatchObject({ code: "PROVIDER_FINISH_REASON_INVALID" });
    expect(fake.visits.at(-1)).toBe("DELETE /v1beta/files/test-upload-1");
  });

  it("fails closed on SAFETY and malformed JSON", () => {
    expect(() => parseGeminiGeneration({
      candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "{}" }] } }],
    })).toThrow(new M3ProcessingError("PROVIDER_SAFETY_BLOCKED"));
    expect(() => parseGeminiGeneration({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not json" }] } }],
    })).toThrowError(expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID", validationFailure: "invalid_json" }));
    expect(() => parseGeminiGeneration({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "" }] } }],
    })).toThrowError(expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID", validationFailure: "parts_shape" }));
  });

  it("classifies invalid structured output without exposing model text", () => {
    const wrap = (body: string) => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: body }] } }] });
    expect(() => parseGeminiGeneration(wrap("not json"))).toThrowError(
      expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID", validationFailure: "invalid_json" }),
    );
    expect(() => parseGeminiGeneration(wrap(JSON.stringify({ ...validModelPayload, grade: "Gold" })))).toThrowError(
      expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID", validationFailure: "top_level_shape" }),
    );
    const badClaim = modelPayloadFor();
    badClaim.utterances.find((utterance) => utterance.text.includes("estimate"))!.confirmedFacts = [
      "Secret invented price 9999.",
    ];
    const sanitized = JSON.parse(parseGeminiGeneration(wrap(JSON.stringify(badClaim))).validatedAnalysisJson);
    expect(sanitized.confirmedFacts).toEqual([]);
    expect(sanitized.uncertainty.facts).toBe(true);
    expect(JSON.stringify(sanitized)).not.toContain("Secret invented price 9999");
  });

  it("materializes claims and evidence from complete canonical transcript sentences", () => {
    const payload = modelPayloadFor();
    payload.utterances.find((utterance) => utterance.text.includes("visit Tuesday"))!.supportsOutcome = true;
    payload.outcome = { status: "observed" };
    const canonical = canonicalAnalysisFrom(payload);

    expect(canonical.confirmedFacts).toEqual([{
      fact: "Hello, I need an estimate for ants.",
      evidence: "Hello, I need an estimate for ants.",
    }]);
    expect(canonical.customerConcerns).toEqual([{
      concern: "Please call before arriving.",
      evidence: "Please call before arriving.",
    }]);
    expect(canonical.outcome).toEqual({ status: "observed", summary: "We can visit Tuesday.", evidence: "We can visit Tuesday." });
    expect(canonical.intentEvidence).toBe("Hello, I need an estimate for ants.");
    expect(canonical.anchors).toEqual({
      beginning: "Hello, I need an estimate for ants.",
      middle: "We can visit Tuesday.",
      ending: "Please call before arriving.",
    });
    expect(JSON.stringify(canonical)).not.toContain("providerContractVersion");
    expect(JSON.stringify(canonical)).not.toContain('"sentenceIds"');
  });

  it("keeps deterministic sentence IDs stable after astral Unicode characters", () => {
    const transcript = "😀 " + validTranscript;
    const sentences = segmentM3Transcript(transcript);
    const payload = modelPayloadFor(transcript);
    const parsed = parseGeminiGeneration(wrapModelPayload(payload));
    const canonical = JSON.parse(parsed.validatedAnalysisJson) as { intentEvidence: string };
    expect(sentences[0]?.start).toBe(0);
    expect(sentences[0]?.id).toBe("sentence-0001");
    expect(canonical.intentEvidence).toBe("😀 Hello, I need an estimate for ants.");
  });

  it("preserves original paragraph separators in multi-sentence evidence", () => {
    const transcript = "I have an indoor cat named Milo.\n\nI am worried about Milo's safety.";
    const payload = modelPayloadFor(transcript);
    payload.intent = "other";
    payload.utterances = [{
      text: transcript,
      speaker: "caller",
      speechAct: "statement",
      confirmedFacts: [],
      customerConcerns: ["I am worried about Milo's safety."],
      supportsIntent: false,
      supportsOutcome: false,
    }];
    const canonical = canonicalAnalysisFrom(payload);

    expect(canonical.intent).toBe("other");
    expect(canonical.customerConcerns[0]?.evidence).toBe(transcript);
  });

  it("rejects invalid marker values and multiple intent-evidence utterances", () => {
    const payload = modelPayloadFor();
    (payload.utterances[0] as unknown as { supportsIntent: unknown }).supportsIntent = "sentence-9999";
    expect(() => parseGeminiGeneration(wrapModelPayload(payload))).toThrowError(
      expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID", validationFailure: "utterance_schema_invalid" }),
    );

    const duplicate = modelPayloadFor();
    duplicate.utterances.find((utterance) => utterance.text.includes("call"))!.supportsIntent = true;
    const ambiguous = canonicalAnalysisFrom(duplicate);
    expect(ambiguous.intent).toBe("other");
    expect(ambiguous.uncertainty.facts).toBe(true);
  });

  it("rejects old sentence IDs if a provider tries to send them alongside utterances", () => {
    const payload = { ...validModelPayload, intentEvidenceSentenceIds: ["sentence-0001"] };
    expect(() => parseGeminiGeneration(wrapModelPayload(payload))).toThrowError(
      expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID", validationFailure: "top_level_shape" }),
    );
  });

  it("rejects fabricated booking and price details against complete evidence", () => {
    const payload = modelPayloadFor();
    payload.utterances.find((utterance) => utterance.text.includes("estimate"))!.confirmedFacts = [
      "The caller booked an inspection for $49.",
    ];
    const sanitized = canonicalAnalysisFrom(payload);
    expect(sanitized.confirmedFacts).toEqual([]);
    expect(sanitized.uncertainty.facts).toBe(true);
  });

  it("does not extract agent questions, advice, or instructions as caller facts", () => {
    const transcript = "I need an ant inspection. Have you seen any damage? Please keep food sealed. We can inspect Tuesday.";
    const sentences = segmentM3Transcript(transcript);
    const payload = modelPayloadFor(transcript);
    payload.utterances = sentences.map((sentence, index) => ({
      text: sentence.text,
      speaker: index === 0 ? "caller" : "agent",
      speechAct: sentence.text.endsWith("?") ? "question" :
        sentence.text.startsWith("Please") ? "instruction" :
          sentence.text.startsWith("We can") ? "offer" : "statement",
      confirmedFacts: index < 3 ? [sentence.text] : [],
      customerConcerns: [],
      supportsIntent: index === 0,
      supportsOutcome: index === 3,
    }));
    payload.outcome = { status: "observed" };
    const canonical = canonicalAnalysisFrom(payload);
    expect(canonical.confirmedFacts).toHaveLength(1);
    expect(canonical.confirmedFacts[0]?.evidence).toBe("I need an ant inspection.");
    expect(canonical.outcome).toEqual({
      status: "unknown", summary: "We can inspect Tuesday.", evidence: "We can inspect Tuesday.",
    });
    expect(canonical.uncertainty.facts).toBe(true);
  });

  it("downgrades an observed outcome that cites an explicit no-booking statement", () => {
    const transcript = "I am not booking today.";
    const payload = modelPayloadFor(transcript);
    payload.intent = "other";
    payload.utterances[0]!.confirmedFacts = [];
    payload.utterances[0]!.customerConcerns = [];
    payload.utterances[0]!.supportsIntent = false;
    payload.utterances[0]!.supportsOutcome = true;
    payload.outcome = { status: "observed" };
    const canonical = canonicalAnalysisFrom(payload);

    expect(canonical.outcome).toEqual({
      status: "unresolved", summary: transcript, evidence: transcript,
    });
  });

  it("represents the spoken fixture with complete caller evidence and two distinct concerns", () => {
    const expected = JSON.parse(readFileSync(
      "supabase/tests/fixtures/m3-spoken-v1/m3-spoken-1m-v1.expected.json", "utf8",
    )) as {
      expected_intent: string;
      confirmed_facts: Array<{ claim: string; evidence: string }>;
      concerns: Array<{ claim: string; evidence: string }>;
      expected_outcome: { status: string };
    };
    const sentences = segmentM3Transcript(spokenTranscript);
    const utterances = sentences.map((sentence) => {
      const turnIndex = (spokenTranscript.slice(0, sentence.start).match(/\r?\n\s*\r?\n/gu) ?? []).length;
      const speaker = turnIndex % 2 === 0 ? "caller" : "agent";
      const speechAct = sentence.text.endsWith("?") ? "question" :
        sentence.text.startsWith("Hi,") ? "greeting" :
          sentence.text.startsWith("Please keep") ? "instruction" :
            sentence.text.startsWith("We would need") ? "advice" :
              sentence.text.startsWith("We can discuss") ? "offer" : "statement";
      return {
        text: sentence.text,
        speaker,
        speechAct,
        confirmedFacts: [] as string[],
        customerConcerns: [] as string[],
        supportsIntent: false,
        supportsOutcome: false,
      };
    });
    const utteranceContaining = (text: string) => {
      const utterance = utterances.find((part) => part.text.includes(text));
      if (!utterance) throw new Error(`TEST_UTTERANCE_NOT_FOUND: ${text}`);
      return utterance;
    };
    const catUtterance = utteranceContaining("indoor cat named Milo");
    const worryUtterance = utteranceContaining("worried about his safety");
    catUtterance.text = `${catUtterance.text} ${worryUtterance.text}`;
    utterances.splice(utterances.indexOf(worryUtterance), 1);
    utteranceContaining("scratching beside the pantry wall").confirmedFacts.push(expected.confirmed_facts[0]!.evidence);
    utteranceContaining("I have not seen an animal").confirmedFacts.push(expected.confirmed_facts[1]!.evidence);
    catUtterance.confirmedFacts.push("I have an indoor cat named Milo.");
    utteranceContaining("Please keep food sealed").confirmedFacts.push(
      utteranceContaining("Please keep food sealed").text,
    );
    catUtterance.customerConcerns.push("I am worried about his safety.");
    utteranceContaining("I need to ask my landlord").customerConcerns.push("I need to ask my landlord before anyone visits.");
    utteranceContaining("I am calling because").supportsIntent = true;
    utteranceContaining("I am not booking today").supportsOutcome = true;
    const payload = {
      providerContractVersion: M3_PROVIDER_UTTERANCE_CONTRACT_VERSION,
      utterances,
      intent: expected.expected_intent,
      outcome: { status: expected.expected_outcome.status },
      uncertainty: { facts: false, speaker: false },
      confidence: null,
    };
    const canonical = canonicalAnalysisFrom(payload);

    expect(canonical.intent).toBe("sales");
    expect(canonical.confirmedFacts.map((item: { fact: string }) => item.fact)).toEqual([
      expected.confirmed_facts[0]!.evidence,
      expected.confirmed_facts[1]!.evidence,
      "I have an indoor cat named Milo.",
    ]);
    expect(canonical.confirmedFacts.every((item: { evidence: string }) => item.evidence.endsWith("."))).toBe(true);
    expect(canonical.customerConcerns.map((item: { concern: string }) => item.concern)).toEqual(
      ["I am worried about his safety.", "I need to ask my landlord before anyone visits."],
    );
    expect(canonical.customerConcerns[0].evidence).toBe(
      "I have an indoor cat named Milo. I am worried about his safety, and I need to ask my landlord before anyone visits.",
    );
    expect(canonical.customerConcerns[1].evidence).toBe(
      "I have an indoor cat named Milo. I am worried about his safety, and I need to ask my landlord before anyone visits.",
    );
    expect(canonical.outcome).toEqual({
      status: "unresolved", summary: "I am not booking today.", evidence: "I am not booking today.",
    });
    expect(canonical.uncertainty.facts).toBe(true);
  });

  it("rejects an unsupported provider contract version", () => {
    const payload = { ...validModelPayload, providerContractVersion: "m3.provider-utterances.v0" };
    expect(() => parseGeminiGeneration(wrapModelPayload(payload))).toThrowError(
      expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID", validationFailure: "provider_contract_version" }),
    );
  });

  it.each([
    ["count", [{ sentenceId: "sentence-0001", speaker: "caller", speechAct: "statement" }], "sentence_annotation_count_mismatch"],
    ["schema", [
      { sentenceId: "sentence-0001", speaker: "caller", speechAct: "statement" },
      { sentenceId: "sentence-0002", speaker: "customer", speechAct: "statement" },
    ], "sentence_annotation_schema_invalid"],
    ["ID/order", [
      { sentenceId: "sentence-0002", speaker: "caller", speechAct: "statement" },
      { sentenceId: "sentence-0001", speaker: "caller", speechAct: "statement" },
    ], "sentence_annotation_id_order_mismatch"],
  ])("emits redacted legacy annotation %s diagnostics, then cleans the provider file", async (_kind, sentenceAnnotations, validationFailure) => {
    const fake = fakeProvider();
    const diagnostics: Array<Record<string, unknown>> = [];
    const transport: M3ProviderTransport = async (input, init) => {
      if (String(input).includes(":generateContent")) {
        const invalid = {
          providerContractVersion: "m3.provider-sentences.v2",
          transcript: "PRIVATE TRANSCRIPT MUST NOT APPEAR IN DIAGNOSTICS. I need an estimate.",
          sentenceAnnotations,
        };
        return Response.json({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(invalid) }] } }],
        });
      }
      return fake.transport(input, init);
    };
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport,
      onDiagnostic: (event) => diagnostics.push(event),
    })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: "structured_response_validation", phase: "finish",
      validationFailure, classification: "invalid_response",
    }));
    expect(fake.visits.at(-1)).toBe("DELETE /v1beta/files/test-upload-1");
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE TRANSCRIPT MUST NOT APPEAR IN DIAGNOSTICS");
  });

  it("rejects missing or multiple model candidates", () => {
    expect(() => parseGeminiGeneration({ candidates: [] })).toThrow(new M3ProcessingError("PROVIDER_CANDIDATE_COUNT_INVALID"));
    expect(() => parseGeminiGeneration({ candidates: [
      { finishReason: "STOP", content: { parts: [{ text: JSON.stringify(validModelPayload) }] } },
      { finishReason: "STOP", content: { parts: [{ text: JSON.stringify(validModelPayload) }] } },
    ] })).toThrow(new M3ProcessingError("PROVIDER_CANDIDATE_COUNT_INVALID"));
  });

  it("keeps model-authored sentence and evidence identifiers out of the provider schema", () => {
    const schema = JSON.stringify(M3_RESPONSE_SCHEMA);
    expect(schema).not.toContain("sentenceId");
    expect(schema).not.toContain("sentenceIds");
    expect(schema).not.toContain("evidenceSentenceIds");
    expect(schema).not.toContain("intentEvidenceSentenceIds");
  });
  it("classifies quota failures without any retry loop inside the adapter", async () => {
    let calls = 0;
    const diagnostics: Array<Record<string, unknown>> = [];
    const transport: M3ProviderTransport = async () => {
      calls += 1;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "2" } });
    };
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport,
      onDiagnostic: (event) => diagnostics.push(event),
    })).rejects.toMatchObject({ code: "PROVIDER_429", retryAfterSeconds: 2 });
    expect(calls).toBe(1);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: "upload_session_start", phase: "finish", classification: "retryable_provider_response",
      httpStatus: 429, retryClassification: "retryable_429",
    }));
  });

  it("classifies 503 and carries a bounded Retry-After for the queue backoff", async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const transport: M3ProviderTransport = async () => new Response("unavailable", {
      status: 503,
      headers: { "retry-after": "99999" },
    });
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport,
      onDiagnostic: (event) => diagnostics.push(event),
    })).rejects.toMatchObject({ code: "PROVIDER_503", retryAfterSeconds: 3600 });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: "upload_session_start", phase: "finish", classification: "retryable_provider_response",
      httpStatus: 503, retryClassification: "retryable_503",
    }));
  });

  it("aborts a provider request at its bounded deadline", async () => {
    const transport: M3ProviderTransport = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport, timeoutMs: 5,
    })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });

  it("bounds response-body parsing after the provider has returned headers", async () => {
    const transport: M3ProviderTransport = async (input, init) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "POST" && url.includes("/upload/v1beta/files")) {
        return new Response("{}", { status: 200, headers: { "x-goog-upload-url": `${apiOrigin}/upload/body-timeout` } });
      }
      if (url.includes("/upload/body-timeout")) {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }
      return Response.json({});
    };
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport, timeoutMs: 20,
    })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });

  it("does not return a transcript when temporary-file cleanup fails", async () => {
    const fake = fakeProvider();
    const transport: M3ProviderTransport = async (input, init) => {
      if ((init?.method ?? "GET") === "DELETE") return new Response("cleanup failed", { status: 503 });
      return fake.transport(input, init);
    };
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport,
    })).rejects.toMatchObject({ code: "PROVIDER_CLEANUP_FAILED" });
  });

  it("deletes the temporary provider file after an invalid utterance marker", async () => {
    const fake = fakeProvider();
    const invalidPayload = modelPayloadFor();
    (invalidPayload.utterances[0] as unknown as { supportsIntent: unknown }).supportsIntent = "sentence-9999";
    const transport: M3ProviderTransport = async (input, init) => {
      if (String(input).includes(":generateContent")) {
        return Response.json({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(invalidPayload) }] } }],
        });
      }
      return fake.transport(input, init);
    };
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport,
    })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID", validationFailure: "utterance_schema_invalid" });
    expect(fake.visits.at(-1)).toBe("DELETE /v1beta/files/test-upload-1");
  });

  it("withholds invalid utterance output when cleanup also fails", async () => {
    const fake = fakeProvider();
    const invalidPayload = modelPayloadFor();
    (invalidPayload.utterances[0] as unknown as { supportsIntent: unknown }).supportsIntent = "sentence-9999";
    let cleanupCalls = 0;
    const diagnostics: Array<Record<string, unknown>> = [];
    const transport: M3ProviderTransport = async (input, init) => {
      if (String(input).includes(":generateContent")) {
        return Response.json({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(invalidPayload) }] } }],
        });
      }
      if ((init?.method ?? "GET") === "DELETE") {
        cleanupCalls += 1;
        return new Response("cleanup failed", { status: 503 });
      }
      return fake.transport(input, init);
    };
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport,
      onDiagnostic: (event) => diagnostics.push(event),
    })).rejects.toMatchObject({ code: "PROVIDER_CLEANUP_FAILED" });
    expect(cleanupCalls).toBe(1);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: "structured_response_validation", validationFailure: "utterance_schema_invalid",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: "temporary_file_cleanup", cleanupOutcome: "failed",
    }));
    expect(JSON.stringify(diagnostics)).not.toContain(JSON.stringify(invalidPayload));
  });

  it("rejects model responses containing score or grade fields", () => {
    expect(() => parseGeminiGeneration({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ ...validModelPayload, grade: "Gold" }) }] } }],
    })).toThrowError(expect.objectContaining({ code: "PROVIDER_RESPONSE_INVALID", validationFailure: "top_level_shape" }));
  });

  it("identifies a resumable upload-session timeout without logging credentials", async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const transport: M3ProviderTransport = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport, timeoutMs: 10,
      correlationId: "00000000-0000-4000-8000-000000000001",
      onDiagnostic: (event) => diagnostics.push(event),
    })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: "upload_session_start", phase: "finish", classification: "timeout",
    }));
    expect(JSON.stringify(diagnostics)).not.toContain("local-test-only");
  });

  it("identifies a timeout transferring and finalizing audio", async () => {
    const fake = fakeProvider();
    const diagnostics: Array<Record<string, unknown>> = [];
    const transport: M3ProviderTransport = async (input, init) => {
      if (String(input).includes("/upload/fake-session")) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return fake.transport(input, init);
    };
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport, timeoutMs: 20,
      correlationId: "00000000-0000-4000-8000-000000000002",
      onDiagnostic: (event) => diagnostics.push(event),
    })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: "audio_upload_finalize", phase: "finish", classification: "timeout",
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: "temporary_file_cleanup", phase: "finish", classification: "cleanup_not_possible",
      cleanupOutcome: "not_possible",
    }));
  });

  it("reports a file that remains PROCESSING at the polling deadline", async () => {
    const fake = fakeProvider("STOP", {
      uploadState: "PROCESSING",
      pollResponses: [fileResource("PROCESSING"), fileResource("PROCESSING")],
    });
    const diagnostics: Array<Record<string, unknown>> = [];
    let currentTime = 0;
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport: fake.transport,
      timeoutMs: 3_000, now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; },
      correlationId: "00000000-0000-4000-8000-000000000003",
      onDiagnostic: (event) => diagnostics.push(event),
    })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: "files_api_polling", phase: "finish", classification: "timeout", fileState: "PROCESSING",
    }));
    expect(fake.visits).not.toContain("POST /v1beta/models/gemini-test:generateContent");
  });

  it("identifies a generateContent request timeout", async () => {
    const fake = fakeProvider();
    const diagnostics: Array<Record<string, unknown>> = [];
    const transport: M3ProviderTransport = (input, init) => {
      if (String(input).includes(":generateContent")) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return fake.transport(input, init);
    };
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport, timeoutMs: 30,
      correlationId: "00000000-0000-4000-8000-000000000004",
      onDiagnostic: (event) => diagnostics.push(event),
    })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: "generation_request", phase: "finish", classification: "timeout",
    }));
  });

  it("identifies a generateContent response-body timeout", async () => {
    const fake = fakeProvider();
    const diagnostics: Array<Record<string, unknown>> = [];
    const transport: M3ProviderTransport = async (input, init) => {
      if (String(input).includes(":generateContent")) {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }
      return fake.transport(input, init);
    };
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport, timeoutMs: 30,
      correlationId: "00000000-0000-4000-8000-000000000005",
      onDiagnostic: (event) => diagnostics.push(event),
    })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: "generation_response_body", phase: "finish", classification: "timeout", httpStatus: 200,
    }));
  });

  it("aborts the underlying provider request when a response body times out", async () => {
    const fake = fakeProvider();
    let requestAborted = false;
    const transport: M3ProviderTransport = async (input, init) => {
      if (String(input).includes(":generateContent")) {
        init?.signal?.addEventListener("abort", () => { requestAborted = true; }, { once: true });
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }
      return fake.transport(input, init);
    };
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport, timeoutMs: 30,
    })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    expect(requestAborted).toBe(true);
  });

  it("reports cleanup timeout and withholds the otherwise valid transcript", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeProvider();
      const diagnostics: Array<Record<string, unknown>> = [];
      const transport: M3ProviderTransport = (input, init) => {
        if ((init?.method ?? "GET") === "DELETE") {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        }
        return fake.transport(input, init);
      };
      const result = transcribeSyntheticAudio({
        apiKey: "local-test-only", model: "gemini-test", audio, transport,
        correlationId: "00000000-0000-4000-8000-000000000006",
        onDiagnostic: (event) => diagnostics.push(event),
      });
      const rejection = expect(result).rejects.toMatchObject({ code: "PROVIDER_CLEANUP_FAILED" });
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
      expect(diagnostics).toContainEqual(expect.objectContaining({
        operation: "temporary_file_cleanup", phase: "finish", classification: "timeout", cleanupOutcome: "failed",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a non-timeout network failure and emits bounded stage diagnostics", async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const transport: M3ProviderTransport = async () => { throw new TypeError("mock network failure"); };
    await expect(transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport,
      correlationId: "00000000-0000-4000-8000-000000000007",
      onDiagnostic: (event) => diagnostics.push(event),
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      operation: "upload_session_start", phase: "finish", classification: "network_failure",
    }));
  });

  it("emits safe correlated stage diagnostics through successful validation and cleanup", async () => {
    const fake = fakeProvider("STOP", { uploadState: "PROCESSING", pollResponses: [fileResource("ACTIVE")] });
    const diagnostics: Array<Record<string, unknown>> = [];
    const response = await transcribeSyntheticAudio({
      apiKey: "local-test-only", model: "gemini-test", audio, transport: fake.transport,
      sleep: async () => undefined,
      correlationId: "00000000-0000-4000-8000-000000000008",
      onDiagnostic: (event) => diagnostics.push(event),
    });
    expect(response.finishReason).toBe("STOP");
    expect(diagnostics.map((event) => event.operation)).toEqual(expect.arrayContaining([
      "upload_session_start", "audio_upload_finalize", "upload_response_body", "upload_response_validation",
      "files_api_polling", "generation_request", "generation_response_body", "structured_response_validation",
      "temporary_file_cleanup",
    ]));
    expect(diagnostics.every((event) => event.correlationId === "00000000-0000-4000-8000-000000000008")).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain("transcript");
    expect(JSON.stringify(diagnostics)).not.toContain("local-test-only");
    expect(JSON.stringify(diagnostics)).not.toContain("generativelanguage.googleapis.com");
  });
});
