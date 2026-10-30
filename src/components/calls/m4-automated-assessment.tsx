"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export type M4AiAssessmentRow = {
  status: string;
  calculation: unknown;
  error_code: string | null;
  updated_at: string;
};

type Criterion = {
  id: string;
  label: string;
  order: number;
  status: "met" | "missed" | "insufficient_evidence";
  pointsEarned: number | null;
  quote: string | null;
  rationale: string;
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readCalculation(value: unknown) {
  if (!isRecord(value) || value.schemaVersion !== "m4.ai-provisional.v1" ||
      !Array.isArray(value.criteria) || typeof value.provisionalPoints !== "number" ||
      typeof value.maxPoints !== "number" || typeof value.assessedCriteria !== "number") return null;
  const criteria:Criterion[] = [];
  for (const raw of value.criteria) {
    if (!isRecord(raw) || typeof raw.id !== "string" ||
        typeof raw.label !== "string" || typeof raw.order !== "number" ||
        (raw.status !== "met" && raw.status !== "missed" && raw.status !== "insufficient_evidence") ||
        (raw.pointsEarned !== null && typeof raw.pointsEarned !== "number")) return null;
    criteria.push({
      id: raw.id, label: raw.label, order: raw.order,
      status: raw.status, pointsEarned: raw.pointsEarned,
      quote: typeof raw.quote === "string" ? raw.quote : null,
      rationale: typeof raw.rationale === "string" ? raw.rationale : "",
    });
  }
  if (criteria.length !== value.maxPoints) return null;
  return { criteria, points:value.provisionalPoints, max:value.maxPoints, assessed:value.assessedCriteria };
}

export function M4AutomatedAssessment({
  callId, analysisReady, allowedToDispatch, assessment,
}: {
  callId:string;
  analysisReady:boolean;
  allowedToDispatch:boolean;
  assessment:M4AiAssessmentRow | null;
}) {
  const router = useRouter();
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const pending = analysisReady && (!assessment || assessment.status === "processing");
  const calculation = assessment?.status === "completed" ? readCalculation(assessment.calculation) : null;

  useEffect(() => {
    if (!analysisReady || !allowedToDispatch || assessment) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/calls/" + encodeURIComponent(callId) + "/auto-score", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
          cache: "no-store",
        });
        if (!res.ok && !cancelled) {
          setDispatchError("Automated scoring could not be started. Please check the M4 service.");
        }
        if (res.ok && !cancelled) router.refresh();
      } catch {
        if (!cancelled) setDispatchError("Automated scoring could not be started.");
      }
    })();
    return () => { cancelled = true; };
  }, [callId, analysisReady, allowedToDispatch, assessment, router]);

  useEffect(() => {
    if (!pending || dispatchError) return;
    let checks = 0;
    const interval = window.setInterval(() => {
      checks += 1;
      router.refresh();
      if (checks >= 50) window.clearInterval(interval);
    }, 3000);
    return () => window.clearInterval(interval);
  }, [pending, dispatchError, router]);

  if (!analysisReady) return null;
  return <section aria-labelledby="m4-ai-heading"
    className="rounded-xl border border-blue-200 bg-white p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-blue-700">Automatic AI assessment</p>
        <h2 id="m4-ai-heading" className="mt-1 text-lg font-semibold text-ink">Provisional AI scorecard</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">Assesses all rubric criteria using the saved transcript. No manual grading is needed to generate this first-pass report.</p>
      </div>
      {calculation &&
        <span className="rounded-lg bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-950">
          {calculation.points} tentative points · {calculation.assessed}/{calculation.max} assessed
        </span>}
    </div>
    <p className="mt-3 text-xs leading-5 text-amber-900">
      AI provisional only — not an official employee grade. Speaker labels, behavior judgments,
      call completeness and rubric calibration still require validation. Unassessed items are not counted as failures.
    </p>
    {dispatchError && <p role="alert" className="mt-4 text-sm text-red-800">{dispatchError}</p>}
    {!dispatchError && pending && <p role="status" className="mt-4 text-sm text-blue-800">
      {assessment ? "Gemini is checking the saved transcript against the rubric…" :
      allowedToDispatch ? "Starting automated scoring…" : "Automated scoring is available to workspace reviewers."}
    </p>}
    {assessment?.status === "failed" && <p role="alert" className="mt-4 text-sm text-amber-900">
      Automatic grading could not complete ({assessment.error_code ?? "unknown"}).
      The transcript and reviewer worksheet remain available; no official score was changed.
    </p>}
    {assessment?.status === "completed" && !calculation &&
      <p role="alert" className="mt-4 text-sm text-red-800">The saved AI assessment has an unsupported format.</p>}
    {calculation && <ol className="mt-4 divide-y divide-line">
      {calculation.criteria.map((criterion) => <li key={criterion.id} className="py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">{criterion.order}. {criterion.label}</h3>
          <span className="rounded-md bg-stone-100 px-2 py-1 text-xs font-semibold text-stone-700">
            {criterion.status === "met" ? "Potentially met · +1" :
              criterion.status === "missed" ? "Potentially missed · 0" : "Insufficient evidence · unscored"}
          </span>
        </div>
        <p className="mt-1 text-sm leading-6 text-muted">{criterion.rationale}</p>
        {criterion.quote && <blockquote className="mt-2 border-l-2 border-blue-300 pl-3 text-sm italic text-ink">
          “{criterion.quote}”
        </blockquote>}
      </li>)}
    </ol>}
  </section>;
}
