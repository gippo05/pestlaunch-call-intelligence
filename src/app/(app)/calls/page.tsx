import { ArrowDown, ArrowUp, Headphones, Upload } from "lucide-react";
import Link from "next/link";
import { CallLibraryFiltersForm } from "@/components/calls/call-library-filters";
import { CallProcessingRefresh } from "@/components/calls/call-processing-refresh";
import { CallStatusBadge } from "@/components/calls/call-status-badge";
import { UploadCallForm } from "@/components/calls/upload-call-form";
import { requireUser } from "@/lib/auth/session";
import {
  callPageHref,
  CALL_PAGE_SIZE,
  categoryLabel,
  companyLabel,
  formatCallDate,
  formatCallDuration,
  isCalibrationColumnUnavailable,
  needsHumanReview,
  parseCallLibraryFilters,
  recordValue,
  safeFilename,
  selectApplicableScore,
  scoreView,
  type ScoreSummary,
  type SearchParams,
} from "@/lib/calls/review-view";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type AnalysisRow = {
  id: string;
  call_id: string;
  version: number;
  outcome: unknown;
  review_status: string;
  processed_at: string | null;
};

type CallRow = {
  id: string;
  original_filename: string;
  brand: string;
  call_type: string | null;
  status: string;
  duration_seconds: number | null;
  created_at: string;
  call_analyses: AnalysisRow | AnalysisRow[] | null;
};
type ReviewQueueRow = Omit<CallRow, "call_analyses"> & {
  latest_analysis_id: string | null;
  latest_analysis_version: number | null;
  latest_analysis_outcome: unknown;
  latest_analysis_review_status: string | null;
  latest_analysis_processed_at: string | null;
};

type RubricRow = { brand: string; category: string; version: number; calibration_status?: "manual_calibration_required" | "owner_approved" | null };
type PersistedScoreRow = {
  id: string;
  analysis_id: string;
  total_score: number | string | null;
  grade: string | null;
  requires_human_review: boolean;
  criterion_results: unknown;
  created_at: string;
  rubric_versions: RubricRow | RubricRow[] | null;
};

const callSelect = "id,original_filename,brand,call_type,status,duration_seconds,created_at,call_analyses(id,call_id,version,outcome,review_status,processed_at)";
const reviewQueueSelect = "id,original_filename,brand,call_type,status,duration_seconds,created_at,latest_analysis_id,latest_analysis_version,latest_analysis_outcome,latest_analysis_review_status,latest_analysis_processed_at";
const scoreSelect = "id,analysis_id,total_score,grade,requires_human_review,criterion_results,created_at,rubric_versions!inner(brand,category,version,calibration_status)";
const scoreSelectWithoutCalibration = "id,analysis_id,total_score,grade,requires_human_review,criterion_results,created_at,rubric_versions!inner(brand,category,version)";

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function makeCallQuery(db: Awaited<ReturnType<typeof createSupabaseServerClient>>, filters: ReturnType<typeof parseCallLibraryFilters>, head = false) {
  if (filters.status === "needs_review") {
    let query = db.from("m5_call_review_queue").select(reviewQueueSelect, { count: "exact", head });
    if (filters.search) query = query.ilike("original_filename", `%${filters.search}%`);
    if (filters.brand) query = query.eq("brand", filters.brand);
    if (filters.category) query = query.eq("call_type", filters.category);
    const ascending = filters.sort === "oldest";
    return query.order("created_at", { ascending }).order("id", { ascending });
  }
  let query = db.from("calls").select(callSelect, { count: "exact", head });
  if (filters.search) query = query.ilike("original_filename", `%${filters.search}%`);
  if (filters.brand) query = query.eq("brand", filters.brand);
  if (filters.category) query = query.eq("call_type", filters.category);
  if (filters.status) query = query.eq("status", filters.status);
  const ascending = filters.sort === "oldest";
  query = query.order("created_at", { ascending }).order("id", { ascending });
  query = query.order("version", { ascending: false, referencedTable: "call_analyses" });
  query = query.limit(1, { referencedTable: "call_analyses" });
  return query;
}

function matchingScore(rows: PersistedScoreRow[], analysisId: string, brand: string, category: string | null) {
  return selectApplicableScore(rows, (row) => {
    const rubric = one(row.rubric_versions);
    return rubric ? {
      analysisId: row.analysis_id,
      brand: rubric.brand,
      category: rubric.category,
      rubricVersion: rubric.version,
      createdAt: row.created_at,
    } : null;
  }, analysisId, brand, category);
}

function scoreSummary(row: PersistedScoreRow | null, analysisReviewStatus: string | null, callCategory: string | null): ScoreSummary | null {
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

function outcomeSummary(value: unknown) {
  const outcome = recordValue(value);
  return typeof outcome.summary === "string" && outcome.summary.trim() ? outcome.summary.trim() : null;
}

function reviewQueueCall(row: ReviewQueueRow): CallRow {
  return {
    id: row.id,
    original_filename: row.original_filename,
    brand: row.brand,
    call_type: row.call_type,
    status: row.status,
    duration_seconds: row.duration_seconds,
    created_at: row.created_at,
    call_analyses: row.latest_analysis_id ? {
      id: row.latest_analysis_id,
      call_id: row.id,
      version: row.latest_analysis_version ?? 1,
      outcome: row.latest_analysis_outcome,
      review_status: row.latest_analysis_review_status ?? "not_reviewed",
      processed_at: row.latest_analysis_processed_at,
    } : null,
  };
}

export default async function CallsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireUser();
  const filters = parseCallLibraryFilters(await searchParams);
  const db = await createSupabaseServerClient();

  const countResult = await makeCallQuery(db, filters, true);
  if (countResult.error) return <CallLibraryError />;
  const totalCount = countResult.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / CALL_PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const callsResult = await makeCallQuery(db, filters)
    .range((page - 1) * CALL_PAGE_SIZE, page * CALL_PAGE_SIZE - 1);
  if (callsResult.error) return <CallLibraryError />;

  const calls = filters.status === "needs_review"
    ? ((callsResult.data ?? []) as unknown as ReviewQueueRow[]).map(reviewQueueCall)
    : (callsResult.data ?? []) as unknown as CallRow[];
  const analysisIds = calls.map((call) => one(call.call_analyses)?.id).filter((id): id is string => Boolean(id));
  let scoreRows: PersistedScoreRow[] = [];
  let scoreLookupUnavailable = false;
  if (analysisIds.length > 0) {
    const scoresResult = await db.from("call_scores").select(scoreSelect)
      .in("analysis_id", analysisIds)
      .order("created_at", { ascending: false })
      .limit(100);
    if (scoresResult.error && isCalibrationColumnUnavailable(scoresResult.error)) {
      scoreLookupUnavailable = true;
      const fallback = await db.from("call_scores").select(scoreSelectWithoutCalibration)
        .in("analysis_id", analysisIds)
        .order("created_at", { ascending: false })
        .limit(100);
      if (!fallback.error) scoreRows = (fallback.data ?? []) as unknown as PersistedScoreRow[];
    } else if (scoresResult.error) scoreLookupUnavailable = true;
    else scoreRows = (scoresResult.data ?? []) as unknown as PersistedScoreRow[];
  }

  return <CallLibrary filters={filters} calls={calls} page={page} pageCount={pageCount} totalCount={totalCount} scoreRows={scoreRows} scoreLookupUnavailable={scoreLookupUnavailable} hasFilters={Boolean(filters.search || filters.brand || filters.category || filters.status)} />;
}

function CallLibrary({
  filters,
  calls,
  page,
  pageCount,
  totalCount,
  scoreRows,
  scoreLookupUnavailable,
  hasFilters,
}: {
  filters: ReturnType<typeof parseCallLibraryFilters>;
  calls: CallRow[];
  page: number;
  pageCount: number;
  totalCount: number;
  scoreRows: PersistedScoreRow[];
  scoreLookupUnavailable: boolean;
  hasFilters: boolean;
}) {
  return (
    <main className="space-y-7">
      <CallProcessingRefresh statuses={calls.map((call) => call.status)} />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-blue-800">Review workspace</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">Calls</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Find a recording, follow its processing state, and review the analysis that is available to your workspace.</p>
        </div>
        <a href="#add-call" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2">
          <Upload aria-hidden="true" className="size-4" /> Upload call
        </a>
      </div>

      <UploadCallForm />

      <section aria-labelledby="call-library-heading" className="space-y-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="call-library-heading" className="text-lg font-semibold text-ink">Call library</h2>
            <p className="mt-1 text-sm text-muted">Search filenames and filter authorized call records. Processing details come from saved call and analysis records.</p>
          </div>
          <span className="text-xs font-medium text-muted">{totalCount} {totalCount === 1 ? "call" : "calls"}</span>
        </div>

        <CallLibraryFiltersForm filters={filters} />
        {scoreLookupUnavailable && <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950" role="status">Official score data is unavailable. Grades stay hidden until the M4 calibration status can be read.</p>}

        {calls.length === 0 ? (
          <section className="rounded-xl border border-dashed border-line bg-white px-6 py-12 text-center sm:px-10">
            <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-blue-50 text-blue-800"><Headphones aria-hidden="true" className="size-5" /></span>
            <h3 className="mt-4 text-base font-semibold text-ink">{hasFilters ? "No calls match these filters" : "No calls in this workspace yet"}</h3>
            <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted">{hasFilters ? "Try a different filename, company, category, or status." : "Upload a synthetic MP3 to create a private call record. It will remain queued until processing is authorized."}</p>
            {hasFilters && <Link href="/calls" className="mt-4 inline-flex text-sm font-semibold text-blue-800 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">Clear filters</Link>}
          </section>
        ) : (
          <section className="overflow-hidden rounded-xl border border-line bg-white" aria-label="Authorized call records">
            <div className="hidden grid-cols-[minmax(15rem,2fr)_minmax(9rem,1fr)_minmax(8rem,1fr)_minmax(8rem,1fr)_minmax(8rem,1fr)] gap-4 border-b border-line bg-stone-50/80 px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted lg:grid">
              <span>Recording</span><span>Company / type</span><span>Duration</span><span>Processing</span><span>Outcome / grade</span>
            </div>
            <ul className="divide-y divide-line">
              {calls.map((call) => {
                const analysis = one(call.call_analyses);
                const savedScore = analysis ? matchingScore(scoreRows, analysis.id, call.brand, call.call_type) : null;
                const summary = scoreSummary(savedScore, analysis?.review_status ?? null, call.call_type);
                const scoring = scoreView(summary);
                const scoreRubric = one(savedScore?.rubric_versions);
                const categoryMismatch = Boolean(savedScore && scoreRubric && scoreRubric.category !== call.call_type);
                const review = needsHumanReview(call.status, analysis?.review_status ?? null, summary ? [{ requiresHumanReview: summary.requiresHumanReview }] : []);
                const outcome = analysis ? outcomeSummary(analysis.outcome) : null;
                const processedAt = analysis?.processed_at ? formatCallDate(analysis.processed_at) : "Not processed";

                return (
                  <li key={call.id} className="grid gap-3 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(15rem,2fr)_minmax(9rem,1fr)_minmax(8rem,1fr)_minmax(8rem,1fr)_minmax(8rem,1fr)] lg:items-center lg:gap-4">
                    <div className="min-w-0">
                      <Link href={`/calls/${call.id}`} className="block break-words text-sm font-semibold text-ink underline-offset-4 hover:text-blue-800 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">{safeFilename(call.original_filename)}</Link>
                      <p className="mt-1 text-xs text-muted">Created {formatCallDate(call.created_at)} · {processedAt}</p>
                      <p className="mt-2 text-xs text-muted lg:hidden">{companyLabel(call.brand)} · {categoryLabel(call.call_type)} · {formatCallDuration(call.duration_seconds)}</p>
                    </div>
                    <p className="hidden text-sm text-muted lg:block">{companyLabel(call.brand)}<span className="mt-1 block text-xs">{categoryLabel(call.call_type)}</span></p>
                    <p className="hidden text-sm text-muted lg:block">{formatCallDuration(call.duration_seconds)}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <CallStatusBadge status={call.status} />
                      {review && <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900">Needs Human Review</span>}
                    </div>
                    <div className="min-w-0 text-sm">
                      <p className="truncate text-muted" title={outcome ?? undefined}>{outcome ? `AI outcome candidate · ${outcome}` : "No outcome recorded"}</p>
                      {scoring.official ? (
                        <p className="mt-1 font-semibold text-emerald-800">{scoring.officialPoints}/{scoring.maxPoints ?? "—"} · {scoring.officialGrade}</p>
                      ) : scoring.calibrationPending ? (
                        <p className="mt-1 text-xs font-medium text-amber-900">Not Scored · Calibration Pending</p>
                      ) : savedScore && summary?.requiresHumanReview ? (
                        <p className="mt-1 text-xs font-medium text-amber-900">Not Scored · Needs Human Review</p>
                      ) : savedScore && scoreLookupUnavailable ? (
                        <p className="mt-1 text-xs font-medium text-amber-900">Not Scored · M4 status unavailable</p>
                      ) : savedScore ? (
                        <p className="mt-1 text-xs font-medium text-amber-900">Not Scored · Needs Human Review</p>
                      ) : scoreLookupUnavailable ? (
                        <p className="mt-1 text-xs text-muted">Score status unavailable</p>
                      ) : (
                        <p className="mt-1 text-xs text-muted">Not Scored</p>
                      )}
                      {categoryMismatch && <p className="mt-1 text-xs text-amber-900">Rubric category: {categoryLabel(scoreRubric?.category)} · call category differs, so the grade is withheld.</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
            {scoreLookupUnavailable && <p className="border-t border-line px-5 py-3 text-xs text-muted">M4 calibration data could not be loaded. No official grades are shown.</p>}
          </section>
        )}

        {totalCount > 0 && <nav aria-label="Call library pages" className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted">Page {page} of {pageCount} · Showing up to {CALL_PAGE_SIZE} records per page.</p>
          <div className="flex items-center gap-2">
            {page > 1 ? <Link href={callPageHref(filters, page - 1)} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm font-semibold text-ink hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700"><ArrowUp aria-hidden="true" className="size-4" /> Newer</Link> : <span className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 text-sm text-muted" aria-disabled="true"><ArrowUp aria-hidden="true" className="size-4" /> Newer</span>}
            {page < pageCount ? <Link href={callPageHref(filters, page + 1)} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm font-semibold text-ink hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">Older <ArrowDown aria-hidden="true" className="size-4" /></Link> : <span className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 text-sm text-muted" aria-disabled="true">Older <ArrowDown aria-hidden="true" className="size-4" /></span>}
          </div>
        </nav>}
      </section>
    </main>
  );
}

function CallLibraryError() {
  return (
    <main className="space-y-6">
      <div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-blue-800">Review workspace</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">Calls</h1></div>
      <section className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-900" role="alert">
        Call records are temporarily unavailable. Refresh the page or contact the workspace owner.
      </section>
    </main>
  );
}
