import { describe, expect, it } from "vitest";
import { DEFAULT_RUBRIC_REGISTRY } from "./rubrics";
import type { RubricDefinition, ScoringInput } from "./types";
import { prepareProvisionalAssessmentPersistence, prepareScorePersistence } from "./scoring-persistence";

const ANALYSIS_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REVIEWER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function makeInput(): ScoringInput {
  const rubric = DEFAULT_RUBRIC_REGISTRY["abc.sales"];
  const evidence = rubric.criteria.map((criterion) => `Synthetic evidence for ${criterion.id}.`);
  const transcript = evidence.map((quote) => `Agent: ${quote}`).join("\n");
  let cursor = 0;
  const observations = rubric.criteria
    .filter((criterion) => criterion.applicability !== "sales_objection")
    .map((criterion) => {
      const quote = evidence[criterion.order - 1];
      const start16 = transcript.indexOf(quote, cursor);
      const start = Array.from(transcript.slice(0, start16)).length;
      const end = start + Array.from(quote).length;
      cursor = start16 + quote.length;
      return {
        criterionId: criterion.id,
        status: "met" as const,
        rationale: "Synthetic human-validated observation.",
        evidenceReferences: [{
          kind: "transcript_span" as const,
          analysisId: ANALYSIS_ID,
          transcriptVersion: 1,
          start,
          end,
          quote,
          speaker: "agent" as const,
        }],
      };
    });

  return {
    call: {
      analysisId: ANALYSIS_ID,
      workspaceId: WORKSPACE_ID,
      brand: "abc",
      companyConfirmed: true,
      conversationalIntent: "sales",
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
      reviewerRole: "owner",
      wholeTranscriptReviewed: true,
    },
    observations,
    objectionState: "none_confirmed",
    retentionRepeatApplicability: "applicable",
    exceptionFlags: { specialCancellation: false },
  };
}

describe("scoring persistence preparation", () => {
  it("creates a versioned persistence request from the deterministic result", () => {
    const prepared = prepareScorePersistence(makeInput());
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;

    expect(prepared.payload.analysisId).toBe(ANALYSIS_ID);
    expect(prepared.payload.scoringVersion).toBe(1);
    expect(prepared.payload.rpcName).toBe("persist_m4_score");
    expect(prepared.payload.rubricVersionKey).toBe("abc.sales.v1");
    expect(prepared.payload.idempotencyKey).toBe(`${ANALYSIS_ID}:abc.sales.v1:engine-1`);
    expect(prepared.payload.calculation.totalPoints).toBeNull();
    expect(prepared.payload.calculation.grade).toBeNull();
    expect(prepared.payload.calculation.provisionalPoints).toBe(17);
    expect(prepared.payload.calculation.provisionalGrade).toBe("Gold");
    expect(prepared.payload.calculation.reviewRequired).toBe(true);
    expect(prepared.payload.calculation.reviewReasons).toContain("rubric_calibration_pending");
    expect(prepared.payload.calculation.criteria.filter((criterion) => criterion.status === "auto_awarded")).toHaveLength(4);
    expect(prepared.payload.evidenceReferences.every((entry) => entry.reference.analysisId === ANALYSIS_ID)).toBe(true);
  });

  it("applies official thresholds only with an explicitly approved isolated rubric fixture", () => {
    const approvedRubric = {
      ...DEFAULT_RUBRIC_REGISTRY["abc.sales"],
      calibrationStatus: "owner_approved",
    } as unknown as RubricDefinition;
    const prepared = prepareScorePersistence(makeInput(), approvedRubric);

    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(prepared.payload.calculation.totalPoints).toBe(17);
    expect(prepared.payload.calculation.grade).toBe("Gold");
    expect(prepared.payload.calculation.provisionalGrade).toBe("Gold");
    expect(prepared.payload.calculation.reviewRequired).toBe(false);
    expect(prepared.payload.calculation.reviewReasons).not.toContain("rubric_calibration_pending");
  });

  it("ignores caller-forged approval and point fields while the registered rubric is pending", () => {
    const forged = {
      ...makeInput(),
      calibrationStatus: "owner_approved",
      approved: true,
      points: 999,
    } as ScoringInput;
    const prepared = prepareScorePersistence(forged);

    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(prepared.payload.calculation.totalPoints).toBeNull();
    expect(prepared.payload.calculation.grade).toBeNull();
    expect(prepared.payload.calculation.provisionalPoints).toBe(17);
    expect(prepared.payload.calculation.reviewReasons).toContain("rubric_calibration_pending");
  });

  it("produces the same calculation and idempotency key for identical reviewed input", () => {
    const input = makeInput();
    const first = prepareScorePersistence(input);
    const second = prepareScorePersistence(input);
    expect(first).toEqual(second);
  });

  it("prepares a NULL-score review result when validated objection state is ambiguous", () => {
    const input = makeInput();
    input.objectionState = "ambiguous";
    const prepared = prepareScorePersistence(input);
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(prepared.payload.calculation.totalPoints).toBeNull();
    expect(prepared.payload.calculation.grade).toBeNull();
    expect(prepared.payload.calculation.reviewRequired).toBe(true);
  });

  it.each([
    ["unreviewed assessment", (input: ScoringInput) => { input.adjudication.status = "unreviewed"; }],
    ["unreviewed analysis", (input: ScoringInput) => { input.analysis.reviewStatus = "review_required"; }],
    ["unconfirmed company", (input: ScoringInput) => { input.call.companyConfirmed = false; }],
    ["unvalidated intent", (input: ScoringInput) => { input.call.intentValidated = false; }],
    ["partial call review", (input: ScoringInput) => { input.adjudication.wholeTranscriptReviewed = false; }],
    ["cross-workspace analysis", (input: ScoringInput) => { input.analysis.workspaceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; }],
  ])("refuses persistence for %s", (_name, change) => {
    const input = makeInput();
    change(input);
    expect(prepareScorePersistence(input).status).toBe("not_persistable");
  });

  it("does not prepare a record when company or conversational intent is unknown", () => {
    const input = makeInput();
    input.call.brand = "unknown";
    expect(prepareScorePersistence(input).status).toBe("not_persistable");
  });
});

describe("provisional M4 assessment persistence preparation", () => {
  function makeUnreviewedCandidate() {
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
    input.observations = [];
    return input;
  }

  it("prepares an all-withheld candidate assessment without an official score", () => {
    const prepared = prepareProvisionalAssessmentPersistence(makeUnreviewedCandidate());
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    expect(prepared.payload.rpcName).toBe("persist_m4_provisional_assessment");
    expect(prepared.payload.analysisId).toBe(ANALYSIS_ID);
    expect(prepared.payload.calculation.totalPoints).toBeNull();
    expect(prepared.payload.calculation.grade).toBeNull();
    expect(prepared.payload.calculation.provisionalPoints).toBe(0);
    expect(prepared.payload.calculation.provisionalGrade).toBeNull();
    expect(prepared.payload.calculation.reviewRequired).toBe(true);
    expect(prepared.payload.calculation.criteria.every((criterion) =>
      criterion.status === "insufficient_evidence" && criterion.pointsEarned === null && criterion.evidenceReferences.length === 0,
    )).toBe(true);
  });

  it.each([
    ["confirmed intent", (input: ScoringInput) => { input.call.intentValidated = true; }],
    ["reviewed analysis", (input: ScoringInput) => { input.analysis.reviewStatus = "reviewed"; }],
    ["missing source transcript", (input: ScoringInput) => { input.analysis.transcript = null; }],
    ["verified speakers", (input: ScoringInput) => { input.analysis.speakerAttribution = "verified"; }],
    ["human adjudication", (input: ScoringInput) => { input.adjudication.status = "human_validated"; }],
    ["unsupported brand", (input: ScoringInput) => { input.call.brand = "unknown"; }],
    ["cross-workspace source", (input: ScoringInput) => { input.analysis.workspaceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; }],
  ])("refuses provisional persistence for %s", (_name, change) => {
    const input = makeUnreviewedCandidate();
    change(input);
    expect(prepareProvisionalAssessmentPersistence(input).status).toBe("not_persistable");
  });
});
