import type { CriterionObservation, ObservationStatus, ScoringInput } from "./types.ts";

const observationStatuses = new Set<ObservationStatus>([
  "met",
  "missed",
  "insufficient_evidence",
  "not_applicable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown) {
  return value === null || typeof value === "string";
}

function isEvidenceReferenceContainer(value: unknown) {
  return Array.isArray(value) && value.every((reference) => reference === null || isRecord(reference));
}

function isObservation(value: unknown): value is CriterionObservation {
  return isRecord(value) &&
    typeof value.criterionId === "string" &&
    observationStatuses.has(value.status as ObservationStatus) &&
    typeof value.rationale === "string" &&
    isEvidenceReferenceContainer(value.evidenceReferences);
}

export function validateScoringInput(value: unknown): { valid: true; input: ScoringInput } | { valid: false } {
  if (!isRecord(value) || !isRecord(value.call) || !isRecord(value.analysis) ||
      !isRecord(value.adjudication) || !isRecord(value.exceptionFlags)) {
    return { valid: false };
  }

  const call = value.call;
  const analysis = value.analysis;
  const adjudication = value.adjudication;
  const exceptionFlags = value.exceptionFlags;
  const valid =
    typeof call.analysisId === "string" &&
    typeof call.workspaceId === "string" &&
    isNullableString(call.brand) &&
    typeof call.companyConfirmed === "boolean" &&
    isNullableString(call.conversationalIntent) &&
    typeof call.intentValidated === "boolean" &&
    (call.telephoneMenuSelection === undefined || isNullableString(call.telephoneMenuSelection)) &&
    typeof analysis.id === "string" &&
    typeof analysis.workspaceId === "string" &&
    isNullableString(analysis.transcript) &&
    typeof analysis.transcriptVersion === "number" &&
    typeof analysis.reviewStatus === "string" &&
    ["verified", "partial", "unverified", "missing"].includes(String(analysis.transcriptCompleteness)) &&
    ["verified", "uncertain"].includes(String(analysis.speakerAttribution)) &&
    ["human_validated", "unreviewed"].includes(String(adjudication.status)) &&
    isNullableString(adjudication.adjudicatorId) &&
    ["owner", "reviewer", "member", "unknown"].includes(String(adjudication.reviewerRole)) &&
    typeof adjudication.wholeTranscriptReviewed === "boolean" &&
    Array.isArray(value.observations) &&
    value.observations.every(isObservation) &&
    ["none_confirmed", "present", "ambiguous", "unknown"].includes(String(value.objectionState)) &&
    ["applicable", "not_applicable", "uncertain"].includes(String(value.retentionRepeatApplicability)) &&
    typeof exceptionFlags.specialCancellation === "boolean";

  return valid ? { valid: true, input: value as unknown as ScoringInput } : { valid: false };
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

