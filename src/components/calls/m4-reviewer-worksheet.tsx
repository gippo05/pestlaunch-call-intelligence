"use client";

import { useMemo, useState } from "react";
import { DEFAULT_RUBRIC_REGISTRY } from "@/lib/scoring/rubrics";
import type { M4AutoSuggestion } from "@/lib/scoring/m4-auto-suggestions";
import {
  summarizeReviewWorksheet,
  type ReviewWorksheetInput,
  type ReviewWorksheetObservation,
  type ReviewWorksheetSummary,
} from "@/lib/scoring/review-worksheet";

const tips: Record<string, string> = {
  validate: "Acknowledge the customer's situation before moving to the next step.",
  investigate: "Ask a specific clarifying question before proposing a treatment.",
  confidence_statement: "Explain what is known and what requires an inspection without promising a diagnosis.",
  present_solution: "Explain the next practical option and the limits of what can be confirmed.",
  pricing: "Clarify price or quote timing; do not invent fees.",
  close: "Confirm the customer's decision, consent, and next action.",
  provide_conclusion: "Summarize the outcome and whether a follow-up was agreed.",
  thank_customer: "Close warmly and thank the customer.",
};

function coachingFor(criterionId: string) {
  const match = Object.entries(tips).find(([key]) => criterionId.includes(key));
  return match?.[1] ?? "Revisit this part of the call and align the response with the relevant handling standard.";
}

type Props = {
  callId: string;
  rubricKey: keyof typeof DEFAULT_RUBRIC_REGISTRY;
  transcript: string;
  editable: boolean;
  initial: ReviewWorksheetInput | null;
  reviewerLabel: string | null;
  suggestions?: M4AutoSuggestion[];
};

export function M4ReviewerWorksheet({ callId, rubricKey, transcript, editable, initial, reviewerLabel, suggestions = [] }: Props) {
  const rubric = DEFAULT_RUBRIC_REGISTRY[rubricKey];
  const [observations, setObservations] = useState<ReviewWorksheetObservation[]>(initial?.observations ?? []);
  const [wholeCallReviewed, setWholeCallReviewed] = useState(initial?.wholeCallReviewed ?? false);
  const [objectionState, setObjectionState] = useState<ReviewWorksheetInput["objectionState"]>(initial?.objectionState ?? "unknown");
  const [saved, setSaved] = useState<ReviewWorksheetSummary | null>(initial ? summarizeReviewWorksheet(initial, rubric) : null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const excerpts = useMemo(() => transcript.split(/\n\s*\n/).map(s => s.trim().slice(0, 500)).filter(s => s.length >= 8).slice(0, 150), [transcript]);
  const update = (id: string, change: Partial<ReviewWorksheetObservation>) => {
    setObservations((current) => {
      const previous = current.find((item) => item.criterionId === id) ?? {
        criterionId: id,
        status: "insufficient_evidence" as const,
        rationale: "",
        evidenceQuote: "",
        agentConfirmed: false,
      };
      const next = { ...previous, ...change };
      return [...current.filter(item => item.criterionId !== id), next];
    });
    setDirty(true);
    setMessage("");
  };

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch(`/api/calls/${encodeURIComponent(callId)}/score-review`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observations, wholeCallReviewed, objectionState }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(typeof data.message === "string" ? data.message : "Could not save reviewer worksheet.");
      }
      setSaved(data.summary as ReviewWorksheetSummary);
      setDirty(false);
      setMessage("Saved locally to this private workspace as a provisional reviewer assessment.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-blue-200 bg-white p-5 sm:p-6" aria-labelledby="m4-reviewer-title">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-blue-800">M4 · Reviewer-assisted call handling QA</p>
        <h2 id="m4-reviewer-title" className="mt-1 text-lg font-semibold text-ink">Working scorecard · {rubric.maxPoints} criteria</h2>
        <p className="mt-2 text-sm leading-6 text-muted">Based on the supplied Sales / ABC / Noble call-handling scorecard structure. Mark each criterion only after checking the call. Excerpts and speaker identity need reviewer confirmation. This worksheet is <strong>not an official PestLaunch grade</strong>; rubric calibration and the M4 approval workflow remain separate.</p>
      </div>
      <div className="rounded-lg bg-blue-50 p-4 text-sm text-blue-950" role="status">
        {saved ? (
          <p><strong>{saved.covered} of {saved.maxPoints} criteria assessed.</strong> {saved.confirmedPoints} supported draft points. {saved.incomplete} still unassessed. {saved.provisionalGrade ? `Provisional band: ${saved.provisionalGrade}.` : "No grade while criteria remain incomplete."}</p>
        ) : <p><strong>No reviewer worksheet saved yet.</strong> The existing 0-point AI placeholder is not an employee performance score.</p>}
        {dirty && <p className="mt-2 font-semibold">Unsaved edits are not included in the summary above.</p>}
        {reviewerLabel && <p className="mt-1 text-xs">Last saved by reviewer: {reviewerLabel}</p>}
      </div>
      {!editable ? <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-950">Only workspace owners and reviewers can save M4 assessments. You can still view the saved summary.</p> : (
        <>
          <label className="flex gap-3 rounded-lg border border-line p-3 text-sm">
            <input type="checkbox" className="mt-1 size-4" checked={wholeCallReviewed}
              onChange={(e) => { setWholeCallReviewed(e.target.checked); if (!e.target.checked) setObjectionState("unknown"); setDirty(true); }}/>
            <span><strong>I reviewed the complete call and transcript.</strong> Check only after genuinely examining the source; this does not mark the AI analysis as officially validated.</span>
          </label>
          {rubric.category === "sales" && (
            <label className="block text-sm font-semibold text-ink">
              Customer objections
              <select className="mt-1 w-full rounded-md border border-line bg-white p-2 text-sm" value={objectionState}
                onChange={(event) => {
                  const next = event.target.value as ReviewWorksheetInput["objectionState"];
                  setObjectionState(next);
                  if (next === "none_confirmed") {
                    setObservations(items => items.filter(item => !rubric.criteria.some(c => c.id === item.criterionId && c.applicability === "sales_objection")));
                  }
                  setDirty(true);
                }}>
                <option value="unknown">Not verified / unknown</option>
                <option value="present">Customer objection present</option>
                <option value="none_confirmed" disabled={!wholeCallReviewed}>No objection — confirmed after entire call review (+4 manual points)</option>
              </select>
            </label>
          )}
          <div className="space-y-2">
            {rubric.criteria.map((criterion) => {
              const item = observations.find(o => o.criterionId === criterion.id);
              const automatic = criterion.applicability === "sales_objection" && wholeCallReviewed && objectionState === "none_confirmed";
              const candidate = suggestions.find(s => s.criterionId === criterion.id);
              return <details key={criterion.id} className="rounded-lg border border-line p-3">
                <summary className="cursor-pointer text-sm font-semibold text-ink">{criterion.order}. {criterion.label} <span className="ml-2 font-normal text-muted">{automatic ? "Automatically awarded (+1 draft point)" : item?.status === "met" ? "Marked met" : item?.status === "missed" ? "Marked missed" : "Needs assessment"}</span></summary>
                {automatic ? <p className="mt-3 text-sm text-muted">The Sales manual provides this point when the reviewer confirms no objection during the entire call.</p> : (
                  <div className="mt-4 grid gap-3">
                    {candidate && <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">
                      <p className="font-semibold">AI evidence candidate · not reviewed</p>
                      <blockquote className="my-2 border-l-2 border-blue-400 pl-2">{candidate.quote}</blockquote>
                      <button type="button" className="rounded-md border border-blue-500 bg-white px-3 py-2 text-xs font-semibold text-blue-800"
                        onClick={() => update(criterion.id, {
                          status: "met",
                          evidenceQuote: candidate.quote,
                          rationale: candidate.rationale,
                          agentConfirmed: false,
                        })}>Use as unverified draft (confirm speaker and rationale)</button>
                    </div>}
                    <label className="text-xs font-semibold text-ink">Reviewer decision
                      <select value={item?.status ?? "insufficient_evidence"} className="mt-1 w-full rounded-md border border-line bg-white p-2 text-sm"
                        onChange={(e) => update(criterion.id, {
                          status: e.target.value as ReviewWorksheetObservation["status"],
                          ...(e.target.value === "insufficient_evidence" ? { evidenceQuote: "", agentConfirmed: false } : {}),
                        })}>
                        <option value="insufficient_evidence">Not assessed / insufficient evidence</option>
                        <option value="met">Met (+1 point)</option>
                        <option value="missed">Missed (0 points; requires full-call review)</option>
                      </select>
                    </label>
                    {item?.status !== "insufficient_evidence" && item && <>
                      <label className="text-xs font-semibold text-ink">Choose exact transcript excerpt
                        <select className="mt-1 w-full rounded-md border border-line bg-white p-2 text-sm"
                          value={excerpts.includes(item.evidenceQuote) ? item.evidenceQuote : ""}
                          onChange={e => update(criterion.id, { evidenceQuote: e.target.value, agentConfirmed: false })}>
                          <option value="">Select a transcript passage...</option>
                          {excerpts.map((excerpt, i) => <option value={excerpt} key={i}>{excerpt.slice(0, 110)}{excerpt.length > 110 ? "…" : ""}</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-semibold text-ink">Or paste a shorter verbatim excerpt
                        <textarea rows={2} className="mt-1 w-full rounded-md border border-line p-2 text-sm" maxLength={550}
                          value={item.evidenceQuote} onChange={e => update(criterion.id, { evidenceQuote: e.target.value, agentConfirmed: false })} />
                      </label>
                      <label className="flex gap-2 text-xs leading-5 text-ink">
                        <input type="checkbox" className="mt-1" checked={item.agentConfirmed}
                          onChange={e => update(criterion.id, { agentConfirmed: e.target.checked })}/>
                        I confirmed the quoted words were spoken by the employee, not the caller.
                      </label>
                      <label className="text-xs font-semibold text-ink">Why this criterion was met or missed
                        <textarea className="mt-1 w-full rounded-md border border-line p-2 text-sm" rows={2} maxLength={400}
                          placeholder="Explain what this excerpt demonstrates in the full-call context."
                          value={item.rationale} onChange={e => update(criterion.id, { rationale: e.target.value })}/>
                      </label>
                    </>}
                  </div>
                )}
              </details>;
            })}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={save} disabled={saving}
              className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60">
              {saving ? "Saving…" : "Save provisional review"}
            </button>
            {message && <p className="text-sm text-muted" role="status">{message}</p>}
          </div>
        </>
      )}
      {saved && saved.criteria.some(c => c.status === "missed") && <div className="rounded-lg border border-line p-4">
        <h3 className="text-sm font-semibold text-ink">Reviewer coaching opportunities · provisional</h3>
        <ul className="mt-3 space-y-3 text-sm">{saved.criteria.filter(c => c.status === "missed").map(c =>
          <li key={c.id}><strong>{c.label}:</strong> {coachingFor(c.id)} {c.quote && <blockquote className="mt-1 border-l-2 border-blue-200 pl-3 text-muted">{c.quote}</blockquote>}</li>
        )}</ul>
      </div>}
    </section>
  );
}
