import { ClipboardCheck } from "lucide-react";
import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { formatCallDate, isCalibrationColumnUnavailable, recordValue, safeFilename, scoreView, type ScoreSummary } from "@/lib/calls/review-view";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DEFAULT_RUBRIC_REGISTRY } from "@/lib/scoring/rubrics";
import { parseWorksheetInput, summarizeReviewWorksheet } from "@/lib/scoring/review-worksheet";

type RubricRow = {
  brand: string;
  category: string;
  version: number;
  calibration_status?: "manual_calibration_required" | "owner_approved" | null;
};

type CallRow = { id: string; original_filename: string; brand: string; call_type: string | null };
type AnalysisRow = { id: string; call_id: string; review_status: string; calls: CallRow | CallRow[] | null };
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
  call_analyses: AnalysisRow | AnalysisRow[] | null;
};
type ProvisionalAnalysisRow = { id: string; call_id: string; review_status: string; calls: CallRow | CallRow[] | null };
type ProvisionalAssessmentRow = {
  id: string;
  analysis_id: string;
  calculation: unknown;
  created_at: string;
  call_analyses: ProvisionalAnalysisRow | ProvisionalAnalysisRow[] | null;
};

type AiAssessmentRow = {
  analysis_id: string;
  status: string;
  calculation: unknown;
  error_code: string | null;
  updated_at: string;
  call_analyses: ProvisionalAnalysisRow | ProvisionalAnalysisRow[] | null;
};

type ReviewerDraftRow = {
  analysis_id: string;
  observations: unknown;
  whole_call_reviewed: boolean;
  objection_state: string;
  updated_at: string;
  call_analyses: {
    id: string;
    transcript: string | null;
    calls: CallRow | CallRow[] | null;
  } | Array<{
    id: string;
    transcript: string | null;
    calls: CallRow | CallRow[] | null;
  }> | null;
};

const scoreSelect = "id,analysis_id,total_score,grade,criterion_results,requires_human_review,scoring_version,created_at,rubric_versions!inner(brand,category,version,calibration_status),call_analyses!inner(id,call_id,review_status,calls!inner(id,original_filename,brand,call_type))";
const scoreSelectWithoutCalibration = "id,analysis_id,total_score,grade,criterion_results,requires_human_review,scoring_version,created_at,rubric_versions!inner(brand,category,version),call_analyses!inner(id,call_id,review_status,calls!inner(id,original_filename,brand,call_type))";

function one<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function scoreSummary(row: ScoreRow, analysisReviewStatus: string | null, callCategory: string | null): ScoreSummary {
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

function reasonLabel(reason: string) {
  return reason.replaceAll("_", " ").replaceAll(":", " · ");
}

export default async function ScorecardsPage() {
  await requireUser();
  const db = await createSupabaseServerClient();
  const initial = await db.from("call_scores").select(scoreSelect)
    .order("created_at", { ascending: false }).limit(100);
  let data: unknown = initial.data;
  let error = initial.error;
  let calibrationStatusUnavailable = false;
  if (initial.error && isCalibrationColumnUnavailable(initial.error)) {
    calibrationStatusUnavailable = true;
    const fallback = await db.from("call_scores").select(scoreSelectWithoutCalibration)
      .order("created_at", { ascending: false }).limit(100);
    data = fallback.data;
    error = fallback.error;
  }
  const scores = (data ?? []) as unknown as ScoreRow[];
  const provisionalResult = await db.from("call_provisional_assessments")
    .select("id,analysis_id,calculation,created_at,call_analyses!inner(id,call_id,review_status,calls!inner(id,original_filename,brand,call_type))")
    .order("created_at", { ascending: false })
    .limit(100);
  const provisionalAssessments = (provisionalResult.data ?? []) as unknown as ProvisionalAssessmentRow[];
  const aiResult = await db.from("m4_ai_assessments")
    .select("analysis_id,status,calculation,error_code,updated_at,call_analyses!inner(id,call_id,review_status,calls!inner(id,original_filename,brand,call_type))")
    .order("updated_at", { ascending: false }).limit(100);
  const aiAssessments = (aiResult.data ?? []) as unknown as AiAssessmentRow[];
  const reviewerResult = await db.from("m4_review_worksheets")
    .select("analysis_id,observations,whole_call_reviewed,objection_state,updated_at,call_analyses!inner(id,transcript,calls!inner(id,original_filename,brand,call_type))")
    .order("updated_at", { ascending: false }).limit(50);
  const reviewerDrafts = ((reviewerResult.data ?? []) as unknown as ReviewerDraftRow[]).flatMap((draft) => {
    const analysis = one(draft.call_analyses);
    const call = analysis ? one(analysis.calls) : null;
    if (!call || !analysis?.transcript) return [];
    const key = `${call.brand}.${call.call_type}` as keyof typeof DEFAULT_RUBRIC_REGISTRY;
    const rubric = DEFAULT_RUBRIC_REGISTRY[key];
    if (!rubric) return [];
    try {
      const validated = parseWorksheetInput({
        observations: draft.observations,
        wholeCallReviewed: draft.whole_call_reviewed,
        objectionState: draft.objection_state,
      }, rubric, analysis.transcript);
      return [{ call, draft, summary: summarizeReviewWorksheet(validated, rubric) }];
    } catch {
      return [];
    }
  });

  return (
    <main className="space-y-7">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-blue-800">Evaluation</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">Scorecards</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Persisted M4 results for calls in your authorized workspace. Official grades appear only when the database rubric is owner-approved and review requirements pass.</p>
      </div>

      {aiAssessments.length > 0 && (
        <section className="space-y-3" aria-label="Automatic AI provisional scores">
          <h2 className="text-lg font-semibold text-ink">Automatic AI assessments · Provisional</h2>
          <p className="text-sm text-muted">AI-generated first-pass points and evidence, not official grades. Unassessed criteria are not failures.</p>
          {aiAssessments.map((assessment) => {
            const analysis = one(assessment.call_analyses);
            const call = analysis ? one(analysis.calls) : null;
            const calculation = recordValue(assessment.calculation);
            const points = typeof calculation.provisionalPoints === "number" ? calculation.provisionalPoints : null;
            const assessed = typeof calculation.assessedCriteria === "number" ? calculation.assessedCriteria : null;
            const max = typeof calculation.maxPoints === "number" ? calculation.maxPoints : null;
            return <article key={assessment.analysis_id} className="rounded-xl border border-blue-200 bg-white p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>{call ? <Link href={`/calls/${call.id}`} className="font-semibold text-ink underline-offset-4 hover:underline">{safeFilename(call.original_filename)}</Link> : <p className="font-semibold text-ink">Call reference unavailable</p>}
                  <p className="mt-1 text-xs text-muted">Automated M4 · {assessment.status.replaceAll("_"," ")} · {formatCallDate(assessment.updated_at)}</p>
                </div>
                <span className="rounded-md bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-950">
                  {points !== null && assessed !== null && max !== null ?
                    `${points} tentative points · ${assessed}/${max} assessed` :
                    assessment.status === "failed" ? "AI scoring unavailable" : "AI scoring in progress"}
                </span>
              </div>
              <p className="mt-2 text-xs text-muted">Provisional only. Open the call for criterion-by-criterion transcript evidence.</p>
            </article>;
          })}
        </section>
      )}

      {reviewerDrafts.length > 0 && (
        <section className="space-y-3" aria-label="Reviewer QA worksheets">
          <h2 className="text-lg font-semibold text-ink">Reviewer QA worksheets · Provisional</h2>
          <p className="text-sm leading-6 text-muted">Manual-derived, evidence-backed reviewer assessments. These are not official PestLaunch grades; rubric calibration is pending.</p>
          {reviewerDrafts.map(({ call, draft, summary }) => (
            <article key={draft.analysis_id} className="rounded-xl border border-blue-200 bg-white p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <Link href={`/calls/${call.id}`} className="font-semibold text-ink underline-offset-4 hover:text-blue-800 hover:underline">{safeFilename(call.original_filename)}</Link>
                  <p className="mt-1 text-xs text-muted">{call.brand === "abc" ? "ABC" : "Noble"} · {call.call_type?.replaceAll("_", " ")} · Updated {formatCallDate(draft.updated_at)}</p>
                </div>
                <span className="rounded-md bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-950">{summary.covered}/{summary.maxPoints} assessed · {summary.confirmedPoints} supported draft points{summary.provisionalGrade ? ` · Provisional ${summary.provisionalGrade}` : ""}</span>
              </div>
              {summary.incomplete > 0 && <p className="mt-2 text-xs text-muted">{summary.incomplete} unassessed criteria; no grade is calculated until the whole-call review is complete.</p>}
            </article>
          ))}
        </section>
      )}

      {provisionalResult.error ? (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950" role="status">Provisional assessments are temporarily unavailable. Official grades remain governed by the saved scorecard and review gates.</section>
      ) : provisionalAssessments.length > 0 ? (
        <section className="space-y-3" aria-label="Provisional M4 assessments">
          <div><h2 className="text-lg font-semibold text-ink">Provisional assessments · Human review required</h2><p className="mt-1 text-sm leading-6 text-muted">These saved AI candidates have no verified criterion decisions or grade. Reviewer-authored worksheets, where available, are displayed separately above.</p></div>
          {provisionalAssessments.map((assessment) => {
            const analysis = one(assessment.call_analyses);
            const call = analysis ? one(analysis.calls) : null;
            const calculation = recordValue(assessment.calculation);
            const rubric = recordValue(calculation.rubric);
            const criterionCount = Array.isArray(calculation.criteria) ? calculation.criteria.length : 0;
            return (
              <article key={assessment.id} className="rounded-xl border border-blue-200 bg-blue-50/40 p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-blue-800">{typeof rubric.brand === "string" ? (rubric.brand === "abc" ? "ABC" : "Noble Sales") : "Company unavailable"}{typeof rubric.category === "string" ? ` · ${rubric.category.replaceAll("_", " ")}` : ""}{typeof rubric.version === "number" ? ` · Rubric v${rubric.version}` : ""}</p>
                    {call ? <Link href={`/calls/${call.id}`} className="mt-1 block break-words text-base font-semibold text-ink underline-offset-4 hover:text-blue-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">{safeFilename(call.original_filename)}</Link> : <p className="mt-1 text-base font-semibold text-ink">Call reference unavailable</p>}
                    <p className="mt-1 text-xs text-muted">Analysis {analysis?.review_status.replaceAll("_", " ") ?? "unavailable"} · Engine v{typeof calculation.scoringEngineVersion === "number" ? calculation.scoringEngineVersion : "unknown"} · Saved {formatCallDate(assessment.created_at)}</p>
                  </div>
                  <span className="rounded-lg border border-blue-300 bg-white px-3 py-2 text-sm font-semibold text-blue-950">Unreviewed baseline · Grade withheld</span>
                </div>
                <p className="mt-3 text-sm leading-6 text-muted">This legacy safety placeholder contains no reviewer-validated criterion decisions. It is not a zero-point employee grade; see the automated AI assessment above, if available.</p>
              </article>
            );
          })}
        </section>
      ) : null}

      {error ? (
        <section className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm leading-6 text-red-900" role="alert">
          Score results are temporarily unavailable. No grades are displayed while rubric calibration status cannot be verified. Refresh the page or contact the workspace owner.
        </section>
      ) : scores.length === 0 ? (
        <section className="rounded-xl border border-dashed border-line bg-white px-6 py-14 text-center sm:px-12">
          <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-blue-50 text-blue-800"><ClipboardCheck aria-hidden="true" className="size-5" /></span>
          <h2 className="mt-4 text-lg font-semibold text-ink">No official scorecards yet</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted">Official scorecards require a calibrated rubric and complete human review. Persisted provisional assessments remain in the section above and do not award points or grades.</p>
          <Link href="/calls" className="mt-5 inline-flex min-h-10 items-center justify-center rounded-lg bg-blue-700 px-4 text-sm font-semibold text-white hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2">Browse calls</Link>
        </section>
      ) : (
        <section className="space-y-3" aria-label="Persisted scorecards">
          {calibrationStatusUnavailable && <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950" role="status">M4 calibration status is not installed or could not be read. Persisted criteria remain visible, but no official grades are shown.</p>}
          <p className="text-xs text-muted">Showing the newest {scores.length} persisted result{scores.length === 1 ? "" : "s"} (maximum 100).</p>
          {scores.map((score) => {
            const rubric = one(score.rubric_versions);
            const analysis = one(score.call_analyses);
            const call = analysis ? one(analysis.calls) : null;
            const analysisReviewStatus = analysis?.review_status ?? "unknown";
            const view = scoreView(scoreSummary(score, analysis?.review_status ?? null, call?.call_type ?? null));
            const official = view.official;

            return (
              <article key={score.id} className="rounded-xl border border-line bg-white p-5 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{rubric ? `${rubric.brand === "abc" ? "ABC" : "Noble Sales"} · ${rubric.category.replaceAll("_", " ")} · Rubric v${rubric.version}` : "Versioned rubric unavailable"}</p>
                    {call ? (
                      <Link href={`/calls/${call.id}`} className="mt-2 block break-words text-base font-semibold text-ink underline-offset-4 hover:text-blue-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">{call.original_filename}</Link>
                    ) : <h2 className="mt-2 text-base font-semibold text-ink">Call reference unavailable</h2>}
                    <p className="mt-1 text-xs text-muted">{call?.call_type?.replaceAll("_", " ") ?? rubric?.category.replaceAll("_", " ") ?? "Category unavailable"} · Analysis {analysisReviewStatus.replaceAll("_", " ")} · Engine v{score.scoring_version} · Saved {formatCallDate(score.created_at)}</p>
                  </div>
                  {official ? (
                    <span className="inline-flex w-fit rounded-full bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-900">{view.officialPoints}/{view.maxPoints ?? "—"} points · {view.officialGrade}</span>
                  ) : view.calibrationPending ? (
                    <span className="inline-flex w-fit rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-950">Not Scored · Calibration Pending</span>
                  ) : calibrationStatusUnavailable ? (
                    <span className="inline-flex w-fit rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-950">Not Scored · Calibration Status Unavailable</span>
                  ) : (
                    <span className="inline-flex w-fit rounded-lg border border-line bg-stone-50 px-3 py-2 text-sm font-semibold text-ink">Not Scored · Needs Human Review</span>
                  )}
                </div>

                {view.calibrationPending && view.provisionalPoints !== null && (
                  <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"><strong>Provisional calculation — not an official grade:</strong> {view.provisionalPoints}/{view.maxPoints ?? "—"} provisional points{view.provisionalGrade ? ` · provisional ${view.provisionalGrade}` : ""}.</p>
                )}
                {view.reviewReasons.length > 0 && (
                  <div className="mt-4 border-t border-line pt-3">
                    <p className="text-xs font-semibold text-muted">Review reasons</p>
                    <ul className="mt-2 flex flex-wrap gap-2">{view.reviewReasons.map((reason) => <li key={reason} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">{reasonLabel(reason)}</li>)}</ul>
                  </div>
                )}
                <details className="mt-4 border-t border-line pt-3">
                  <summary className="cursor-pointer rounded-sm text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">Review criteria and evidence</summary>
                  {view.criteria.length === 0 ? <p className="mt-3 text-sm text-muted">No validated criteria are stored.</p> : (
                    <ol className="mt-3 divide-y divide-line">
                      {view.criteria.map((criterion) => (
                        <li key={criterion.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                          <div><h3 className="text-sm font-semibold text-ink">{criterion.order}. {criterion.label} <span className="font-normal capitalize text-muted">· {criterion.status.replaceAll("_", " ")}</span></h3><p className="mt-1 break-words text-sm leading-6 text-muted">{criterion.rationale}</p>{criterion.evidenceReferences.map((reference, index) => typeof reference.quote === "string" ? <blockquote key={`${criterion.id}-${index}`} className="mt-2 break-words border-l-2 border-blue-300 pl-3 text-sm text-muted">{reference.quote}</blockquote> : null)}</div>
                          <span className="text-xs text-muted">{criterion.pointsEarned === null ? `Withheld / ${criterion.pointsPossible}` : `${criterion.pointsEarned} / ${criterion.pointsPossible}${official ? " points" : " provisional points"}`}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </details>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}
