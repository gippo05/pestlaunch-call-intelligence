/**
 * Cheap, deterministic M4 *suggestions*, never an official or provisional grade.
 * M3 utterance speaker labels are model-authored and unverified. We do not infer
 * missed behaviors from absence of phrases or award points on this path.
 */
export type M4SpeakerHint = {
  start: number;
  end: number;
  speaker: "agent" | "caller" | "unknown";
  speechAct: string;
};
export type M4AutoSuggestion = {
  criterionId: string;
  status: "potentially_met";
  quote: string;
  rationale: string;
  speaker: "agent";
  evidenceSource: "model_speaker_unverified";
};
const rules: Array<{ suffix: string; pattern: RegExp; rationale: string; acts?: string[] }> = [
  { suffix: ".validate", pattern: /\b(?:i understand|i'm sorry|i hear you|that sounds|i can appreciate)\b/i,
    rationale: "Possible customer acknowledgment; verify tone and context." },
  { suffix: ".confidence_statement", pattern: /\b(?:we can help|happy to help|let me assist|we will help)\b/i,
    rationale: "Possible confidence or help statement; check against the business procedure." },
  { suffix: ".investigate", pattern: /\?/, acts: ["question"],
    rationale: "Possible investigating question; confirm it addresses the customer's need." },
  { suffix: ".summary_statement", pattern: /\b(?:to recap|you mentioned|so you're|let me summarize)\b/i,
    rationale: "Possible summary of the caller's situation; verify completeness." },
  { suffix: ".present_solution", pattern: /\b(?:inspection|our technician|recommend|schedule a visit|we can inspect)\b/i,
    rationale: "Potential solution or inspection offer; confirm it was appropriate, not a promised booking." },
  { suffix: ".consensus", pattern: /\b(?:does that work|does that sound|are you comfortable|is that okay)\b/i,
    rationale: "Possible consensus question; verify a meaningful customer response." },
  { suffix: ".close", pattern: /\b(?:would you like to schedule|can we set up|shall we book)\b/i,
    rationale: "Possible closing question; verify consent, not an inferred booking." },
  { suffix: ".pricing", pattern: /\$\s?\d|\b(?:price|cost|estimate|quote|fee)\b/i,
    rationale: "Possible pricing discussion; verify no price was invented." },
  { suffix: ".provide_conclusion", pattern: /\b(?:to summarize|next step|call back|once you have permission)\b/i,
    rationale: "Potential closing guidance; confirm the final outcome." },
  { suffix: ".offer_final_information", pattern: /\b(?:anything else|other questions|further questions)\b/i,
    rationale: "Potential offer to answer remaining questions." },
  { suffix: ".thank_customer", pattern: /\b(?:thank you|thanks for calling)\b/i,
    rationale: "Possible courtesy close from the employee." },
  { suffix: ".validate_confidence_statement", pattern: /\b(?:i understand|we can help|let me assist)\b/i,
    rationale: "Possible retention validation; compare with the approved handling procedure." },
  { suffix: ".do_your_research", pattern: /\b(?:let me check|looking at your account|previous visit)\b/i,
    rationale: "Possible account research; verify actual actions." },
  { suffix: ".validate_summary_statement", pattern: /\b(?:to recap|you mentioned|so you're)\b/i,
    rationale: "Possible retention summary; reviewer should verify it." },
  { suffix: ".leave_teaser", pattern: /\b(?:look forward|next time|future service)\b/i,
    rationale: "Possible future-service invitation; verify it suits the call." },
];

export function deriveM4AutoSuggestions(
  category: string | null | undefined,
  transcript: string,
  speakerSegments: unknown,
): M4AutoSuggestion[] {
  if (!["sales", "general_office", "retention"].includes(category ?? "") ||
      !Array.isArray(speakerSegments) || !transcript.trim()) return [];
  const unique = new Set<string>();
  const suggestions: M4AutoSuggestion[] = [];
  for (const segment of speakerSegments) {
    if (!segment || typeof segment !== "object" || segment.speaker !== "agent" ||
        !Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) ||
        segment.start < 0 || segment.end <= segment.start ||
        segment.end > transcript.length || segment.end - segment.start > 1500) continue;
    const spoken = transcript.slice(segment.start, segment.end);
    if (!spoken.trim()) continue;
    for (const rule of rules) {
      const criterionId = `${category}${rule.suffix}`;
      if (unique.has(criterionId) || !rule.pattern.test(spoken) ||
          (rule.acts && !rule.acts.includes(segment.speechAct))) continue;
      const quote = spoken.slice(0, 500).trim();
      if (quote.length < 8) continue;
      unique.add(criterionId);
      suggestions.push({
        criterionId,
        status: "potentially_met",
        quote,
        rationale: rule.rationale,
        speaker: "agent",
        evidenceSource: "model_speaker_unverified",
      });
    }
  }
  return suggestions.slice(0, 17);
}
