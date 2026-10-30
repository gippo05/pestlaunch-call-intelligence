import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, VolumeX } from "lucide-react";
import { CallStatusBadge } from "@/components/calls/call-status-badge";
import { CallProcessingRefresh } from "@/components/calls/call-processing-refresh";
import { TranscriptViewer } from "@/components/calls/transcript-viewer";
import { Button } from "@/components/ui/button";
import { M4ReviewerWorksheet } from "@/components/calls/m4-reviewer-worksheet";
import { DEFAULT_RUBRIC_REGISTRY } from "@/lib/scoring/rubrics";
import { deriveM4AutoSuggestions } from "@/lib/scoring/m4-auto-suggestions";
import { parseWorksheetInput, type ReviewWorksheetInput } from "@/lib/scoring/review-worksheet";
import { requireUser } from "@/lib/auth/session";
import {
  callStatusLabel,
  candidateTextLocation,
  categoryLabel,
  companyLabel,
  coachingView,
  formatCallDate,
  formatCallDuration,
  isCalibrationColumnUnavailable,
  needsHumanReview,
  recordValue,
  safeCandidateItems,
  safeFilename,
  selectApplicableScore,
  scoreEvidenceLocations,
  scoreView,
  provisionalCoachingView,
  type ScoreSummary,
  type TranscriptLocation,
} from "@/lib/calls/review-view";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type CallRow = {
  id: string;
  workspace_id: string;
  original_filename: string;
  brand: string;
  call_type: string | null;
  status: string;
  created_at: string;
  duration_seconds: number | null;
};

type AnalysisRow = {
  id: string;
  call_id: string;
  transcript: string | null;
  provider: string | null;
  model: string | null;
  extracted_facts: unknown;
  outcome: unknown;
  quality_indicators: unknown;
  review_status: string;
  version: number;
  processed_at: string | null;
};

type RubricRow = { brand: string; category: string; version: number; calibration_status?: "manual_calibration_required" | "owner_approved" | null };
type ScoreRow = {
  id: string;
  analysis_id: string;
  total_score: number | string | null;
  grade: string | null;
  criterion_results: unknown;
  requires_human_review: boolean;
  scoring_version: number;
  created_at: string;
  rubric_versions: RubricRow | RubricRow[] | null;
};
type ProvisionalAssessmentRow = {
  id: string;
  analysis_id: string;
  calculation: unknown;
  created_at: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const scoreSelect = "id,analysis_id,total_score,grade,criterion_results,requires_human_review,scoring_version,created_at,rubric_versions!inner(brand,category,version,calibration_status)";
const scoreSelectWithoutCalibration = "id,analysis_id,total_score,grade,criterion_results,requires_human_review,scoring_version,created_at,rubric_versions!inner(brand,category,version)";

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function scoreSummary(row: ScoreRow | null, analysisReviewStatus: string | null, callCategory: string | null): ScoreSummary | null {
  if (!row) return null;
  const rubric = one(row.rubric_versions);
  return {
    totalScore: row.total_score,
    grade: row.grade,
    requiresHumanReview: row.requires_human_review,
    analysisReviewStatus,
    categoryMatches: rubric?.category === callCategory,
    calibrationStatus: rubric?.calibration_status ?? null,
    criterionResults: row.criterion_results,
  };
}

function readTextItems(value: unknown) {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [] as string[];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function getQualityFlags(value: unknown) {
  const flags = recordValue(value).review_flags;
  return readTextItems(flags);
}

function savedOutcome(analysis: AnalysisRow | null) {
  if (!analysis) return null;
  const outcome = recordValue(analysis.outcome);
  return {
    status: typeof outcome.status === "string" && outcome.status.trim() ? outcome.status.trim() : null,
    summary: typeof outcome.summary === "string" && outcome.summary.trim() ? outcome.summary.trim() : null,
    evidence: readTextItems(outcome.evidence),
  };
}

function locateCandidates(transcript: string, items: Array<{ text: string; evidence: string }>, prefix: string) {
  return items.map((item, index) => ({
    ...item,
    location: candidateTextLocation(transcript, item.evidence, `${prefix}-${index}`),
  }));
}

function evidenceLink(location: TranscriptLocation | null, text = "Locate in transcript") {
  if (!location) return <span className="text-xs text-muted">No matching transcript location is available.</span>;
  return <a href={`#${location.anchorId}`} className="inline-flex min-h-8 items-center rounded-md px-2 text-xs font-semibold text-blue-800 underline underline-offset-2 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">{text}</a>;
}

function evidenceStatus(reference: Record<string, unknown>) {
  if (reference.kind === "full_transcript_review") return "Whole-transcript review attestation";
  if (reference.kind === "transcript_span") return "Saved transcript excerpt";
  return "Unsupported evidence reference";
}

export default async function CallDetailPage({ params }: { params: Promise<{ callId: string }> }) {
  const viewer = await requireUser();
  const { callId } = await params;
  if (!uuid.test(callId)) notFound();

  const db = await createSupabaseServerClient();
  const { data: callData, error: callError } = await db.from("calls")
    .select("id,workspace_id,original_filename,brand,call_type,status,created_at,duration_seconds")
    .eq("id", callId).maybeSingle();
  const call = callData as CallRow | null;
  if (callError || !call) notFound();

  const { data: analysisData, error: analysisError } = await db.from("call_analyses")
    .select("id,call_id,transcript,provider,model,extracted_facts,outcome,quality_indicators,review_status,version,processed_at")
    .eq("call_id", call.id).order("version", { ascending: false }).limit(1).maybeSingle();
  const analysis = analysisData as AnalysisRow | null;

  // Distinct, reviewer-authored draft. This is NOT a human-approved M4 call_score.
  const selectedRubricKey = `${call.brand}.${call.call_type}` as keyof typeof DEFAULT_RUBRIC_REGISTRY;
  const selectedDraftRubric = DEFAULT_RUBRIC_REGISTRY[selectedRubricKey] ?? null;
  const { data: reviewerMembership } = await db.from("workspace_members").select("role")
    .eq("workspace_id", call.workspace_id).eq("user_id", viewer.id).maybeSingle();
  const mayEditWorksheet = reviewerMembership?.role === "owner" || reviewerMembership?.role === "reviewer";
  let savedReviewWorksheet: ReviewWorksheetInput | null = null;
  if (analysis?.transcript && selectedDraftRubric && mayEditWorksheet) {
    const { data: worksheet } = await db.from("m4_review_worksheets")
      .select("observations,whole_call_reviewed,objection_state")
      .eq("analysis_id", analysis.id).maybeSingle();
    if (worksheet) {
      try {
        savedReviewWorksheet = parseWorksheetInput({
          observations: worksheet.observations,
          wholeCallReviewed: worksheet.whole_call_reviewed,
          objectionState: worksheet.objection_state,
        }, selectedDraftRubric, analysis.transcript);
      } catch {
        // Never display or total a malformed worksheet.
      }
    }
  }

  let provisionalAssessment: ProvisionalAssessmentRow | null = null;
  let provisionalAssessmentUnavailable = false;
  if (analysis) {
    const provisionalResult = await db.from("call_provisional_assessments")
      .select("id,analysis_id,calculation,created_at")
      .eq("analysis_id", analysis.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    provisionalAssessmentUnavailable = Boolean(provisionalResult.error);
    provisionalAssessment = provisionalResult.data as ProvisionalAssessmentRow | null;
  }

  let scoreRow: ScoreRow | null = null;
  let scoreLookupUnavailable = false;
  if (analysis) {
    const { data: scoreData, error: scoreError } = await db.from("call_scores").select(scoreSelect)
      .eq("analysis_id", analysis.id).order("created_at", { ascending: false }).limit(100);
    let scoreRows: ScoreRow[] = [];
    if (scoreError && isCalibrationColumnUnavailable(scoreError)) {
      scoreLookupUnavailable = true;
      const fallback = await db.from("call_scores").select(scoreSelectWithoutCalibration)
        .eq("analysis_id", analysis.id).order("created_at", { ascending: false }).limit(100);
      if (!fallback.error) scoreRows = (fallback.data ?? []) as unknown as ScoreRow[];
    } else if (scoreError) scoreLookupUnavailable = true;
    else scoreRows = (scoreData ?? []) as unknown as ScoreRow[];
    if (scoreRows.length > 0) {
      scoreRow = selectApplicableScore(scoreRows, (row) => {
        const rubric = one(row.rubric_versions);
        return rubric ? {
          analysisId: row.analysis_id,
          brand: rubric.brand,
          category: rubric.category,
          rubricVersion: rubric.version,
          createdAt: row.created_at,
        } : null;
      }, analysis.id, call.brand, call.call_type);
    }
  }

  let activeRubric: RubricRow | null = null;
  let rubricLookupUnavailable = false;
  if (!scoreRow && call.call_type) {
    const rubricResult = await db.from("rubric_versions")
      .select("brand,category,version,calibration_status")
      .eq("brand", call.brand)
      .eq("category", call.call_type)
      .eq("is_active", true)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (rubricResult.error && isCalibrationColumnUnavailable(rubricResult.error)) {
      rubricLookupUnavailable = true;
      const fallback = await db.from("rubric_versions")
        .select("brand,category,version")
        .eq("brand", call.brand)
        .eq("category", call.call_type)
        .eq("is_active", true)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!fallback.error) activeRubric = fallback.data as RubricRow | null;
    } else if (rubricResult.error) {
      rubricLookupUnavailable = true;
    } else {
      activeRubric = rubricResult.data as RubricRow | null;
    }
  }

  const provisionalCalculation = recordValue(provisionalAssessment?.calculation);
  const provisionalRubric = recordValue(provisionalCalculation.rubric);
  const provisionalSummary: ScoreSummary | null = provisionalAssessment ? {
    totalScore: null,
    grade: null,
    requiresHumanReview: true,
    analysisReviewStatus: analysis?.review_status ?? null,
    categoryMatches: provisionalRubric.category === call.call_type,
    calibrationStatus: provisionalRubric.calibrationStatus === "owner_approved" || provisionalRubric.calibrationStatus === "manual_calibration_required"
      ? provisionalRubric.calibrationStatus
      : null,
    criterionResults: provisionalAssessment.calculation,
  } : null;
  const summary = scoreSummary(scoreRow, analysis?.review_status ?? null, call.call_type) ?? provisionalSummary;
  const scoring = scoreView(summary);
  const rubric = one(scoreRow?.rubric_versions) ?? activeRubric;
  const transcript = analysis?.transcript ?? null;
  const extracted = analysis ? recordValue(analysis.extracted_facts) : {};
  const factCandidates = safeCandidateItems(extracted.confirmed_facts, "fact");
  const concernCandidates = safeCandidateItems(extracted.customer_concerns, "concern");
  const factLocations = transcript ? locateCandidates(transcript, factCandidates, "candidate-fact") : factCandidates.map((item) => ({ ...item, location: null }));
  const concernLocations = transcript ? locateCandidates(transcript, concernCandidates, "candidate-concern") : concernCandidates.map((item) => ({ ...item, location: null }));
  const outcome = savedOutcome(analysis);
  const outcomeLocations = transcript && outcome ? outcome.evidence.map((quote, index) => candidateTextLocation(transcript, quote, `candidate-outcome-${index}`)) : [];
  const m4Locations = analysis && transcript ? scoreEvidenceLocations(scoring, analysis.id, analysis.version, transcript) : [];
  const coaching = analysis ? coachingView(summary, analysis.id, analysis.version, transcript) : coachingView(null, "", 0, null);
  const provisionalCoaching = provisionalCoachingView(extracted.customer_concerns, analysis?.outcome, transcript);
  const coachingEvidenceLocations = transcript ? provisionalCoaching.prompts.flatMap((prompt, index) => {
    const location = candidateTextLocation(transcript, prompt.evidence.quote, `provisional-coaching-${index}`);
    return location ? [location] : [];
  }) : [];
  const transcriptLocations = [...m4Locations, ...factLocations.flatMap((item) => item.location ? [item.location] : []), ...concernLocations.flatMap((item) => item.location ? [item.location] : []), ...outcomeLocations.filter((item): item is TranscriptLocation => item !== null), ...coachingEvidenceLocations];
  const quality = recordValue(analysis?.quality_indicators);
  const verifiedShapeSuggestions = transcript && selectedDraftRubric
    ? deriveM4AutoSuggestions(call.call_type, transcript, quality.speaker_segments)
    : [];
  const flags = getQualityFlags(analysis?.quality_indicators);
  const humanReview = analysis
    ? !scoring.official || needsHumanReview(call.status, analysis.review_status, summary ? [{ requiresHumanReview: summary.requiresHumanReview }] : [])
    : call.status === "failed" || call.status === "review_required";

  return (
    <main className="space-y-6">
      <CallProcessingRefresh statuses={[call.status]} />
      <Link href="/calls" className="inline-flex min-h-9 items-center gap-2 rounded-md text-sm font-semibold text-blue-800 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700"><ArrowLeft aria-hidden="true" className="size-4" /> Back to calls</Link>

      <section className="rounded-xl border border-line bg-white p-5 sm:p-6" aria-labelledby="call-title">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-800">Call review</p>
            <h1 id="call-title" className="mt-2 break-words text-2xl font-semibold tracking-tight text-ink">{safeFilename(call.original_filename)}</h1>
            <p className="mt-2 text-sm text-muted">{companyLabel(call.brand)} · {categoryLabel(call.call_type)} · {formatCallDuration(call.duration_seconds)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CallStatusBadge status={call.status} />
            {scoring.official ? (
              <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-900">{scoring.officialPoints}/{scoring.maxPoints ?? "—"} · {scoring.officialGrade}</span>
            ) : scoring.calibrationPending ? (
              <span className="inline-flex rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-semibold text-amber-950">Not Scored · Calibration Pending</span>
            ) : (
              <span className="inline-flex rounded-full border border-line bg-stone-50 px-3 py-1.5 text-sm font-semibold text-ink">Not Scored</span>
            )}
          </div>
        </div>
        <dl className="mt-5 grid gap-3 border-t border-line pt-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs font-medium text-muted">Created</dt><dd className="mt-1 font-medium text-ink">{formatCallDate(call.created_at)}</dd></div>
          <div><dt className="text-xs font-medium text-muted">Processed</dt><dd className="mt-1 font-medium text-ink">{analysis?.processed_at ? formatCallDate(analysis.processed_at) : "Not processed"}</dd></div>
          <div><dt className="text-xs font-medium text-muted">Analysis review status</dt><dd className="mt-1 font-medium capitalize text-ink">{analysis?.review_status.replaceAll("_", " ") ?? "Not available"}</dd></div>
          <div><dt className="text-xs font-medium text-muted">AI provenance</dt><dd className="mt-1 font-medium text-ink">{analysis?.provider || analysis?.model ? `${analysis.provider ?? "Provider unavailable"} · ${analysis.model ?? "Model unavailable"}` : "No analysis provenance"}</dd></div>
        </dl>
      </section>

      {humanReview && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 sm:p-5" role="status" aria-live="polite">
          <h2 className="font-semibold text-amber-950">Needs Human Review</h2>
          <p className="mt-1 text-sm leading-6 text-amber-950">{analysis ? "Saved model output is an unreviewed candidate. Check the transcript and evidence before relying on any extracted fact, concern, or outcome." : call.status === "failed" ? "Processing failed before a reviewable analysis was saved. No transcript or score is available." : "No reviewable analysis is available yet. This call is awaiting processing or a reviewable result."}</p>
          {flags.length > 0 && <ul className="mt-3 flex flex-wrap gap-2">{flags.map((flag) => <li key={flag} className="rounded-full border border-amber-300 bg-white/70 px-2.5 py-1 text-xs text-amber-950">{flag.replaceAll("_", " ").toLowerCase()}</li>)}</ul>}
        </section>
      )}
      {analysisError && <section className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900" role="alert">Analysis details are temporarily unavailable. The call remains private.</section>}
      {!analysis && !analysisError && <section className="rounded-xl border border-line bg-white p-5" role="status"><h2 className="font-semibold text-ink">{call.status === "failed" ? "Processing failed" : call.status === "processing" ? "Processing in progress" : "Awaiting processing"}</h2><p className="mt-1 text-sm leading-6 text-muted">{call.status === "failed" ? "No transcript, outcome, or score was saved. A workspace reviewer can inspect the processing status." : "The recording remains private. No transcript, outcome, or score is available until an authorized processing run creates an analysis."}</p><p className="mt-2 text-xs text-muted">Current state: {callStatusLabel(call.status)}</p></section>}

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(18rem,0.7fr)]">
        <article className="rounded-xl border border-line bg-white p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Recorded call result</p>
              <h2 className="mt-1 text-lg font-semibold text-ink">Outcome summary</h2>
            </div>
            {outcome?.status && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium capitalize text-slate-700">{outcome.status.replaceAll("_", " ")}</span>}
          </div>
          <p className="mt-3 break-words text-sm leading-6 text-ink">{outcome?.summary ?? "No documented outcome is available."}</p>
          {outcome?.summary && <p className="mt-2 text-xs text-muted">AI-extracted outcome candidate · verify against the transcript</p>}
          {outcome?.evidence.map((quote, index) => <blockquote key={`${index}-${quote}`} className="mt-3 rounded-r-md border-l-2 border-blue-300 bg-blue-50/60 px-3 py-2 text-sm leading-6 text-ink">{quote}<div className="mt-1">{evidenceLink(outcomeLocations[index] ?? null, "Locate excerpt")}</div></blockquote>)}
        </article>
        <article className="rounded-xl border border-line bg-white p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-700"><VolumeX aria-hidden="true" className="size-4" /></span>
            <div>
              <h2 className="font-semibold text-ink">Audio playback</h2>
              <p className="mt-1 text-sm leading-6 text-muted">Playback is unavailable because an authorized private media-read flow is not configured. The recording stays private.</p>
              <Button type="button" variant="outline" disabled className="mt-3">Playback unavailable</Button>
            </div>
          </div>
        </article>
      </section>

      <section className="rounded-xl border border-line bg-white p-5 sm:p-6" aria-labelledby="transcript-heading">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Source text</p><h2 id="transcript-heading" className="mt-1 text-lg font-semibold text-ink">Transcript</h2></div>
          {analysis && <span className="text-xs text-muted">Transcript version {analysis.version}</span>}
        </div>
        <TranscriptViewer transcript={transcript} locations={transcriptLocations} />
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <CandidateList title="AI-extracted fact candidates" emptyLabel="No fact candidates were saved." items={factLocations} />
        <CandidateList title="AI-extracted concern candidates" emptyLabel="No concern candidates were saved." items={concernLocations} />
      </section>

      <ScorecardSection score={summary} scoring={scoring} scoreLookupUnavailable={scoreLookupUnavailable} rubricLookupUnavailable={rubricLookupUnavailable} callType={call.call_type} rubric={rubric} locations={m4Locations} />
      {analysis?.transcript && selectedDraftRubric && (
        <section className="rounded-xl border border-line bg-white p-5 sm:p-6" aria-labelledby="m4-auto-heading">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-blue-800">M4 · Automatic pre-assessment</p>
          <h2 id="m4-auto-heading" className="mt-1 text-lg font-semibold text-ink">Transcript-linked scoring suggestions</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            These rule-based cues run automatically from Gemini&apos;s existing speaker-tagged transcript. No second model request is needed.
            Speaker labels and behavior judgments have not been human-verified. No points, missed criteria or official grade are awarded automatically.
          </p>
          {verifiedShapeSuggestions.length ? (
            <ul className="mt-4 space-y-3">
              {verifiedShapeSuggestions.map((suggestion) => (
                <li key={suggestion.criterionId} className="rounded-lg border border-blue-100 bg-blue-50/40 p-3">
                  <p className="text-sm font-semibold text-ink">{selectedDraftRubric.criteria.find(c => c.id === suggestion.criterionId)?.label ?? suggestion.criterionId} <span className="font-normal text-blue-800">· Potentially met — verify</span></p>
                  <p className="mt-2 text-sm text-muted">{suggestion.rationale}</p>
                  <blockquote className="mt-2 border-l-2 border-blue-300 pl-3 text-sm text-ink">{suggestion.quote}</blockquote>
                  <p className="mt-2 text-xs text-muted">Gemini-identified employee excerpt · unverified speaker attribution</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 rounded-lg bg-stone-50 p-3 text-sm text-muted">
              No reliably attributable automatic criterion suggestions were available from this analysis.
              Earlier Gemini recordings did not retain speaker-tagged excerpts; use the reviewer worksheet for evidence-based scoring.
            </p>
          )}
        </section>
      )}
      {analysis?.transcript && selectedDraftRubric && mayEditWorksheet && (
        <M4ReviewerWorksheet callId={call.id} rubricKey={selectedRubricKey} transcript={analysis.transcript}
          editable={mayEditWorksheet} initial={savedReviewWorksheet} reviewerLabel={null} suggestions={verifiedShapeSuggestions} />
      )}
      {provisionalAssessment && <p className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-950" role="status"><strong>Original AI candidate assessment.</strong> This record predates manual QA and has no validated criterion observations. It is not a 0-point employee grade. Any saved reviewer decisions appear in the working scorecard above; official scoring remains gated by calibration and source review.</p>}
      {provisionalAssessmentUnavailable && <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950" role="status">The provisional M4 assessment could not be read. The call remains review required and no grade is displayed.</p>}
      <CoachingSection coaching={coaching} locations={m4Locations} />
      <ProvisionalCoachingSection coaching={provisionalCoaching} locations={transcriptLocations} />
    </main>
  );
}

function CandidateList({
  title,
  emptyLabel,
  items,
}: {
  title: string;
  emptyLabel: string;
  items: Array<{ text: string; evidence: string; location: TranscriptLocation | null }>;
}) {
  return (
    <article className="rounded-xl border border-line bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-900">Unreviewed model output</span>
      </div>
      {items.length === 0 ? <p className="mt-3 text-sm text-muted">{emptyLabel}</p> : (
        <ul className="mt-4 space-y-4">
          {items.map((item, index) => (
            <li key={`${index}-${item.text}`} className="border-t border-line pt-4 first:border-t-0 first:pt-0">
              <p className="break-words text-sm font-medium leading-6 text-ink">{item.text}</p>
              <p className="mt-2 text-xs font-semibold text-muted">Supporting excerpt candidate</p>
              <blockquote className="mt-1 break-words border-l-2 border-blue-300 pl-3 text-sm leading-6 text-muted">{item.evidence}</blockquote>
              <div className="mt-1">{evidenceLink(item.location)}</div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function ScorecardSection({
  score,
  scoring,
  scoreLookupUnavailable,
  rubricLookupUnavailable,
  callType,
  rubric,
  locations,
}: {
  score: ScoreSummary | null;
  scoring: ReturnType<typeof scoreView>;
  scoreLookupUnavailable: boolean;
  rubricLookupUnavailable: boolean;
  callType: string | null;
  rubric: RubricRow | null;
  locations: TranscriptLocation[];
}) {
  return (
    <section className="rounded-xl border border-line bg-white p-5 sm:p-6" aria-labelledby="scorecard-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Deterministic assessment</p><h2 id="scorecard-heading" className="mt-1 text-lg font-semibold text-ink">Scorecard</h2><p className="mt-1 text-xs text-muted">{rubric ? `${companyLabel(rubric.brand)} · ${categoryLabel(rubric.category)} · Rubric v${rubric.version}${rubric.calibration_status === "manual_calibration_required" ? " · Owner calibration required" : rubricLookupUnavailable ? " · Calibration status unavailable" : ""}` : `${categoryLabel(callType)} · ${rubricLookupUnavailable ? "Rubric status unavailable" : "No rubric available"}`}</p>
          {rubric && rubric.category !== callType && <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" role="status">The saved call category is {categoryLabel(callType)}, while this persisted score uses {categoryLabel(rubric.category)}. Verify the category mapping; official points and grade are withheld.</p>}
        </div>
        {scoring.official ? (
          <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-900">{scoring.officialPoints}/{scoring.maxPoints ?? "—"} · {scoring.officialGrade}</span>
        ) : scoring.calibrationPending ? (
          <span className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-950">Not Scored — Calibration Pending</span>
        ) : (
          <span className="rounded-lg border border-line bg-stone-50 px-3 py-2 text-sm font-semibold text-ink">Not Scored</span>
        )}
      </div>
      {scoreLookupUnavailable && <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950" role="status">M4 calibration status is unavailable. No official grade is displayed.</p>}
      {!score ? (
        <p className="mt-4 rounded-lg bg-stone-50 p-4 text-sm leading-6 text-muted">{!callType ? "The call category is unclassified, so no rubric can be selected." : rubricLookupUnavailable ? "No M4 score is stored. Rubric calibration status could not be verified, so scoring remains withheld." : rubric?.calibration_status === "owner_approved" ? "No persisted M4 score is available. The transcript and speaker attribution still require human review before scoring." : "No M4 score is stored. This rubric requires owner calibration, a human-reviewed transcript, verified speaker attribution, and a confirmed call category before an official score can be shown."}</p>
      ) : (
        <>
          {scoring.calibrationPending && scoring.provisionalPoints !== null && (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
              <strong>Provisional calculation only — not an official score or grade.</strong>{" "}
              {scoring.provisionalPoints}/{scoring.maxPoints ?? "—"} provisional points{scoring.provisionalGrade ? ` · provisional ${scoring.provisionalGrade}` : ""}.
            </p>
          )}
          {!scoring.official && !scoring.calibrationPending && <p className="mt-4 rounded-lg bg-stone-50 p-4 text-sm text-muted">Official points and grade are withheld until the source, reviewer, and evidence requirements pass.</p>}
          {scoring.reviewReasons.length > 0 && <ul className="mt-3 flex flex-wrap gap-2">{scoring.reviewReasons.map((reason) => <li key={reason} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">{reason.replaceAll("_", " ")}</li>)}</ul>}
          {scoring.criteria.length === 0 ? <p className="mt-4 text-sm text-muted">No validated criteria are available.</p> : (
            <ol className="mt-5 divide-y divide-line border-t border-line">
              {scoring.criteria.map((criterion) => {
                const references = criterion.evidenceReferences;
                const criterionLocations = locations.filter((location) => location.criterionId === criterion.id);
                return (
                  <li key={criterion.id} className="grid gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                    <div>
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h3 className="text-sm font-semibold text-ink">{criterion.order}. {criterion.label}</h3>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium capitalize text-slate-700">{criterion.status.replaceAll("_", " ")}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted">Review state: {scoring.official ? "Human reviewed · rubric approved" : scoring.calibrationPending ? "Provisional · calibration pending" : "Human review required"}</p>
                      <p className="mt-2 break-words text-sm leading-6 text-muted">{criterion.rationale}</p>
                      {references.length > 0 && <p className="mt-2 text-xs text-muted">{references.map(evidenceStatus).join(" · ")}</p>}
                      {criterionLocations.map((location) => <span key={location.anchorId} className="mr-2 inline-block">{evidenceLink(location, "Locate saved excerpt")}</span>)}
                      {references.some((reference) => reference.kind === "full_transcript_review") && <a href="#transcript" className="inline-flex min-h-8 items-center rounded-md px-2 text-xs font-semibold text-blue-800 underline underline-offset-2 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">Open complete transcript</a>}
                      {references.some((reference) => reference.kind === "transcript_span") && criterionLocations.length === 0 && <p className="mt-1 text-xs text-amber-900">Saved excerpt could not be located in the current transcript. Human review is required.</p>}
                    </div>
                    <span className="text-xs font-medium text-muted">{criterion.pointsEarned === null ? `Withheld / ${criterion.pointsPossible}` : `${criterion.pointsEarned} / ${criterion.pointsPossible}${scoring.official ? " points" : " provisional points"}`}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function ProvisionalCoachingSection({
  coaching,
  locations,
}: {
  coaching: ReturnType<typeof provisionalCoachingView>;
  locations: TranscriptLocation[];
}) {
  return (
    <section className="rounded-xl border border-blue-200 bg-blue-50/40 p-5 sm:p-6" aria-labelledby="provisional-coaching-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-blue-800">M5 reviewer support</p><h2 id="provisional-coaching-heading" className="mt-1 text-lg font-semibold text-ink">Provisional coaching suggestions</h2></div>
        <span className="rounded-full border border-blue-200 bg-white px-2.5 py-1 text-xs font-semibold text-blue-900">Human review required</span>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted">These deterministic prompts connect saved candidate text and exact transcript excerpts to a review question. They are not policy findings or employee assessments. Verify speaker roles and the approved handling standard before acting on a suggestion.</p>
      {coaching.state === "unavailable" ? (
        <p className="mt-4 rounded-lg border border-line bg-white p-4 text-sm text-muted">{coaching.message}</p>
      ) : (
        <ul className="mt-4 grid gap-3 md:grid-cols-2">
          {coaching.prompts.map((prompt, index) => {
            const location = locations.find((item) => item.start === prompt.evidence.start && item.end === prompt.evidence.end && item.quote === prompt.evidence.quote) ?? null;
            return (
              <li key={`${prompt.kind}-${index}`} className="rounded-lg border border-line bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-blue-800">{prompt.kind === "concern" ? "Concern candidate" : prompt.kind === "outcome" ? "Outcome candidate" : prompt.kind === "strength" ? "Potential strength" : "Review opportunity"}</p>
                <p className="mt-1 break-words text-sm font-medium leading-6 text-ink">{prompt.claim}</p>
                <p className="mt-3 text-sm leading-6 text-muted">{prompt.prompt}</p>
                <blockquote className="mt-3 break-words border-l-2 border-blue-300 pl-3 text-sm leading-6 text-muted">{prompt.evidence.quote}</blockquote>
                <div className="mt-1">{evidenceLink(location, "Locate exact excerpt")}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CoachingSection({ coaching, locations }: { coaching: ReturnType<typeof coachingView>; locations: TranscriptLocation[] }) {
  return (
    <section className="rounded-xl border border-line bg-white p-5 sm:p-6" aria-labelledby="coaching-heading">
      <div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Reviewer support</p><h2 id="coaching-heading" className="mt-1 text-lg font-semibold text-ink">Coaching actions</h2></div>
      <p className="mt-2 text-sm leading-6 text-muted">Coaching uses deterministic, general-purpose guidance from human-reviewed missed criteria. It does not generate advice from model output.</p>
      {coaching.state === "unavailable" ? (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">{coaching.message}</p>
      ) : coaching.actions.length === 0 ? (
        <p className="mt-4 rounded-lg bg-stone-50 p-4 text-sm text-muted">{coaching.message}</p>
      ) : (
        <ul className="mt-4 grid gap-4 md:grid-cols-2">
          {coaching.actions.map((action) => {
            const location = locations.find((item) => item.criterionId === action.criterionId && item.start === action.evidence.start && item.end === action.evidence.end && item.quote === action.evidence.quote) ?? null;
            return (
              <li key={action.criterionId} className="rounded-lg border border-line bg-stone-50 p-4">
                <span className="text-xs font-semibold uppercase tracking-[0.08em] text-blue-800">{action.category}</span>
                <h3 className="mt-1 text-sm font-semibold text-ink">{action.criterionLabel}</h3>
                <p className="mt-3 text-xs font-semibold text-muted">Observed behavior · {action.reviewState}</p>
                <p className="mt-1 text-sm leading-6 text-ink">{action.observedBehavior}</p>
                <blockquote className="mt-3 border-l-2 border-blue-300 pl-3 text-sm leading-6 text-muted">{action.evidence.quote}</blockquote>
                <div className="mt-1">{evidenceLink(location)}</div>
                <p className="mt-3 text-sm leading-6 text-muted"><strong className="text-ink">Why it matters:</strong> {action.whyItMatters}</p>
                <p className="mt-2 text-sm leading-6 text-muted"><strong className="text-ink">Try next time:</strong> {action.recommendedImprovement}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
