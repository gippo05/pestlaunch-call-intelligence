import type { RubricDefinition } from "./types.ts";

export type ReviewWorksheetObservation = {
  criterionId: string;
  status: "met" | "missed" | "insufficient_evidence";
  evidenceQuote: string;
  rationale: string;
  agentConfirmed: boolean;
};

export type ReviewWorksheetInput = {
  observations: ReviewWorksheetObservation[];
  wholeCallReviewed: boolean;
  objectionState: "unknown" | "present" | "none_confirmed";
};

export type ReviewWorksheetSummary = {
  covered: number;
  maxPoints: number;
  confirmedPoints: number;
  incomplete: number;
  provisionalGrade: "Gold" | "Green" | "Below Standard" | null;
  criteria: Array<{
    id: string;
    label: string;
    status: "met" | "missed" | "auto_awarded" | "insufficient_evidence";
    points: number | null;
    quote: string | null;
    rationale: string;
  }>;
};

export function parseWorksheetInput(
  raw: unknown,
  rubric: RubricDefinition,
  transcript: string,
): ReviewWorksheetInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid reviewer worksheet.");
  }
  const data = raw as Record<string, unknown>;
  const wholeCallReviewed = data.wholeCallReviewed === true;
  const objectionState = data.objectionState;
  if (!["unknown", "present", "none_confirmed"].includes(String(objectionState))) {
    throw new Error("Invalid objection review state.");
  }
  if (objectionState === "none_confirmed" && !wholeCallReviewed) {
    throw new Error("Review the entire call before confirming there were no objections.");
  }
  if (!Array.isArray(data.observations) || data.observations.length > rubric.criteria.length) {
    throw new Error("Invalid number of criterion observations.");
  }
  const allowed = new Set(rubric.criteria.map((criterion) => criterion.id));
  const seen = new Set<string>();
  const observations: ReviewWorksheetObservation[] = data.observations.map((rawObservation) => {
    if (!rawObservation || typeof rawObservation !== "object" || Array.isArray(rawObservation)) {
      throw new Error("Invalid criterion observation.");
    }
    const item = rawObservation as Record<string, unknown>;
    const criterionId = item.criterionId;
    if (typeof criterionId !== "string" || !allowed.has(criterionId) || seen.has(criterionId)) {
      throw new Error("Invalid or repeated criterion.");
    }
    seen.add(criterionId);
    if (!["met", "missed", "insufficient_evidence"].includes(String(item.status))) {
      throw new Error("Unsupported criterion decision.");
    }
    const status = item.status as ReviewWorksheetObservation["status"];
    const quote = typeof item.evidenceQuote === "string" ? item.evidenceQuote.trim() : "";
    const rationale = typeof item.rationale === "string" ? item.rationale.trim() : "";
    const agentConfirmed = item.agentConfirmed === true;
    if (quote.length > 550 || rationale.length > 400) {
      throw new Error("Reviewer evidence or rationale is too long.");
    }
    if (status === "insufficient_evidence") {
      if (quote || agentConfirmed) throw new Error("Unresolved criteria cannot claim verified evidence.");
      return { criterionId, status, evidenceQuote: "", rationale, agentConfirmed: false };
    }
    if (quote.length < 8 || !transcript.includes(quote) || !agentConfirmed || rationale.length < 6) {
      throw new Error("Point decisions require an exact agent excerpt, speaker confirmation, and rationale.");
    }
    if (status === "missed" && !wholeCallReviewed) {
      throw new Error("A missed behavior requires review of the entire call.");
    }
    if (rubric.category === "sales" && rubric.criteria.some(
      (criterion) => criterion.id === criterionId && criterion.applicability === "sales_objection",
    ) && objectionState === "none_confirmed") {
      throw new Error("No-objection points are awarded from the whole-call review, not manually.");
    }
    return { criterionId, status, evidenceQuote: quote, rationale, agentConfirmed };
  });

  return {
    observations,
    wholeCallReviewed,
    objectionState: objectionState as ReviewWorksheetInput["objectionState"],
  };
}

/** A reviewer worksheet is a provisional QA calculation, NEVER a persisted official score. */
export function summarizeReviewWorksheet(
  input: ReviewWorksheetInput,
  rubric: RubricDefinition,
): ReviewWorksheetSummary {
  const byId = new Map(input.observations.map((item) => [item.criterionId, item]));
  const criteria: ReviewWorksheetSummary["criteria"] = rubric.criteria.map((criterion) => {
    if (criterion.applicability === "sales_objection" &&
      input.wholeCallReviewed && input.objectionState === "none_confirmed") {
      return {
        id: criterion.id, label: criterion.label, status: "auto_awarded",
        points: 1, quote: null,
        rationale: "Reviewer confirmed no customer objection after reviewing the entire call; sales manual awards this criterion automatically.",
      };
    }
    const observation = byId.get(criterion.id);
    if (!observation || observation.status === "insufficient_evidence" ||
      !observation.agentConfirmed || !observation.evidenceQuote) {
      return {
        id: criterion.id, label: criterion.label, status: "insufficient_evidence",
        points: null, quote: null, rationale: observation?.rationale || "Awaiting evidence-backed reviewer assessment.",
      };
    }
    return {
      id: criterion.id, label: criterion.label, status: observation.status,
      points: observation.status === "met" ? 1 : 0,
      quote: observation.evidenceQuote, rationale: observation.rationale,
    };
  });
  const covered = criteria.filter((criterion) => criterion.points !== null).length;
  const confirmedPoints = criteria.reduce((sum, criterion) => sum + (criterion.points ?? 0), 0);
  const complete = covered === rubric.maxPoints && input.wholeCallReviewed;
  const provisionalGrade = !complete ? null : confirmedPoints >= rubric.thresholds.gold
    ? "Gold" : confirmedPoints >= rubric.thresholds.greenMinimum ? "Green" : "Below Standard";
  return {
    covered, maxPoints: rubric.maxPoints, confirmedPoints,
    incomplete: rubric.maxPoints - covered, provisionalGrade, criteria,
  };
}
