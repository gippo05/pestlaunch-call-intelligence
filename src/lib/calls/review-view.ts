import type { ScoringGrade } from "@/lib/scoring/types";

export const CALL_PAGE_SIZE = 25;

export const callCategories = ["sales", "general_office", "retention"] as const;
export const callStatuses = ["uploaded", "queued", "processing", "completed", "failed", "review_required", "test_completed"] as const;
export const callStatusFilters = [...callStatuses, "needs_review"] as const;

export type CallCategoryValue = (typeof callCategories)[number];
export type CallStatusValue = (typeof callStatuses)[number];
export type CallStatusFilter = (typeof callStatusFilters)[number];
export type CallBrandValue = "abc" | "noble_sales";
export type CallSort = "newest" | "oldest";

export type CallLibraryFilters = {
  search: string;
  brand: CallBrandValue | "";
  category: CallCategoryValue | "";
  status: CallStatusFilter | "";
  sort: CallSort;
  page: number;
};

export type SearchParams = Record<string, string | string[] | undefined>;

export type ScoreCalibration = "manual_calibration_required" | "owner_approved" | null;

export type ScoreSummary = {
  totalScore: number | string | null;
  grade: string | null;
  requiresHumanReview: boolean;
  analysisReviewStatus: string | null;
  categoryMatches: boolean;
  calibrationStatus: ScoreCalibration;
  criterionResults: unknown;
};

export type TranscriptEvidence = {
  criterionId: string;
  start: number;
  end: number;
  quote: string;
};

export type TranscriptLocation = TranscriptEvidence & { anchorId: string };

export type CoachingAction = {
  criterionId: string;
  criterionLabel: string;
  category: string;
  observedBehavior: string;
  evidence: TranscriptEvidence;
  whyItMatters: string;
  recommendedImprovement: string;
  reviewState: "human-reviewed evidence";
};

export type CoachingView = {
  state: "available" | "unavailable";
  message: string | null;
  actions: CoachingAction[];
};

export type ProvisionalCoachingPrompt = {
  kind: "concern" | "outcome" | "strength" | "review_opportunity";
  claim: string;
  prompt: string;
  evidence: TranscriptEvidence;
  reviewState: "provisional human review required";
};

export type ProvisionalCoachingView = {
  state: "available" | "unavailable";
  message: string | null;
  prompts: ProvisionalCoachingPrompt[];
};

export type CriterionView = {
  id: string;
  label: string;
  order: number;
  status: string;
  pointsEarned: number | null;
  pointsPossible: number;
  rationale: string;
  evidenceReferences: Array<Record<string, unknown>>;
};

export type ScoreView = {
  official: boolean;
  officialGrade: ScoringGrade | null;
  officialPoints: number | null;
  calibrationPending: boolean;
  provisionalPoints: number | null;
  provisionalGrade: ScoringGrade | null;
  maxPoints: number | null;
  reviewReasons: string[];
  criteria: CriterionView[];
};

const categoryLabels: Record<string, string> = {
  sales: "Sales",
  general_office: "General Office",
  retention: "Retention",
};

const statusLabels: Record<string, string> = {
  uploaded: "Uploaded",
  queued: "Queued · awaiting processing",
  processing: "Processing",
  completed: "Analysis saved · review status varies",
  failed: "Processing failed",
  review_required: "Needs human review",
  test_completed: "Synthetic test complete",
};

const coachingTemplates: Record<string, { category: string; why: string; recommendation: string }> = {
  validation: {
    category: "Missed validation",
    why: "Validating the caller's situation helps the agent respond to the need they actually raised.",
    recommendation: "Acknowledge the caller's stated concern and confirm the key detail before moving to a solution.",
  },
  investigation: {
    category: "Insufficient investigation",
    why: "Relevant questions help establish the circumstances needed for an accurate response.",
    recommendation: "Ask a focused follow-up question, then summarize the answer before recommending a next step.",
  },
  expectation: {
    category: "Weak expectation setting",
    why: "Clear expectations help the caller understand what will happen and what information may still be needed.",
    recommendation: "State the next step and its expected timing in plain language, then check that the caller understands.",
  },
  conclusion: {
    category: "Missing conclusion",
    why: "A clear close gives the caller a chance to resolve remaining questions before the conversation ends.",
    recommendation: "Recap the agreed next step and ask whether the caller needs any other information.",
  },
  objection: {
    category: "Incomplete objection handling",
    why: "Addressing the caller's stated objection can clarify whether the proposed next step meets their concern.",
    recommendation: "Restate the concern, respond to it directly, and confirm whether the response resolves it before closing.",
  },
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function sanitizeCallSearch(value: string | undefined) {
  return (value ?? "")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\\%_]/g, "")
    .trim()
    .slice(0, 80);
}

export function parseCallLibraryFilters(params: SearchParams): CallLibraryFilters {
  const rawBrand = first(params.company);
  const rawCategory = first(params.category);
  const rawStatus = first(params.status);
  const rawSort = first(params.sort);
  const rawPage = Number.parseInt(first(params.page) ?? "1", 10);

  return {
    search: sanitizeCallSearch(first(params.q)),
    brand: rawBrand === "abc" || rawBrand === "noble_sales" ? rawBrand : "",
    category: callCategories.includes(rawCategory as CallCategoryValue) ? rawCategory as CallCategoryValue : "",
    status: callStatusFilters.includes(rawStatus as CallStatusFilter) ? rawStatus as CallStatusFilter : "",
    sort: rawSort === "oldest" ? "oldest" : "newest",
    page: Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 1000) : 1,
  };
}

export function callPageHref(filters: CallLibraryFilters, page: number) {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.brand) params.set("company", filters.brand);
  if (filters.category) params.set("category", filters.category);
  if (filters.status) params.set("status", filters.status);
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/calls?${query}` : "/calls";
}

export function companyLabel(value: string | null | undefined) {
  if (value === "abc") return "ABC";
  if (value === "noble_sales") return "Noble Sales";
  return "Company unavailable";
}

export function categoryLabel(value: string | null | undefined) {
  return value && categoryLabels[value] ? categoryLabels[value] : "Unclassified";
}

export function callStatusLabel(value: string | null | undefined) {
  return value && statusLabels[value] ? statusLabels[value] : "Status unavailable";
}

export function safeFilename(value: string | null | undefined) {
  const cleaned = (value ?? "").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return cleaned || "Untitled call";
}

export function formatCallDuration(value: number | null | undefined) {
  if (!Number.isSafeInteger(value) || value === null || value === undefined || value < 0) return "Unknown duration";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatCallDate(value: string | null | undefined) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

export function needsHumanReview(
  callStatus: string,
  analysisReviewStatus: string | null,
  scores: Array<{ requiresHumanReview: boolean }>,
) {
  if (callStatus === "failed" || callStatus === "review_required") return true;
  if (analysisReviewStatus !== null && analysisReviewStatus !== "reviewed") return true;
  return scores.some((score) => score.requiresHumanReview);
}

export type ApplicableScoreCandidate = {
  analysisId: string;
  brand: string;
  category: string;
  rubricVersion: number;
  createdAt: string;
};

export function selectApplicableScore<T>(
  rows: ReadonlyArray<T>,
  identify: (row: T) => ApplicableScoreCandidate | null,
  analysisId: string,
  brand: string,
  callCategory: string | null,
): T | null {
  const identified = rows.flatMap((row) => {
    const candidate = identify(row);
    return candidate && candidate.analysisId === analysisId && candidate.brand === brand ? [{ row, candidate }] : [];
  });
  const exact = callCategory ? identified.filter(({ candidate }) => candidate.category === callCategory) : [];
  const categories = new Set(identified.map(({ candidate }) => candidate.category));
  const applicable = exact.length > 0 ? exact : categories.size === 1 ? identified : [];
  applicable.sort((left, right) => right.candidate.rubricVersion - left.candidate.rubricVersion || Date.parse(right.candidate.createdAt) - Date.parse(left.candidate.createdAt));
  return applicable[0]?.row ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCriteria(value: unknown): CriterionView[] {
  if (!isRecord(value) || !Array.isArray(value.criteria)) return [];
  return value.criteria.flatMap((item): CriterionView[] => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.label !== "string" ||
      typeof item.order !== "number" || typeof item.status !== "string" ||
      typeof item.pointsPossible !== "number" || typeof item.rationale !== "string") return [];
    return [{
      id: item.id,
      label: item.label,
      order: item.order,
      status: item.status,
      pointsEarned: typeof item.pointsEarned === "number" ? item.pointsEarned : null,
      pointsPossible: item.pointsPossible,
      rationale: item.rationale,
      evidenceReferences: Array.isArray(item.evidenceReferences) ? item.evidenceReferences.filter(isRecord) : [],
    }];
  }).sort((left, right) => left.order - right.order);
}

function parseGrade(value: unknown): ScoringGrade | null {
  return value === "Gold" || value === "Green" || value === "Below Standard" ? value : null;
}

function parsePoints(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function scoreView(score: ScoreSummary | null): ScoreView {
  const result = score && isRecord(score.criterionResults) ? score.criterionResults : null;
  const rubric = result && isRecord(result.rubric) ? result.rubric : null;
  const calibrationPending = score?.calibrationStatus === "manual_calibration_required";
  const official = Boolean(score && rubric?.calibrationStatus === "owner_approved" &&
    score.calibrationStatus === "owner_approved" && score.analysisReviewStatus === "reviewed" && score.categoryMatches && !score.requiresHumanReview &&
    parsePoints(score.totalScore) !== null && parseGrade(score.grade) !== null);
  const reviewReasons = result && Array.isArray(result.reviewReasons)
    ? result.reviewReasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  const provisionalPoints = result && calibrationPending ? parsePoints(result.provisionalPoints) : null;
  const provisionalGrade = result && calibrationPending ? parseGrade(result.provisionalGrade) : null;

  return {
    official,
    officialGrade: official ? parseGrade(score?.grade) : null,
    officialPoints: official ? parsePoints(score?.totalScore) : null,
    calibrationPending,
    provisionalPoints,
    provisionalGrade,
    maxPoints: result ? parsePoints(result.maxPoints) : null,
    reviewReasons,
    criteria: result ? readCriteria(result) : [],
  };
}

function parseTranscriptEvidence(value: unknown, criterionId: string, analysisId: string, transcriptVersion: number): TranscriptEvidence | null {
  if (!isRecord(value) || value.kind !== "transcript_span" || value.analysisId !== analysisId ||
    value.transcriptVersion !== transcriptVersion || typeof value.start !== "number" ||
    typeof value.end !== "number" || typeof value.quote !== "string" || value.quote.trim().length === 0 ||
    !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || value.start < 0 || value.end <= value.start) return null;
  return { criterionId, start: value.start, end: value.end, quote: value.quote };
}

export function scoreEvidenceLocations(view: ScoreView, analysisId: string, transcriptVersion: number, transcript: string) {
  const codepoints = Array.from(transcript);
  const locations: TranscriptLocation[] = [];
  for (const criterion of view.criteria) {
    for (const reference of criterion.evidenceReferences) {
      const evidence = parseTranscriptEvidence(reference, criterion.id, analysisId, transcriptVersion);
      if (!evidence || evidence.end > codepoints.length || codepoints.slice(evidence.start, evidence.end).join("") !== evidence.quote) continue;
      locations.push({ ...evidence, anchorId: `m4-evidence-${locations.length}` });
    }
  }
  return locations;
}

export function candidateTextLocation(transcript: string, quote: string, anchorId: string): TranscriptLocation | null {
  const trimmed = quote.trim();
  if (!trimmed) return null;
  const start16 = transcript.indexOf(trimmed);
  if (start16 < 0) return null;
  const start = Array.from(transcript.slice(0, start16)).length;
  return { criterionId: "candidate", start, end: start + Array.from(trimmed).length, quote: trimmed, anchorId };
}

export function provisionalCoachingView(
  customerConcerns: unknown,
  outcomeValue: unknown,
  transcript: string | null,
): ProvisionalCoachingView {
  if (!transcript?.trim()) {
    return { state: "unavailable", message: "No transcript is available for evidence-linked review prompts.", prompts: [] };
  }

  const prompts: ProvisionalCoachingPrompt[] = safeCandidateItems(customerConcerns, "concern")
    .slice(0, 4)
    .flatMap((item) => {
      const location = candidateTextLocation(transcript, item.evidence, "provisional-concern");
      if (!location) return [];
      return [{
        kind: "concern" as const,
        claim: item.text,
        prompt: "Review whether the conversation addressed this concern and clarified any needed next step.",
        evidence: { criterionId: "candidate-concern", start: location.start, end: location.end, quote: location.quote },
        reviewState: "provisional human review required" as const,
      }];
    });

  const directMatch = (pattern: RegExp) => {
    const match = transcript.match(pattern);
    const quote = match?.[1] ?? match?.[0];
    if (!quote) return null;
    return candidateTextLocation(transcript, quote, `provisional-coaching-${prompts.length}`);
  };
  const permissionEvidence = directMatch(/(?:^|\n)(?:Caller:\s*)?([^.!?\n]*(?:need to ask my landlord|permission is granted|before anyone visits)[^.!?\n]*[.!?]?)/i);
  if (permissionEvidence) {
    prompts.push({
      kind: "review_opportunity",
      claim: "Potential review opportunity: the caller raised a pet-safety or landlord-permission constraint.",
      prompt: "Check whether the confirmed agent speaker acknowledged the safety and permission constraints, then offered a clear, consent-based next step. Speaker roles are unverified; this is not a policy finding.",
      evidence: { criterionId: "candidate-permission", start: permissionEvidence.start, end: permissionEvidence.end, quote: permissionEvidence.quote },
      reviewState: "provisional human review required",
    });
  }
  const consentEvidence = directMatch(/(?:^|\n)(?:Agent:\s*)?([^.!?\n]*(?:pet precautions before any work|no treatment begins without your agreement)[^.!?\n]*[.!?]?)/i);
  if (consentEvidence) {
    prompts.push({
      kind: "strength",
      claim: "Potential strength to verify: the transcript contains an explicit pet-safety and consent safeguard.",
      prompt: "If speaker attribution confirms this was the agent, verify the wording against the approved handling standard and consider retaining this clear consent safeguard.",
      evidence: { criterionId: "candidate-consent", start: consentEvidence.start, end: consentEvidence.end, quote: consentEvidence.quote },
      reviewState: "provisional human review required",
    });
  }

  const outcome = recordValue(outcomeValue);
  const outcomeClaim = typeof outcome.summary === "string" ? outcome.summary.trim() : "";
  const outcomeEvidence = typeof outcome.evidence === "string"
    ? [outcome.evidence]
    : Array.isArray(outcome.evidence)
      ? outcome.evidence.filter((item): item is string => typeof item === "string")
      : [];
  for (const quote of outcomeEvidence) {
    const location = candidateTextLocation(transcript, quote, "provisional-outcome");
    if (!location) continue;
    prompts.push({
      kind: "outcome",
      claim: outcomeClaim || "Recorded outcome candidate",
      prompt: /\bnot booking\b|\bnot scheduling\b/i.test(location.quote)
        ? "Verify the caller's decision was respected. If helpful, check whether they want a callback after permission is obtained; do not infer consent or schedule a visit."
        : "Review whether this transcript excerpt supports the recorded outcome and any stated next step.",
      evidence: { criterionId: "candidate-outcome", start: location.start, end: location.end, quote: location.quote },
      reviewState: "provisional human review required",
    });
    break;
  }

  return prompts.length
    ? { state: "available", message: null, prompts }
    : { state: "unavailable", message: "No evidence-linked prompt is available; review the transcript and candidates directly.", prompts: [] };
}

function coachingTemplate(criterionId: string) {
  if (criterionId.endsWith(".validate") || criterionId === "retention.validate_confidence_statement" || criterionId === "retention.validate_summary_statement") {
    return coachingTemplates.validation;
  }
  if (criterionId.endsWith(".investigate") || criterionId === "retention.do_your_research") return coachingTemplates.investigation;
  if (criterionId.includes("expectation_statement")) return coachingTemplates.expectation;
  if (criterionId.endsWith(".provide_conclusion")) return coachingTemplates.conclusion;
  if (["sales.agree", "sales.restate_insinuate", "sales.resolve", "sales.reclose"].includes(criterionId)) return coachingTemplates.objection;
  return null;
}

export function coachingView(
  score: ScoreSummary | null,
  analysisId: string,
  transcriptVersion: number,
  transcript: string | null,
): CoachingView {
  const view = scoreView(score);
  if (!score || !view.official) {
    return {
      state: "unavailable",
      message: score?.calibrationStatus === "manual_calibration_required"
        ? "Coaching unavailable — Needs Human Review. This rubric still needs owner-approved calibration."
        : "Coaching unavailable — Needs Human Review. Coaching requires an approved rubric and a complete human-reviewed scorecard.",
      actions: [],
    };
  }

  const actions: CoachingAction[] = [];
  const codepoints = Array.from(transcript ?? "");
  for (const criterion of view.criteria) {
    if (criterion.status !== "missed" || criterion.pointsEarned !== 0) continue;
    const template = coachingTemplate(criterion.id);
    if (!template) continue;
    const evidence = criterion.evidenceReferences
      .map((reference) => parseTranscriptEvidence(reference, criterion.id, analysisId, transcriptVersion))
      .find((item): item is TranscriptEvidence => item !== null && transcript !== null && item.end <= codepoints.length && codepoints.slice(item.start, item.end).join("") === item.quote);
    if (!evidence || !criterion.rationale.trim()) {
      return {
        state: "unavailable",
        message: "Coaching unavailable — Needs Human Review. A missed criterion does not have a verifiable evidence location in the saved transcript.",
        actions: [],
      };
    }
    actions.push({
      criterionId: criterion.id,
      criterionLabel: criterion.label,
      category: template.category,
      observedBehavior: criterion.rationale,
      evidence,
      whyItMatters: template.why,
      recommendedImprovement: template.recommendation,
      reviewState: "human-reviewed evidence",
    });
  }

  return { state: "available", message: actions.length ? null : "No coaching action was identified in the reviewed criteria.", actions };
}

export function safeCandidateItems(value: unknown, key: "fact" | "concern") {
  if (!Array.isArray(value)) return [] as Array<{ text: string; evidence: string }>;
  return value.flatMap((item): Array<{ text: string; evidence: string }> => {
    if (!isRecord(item) || typeof item[key] !== "string" || typeof item.evidence !== "string") return [];
    const text = item[key].trim();
    const evidence = item.evidence.trim();
    return text && evidence ? [{ text, evidence }] : [];
  });
}

export function reviewReasons(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.reviewReasons)) return [] as string[];
  return value.reviewReasons.filter((reason): reason is string => typeof reason === "string");
}

export function recordValue(value: unknown) {
  return isRecord(value) ? value : {};
}

export function isCalibrationColumnUnavailable(error: { code?: string; message?: string } | null | undefined) {
  return error?.code === "42703" || error?.code === "PGRST204" || Boolean(error?.message?.toLowerCase().includes("calibration_status"));
}
