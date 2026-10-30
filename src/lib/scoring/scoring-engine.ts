import { selectRubric, DEFAULT_RUBRIC_REGISTRY } from "./rubrics.ts";
import { isUuid, validateScoringInput } from "./input-validation.ts";
import type {
  CallBrand,
  CallCategory,
  CriterionObservation,
  CriterionResult,
  EvidenceReference,
  RubricDefinition,
  ScoringGrade,
  ScoringInput,
  ScoringResult,
} from "./types.ts";

export const SCORING_ENGINE_VERSION = 1;

function unique(values: string[]) {
  return [...new Set(values)];
}

function rubricMatches(left: RubricDefinition, right: RubricDefinition) {
  return left.id === right.id &&
    left.brand === right.brand &&
    left.category === right.category &&
    left.version === right.version &&
    left.maxPoints === right.maxPoints &&
    left.thresholds.gold === right.thresholds.gold &&
    left.thresholds.greenMinimum === right.thresholds.greenMinimum &&
    left.criteria.length === right.criteria.length &&
    left.criteria.every((criterion, index) => {
      const expected = right.criteria[index];
      return criterion.id === expected.id &&
        criterion.label === expected.label &&
        criterion.order === expected.order &&
        criterion.weight === expected.weight &&
        criterion.applicability === expected.applicability &&
        criterion.calibrationRequired === expected.calibrationRequired;
    });
}

function isAuthorizedReviewer(input: ScoringInput) {
  return input.adjudication.status === "human_validated" &&
    isUuid(input.adjudication.adjudicatorId) &&
    (input.adjudication.reviewerRole === "owner" || input.adjudication.reviewerRole === "reviewer");
}

function getSourceReviewReasons(input: ScoringInput) {
  const reasons: string[] = [];
  if (!isUuid(input.call.analysisId) || !isUuid(input.analysis.id) ||
      !isUuid(input.call.workspaceId) || !isUuid(input.analysis.workspaceId)) {
    reasons.push("analysis_identity_invalid");
  }
  if (input.call.analysisId !== input.analysis.id || input.call.workspaceId !== input.analysis.workspaceId) {
    reasons.push("analysis_scope_mismatch");
  }
  if (!input.analysis.transcript?.trim() || input.analysis.transcriptCompleteness === "missing") {
    reasons.push("transcript_missing");
  } else if (input.analysis.transcriptCompleteness !== "verified") {
    reasons.push("transcript_completeness_unverified");
  }
  if (input.analysis.reviewStatus !== "reviewed") reasons.push("analysis_not_human_reviewed");
  if (input.analysis.speakerAttribution !== "verified") reasons.push("speaker_attribution_unverified");
  if (input.adjudication.status !== "human_validated") reasons.push("adjudication_unreviewed");
  if (!isAuthorizedReviewer(input)) reasons.push("reviewer_not_authorized");
  if (!input.adjudication.wholeTranscriptReviewed) reasons.push("whole_transcript_not_reviewed");
  if (!Number.isSafeInteger(input.analysis.transcriptVersion) || input.analysis.transcriptVersion < 1) {
    reasons.push("transcript_version_invalid");
  }
  return reasons;
}

function codePointSlice(value: string, start: number, end: number) {
  return Array.from(value).slice(start, end).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvidenceReferenceValid(reference: EvidenceReference | unknown, input: ScoringInput) {
  if (!isRecord(reference) || typeof reference.analysisId !== "string" ||
      typeof reference.transcriptVersion !== "number") return false;
  if (reference.analysisId !== input.analysis.id || reference.transcriptVersion !== input.analysis.transcriptVersion) {
    return false;
  }

  if (reference.kind === "full_transcript_review") {
    return reference.scope === "complete_call" &&
      typeof reference.adjudicatorId === "string" &&
      reference.adjudicatorId === input.adjudication.adjudicatorId &&
      input.adjudication.wholeTranscriptReviewed &&
      isAuthorizedReviewer(input);
  }
  if (reference.kind !== "transcript_span") return false;

  const transcript = input.analysis.transcript;
  return Boolean(transcript) &&
    reference.speaker === "agent" &&
    typeof reference.quote === "string" &&
    typeof reference.start === "number" &&
    typeof reference.end === "number" &&
    Number.isSafeInteger(reference.start) &&
    Number.isSafeInteger(reference.end) &&
    reference.start >= 0 &&
    reference.end > reference.start &&
    reference.end <= Array.from(transcript ?? "").length &&
    reference.quote.trim().length > 0 &&
    codePointSlice(transcript ?? "", reference.start, reference.end) === reference.quote;
}

function validateObservationEvidence(observation: CriterionObservation, input: ScoringInput) {
  const references = observation.evidenceReferences;
  if (!Array.isArray(references) || references.length === 0) return false;
  if (!references.every((reference) => isEvidenceReferenceValid(reference, input))) return false;
  return references.some((reference) => reference.kind === "transcript_span");
}

function criterionResult(
  definition: RubricDefinition["criteria"][number],
  status: CriterionResult["status"],
  pointsEarned: number | null,
  evidenceReferences: EvidenceReference[],
  rationale: string,
): CriterionResult {
  return {
    id: definition.id,
    label: definition.label,
    order: definition.order,
    status,
    pointsEarned,
    pointsPossible: definition.weight,
    evidenceReferences,
    rationale,
  };
}

function scoreObservedCriterion(
  definition: RubricDefinition["criteria"][number],
  observations: CriterionObservation[],
  input: ScoringInput,
  reviewReasons: string[],
): CriterionResult {
  const matching = observations.filter((observation) => observation.criterionId === definition.id);
  if (matching.length === 0) {
    reviewReasons.push(`observation_missing:${definition.id}`);
    return criterionResult(definition, "insufficient_evidence", null, [], "No validated observation was supplied; this is not treated as a proven failure.");
  }
  if (matching.length !== 1) {
    reviewReasons.push(`duplicate_observations:${definition.id}`);
    return criterionResult(definition, "insufficient_evidence", null, [], "Multiple observations conflict or duplicate this criterion; human review is required.");
  }

  const observation = matching[0];
  if (observation.status === "insufficient_evidence") {
    reviewReasons.push(`observation_insufficient:${definition.id}`);
    const validReferences = observation.evidenceReferences.filter((reference) => isEvidenceReferenceValid(reference, input));
    return criterionResult(definition, "insufficient_evidence", null, validReferences, observation.rationale.trim() || "The available evidence does not support a point decision.");
  }
  if (observation.status === "not_applicable") {
    reviewReasons.push(`criterion_not_applicable_without_policy:${definition.id}`);
    return criterionResult(definition, "insufficient_evidence", null, [], "No approved policy defines a not-applicable point treatment for this criterion.");
  }
  if (!observation.rationale.trim() || !validateObservationEvidence(observation, input)) {
    reviewReasons.push(`unsupported_evidence:${definition.id}`);
    return criterionResult(definition, "insufficient_evidence", null, [], "The observation lacks a grounded agent excerpt from this reviewed transcript.");
  }

  const references = [...observation.evidenceReferences];
  return criterionResult(
    definition,
    observation.status,
    observation.status === "met" ? definition.weight : 0,
    references,
    observation.rationale.trim(),
  );
}

function buildAssessmentContext(input: ScoringInput, category: CallCategory | null) {
  return {
    analysisId: input.analysis.id,
    workspaceId: input.analysis.workspaceId,
    brand: input.call.brand,
    category,
    companyConfirmed: input.call.companyConfirmed,
    intentValidated: input.call.intentValidated,
    telephoneMenuSelection: input.call.telephoneMenuSelection ?? null,
    analysisReviewStatus: input.analysis.reviewStatus,
    transcriptVersion: input.analysis.transcriptVersion,
    transcriptCompleteness: input.analysis.transcriptCompleteness,
    speakerAttribution: input.analysis.speakerAttribution,
    adjudicationStatus: input.adjudication.status,
    adjudicatorId: input.adjudication.adjudicatorId,
    reviewerRole: input.adjudication.reviewerRole,
    wholeTranscriptReviewed: input.adjudication.wholeTranscriptReviewed,
    objectionState: input.objectionState,
    retentionRepeatApplicability: input.retentionRepeatApplicability,
    exceptionFlags: { specialCancellation: input.exceptionFlags.specialCancellation },
  };
}

function notScoredResult(input: ScoringInput, reasons: string[]): ScoringResult {
  return {
    schemaVersion: "m4.score-result.v1",
    scoringEngineVersion: SCORING_ENGINE_VERSION,
    rubric: null,
    criteria: [],
    totalPoints: null,
    provisionalPoints: 0,
    provisionalGrade: null,
    maxPoints: 0,
    grade: null,
    reviewRequired: true,
    reviewReasons: unique(reasons),
    assessmentContext: buildAssessmentContext(input, null),
  };
}

function calculateGrade(rubric: RubricDefinition, points: number): ScoringGrade {
  if (points >= rubric.thresholds.gold) return "Gold";
  if (points >= rubric.thresholds.greenMinimum) return "Green";
  return "Below Standard";
}

function buildCriterionResult(
  definition: RubricDefinition["criteria"][number],
  input: ScoringInput,
  sourceSafe: boolean,
  reviewReasons: string[],
): CriterionResult {
  if (!sourceSafe) {
    return criterionResult(definition, "insufficient_evidence", null, [], "The source or assessment is not fully reviewed; no point decision is made.");
  }
  if (input.exceptionFlags.specialCancellation) {
    const observation = input.observations.find((candidate) => candidate.criterionId === definition.id);
    const references = observation?.evidenceReferences.filter((reference) => isEvidenceReferenceValid(reference, input)) ?? [];
    return criterionResult(definition, "insufficient_evidence", null, references, "A special cancellation exception is flagged without an approved scoring policy; no point decision is made.");
  }

  if (definition.applicability === "sales_objection") {
    if (input.objectionState === "none_confirmed") {
      const reviewReference: EvidenceReference = {
        kind: "full_transcript_review",
        analysisId: input.analysis.id,
        transcriptVersion: input.analysis.transcriptVersion,
        scope: "complete_call",
        adjudicatorId: input.adjudication.adjudicatorId!,
      };
      return criterionResult(
        definition,
        "auto_awarded",
        definition.weight,
        [reviewReference],
        "The human reviewer confirmed no objection across the complete transcript; this conditional point is auto-awarded.",
      );
    }
    if (input.objectionState !== "present") {
      reviewReasons.push("objection_state_unresolved");
      const reviewReference: EvidenceReference = {
        kind: "full_transcript_review",
        analysisId: input.analysis.id,
        transcriptVersion: input.analysis.transcriptVersion,
        scope: "complete_call",
        adjudicatorId: input.adjudication.adjudicatorId!,
      };
      return criterionResult(definition, "insufficient_evidence", null, [reviewReference], "Objection presence is unresolved; this conditional point is neither awarded nor deducted.");
    }
  }

  if (definition.applicability === "retention_repeat") {
    if (input.retentionRepeatApplicability === "not_applicable") {
      reviewReasons.push("retention_repeat_na_policy_unapproved");
      const reviewReference: EvidenceReference = {
        kind: "full_transcript_review",
        analysisId: input.analysis.id,
        transcriptVersion: input.analysis.transcriptVersion,
        scope: "complete_call",
        adjudicatorId: input.adjudication.adjudicatorId!,
      };
      return criterionResult(definition, "not_applicable", null, [reviewReference], "Applicability is resolved, but the rubric has no approved N/A point treatment.");
    }
    if (input.retentionRepeatApplicability !== "applicable") {
      reviewReasons.push("retention_repeat_applicability_uncertain");
      const reviewReference: EvidenceReference = {
        kind: "full_transcript_review",
        analysisId: input.analysis.id,
        transcriptVersion: input.analysis.transcriptVersion,
        scope: "complete_call",
        adjudicatorId: input.adjudication.adjudicatorId!,
      };
      return criterionResult(definition, "insufficient_evidence", null, [reviewReference], "Whether a repeat was necessary is unresolved.");
    }
  }

  return scoreObservedCriterion(definition, input.observations, input, reviewReasons);
}

export function scoreAssessment(input: ScoringInput, rubricOverride?: RubricDefinition): ScoringResult {
  if (!validateScoringInput(input).valid) {
    return {
      schemaVersion: "m4.score-result.v1",
      scoringEngineVersion: SCORING_ENGINE_VERSION,
      rubric: null,
      criteria: [],
      totalPoints: null,
      provisionalPoints: 0,
      provisionalGrade: null,
      maxPoints: 0,
      grade: null,
      reviewRequired: true,
      reviewReasons: ["scoring_input_invalid"],
      assessmentContext: {
        analysisId: "",
        workspaceId: "",
        brand: null,
        category: null,
        companyConfirmed: false,
        intentValidated: false,
        telephoneMenuSelection: null,
        analysisReviewStatus: "unknown",
        transcriptVersion: 0,
        transcriptCompleteness: "missing",
        speakerAttribution: "uncertain",
        adjudicationStatus: "unreviewed",
        adjudicatorId: null,
        reviewerRole: "unknown",
        wholeTranscriptReviewed: false,
        objectionState: "unknown",
        retentionRepeatApplicability: "uncertain",
        exceptionFlags: { specialCancellation: false },
      },
    };
  }

  const selection = selectRubric(input);
  if (!selection.rubric) return notScoredResult(input, selection.reviewReasons);

  const rubric = rubricOverride ?? selection.rubric;
  const approvedRubric = DEFAULT_RUBRIC_REGISTRY[`${rubric.brand}.${rubric.category}` as keyof typeof DEFAULT_RUBRIC_REGISTRY];
  if (
    rubric.brand !== selection.rubric.brand ||
    rubric.category !== selection.rubric.category ||
    !approvedRubric ||
    !rubricMatches(rubric, approvedRubric) ||
    (rubric.calibrationStatus !== "manual_calibration_required" && rubric.calibrationStatus !== "owner_approved")
  ) {
    return notScoredResult(input, ["rubric_classification_mismatch"]);
  }

  const reviewReasons = [...selection.reviewReasons, ...getSourceReviewReasons(input)];
  if (input.exceptionFlags.specialCancellation) reviewReasons.push("unapproved_special_cancellation_exception");
  const sourceSafe = reviewReasons.length === 0;

  for (const observation of input.observations) {
    if (!rubric.criteria.some((criterion) => criterion.id === observation.criterionId)) {
      reviewReasons.push(`unsupported_observation:${observation.criterionId}`);
    }
  }

  const criteria = rubric.criteria.map((definition) =>
    buildCriterionResult(definition, input, sourceSafe, reviewReasons),
  );
  const provisionalPoints = criteria.reduce((sum, criterion) => sum + (criterion.pointsEarned ?? 0), 0);
  const complete = criteria.every((criterion) => criterion.pointsEarned !== null);
  const provisionalGrade = complete ? calculateGrade(rubric, provisionalPoints) : null;
  if (rubric.calibrationStatus !== "owner_approved") reviewReasons.push("rubric_calibration_pending");
  const finalReviewReasons = unique(reviewReasons);
  const reviewRequired = finalReviewReasons.length > 0;
  const totalPoints = rubric.calibrationStatus === "owner_approved" && !reviewRequired && complete
    ? provisionalPoints
    : null;
  const category = input.call.conversationalIntent as CallCategory;
  const brand = input.call.brand as CallBrand;

  return {
    schemaVersion: "m4.score-result.v1",
    scoringEngineVersion: SCORING_ENGINE_VERSION,
    rubric: {
      id: rubric.id,
      brand,
      category,
      version: rubric.version,
      calibrationStatus: rubric.calibrationStatus,
    },
    criteria,
    totalPoints,
    provisionalPoints,
    provisionalGrade,
    maxPoints: rubric.maxPoints,
    grade: totalPoints === null ? null : provisionalGrade,
    reviewRequired,
    reviewReasons: finalReviewReasons,
    assessmentContext: buildAssessmentContext(input, category),
  };
}

