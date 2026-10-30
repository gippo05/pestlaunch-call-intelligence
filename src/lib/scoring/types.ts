export type CallBrand = "abc" | "noble_sales";
export type CallCategory = "sales" | "general_office" | "retention";

export type CriterionStatus =
  | "met"
  | "missed"
  | "auto_awarded"
  | "insufficient_evidence"
  | "not_applicable";

export type ObservationStatus = Exclude<CriterionStatus, "auto_awarded">;

export type TranscriptSpanReference = {
  kind: "transcript_span";
  analysisId: string;
  transcriptVersion: number;
  start: number;
  end: number;
  quote: string;
  speaker: "agent" | "caller" | "unknown";
};

export type FullTranscriptReviewReference = {
  kind: "full_transcript_review";
  analysisId: string;
  transcriptVersion: number;
  scope: "complete_call";
  adjudicatorId: string;
};

export type EvidenceReference = TranscriptSpanReference | FullTranscriptReviewReference;

export type CriterionObservation = {
  criterionId: string;
  status: ObservationStatus;
  rationale: string;
  evidenceReferences: EvidenceReference[];
};

export type RubricCriterion = {
  id: string;
  label: string;
  order: number;
  weight: 1;
  applicability: "always" | "sales_objection" | "retention_repeat";
  calibrationRequired: true;
};

export type RubricDefinition = {
  id: string;
  brand: CallBrand;
  category: CallCategory;
  version: number;
  maxPoints: number;
  thresholds: {
    gold: number;
    greenMinimum: number;
  };
  calibrationStatus: "manual_calibration_required" | "owner_approved";
  criteria: readonly RubricCriterion[];
};

export type ScoringInput = {
  call: {
    analysisId: string;
    workspaceId: string;
    brand: string | null;
    companyConfirmed: boolean;
    conversationalIntent: string | null;
    intentValidated: boolean;
    telephoneMenuSelection?: string | null;
  };
  analysis: {
    id: string;
    workspaceId: string;
    transcript: string | null;
    transcriptVersion: number;
    reviewStatus: string;
    transcriptCompleteness: "verified" | "partial" | "unverified" | "missing";
    speakerAttribution: "verified" | "uncertain";
  };
  adjudication: {
    status: "human_validated" | "unreviewed";
    adjudicatorId: string | null;
    reviewerRole: "owner" | "reviewer" | "member" | "unknown";
    wholeTranscriptReviewed: boolean;
  };
  observations: CriterionObservation[];
  objectionState: "none_confirmed" | "present" | "ambiguous" | "unknown";
  retentionRepeatApplicability: "applicable" | "not_applicable" | "uncertain";
  exceptionFlags: {
    specialCancellation: boolean;
  };
};

export type ScoringGrade = "Gold" | "Green" | "Below Standard";

export type CriterionResult = {
  id: string;
  label: string;
  order: number;
  status: CriterionStatus;
  pointsEarned: number | null;
  pointsPossible: number;
  evidenceReferences: EvidenceReference[];
  rationale: string;
};

export type ScoringResult = {
  schemaVersion: "m4.score-result.v1";
  scoringEngineVersion: number;
  rubric: {
    id: string;
    brand: CallBrand;
    category: CallCategory;
    version: number;
    calibrationStatus: "manual_calibration_required" | "owner_approved";
  } | null;
  criteria: CriterionResult[];
  /** Null means an official point total is withheld pending human review. */
  totalPoints: number | null;
  /** Known points only; never an official grade when review is required. */
  provisionalPoints: number;
  /** Threshold classification of a complete calculation; always provisional until calibration is approved. */
  provisionalGrade: ScoringGrade | null;
  maxPoints: number;
  grade: ScoringGrade | null;
  reviewRequired: boolean;
  reviewReasons: string[];
  assessmentContext: {
    analysisId: string;
    workspaceId: string;
    brand: string | null;
    category: string | null;
    companyConfirmed: boolean;
    intentValidated: boolean;
    telephoneMenuSelection: string | null;
    analysisReviewStatus: string;
    transcriptVersion: number;
    transcriptCompleteness: string;
    speakerAttribution: string;
    adjudicationStatus: string;
    adjudicatorId: string | null;
    reviewerRole: string;
    wholeTranscriptReviewed: boolean;
    objectionState: string;
    retentionRepeatApplicability: string;
    exceptionFlags: { specialCancellation: boolean };
  };
};

