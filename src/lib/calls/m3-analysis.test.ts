import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assessM3Quality, parseM3Analysis } from "../../../supabase/functions/_shared/m3-analysis";

const validPayload = {
  transcript: "Hello, I need an estimate for ants. We can visit Tuesday. Please call before arriving.",
  intent: "sales",
  confirmedFacts: [
    { fact: "I need an estimate for ants.", evidence: "I need an estimate for ants." },
  ],
  customerConcerns: [
    { concern: "Please call before arriving.", evidence: "Please call before arriving." },
  ],
  outcome: {
    status: "observed",
    summary: "We can visit Tuesday.",
    evidence: "We can visit Tuesday.",
  },
  intentEvidence: "I need an estimate for ants.",
  anchors: {
    beginning: "Hello, I need an estimate for ants.",
    middle: "We can visit Tuesday.",
    ending: "Please call before arriving.",
  },
  uncertainty: { facts: false, speaker: false },
  confidence: 0.82,
};

const spokenOneMinuteTranscript = readFileSync(
  "supabase/tests/fixtures/m3-spoken-v1/m3-spoken-1m-v1.txt",
  "utf8",
).trim();

function analyze(payload: unknown = validPayload) {
  return assessM3Quality(parseM3Analysis(JSON.stringify(payload), "gemini-test-model"));
}

describe("M3 analysis contract and quality assessment", () => {
  it("requires human review while source completeness has no ground-truth reference", () => {
    const result = analyze();

    expect(result.transcript).toBe(validPayload.transcript);
    expect(result.callType).toBe("sales");
    expect(result.callStatus).toBe("review_required");
    expect(result.reviewStatus).toBe("review_required");
    expect(result.quality.sourceCompleteness).toBe("unverified");
    expect(result.quality.reviewReasons).toContain("SOURCE_COMPLETENESS_UNVERIFIED");
    expect(result.quality.anchorMatches).toEqual({ beginning: true, middle: true, ending: true });
    expect(result.extractedFacts.provenance.schema_version).toBe("m3-transcript-v1");
    expect(result.qualityIndicators.schema_version).toBe("m3-transcript-v1");
    expect(result).not.toHaveProperty("score");
  });

  it("records the revised extraction prompt version for new analyses", () => {
    expect(analyze().extractedFacts.provenance.prompt_version).toBe("m3.transcription.v7");
  });

  it("keeps no-booking service intent, negative facts, and separate concerns distinct", () => {
    const result = analyze({
      ...validPayload,
      transcript: spokenOneMinuteTranscript,
      intent: "sales",
      confirmedFacts: [
        {
          fact: "I heard scratching beside the pantry wall after sunset on three evenings.",
          evidence: "I heard scratching beside the pantry wall after sunset on three evenings.",
        },
        {
          fact: "I have not seen an animal, droppings, or damaged food.",
          evidence: "I have not seen an animal, droppings, or damaged food.",
        },
      ],
      customerConcerns: [
        {
          concern: "I am worried about his safety.",
          evidence: "I have an indoor cat named Milo. I am worried about his safety",
        },
        {
          concern: "I need to ask my landlord before anyone visits.",
          evidence: "I need to ask my landlord before anyone visits.",
        },
      ],
      outcome: {
        status: "unresolved",
        summary: "I have not scheduled a visit or quoted a price.",
        evidence: "I have not scheduled a visit or quoted a price.",
      },
      intentEvidence: "I am calling because I heard scratching beside the pantry wall after sunset on three evenings.",
      anchors: {
        beginning: "Hi, I am Mira Vale.",
        middle: "I will note those observations without guessing at a pest.",
        ending: "Call back if permission is granted.",
      },
      uncertainty: { facts: false, speaker: false },
    });

    expect(result.extractedFacts.intent).toBe("sales");
    expect(result.outcome.status).toBe("unresolved");
    expect(result.extractedFacts.confirmed_facts).toHaveLength(2);
    expect(result.extractedFacts.confirmed_facts[1]?.fact).toContain("not seen");
    expect(result.extractedFacts.customer_concerns).toHaveLength(2);
    expect(result.extractedFacts.customer_concerns.map(({ concern }) => concern)).toEqual([
      "I am worried about his safety.",
      "I need to ask my landlord before anyone visits.",
    ]);
  });

  it.each([
    {
      label: "administrative-only call",
      transcript: "Hello. What time does your office close today? I only need directions. Goodbye.",
      intent: "general_office",
      intentEvidence: "What time does your office close today?",
      outcome: { status: "unknown", summary: "Goodbye.", evidence: "Goodbye." },
      anchors: { beginning: "Hello.", middle: "I only need directions.", ending: "Goodbye." },
    },
    {
      label: "existing-customer follow-up",
      transcript: "I already receive monthly service. I want to renew my plan. Please keep the same schedule.",
      intent: "retention",
      intentEvidence: "I already receive monthly service. I want to renew my plan.",
      outcome: { status: "unresolved", summary: "I want to renew my plan.", evidence: "I want to renew my plan." },
      anchors: {
        beginning: "I already receive monthly service.",
        middle: "I want to renew my plan.",
        ending: "Please keep the same schedule.",
      },
    },
  ])("accepts the existing taxonomy for an $label", ({ transcript, intent, intentEvidence, outcome, anchors }) => {
    const result = analyze({
      ...validPayload,
      transcript,
      intent,
      confirmedFacts: [],
      customerConcerns: [],
      intentEvidence,
      outcome,
      anchors,
      uncertainty: { facts: true, speaker: false },
      confidence: null,
    });

    expect(result.extractedFacts.intent).toBe(intent);
  });

  it("preserves unknown intent and fact uncertainty instead of forcing sales", () => {
    const result = analyze({
      ...validPayload,
      transcript: "Hello. I heard a sound. I cannot tell what it was. Goodbye.",
      intent: "other",
      confirmedFacts: [],
      customerConcerns: [],
      intentEvidence: "I heard a sound.",
      outcome: { status: "unknown", summary: "I cannot tell what it was.", evidence: "I cannot tell what it was." },
      anchors: { beginning: "Hello.", middle: "I cannot tell what it was.", ending: "Goodbye." },
      uncertainty: { facts: true, speaker: false },
      confidence: null,
    });

    expect(result.extractedFacts.intent).toBe("other");
    expect(result.quality.uncertainty.facts).toBe(true);
    expect(result.quality.reviewReasons).toContain("OTHER_INTENT");
  });

  it("distinguishes a spoken booking from an unresolved service inquiry", () => {
    const transcript = "I need an ant inspection. We scheduled the inspection for Tuesday at ten. I will be home.";
    const result = analyze({
      ...validPayload,
      transcript,
      intent: "sales",
      confirmedFacts: [{
        fact: "We scheduled the inspection for Tuesday at ten.",
        evidence: "We scheduled the inspection for Tuesday at ten.",
      }],
      customerConcerns: [],
      outcome: {
        status: "observed",
        summary: "We scheduled the inspection for Tuesday at ten.",
        evidence: "We scheduled the inspection for Tuesday at ten.",
      },
      intentEvidence: "I need an ant inspection.",
      anchors: {
        beginning: "I need an ant inspection.",
        middle: "We scheduled the inspection for Tuesday at ten.",
        ending: "I will be home.",
      },
      uncertainty: { facts: false, speaker: false },
    });

    expect(result.outcome.status).toBe("observed");
    expect(result.outcome.summary).toBe("We scheduled the inspection for Tuesday at ten.");
  });

  it("maps the unscored other intent to a null call type and a review outcome", () => {
    const result = analyze({ ...validPayload, intent: "other" });

    expect(result.callType).toBeNull();
    expect(result.callStatus).toBe("review_required");
    expect(result.reviewStatus).toBe("review_required");
  });

  it("keeps an unknown outcome valid but requires human review", () => {
    const result = analyze({
      ...validPayload,
      outcome: {
        status: "unknown",
        summary: "Please call before arriving.",
        evidence: "Please call before arriving.",
      },
    });

    expect(result.outcome.status).toBe("unknown");
    expect(result.callStatus).toBe("review_required");
  });

  it.each(["", "not json", "{}", JSON.stringify({ ...validPayload, unexpected: true })])(
    "rejects malformed, empty, or non-exact provider payloads (%s)",
    (candidateText) => {
      expect(() => parseM3Analysis(candidateText, "gemini-test-model")).toThrow("INVALID_ANALYSIS");
    },
  );

  it("rejects evidence that is not an exact transcript excerpt", () => {
    expect(() => analyze({
      ...validPayload,
      confirmedFacts: [{ fact: "The call is booked.", evidence: "The visit is booked for Friday." }],
    })).toThrow("INVALID_ANALYSIS");
  });

  it("rejects fact or concern claims that are not verbatim transcript excerpts", () => {
    expect(() => analyze({
      ...validPayload,
      confirmedFacts: [{ fact: "The customer booked Friday for $49 with Mike.", evidence: "I need an estimate for ants." }],
    })).toThrow("INVALID_ANALYSIS");
    expect(() => analyze({
      ...validPayload,
      customerConcerns: [{ concern: "The customer fears pesticide exposure.", evidence: "Please call before arriving." }],
    })).toThrow("INVALID_ANALYSIS");
  });

  it("requires intent evidence and outcome summaries to be grounded in the transcript", () => {
    expect(() => analyze({ ...validPayload, intentEvidence: "We booked Friday for $49." })).toThrow("INVALID_ANALYSIS");
    expect(() => analyze({
      ...validPayload,
      outcome: { ...validPayload.outcome, summary: "A $49 appointment was booked with Mike." },
    })).toThrow("INVALID_ANALYSIS");
  });

  it("marks an unterminated final transcript sentence incomplete and review-required", () => {
    const transcript = "Hello, I need an estimate for ants. We can visit Tuesday. Please call before arriving";
    const result = analyze({
      ...validPayload,
      transcript,
      customerConcerns: [{
        concern: "Please call before arriving.",
        evidence: "Please call before arriving",
      }],
      anchors: {
        beginning: "Hello, I need an estimate for ants.",
        middle: "We can visit Tuesday.",
        ending: "Please call before arriving",
      },
    });

    expect(result.quality.anchorMatches.ending).toBe(false);
    expect(result.quality.missingEnding).toBe(true);
    expect(result.callStatus).toBe("review_required");
  });

  it("derives anchors from canonical sentence positions instead of model-supplied snippets", () => {
    const result = analyze({
      ...validPayload,
      anchors: {
        beginning: "Please call before arriving.",
        middle: "We can visit Tuesday.",
        ending: "Hello, I need an estimate for ants.",
      },
    });
    expect(result.quality.anchorsInOrder).toBe(true);
    expect(result.qualityIndicators.anchors).toEqual({
      beginning: "Hello, I need an estimate for ants.",
      middle: "We can visit Tuesday.",
      ending: "Please call before arriving.",
    });
    expect(result.quality.reviewReasons).not.toContain("ANCHORS_OUT_OF_ORDER");
  });

  it("rejects unsupported classifications instead of coercing them", () => {
    expect(() => analyze({ ...validPayload, intent: "appointment_booking" })).toThrow("INVALID_ANALYSIS");
  });

  it("rejects fabricated representative, booking, date, or price claims", () => {
    for (const fact of [
      "Representative Mike booked Friday.",
      "The appointment is on October 30.",
      "The price is $49.",
    ]) {
      expect(() => analyze({
        ...validPayload,
        confirmedFacts: [{ fact, evidence: "I need an estimate for ants." }],
      })).toThrow("INVALID_ANALYSIS");
    }
  });

  it("flags repeated transcript passages for review", () => {
    const repeated = "The customer asks about a monthly plan. ".repeat(8);
    const transcript = `${validPayload.transcript} ${repeated}`;
    const result = analyze({
      ...validPayload,
      transcript,
      anchors: {
        beginning: "Hello, I need an estimate for ants.",
        middle: "We can visit Tuesday.",
        ending: "The customer asks about a monthly plan.",
      },
    });

    expect(result.quality.repeatedContent).toBe(true);
    expect(result.callStatus).toBe("review_required");
  });

  it("flags transcript truncation and model uncertainty about facts or speaker", () => {
    const transcript = "Hello, I need an estimate for ants. We can visit Tuesday. Please call before arriving. I will send";
    const result = analyze({
      ...validPayload,
      transcript,
      anchors: {
        beginning: "Hello, I need an estimate for ants.",
        middle: "We can visit Tuesday.",
        ending: "I will send",
      },
      uncertainty: { facts: true, speaker: true },
    });

    expect(result.quality.truncated).toBe(true);
    expect(result.quality.uncertainty).toEqual({ facts: true, speaker: true });
    expect(result.callStatus).toBe("review_required");
  });

  it("preserves a long transcript without shortening the persisted text", () => {
    const longText = `${validPayload.transcript} ${"This is synthetic benchmark dialogue. ".repeat(3_800)}`;
    const result = analyze({
      ...validPayload,
      transcript: longText,
      anchors: {
        beginning: "Hello, I need an estimate for ants.",
        middle: "This is synthetic benchmark dialogue.",
        ending: "This is synthetic benchmark dialogue.",
      },
    });

    expect(result.transcript).toBe(longText);
  });

  it("rejects transcripts larger than the atomic persistence limit", () => {
    const transcript = "x".repeat(150_001);
    expect(() => analyze({
      ...validPayload,
      transcript,
      confirmedFacts: [],
      customerConcerns: [],
      outcome: { status: "unknown", summary: "x".repeat(10), evidence: "x".repeat(10) },
      intentEvidence: "x".repeat(10),
      anchors: { beginning: "x".repeat(10), middle: "x".repeat(10), ending: "x".repeat(10) },
    })).toThrow("INVALID_ANALYSIS");
  });
});
