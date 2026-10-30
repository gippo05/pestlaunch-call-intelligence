import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUBRIC_REGISTRY,
  selectRubric,
} from "./rubrics";
import {
  scoreAssessment,
} from "./scoring-engine";
import type { RubricDefinition, ScoringInput } from "./types";

const ANALYSIS_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const REVIEWER_ID = "33333333-3333-4333-8333-333333333333";

function codePointLength(value: string) {
  return Array.from(value).length;
}

function makeInput(
  options: {
    brand?: string;
    category?: string;
    metCount?: number;
    includeObjectionObservations?: boolean;
    objectionState?: ScoringInput["objectionState"];
  } = {},
): ScoringInput {
  const brand = options.brand ?? "abc";
  const category = options.category ?? "sales";
  const registryKey = `${brand}.${category}` as keyof typeof DEFAULT_RUBRIC_REGISTRY;
  const rubric = DEFAULT_RUBRIC_REGISTRY[registryKey];
  const criteria = rubric?.criteria ?? [];
  const evidenceEntries = criteria.map((criterion) => ({
    criterionId: criterion.id,
    quote: `Synthetic evidence for ${criterion.id}.`,
  }));
  const transcript = evidenceEntries.map(({ quote }) => `Agent: ${quote}`).join("\n");
  let cursor = 0;
  const offsets = new Map<string, { start: number; end: number; quote: string }>();
  for (const { criterionId, quote } of evidenceEntries) {
    const startUtf16 = transcript.indexOf(quote, cursor);
    const endUtf16 = startUtf16 + quote.length;
    offsets.set(criterionId, {
      start: codePointLength(transcript.slice(0, startUtf16)),
      end: codePointLength(transcript.slice(0, endUtf16)),
      quote,
    });
    cursor = endUtf16;
  }

  const objections = new Set([
    "sales.agree",
    "sales.restate_insinuate",
    "sales.resolve",
    "sales.reclose",
  ]);
  const ordinaryCriteria = criteria.filter((criterion) => !objections.has(criterion.id));
  const metCount = options.metCount ?? criteria.length;
  const observations = criteria
    .filter((criterion) => options.includeObjectionObservations !== false || !objections.has(criterion.id))
    .map((criterion) => {
      const offset = offsets.get(criterion.id)!;
      const ordinal = ordinaryCriteria.findIndex((candidate) => candidate.id === criterion.id);
      const conditionalOrdinal = criteria
        .filter((candidate) => objections.has(candidate.id))
        .findIndex((candidate) => candidate.id === criterion.id);
      const status = ordinal >= 0
        ? (ordinal < Math.min(metCount, ordinaryCriteria.length) ? "met" : "missed")
        : (metCount > ordinaryCriteria.length && conditionalOrdinal < metCount - ordinaryCriteria.length ? "met" : "missed");
      return {
        criterionId: criterion.id,
        status: status as "met" | "missed",
        rationale: `A human reviewer validated ${criterion.label} from this synthetic excerpt.`,
        evidenceReferences: [
          {
            kind: "transcript_span" as const,
            analysisId: ANALYSIS_ID,
            transcriptVersion: 1,
            start: offset.start,
            end: offset.end,
            quote: offset.quote,
            speaker: "agent" as const,
          },
        ],
      };
    });

  return {
    call: {
      analysisId: ANALYSIS_ID,
      workspaceId: WORKSPACE_ID,
      brand,
      companyConfirmed: true,
      conversationalIntent: category,
      intentValidated: true,
      telephoneMenuSelection: "sales",
    },
    analysis: {
      id: ANALYSIS_ID,
      workspaceId: WORKSPACE_ID,
      transcript,
      transcriptVersion: 1,
      reviewStatus: "reviewed",
      transcriptCompleteness: "verified",
      speakerAttribution: "verified",
    },
    adjudication: {
      status: "human_validated",
      adjudicatorId: REVIEWER_ID,
      reviewerRole: "reviewer",
      wholeTranscriptReviewed: true,
    },
    observations,
    objectionState: options.objectionState ?? "present",
    retentionRepeatApplicability: "applicable",
    exceptionFlags: { specialCancellation: false },
  };
}

function scoreWithApprovedTestRubric(input: ScoringInput) {
  const key = `${input.call.brand}.${input.call.conversationalIntent}` as keyof typeof DEFAULT_RUBRIC_REGISTRY;
  const rubric = DEFAULT_RUBRIC_REGISTRY[key];
  if (!rubric) throw new Error("The isolated approved-policy fixture requires a known rubric.");
  return scoreAssessment(input, {
    ...rubric,
    calibrationStatus: "owner_approved",
  } as unknown as RubricDefinition);
}

describe("versioned rubric registry", () => {
  it.each([
    ["abc.sales", 17],
    ["noble_sales.sales", 17],
    ["abc.general_office", 12],
    ["noble_sales.general_office", 12],
    ["abc.retention", 12],
    ["noble_sales.retention", 12],
  ] as const)("keeps %s at %i ordered one-point criteria", (key, expectedCount) => {
    const rubric = DEFAULT_RUBRIC_REGISTRY[key];
    expect(rubric.criteria).toHaveLength(expectedCount);
    expect(rubric.criteria.every((criterion) => criterion.weight === 1)).toBe(true);
    expect(rubric.criteria.map((criterion) => criterion.order)).toEqual(
      Array.from({ length: expectedCount }, (_, index) => index + 1),
    );
    expect(rubric.maxPoints).toBe(expectedCount);
    expect(rubric.calibrationStatus).toBe("manual_calibration_required");
  });

  it("gives the two Sales Expectation Statement steps separate stable IDs", () => {
    const criteria = DEFAULT_RUBRIC_REGISTRY["abc.sales"].criteria;
    const expectations = criteria.filter((criterion) => criterion.label === "Expectation Statement");
    expect(expectations.map((criterion) => criterion.id)).toEqual([
      "sales.expectation_statement.first",
      "sales.expectation_statement.second",
    ]);
  });

  it.each([
    ["abc.sales", [
      "Validate", "Confidence Statement", "Expectation Statement", "Investigate", "Summary Statement",
      "Expectation Statement", "Present Solution", "Consensus", "Close", "Pricing", "Agree",
      "Restate & Insinuate", "Resolve", "Re-Close", "Provide a Conclusion", "Offer final information",
      "Thank the Customer",
    ]],
    ["abc.general_office", [
      "Validate", "Confidence Statement", "Expectation Statement", "Investigate", "Summary Statement",
      "Expectation Statement", "Present Solution", "Consensus", "Close", "Provide a Conclusion",
      "Thank the Customer", "Offer final information",
    ]],
    ["abc.retention", [
      "Validate & Confidence Statement", "Transition Statement", "Do Your Research", "Investigate",
      "Validate & Summary Statement", "Validate & Expectation Statement", "Present Solution", "Consensus",
      "Repeat (when necessary)", "Provide a Conclusion", "Thank the Customer", "Leave a Teaser",
    ]],
  ] as const)("preserves the specified criterion order for %s", (key, labels) => {
    expect(DEFAULT_RUBRIC_REGISTRY[key].criteria.map((criterion) => criterion.label)).toEqual(labels);
  });

  it("keeps each company mapped to a separate rubric identity", () => {
    expect(DEFAULT_RUBRIC_REGISTRY["abc.sales"].id).not.toBe(
      DEFAULT_RUBRIC_REGISTRY["noble_sales.sales"].id,
    );
    expect(DEFAULT_RUBRIC_REGISTRY["abc.sales"].brand).toBe("abc");
    expect(DEFAULT_RUBRIC_REGISTRY["noble_sales.sales"].brand).toBe("noble_sales");
  });
});

describe("rubric routing", () => {
  it.each([
    ["abc", "sales"],
    ["abc", "general_office"],
    ["abc", "retention"],
    ["noble_sales", "sales"],
    ["noble_sales", "general_office"],
    ["noble_sales", "retention"],
  ])("routes validated %s / %s", (brand, category) => {
    const input = makeInput({ brand, category });
    expect(selectRubric(input).rubric?.brand).toBe(brand);
    expect(selectRubric(input).rubric?.category).toBe(category);
  });

  it("uses validated conversational intent instead of a conflicting telephone menu", () => {
    const input = makeInput({ category: "retention" });
    input.call.telephoneMenuSelection = "sales";
    expect(selectRubric(input).rubric?.id).toBe("abc.retention.v1");
  });

  it.each([
    { brand: "unknown", category: "sales" },
    { brand: "abc", category: "unknown" },
  ])("does not guess for unsupported brand or intent", (classification) => {
    const input = makeInput(classification);
    expect(selectRubric(input).rubric).toBeNull();
    expect(selectRubric(input).reviewRequired).toBe(true);
  });

  it("does not route an unreviewed company or intent", () => {
    const input = makeInput();
    input.call.companyConfirmed = false;
    input.call.intentValidated = false;
    expect(selectRubric(input).rubric).toBeNull();
    expect(selectRubric(input).reviewReasons).toContain("classification_unreviewed");
  });

  it("selects a candidate rubric for a known brand and unvalidated AI intent", () => {
    const input = makeInput();
    input.call.intentValidated = false;
    input.analysis.reviewStatus = "review_required";
    input.analysis.transcriptCompleteness = "unverified";
    input.analysis.speakerAttribution = "uncertain";
    input.adjudication = {
      status: "unreviewed",
      adjudicatorId: null,
      reviewerRole: "unknown",
      wholeTranscriptReviewed: false,
    };

    const selection = selectRubric(input);
    expect(selection.rubric?.id).toBe("abc.sales.v1");
    expect(selection.reviewRequired).toBe(true);
    expect(selection.reviewReasons).toContain("classification_unreviewed");
    const result = scoreAssessment(input);
    expect(result.totalPoints).toBeNull();
    expect(result.provisionalPoints).toBe(0);
    expect(result.provisionalGrade).toBeNull();
    expect(result.criteria.every((criterion) => criterion.status === "insufficient_evidence" && criterion.pointsEarned === null)).toBe(true);
  });

  it("rejects an explicitly supplied rubric from a different company", () => {
    const input = makeInput({ brand: "abc", category: "sales" });
    const result = scoreAssessment(input, DEFAULT_RUBRIC_REGISTRY["noble_sales.sales"]);
    expect(result.rubric).toBeNull();
    expect(result.grade).toBeNull();
    expect(result.reviewReasons).toContain("rubric_classification_mismatch");
  });
});

describe("deterministic thresholds", () => {
  it.each([
    [17, "Gold"],
    [16, "Green"],
    [14, "Green"],
    [13, "Below Standard"],
  ] as const)("grades Sales at %i points", (points, grade) => {
    const result = scoreWithApprovedTestRubric(makeInput({ metCount: points }));
    expect(result.totalPoints).toBe(points);
    expect(result.maxPoints).toBe(17);
    expect(result.grade).toBe(grade);
    expect(result.reviewRequired).toBe(false);
  });

  it.each([
    ["general_office", 12, "Gold"],
    ["general_office", 11, "Green"],
    ["general_office", 10, "Below Standard"],
    ["retention", 12, "Gold"],
    ["retention", 11, "Green"],
    ["retention", 10, "Below Standard"],
  ] as const)("grades %s at %i points", (category, points, grade) => {
    const result = scoreWithApprovedTestRubric(makeInput({ category, metCount: points }));
    expect(result.totalPoints).toBe(points);
    expect(result.maxPoints).toBe(12);
    expect(result.grade).toBe(grade);
    expect(result.reviewRequired).toBe(false);
  });

  it("keeps a complete 17/17 result provisional while the production rubric is unapproved", () => {
    const result = scoreAssessment(makeInput({ metCount: 17 }));

    expect(result.provisionalPoints).toBe(17);
    expect(result.provisionalGrade).toBe("Gold");
    expect(result.totalPoints).toBeNull();
    expect(result.grade).toBeNull();
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReasons).toContain("rubric_calibration_pending");
  });

  it.each([
    ["abc", "sales", 17],
    ["noble_sales", "sales", 17],
    ["abc", "general_office", 12],
    ["noble_sales", "general_office", 12],
    ["abc", "retention", 12],
    ["noble_sales", "retention", 12],
  ] as const)("never emits an official result for pending %s / %s calibration", (brand, category, maxPoints) => {
    const result = scoreAssessment(makeInput({ brand, category, metCount: maxPoints }));

    expect(result.provisionalPoints).toBe(maxPoints);
    expect(result.totalPoints).toBeNull();
    expect(result.grade).toBeNull();
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReasons).toContain("rubric_calibration_pending");
  });

  it("withholds official results for missing or uncertain observations under an approved test rubric", () => {
    const missingObservation = makeInput({ metCount: 17 });
    missingObservation.observations.pop();
    const missingResult = scoreWithApprovedTestRubric(missingObservation);

    expect(missingResult.totalPoints).toBeNull();
    expect(missingResult.grade).toBeNull();
    expect(missingResult.provisionalGrade).toBeNull();
    expect(missingResult.reviewRequired).toBe(true);

    const uncertainSpeaker = makeInput({ metCount: 17 });
    uncertainSpeaker.analysis.speakerAttribution = "uncertain";
    const uncertainResult = scoreWithApprovedTestRubric(uncertainSpeaker);

    expect(uncertainResult.totalPoints).toBeNull();
    expect(uncertainResult.grade).toBeNull();
    expect(uncertainResult.provisionalGrade).toBeNull();
    expect(uncertainResult.reviewReasons).toContain("speaker_attribution_unverified");
  });
});

describe("Sales objection policy", () => {
  const objectionIds = [
    "sales.agree",
    "sales.restate_insinuate",
    "sales.resolve",
    "sales.reclose",
  ];

  it("auto-awards exactly four points only when no objection is positively confirmed", () => {
    const result = scoreWithApprovedTestRubric(
      makeInput({
        metCount: 13,
        includeObjectionObservations: false,
        objectionState: "none_confirmed",
      }),
    );
    expect(result.criteria.filter((criterion) => criterion.status === "auto_awarded").map((criterion) => criterion.id)).toEqual(objectionIds);
    expect(result.totalPoints).toBe(17);
    expect(result.grade).toBe("Gold");
  });

  it("does not confirm no objection from an unreviewed transcript", () => {
    const input = makeInput({
      includeObjectionObservations: false,
      objectionState: "none_confirmed",
    });
    input.adjudication.wholeTranscriptReviewed = false;
    const result = scoreWithApprovedTestRubric(input);
    expect(result.criteria.filter((criterion) => criterion.status === "auto_awarded")).toHaveLength(0);
    expect(result.totalPoints).toBeNull();
    expect(result.grade).toBeNull();
  });

  it("scores present objections only from their evidence and never auto-awards", () => {
    const input = makeInput({ metCount: 13, objectionState: "present" });
    for (const observation of input.observations) {
      if (objectionIds.includes(observation.criterionId)) {
        observation.status = observation.criterionId === "sales.agree" ? "met" : "missed";
      }
    }
    const result = scoreWithApprovedTestRubric(input);
    expect(result.criteria.filter((criterion) => objectionIds.includes(criterion.id)).map((criterion) => criterion.status)).toEqual([
      "met",
      "missed",
      "missed",
      "missed",
    ]);
    expect(result.criteria.some((criterion) => criterion.status === "auto_awarded")).toBe(false);
    expect(result.totalPoints).toBe(14);
    expect(result.grade).toBe("Green");
  });

  it.each(["ambiguous", "unknown"] as const)("withholds all four objection points when state is %s", (objectionState) => {
    const result = scoreWithApprovedTestRubric(makeInput({ objectionState }));
    const conditional = result.criteria.filter((criterion) => objectionIds.includes(criterion.id));
    expect(conditional.map((criterion) => criterion.status)).toEqual([
      "insufficient_evidence",
      "insufficient_evidence",
      "insufficient_evidence",
      "insufficient_evidence",
    ]);
    expect(conditional.every((criterion) => criterion.pointsEarned === null)).toBe(true);
    expect(result.totalPoints).toBeNull();
    expect(result.grade).toBeNull();
    expect(result.reviewRequired).toBe(true);
  });
});

describe("evidence and review gates", () => {
  it("keeps a missing observation unknown instead of converting it to a failure", () => {
    const input = makeInput();
    input.observations = input.observations.filter((observation) => observation.criterionId !== "sales.validate");
    const result = scoreWithApprovedTestRubric(input);
    const validate = result.criteria.find((criterion) => criterion.id === "sales.validate");
    expect(validate?.status).toBe("insufficient_evidence");
    expect(validate?.pointsEarned).toBeNull();
    expect(result.totalPoints).toBeNull();
    expect(result.grade).toBeNull();
  });

  it("keeps a criterion with no evidence unknown even when its observation says met", () => {
    const input = makeInput();
    input.observations[0].evidenceReferences = [];
    const result = scoreAssessment(input);
    expect(result.criteria[0].status).toBe("insufficient_evidence");
    expect(result.criteria[0].pointsEarned).toBeNull();
    expect(result.grade).toBeNull();
  });

  it("validates transcript evidence offsets in Unicode code points", () => {
    const input = makeInput();
    input.analysis.transcript = `🦗${input.analysis.transcript}`;
    for (const observation of input.observations) {
      for (const reference of observation.evidenceReferences) {
        if (reference.kind === "transcript_span") {
          reference.start += 1;
          reference.end += 1;
        }
      }
    }
    const result = scoreWithApprovedTestRubric(input);
    expect(result.totalPoints).toBe(17);
    expect(result.grade).toBe("Gold");
  });

  it.each([
    ["cross_analysis", (input: ScoringInput) => { input.observations[0].evidenceReferences[0].analysisId = "44444444-4444-4444-8444-444444444444"; }],
    ["unmatched_quote", (input: ScoringInput) => {
      const reference = input.observations[0].evidenceReferences[0];
      if (reference.kind === "transcript_span") reference.quote = "fabricated words not in the transcript";
    }],
    ["caller_attribution", (input: ScoringInput) => {
      const reference = input.observations[0].evidenceReferences[0];
      if (reference.kind === "transcript_span") reference.speaker = "caller";
    }],
  ])("rejects %s evidence", (_name, change) => {
    const input = makeInput();
    change(input);
    const result = scoreAssessment(input);
    expect(result.criteria[0].status).toBe("insufficient_evidence");
    expect(result.criteria[0].pointsEarned).toBeNull();
    expect(result.grade).toBeNull();
    expect(result.reviewRequired).toBe(true);
  });

  it.each([
    ["missing", null, "missing"],
    ["partial", "Agent: Partial synthetic transcript.", "partial"],
    ["unverified", "Agent: Synthetic transcript.", "unverified"],
  ] as const)("withholds a grade for a %s transcript", (_name, transcript, completeness) => {
    const input = makeInput();
    input.analysis.transcript = transcript;
    input.analysis.transcriptCompleteness = completeness;
    const result = scoreAssessment(input);
    expect(result.grade).toBeNull();
    expect(result.totalPoints).toBeNull();
    expect(result.reviewRequired).toBe(true);
  });

  it("withholds a grade when M3 analysis has not been independently reviewed", () => {
    const input = makeInput();
    input.analysis.reviewStatus = "review_required";
    const result = scoreAssessment(input);
    expect(result.grade).toBeNull();
    expect(result.reviewReasons).toContain("analysis_not_human_reviewed");
  });

  it("withholds a grade when speaker attribution is uncertain", () => {
    const input = makeInput();
    input.analysis.speakerAttribution = "uncertain";
    const result = scoreAssessment(input);
    expect(result.grade).toBeNull();
    expect(result.reviewReasons).toContain("speaker_attribution_unverified");
  });

  it("withholds a grade when assessment authority or full-call review is missing", () => {
    const input = makeInput();
    input.adjudication.wholeTranscriptReviewed = false;
    input.adjudication.reviewerRole = "member";
    const result = scoreAssessment(input);
    expect(result.grade).toBeNull();
    expect(result.reviewRequired).toBe(true);
  });

  it("ignores caller-supplied numeric points", () => {
    const input = { ...makeInput(), points: 999, grade: "Gold" } as ScoringInput;
    const result = scoreAssessment(input);
    expect(result.provisionalPoints).toBe(17);
    expect(result.provisionalGrade).toBe("Gold");
    expect(result.totalPoints).toBeNull();
    expect(result.grade).toBeNull();
  });

  it("withholds scoring when call and analysis tenant identities disagree", () => {
    const input = makeInput();
    input.analysis.workspaceId = "55555555-5555-4555-8555-555555555555";
    const result = scoreAssessment(input);
    expect(result.totalPoints).toBeNull();
    expect(result.grade).toBeNull();
    expect(result.reviewReasons).toContain("analysis_scope_mismatch");
  });

  it("withholds scoring when source identifiers are not database UUIDs", () => {
    const input = makeInput();
    input.analysis.id = "not-a-database-id";
    input.call.analysisId = "not-a-database-id";
    const result = scoreAssessment(input);
    expect(result.totalPoints).toBeNull();
    expect(result.grade).toBeNull();
    expect(result.reviewReasons).toContain("analysis_identity_invalid");
  });

  it("returns a Not Scored result for structurally malformed input instead of throwing", () => {
    const malformed = { call: null } as unknown as ScoringInput;
    expect(() => scoreAssessment(malformed)).not.toThrow();
    const result = scoreAssessment(malformed);
    expect(result.rubric).toBeNull();
    expect(result.totalPoints).toBeNull();
    expect(result.reviewReasons).toContain("scoring_input_invalid");
  });
});

describe("Retention exceptions", () => {
  it("does not award a point or grade for an unapproved Repeat N/A treatment", () => {
    const input = makeInput({ brand: "abc", category: "retention" });
    input.retentionRepeatApplicability = "not_applicable";
    const result = scoreAssessment(input);
    const repeat = result.criteria.find((criterion) => criterion.id === "retention.repeat");
    expect(repeat?.status).toBe("not_applicable");
    expect(repeat?.pointsEarned).toBeNull();
    expect(result.totalPoints).toBeNull();
    expect(result.grade).toBeNull();
    expect(result.reviewReasons).toContain("retention_repeat_na_policy_unapproved");
  });

  it("requires review when Repeat applicability is uncertain", () => {
    const input = makeInput({ category: "retention" });
    input.retentionRepeatApplicability = "uncertain";
    const result = scoreAssessment(input);
    expect(result.criteria.find((criterion) => criterion.id === "retention.repeat")?.status).toBe("insufficient_evidence");
    expect(result.grade).toBeNull();
  });

  it("does not automatically penalize a flagged special cancellation", () => {
    const input = makeInput({ category: "retention", metCount: 0 });
    input.exceptionFlags.specialCancellation = true;
    const result = scoreAssessment(input);
    expect(result.criteria.every((criterion) => criterion.status !== "missed")).toBe(true);
    expect(result.criteria.every((criterion) => criterion.pointsEarned === null)).toBe(true);
    expect(result.totalPoints).toBeNull();
    expect(result.grade).toBeNull();
    expect(result.reviewReasons).toContain("unapproved_special_cancellation_exception");
  });
});
