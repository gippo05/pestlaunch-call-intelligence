import { describe, it, expect } from "vitest";
import { deriveM4AutoSuggestions } from "./m4-auto-suggestions";
import { assessM3Quality, parseM3Analysis } from "../../../supabase/functions/_shared/m3-analysis";

const caller = "Can you help me with ants?";
const agent = "Thank you for calling. Have you seen any ants?";
const transcript = caller + "\n\n" + agent;
const speakerSegments = [
  { start: 0, end: caller.length, speaker: "caller", speechAct: "question" },
  { start: caller.length + 2, end: transcript.length, speaker: "agent", speechAct: "question" },
] as const;

describe("M3 speaker-source to M4 candidate scoring handoff", () => {
  it("proposes only evidence-linked, reviewer-pending employee behavior, never points", () => {
    const suggestions = deriveM4AutoSuggestions("sales", transcript, speakerSegments);
    expect(suggestions.map(item => item.criterionId)).toContain("sales.thank_customer");
    expect(suggestions.map(item => item.criterionId)).toContain("sales.investigate");
    expect(suggestions.every(item => item.status === "potentially_met")).toBe(true);
    expect(suggestions.every(item => transcript.includes(item.quote))).toBe(true);
    expect(suggestions.every(item => item.evidenceSource === "model_speaker_unverified")).toBe(true);
    expect(suggestions.some(item => "points" in item || "grade" in item)).toBe(false);
  });
  it("does not credit caller statements as employee actions", () => {
    const callerOnly = "Thank you. Can I book an inspection?";
    const result = deriveM4AutoSuggestions("sales", callerOnly, [
      { start: 0, end: callerOnly.length, speaker: "caller", speechAct: "question" },
    ]);
    expect(result).toEqual([]);
  });
  it("fails closed when speaker segments are unavailable or malformed", () => {
    expect(deriveM4AutoSuggestions("sales", transcript, undefined)).toEqual([]);
    expect(deriveM4AutoSuggestions("sales", transcript, [
      { start: 0, end: transcript.length + 1, speaker: "agent", speechAct: "question" },
    ])).toEqual([]);
  });
  it("preserves optional unverified model-speaker spans and suggestions in private M3 quality metadata", () => {
    const payload = {
      transcript,
      intent: "sales",
      confirmedFacts: [],
      customerConcerns: [],
      outcome: { status: "unknown", summary: "", evidence: "" },
      intentEvidence: caller,
      anchors: { beginning: caller, middle: caller, ending: agent },
      uncertainty: { facts: true, speaker: false },
      confidence: null,
      speakerSegments,
    };
    const saved = assessM3Quality(parseM3Analysis(JSON.stringify(payload), "gemini-test"));
    expect(saved.qualityIndicators.speaker_segments).toHaveLength(2);
    expect(saved.qualityIndicators.m4_auto_suggestions?.map(x => x.criterionId)).toContain("sales.thank_customer");
    expect(saved.reviewStatus).toBe("review_required");
  });
  it("rejects ungrounded or tampered speaker spans during M3 validation", () => {
    const payload = {
      transcript, intent: "sales", confirmedFacts: [], customerConcerns: [],
      outcome: { status: "unknown", summary: "", evidence: "" }, intentEvidence: caller,
      anchors: { beginning: caller, middle: caller, ending: agent },
      uncertainty: { facts: true, speaker: false }, confidence: null,
      speakerSegments: [
        { start: 0, end: caller.length + 10, speaker: "agent", speechAct: "question" },
        speakerSegments[1],
      ],
    };
    expect(() => parseM3Analysis(JSON.stringify(payload), "gemini-test")).toThrow();
  });
});