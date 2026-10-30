import { prepareProvisionalAssessmentPersistence, type ProvisionalPersistencePreparation } from "./scoring-persistence.ts";
import type { RubricDefinition, ScoringInput } from "./types.ts";

type UnknownRecord = Record<string, unknown>;

export type M3ProvisionalCandidate = {
  call: {
    id: string;
    workspaceId: string;
    brand: string | null;
    category: string | null;
    status: string;
  };
  analysis: {
    id: string;
    callId: string;
    transcript: string | null;
    extractedFacts: unknown;
    qualityIndicators: unknown;
    reviewStatus: string;
    version: number;
  };
  rubric: unknown;
};

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function rubricFromDatabase(value: unknown): RubricDefinition | null {
  const row = record(value);
  const definition = record(row?.definition);
  const thresholds = record(definition?.thresholds);
  if (!row || !definition || !thresholds || definition.schema_version !== "m4.rubric.v1" ||
      typeof row.brand !== "string" || typeof row.category !== "string" ||
      typeof row.version !== "number" || typeof definition.rubric_id !== "string" ||
      typeof definition.max_points !== "number" || typeof thresholds.gold !== "number" ||
      typeof thresholds.green_minimum !== "number" ||
      (row.calibration_status !== "manual_calibration_required" && row.calibration_status !== "owner_approved") ||
      !Array.isArray(definition.criteria)) return null;

  const criteria = definition.criteria.flatMap((item): RubricDefinition["criteria"][number][] => {
    const criterion = record(item);
    if (!criterion || typeof criterion.id !== "string" || typeof criterion.label !== "string" ||
        typeof criterion.order !== "number" || criterion.weight !== 1 ||
        (criterion.applicability !== "always" && criterion.applicability !== "sales_objection" && criterion.applicability !== "retention_repeat") ||
        criterion.calibrationRequired !== true) return [];
    return [{
      id: criterion.id,
      label: criterion.label,
      order: criterion.order,
      weight: 1,
      applicability: criterion.applicability,
      calibrationRequired: true,
    }];
  });
  if (criteria.length !== definition.criteria.length) return null;

  return {
    id: definition.rubric_id,
    brand: row.brand as RubricDefinition["brand"],
    category: row.category as RubricDefinition["category"],
    version: row.version,
    maxPoints: definition.max_points,
    thresholds: { gold: thresholds.gold, greenMinimum: thresholds.green_minimum },
    calibrationStatus: row.calibration_status,
    criteria,
  };
}

function scoringInput(candidate: M3ProvisionalCandidate): ScoringInput | null {
  const facts = record(candidate.analysis.extractedFacts);
  const provenance = record(facts?.provenance);
  const quality = record(candidate.analysis.qualityIndicators);
  if (!facts || !provenance || !quality || candidate.call.status !== "review_required" ||
      candidate.analysis.reviewStatus !== "review_required" ||
      candidate.analysis.callId !== candidate.call.id ||
      provenance.provider !== "gemini" || provenance.schema_version !== "m3-transcript-v1" ||
      typeof provenance.model !== "string" ||
      quality.schema_version !== "m3-transcript-v1" || quality.source_completeness !== "unverified" ||
      quality.needs_human_review !== true) return null;

  return {
    call: {
      analysisId: candidate.analysis.id,
      workspaceId: candidate.call.workspaceId,
      brand: candidate.call.brand,
      companyConfirmed: candidate.call.brand === "abc" || candidate.call.brand === "noble_sales",
      conversationalIntent: candidate.call.category,
      intentValidated: false,
      telephoneMenuSelection: null,
    },
    analysis: {
      id: candidate.analysis.id,
      workspaceId: candidate.call.workspaceId,
      transcript: candidate.analysis.transcript,
      transcriptVersion: candidate.analysis.version,
      reviewStatus: candidate.analysis.reviewStatus,
      transcriptCompleteness: "unverified",
      speakerAttribution: "uncertain",
    },
    adjudication: {
      status: "unreviewed",
      adjudicatorId: null,
      reviewerRole: "unknown",
      wholeTranscriptReviewed: false,
    },
    observations: [],
    objectionState: "unknown",
    retentionRepeatApplicability: "uncertain",
    exceptionFlags: { specialCancellation: false },
  };
}

/** Convert a saved M3 database candidate into an all-withheld M4 payload. */
export function prepareM3ProvisionalAssessment(
  candidate: M3ProvisionalCandidate,
): ProvisionalPersistencePreparation {
  if (!candidate.call.id || !candidate.call.workspaceId || !candidate.analysis.id || !candidate.analysis.transcript?.trim()) {
    return { status: "not_persistable", reason: "saved_m3_candidate_required" };
  }
  const input = scoringInput(candidate);
  if (!input) return { status: "not_persistable", reason: "saved_unreviewed_m3_analysis_required" };
  const rubric = rubricFromDatabase(candidate.rubric);
  if (!rubric) return { status: "not_persistable", reason: "active_database_rubric_invalid" };
  return prepareProvisionalAssessmentPersistence(input, rubric);
}
