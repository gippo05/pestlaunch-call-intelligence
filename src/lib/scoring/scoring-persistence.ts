import { scoreAssessment } from "./scoring-engine.ts";
import { selectRubric } from "./rubrics.ts";
import { isUuid } from "./input-validation.ts";
import type { EvidenceReference, RubricDefinition, ScoringInput, ScoringResult } from "./types.ts";

export const PERSIST_M4_SCORE_RPC = "persist_m4_score";
export const PERSIST_M4_PROVISIONAL_ASSESSMENT_RPC = "persist_m4_provisional_assessment";

export type PreparedScorePersistence = {
  rpcName: typeof PERSIST_M4_SCORE_RPC;
  analysisId: string;
  scoringVersion: number;
  rubricVersionKey: string;
  idempotencyKey: string;
  calculation: ScoringResult;
  evidenceReferences: Array<{ criterionId: string; reference: EvidenceReference }>;
};

export type PersistencePreparation =
  | { status: "prepared"; payload: PreparedScorePersistence }
  | { status: "not_persistable"; reason: string };

export type PreparedProvisionalAssessmentPersistence = {
  rpcName: typeof PERSIST_M4_PROVISIONAL_ASSESSMENT_RPC;
  analysisId: string;
  scoringVersion: number;
  rubricVersionKey: string;
  idempotencyKey: string;
  calculation: ScoringResult;
};

export type ProvisionalPersistencePreparation =
  | { status: "prepared"; payload: PreparedProvisionalAssessmentPersistence }
  | { status: "not_persistable"; reason: string };

function hasAuthorizedValidatedSource(input: ScoringInput) {
  return input.call.analysisId === input.analysis.id &&
    isUuid(input.call.analysisId) &&
    isUuid(input.call.workspaceId) &&
    isUuid(input.analysis.id) &&
    isUuid(input.analysis.workspaceId) &&
    input.call.workspaceId === input.analysis.workspaceId &&
    input.analysis.reviewStatus === "reviewed" &&
    input.analysis.transcriptCompleteness === "verified" &&
    input.analysis.speakerAttribution === "verified" &&
    Boolean(input.analysis.transcript?.trim()) &&
    Number.isSafeInteger(input.analysis.transcriptVersion) &&
    input.analysis.transcriptVersion > 0 &&
    input.call.companyConfirmed &&
    input.call.intentValidated &&
    input.adjudication.status === "human_validated" &&
    input.adjudication.wholeTranscriptReviewed &&
    isUuid(input.adjudication.adjudicatorId) &&
    (input.adjudication.reviewerRole === "owner" || input.adjudication.reviewerRole === "reviewer");
}

/**
 * `trustedRubric` is loaded by server code from the protected rubric_versions
 * row. Client supplied approval flags are never accepted; persist_m4_score
 * independently enforces the database calibration state.
 */
export function prepareScorePersistence(
  input: ScoringInput,
  trustedRubric?: RubricDefinition,
): PersistencePreparation {
  const selection = selectRubric(input);
  if (!selection.rubric) {
    return { status: "not_persistable", reason: selection.reviewReasons[0] ?? "rubric_unresolved" };
  }
  if (!hasAuthorizedValidatedSource(input)) {
    return { status: "not_persistable", reason: "authorized_validated_source_required" };
  }

  const calculation = scoreAssessment(input, trustedRubric ?? selection.rubric);
  if (!calculation.rubric) {
    return { status: "not_persistable", reason: "approved_rubric_required" };
  }

  const rubricVersionKey = `${calculation.rubric.id}`;
  const evidenceReferences = calculation.criteria.flatMap((criterion) =>
    criterion.evidenceReferences.map((reference) => ({ criterionId: criterion.id, reference })),
  );

  return {
    status: "prepared",
    payload: {
      rpcName: PERSIST_M4_SCORE_RPC,
      analysisId: input.analysis.id,
      scoringVersion: calculation.scoringEngineVersion,
      rubricVersionKey,
      idempotencyKey: `${input.analysis.id}:${rubricVersionKey}:engine-${calculation.scoringEngineVersion}`,
      calculation,
      evidenceReferences,
    },
  };
}

function hasUnreviewedCandidateSource(input: ScoringInput) {
  return input.call.analysisId === input.analysis.id &&
    isUuid(input.call.analysisId) &&
    isUuid(input.call.workspaceId) &&
    isUuid(input.analysis.id) &&
    isUuid(input.analysis.workspaceId) &&
    input.call.workspaceId === input.analysis.workspaceId &&
    input.call.companyConfirmed &&
    !input.call.intentValidated &&
    input.analysis.reviewStatus === "review_required" &&
    input.analysis.transcriptCompleteness !== "verified" &&
    input.analysis.transcriptCompleteness !== "missing" &&
    input.analysis.speakerAttribution === "uncertain" &&
    Boolean(input.analysis.transcript?.trim()) &&
    Number.isSafeInteger(input.analysis.transcriptVersion) &&
    input.analysis.transcriptVersion > 0 &&
    input.adjudication.status === "unreviewed" &&
    input.adjudication.adjudicatorId === null &&
    input.adjudication.reviewerRole === "unknown" &&
    !input.adjudication.wholeTranscriptReviewed &&
    input.observations.length === 0 &&
    !input.exceptionFlags.specialCancellation;
}

/** Prepare only an all-withheld assessment for a saved, unreviewed M3 candidate. */
export function prepareProvisionalAssessmentPersistence(
  input: ScoringInput,
  trustedRubric?: RubricDefinition,
): ProvisionalPersistencePreparation {
  if (!hasUnreviewedCandidateSource(input)) {
    return { status: "not_persistable", reason: "unreviewed_candidate_source_required" };
  }

  const selection = selectRubric(input);
  if (!selection.rubric) {
    return { status: "not_persistable", reason: selection.reviewReasons[0] ?? "rubric_unresolved" };
  }
  const calculation = scoreAssessment(input, trustedRubric ?? selection.rubric);
  if (!calculation.rubric || !calculation.reviewRequired ||
      calculation.totalPoints !== null || calculation.grade !== null ||
      calculation.provisionalPoints !== 0 || calculation.provisionalGrade !== null ||
      calculation.criteria.length !== calculation.maxPoints ||
      calculation.criteria.some((criterion) => criterion.status !== "insufficient_evidence" ||
        criterion.pointsEarned !== null || criterion.evidenceReferences.length !== 0)) {
    return { status: "not_persistable", reason: "all_withheld_provisional_assessment_required" };
  }

  const rubricVersionKey = calculation.rubric.id;
  return {
    status: "prepared",
    payload: {
      rpcName: PERSIST_M4_PROVISIONAL_ASSESSMENT_RPC,
      analysisId: input.analysis.id,
      scoringVersion: calculation.scoringEngineVersion,
      rubricVersionKey,
      idempotencyKey: `${input.analysis.id}:${rubricVersionKey}:engine-${calculation.scoringEngineVersion}:provisional`,
      calculation,
    },
  };
}

