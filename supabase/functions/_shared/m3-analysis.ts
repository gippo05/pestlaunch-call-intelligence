import { deriveM4AutoSuggestions, type M4AutoSuggestion } from "../../../src/lib/scoring/m4-auto-suggestions.ts";

export type M3Intent = "sales" | "general_office" | "retention" | "other";
export type M3OutcomeStatus = "observed" | "unresolved" | "unknown";
export type M3TranscriptSentence = {
  id: string;
  index: number;
  start: number;
  end: number;
  text: string;
  complete: boolean;
};

type M3SentenceSpeaker = "caller" | "agent" | "unknown";
type M3SentenceAct = "statement" | "question" | "offer" | "advice" | "instruction" | "self_identification" | "greeting" | "unknown";
export type M3SpeakerSpan = {
  start: number;
  end: number;
  speaker: M3SentenceSpeaker;
  speechAct: M3SentenceAct;
};

export type M3ProviderAnalysis = {
  transcript: string;
  intent: M3Intent;
  confirmedFacts: Array<{ fact: string; evidence: string }>;
  customerConcerns: Array<{ concern: string; evidence: string }>;
  outcome: { status: M3OutcomeStatus; summary: string; evidence: string };
  intentEvidence: string | null;
  anchors: { beginning: string; middle: string; ending: string };
  uncertainty: { facts: boolean; speaker: boolean };
  confidence: number | null;
  model: string;
  /** Optional, model-suggested utterance speakers; NOT independently verified. */
  speakerSegments?: M3SpeakerSpan[];
};

export type M3PersistedAnalysis = {
  provider: "gemini";
  model: string;
  transcript: string;
  extractedFacts: {
    intent: M3Intent;
    confirmed_facts: M3ProviderAnalysis["confirmedFacts"];
    customer_concerns: M3ProviderAnalysis["customerConcerns"];
    intent_evidence: string[];
    provenance: {
      provider: "gemini";
      model: string;
      schema_version: "m3-transcript-v1";
      prompt_version: "m3.transcription.v7";
      source_completeness: "unverified";
    };
  };
  outcome: { status: M3OutcomeStatus; summary: string; evidence: string[] };
  quality: {
    sourceCompleteness: "unverified";
    anchorMatches: { beginning: boolean; middle: boolean; ending: boolean };
    anchorsInOrder: boolean;
    repeatedContent: boolean;
    truncated: boolean;
    missingBeginning: boolean;
    missingMiddle: boolean;
    missingEnding: boolean;
    uncertainty: M3ProviderAnalysis["uncertainty"];
    reviewReasons: string[];
  };
  confidence: number | null;
  callType: Exclude<M3Intent, "other"> | null;
  callStatus: "completed" | "review_required";
  reviewStatus: "not_reviewed" | "review_required";
  durationSeconds: number;
  qualityIndicators: {
    schema_version: "m3-transcript-v1";
    source_completeness: "unverified";
    needs_human_review: true;
    review_flags: string[];
    anchors: M3ProviderAnalysis["anchors"];
    /** Private, unverified model speaker hints for M4 human review only. */
    speaker_segments?: M3SpeakerSpan[];
    /** Review-only candidate observations, never scored met/missed automatically. */
    m4_auto_suggestions?: M4AutoSuggestion[];
  };
};

const ANALYSIS_KEYS = [
  "transcript",
  "intent",
  "confirmedFacts",
  "customerConcerns",
  "outcome",
  "intentEvidence",
  "anchors",
  "uncertainty",
  "confidence",
] as const;

const INTENTS = new Set<M3Intent>(["sales", "general_office", "retention", "other"]);
const OUTCOMES = new Set<M3OutcomeStatus>(["observed", "unresolved", "unknown"]);
const M3_PROVIDER_LEGACY_SENTENCE_CONTRACT_VERSION = "m3.provider-sentences.v2" as const;
export const M3_PROVIDER_UTTERANCE_CONTRACT_VERSION = "m3.provider-utterances.v1" as const;
export const M3_PROMPT_VERSION = "m3.transcription.v7" as const;
// Keep this identical to complete_m3_job's limit so valid model output cannot
// strand a leased job at the persistence boundary.
const MAX_TRANSCRIPT_LENGTH = 150_000;
const MAX_ITEMS = 100;
const MAX_EVIDENCE_LENGTH = 2_000;
const MAX_SENTENCES = 20_000;

const SENTENCE_CLOSERS = new Set([')', ']', '}', '"', "'", "’", "”", "»"]);
const CLAIM_SCOPE_PREFIX = /\b(?:no|not|never|without|if|unless|when|whenever|provided|assuming|maybe|perhaps|possibly|probably|might|may|could|should|would|seems?|appears?|think|thinks|thought|believe|believes|believed|wonder|wonders|wondered|guess|guesses|guessed|suspect|suspects|suspected|cannot|can't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't|mustn't)\b/iu;
const CLAIM_LEADING_SCOPE = /^\s*(?:if|unless|when|whenever|provided|assuming|as\s+long\s+as)\b/iu;
const CLAIM_SCOPE_SUFFIX = /(?:[,;]\s*(?:(?:and|but|though|although|yet|however)\s+)?|\b(?:and|but|though|although|yet|however)\b\s+)(?:(?:i|we|they|it)\s+)?(?:(?:am|are|is|was|were)\s+)?(?:think|thinks|thought|believe|believes|believed|guess|guesses|guessed|suspect|suspects|suspected|maybe|perhaps|possibly|probably|apparently|allegedly|reportedly|unless|if|when|whenever|provided|assuming|might|may|could|should|would|seems?|appears?|not\s+(?:sure|certain|confident)|(?:be\s+)?(?:wrong|mistaken))\b/iu;
const NON_TERMINAL_ABBREVIATIONS = new Set([
  "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "st.", "vs.", "etc.", "e.g.", "i.e.", "u.s.",
]);

/**
 * Segment the canonical transcript with fixed sentence-boundary rules. IDs are
 * derived only from position in that transcript and are never model-authored.
 */
export function segmentM3Transcript(transcript: string): M3TranscriptSentence[] {
  const sentences: M3TranscriptSentence[] = [];
  let segmentStart = 0;
  let cursor = 0;

  const append = (rawEnd: number, nextStart: number, complete: boolean) => {
    let start = segmentStart;
    let end = rawEnd;
    while (start < end && /\s/u.test(transcript[start]!)) start += 1;
    while (end > start && /\s/u.test(transcript[end - 1]!)) end -= 1;
    if (start < end) {
      const index = sentences.length;
      sentences.push({
        id: `sentence-${String(index + 1).padStart(4, "0")}`,
        index,
        start,
        end,
        text: transcript.slice(start, end),
        complete,
      });
    }
    segmentStart = nextStart;
  };

  while (cursor < transcript.length) {
    const paragraphSeparatorLength = transcript[cursor] === "\r" || transcript[cursor] === "\n"
      ? blankLineSeparatorLength(transcript, cursor)
      : 0;
    if (paragraphSeparatorLength > 0) {
      const nextStart = cursor + paragraphSeparatorLength;
      append(cursor, nextStart, false);
      cursor = nextStart;
      while (cursor < transcript.length && /\s/u.test(transcript[cursor]!)) cursor += 1;
      segmentStart = cursor;
      continue;
    }

    const boundaryEnd = sentenceBoundaryEnd(transcript, cursor);
    if (boundaryEnd === null) {
      cursor += 1;
      continue;
    }
    append(boundaryEnd, boundaryEnd, true);
    cursor = boundaryEnd;
    while (cursor < transcript.length && /\s/u.test(transcript[cursor]!)) cursor += 1;
    segmentStart = cursor;
  }

  if (segmentStart < transcript.length) append(transcript.length, transcript.length, false);
  if (sentences.length === 0 || sentences.length > MAX_SENTENCES) {
    throw invalidAnalysis("sentence_segmentation_invalid");
  }
  return sentences;
}

function blankLineSeparatorLength(transcript: string, index: number) {
  const separator = transcript.slice(index).match(/^(?:\r?\n[ \t]*){2,}/u)?.[0];
  return separator?.length ?? 0;
}

function sentenceBoundaryEnd(transcript: string, index: number): number | null {
  const character = transcript[index];
  if (character !== "." && character !== "?" && character !== "!") return null;
  if (character === "." && isNonTerminalPeriod(transcript, index)) return null;

  let end = index + 1;
  while (end < transcript.length && /[.!?]/u.test(transcript[end]!)) end += 1;
  while (end < transcript.length && SENTENCE_CLOSERS.has(transcript[end]!)) end += 1;
  return end === transcript.length || /\s/u.test(transcript[end]!) ? end : null;
}

function isNonTerminalPeriod(transcript: string, index: number) {
  const previous = transcript[index - 1] ?? "";
  const next = transcript[index + 1] ?? "";
  if (/\d/u.test(previous) && /\d/u.test(next)) return true;

  const prefix = transcript.slice(0, index + 1);
  const token = prefix.match(/(?:^|\s|[([{])([^\s([{]+)$/u)?.[1]?.toLocaleLowerCase();
  if (token && NON_TERMINAL_ABBREVIATIONS.has(token)) return true;
  if (token && /^(?:[a-z]\.){2,}$/iu.test(token)) return true;
  if (/\b[A-Z]\.$/u.test(prefix) && /^\s+[A-Z]/u.test(transcript.slice(index + 1))) return true;
  return false;
}

export function parseM3Analysis(candidateText: string, model: string): M3ProviderAnalysis {
  let value: unknown;
  try {
    value = JSON.parse(candidateText);
  } catch {
    throw invalidAnalysis("invalid_json");
  }

  if (!isRecord(value) || !hasExactKeys(value, "speakerSegments" in value
    ? [...ANALYSIS_KEYS, "speakerSegments"] : ANALYSIS_KEYS)) throw invalidAnalysis("top_level_shape");

  const transcript = requireTranscript(value.transcript);

  if (typeof value.intent !== "string" || !INTENTS.has(value.intent as M3Intent)) throw invalidAnalysis("intent_invalid");

  const confirmedFacts = parseEvidenceItems(value.confirmedFacts, "fact", transcript);
  const customerConcerns = parseEvidenceItems(value.customerConcerns, "concern", transcript);

  if (!isRecord(value.outcome) || !hasExactKeys(value.outcome, ["status", "summary", "evidence"])) {
    throw invalidAnalysis("outcome_shape");
  }
  if (typeof value.outcome.status !== "string" || !OUTCOMES.has(value.outcome.status as M3OutcomeStatus)) {
    throw invalidAnalysis("outcome_status");
  }
  let outcomeSummary: string;
  let outcomeEvidence: string;
  if (value.outcome.status === "unknown" && value.outcome.summary === "" && value.outcome.evidence === "") {
    outcomeSummary = "";
    outcomeEvidence = "";
  } else {
    outcomeSummary = requireEvidence(value.outcome.summary, transcript);
    outcomeEvidence = requireEvidence(value.outcome.evidence, transcript);
    if (!outcomeEvidence.includes(outcomeSummary)) throw invalidAnalysis("claim_not_within_evidence");
  }
  const outcome = {
    status: value.outcome.status as M3OutcomeStatus,
    summary: outcomeSummary,
    evidence: outcomeEvidence,
  };

  const intentEvidence = value.intentEvidence === null && value.intent === "other"
    ? null
    : requireEvidence(value.intentEvidence, transcript);
  if (intentEvidence === null && value.intent !== "other") throw invalidAnalysis("intent_invalid");

  if (!isRecord(value.anchors) || !hasExactKeys(value.anchors, ["beginning", "middle", "ending"])) {
    throw invalidAnalysis("anchors_shape");
  }
  const anchors = {
    beginning: requireEvidence(value.anchors.beginning, transcript),
    middle: requireEvidence(value.anchors.middle, transcript),
    ending: requireEvidence(value.anchors.ending, transcript),
  };

  if (!isRecord(value.uncertainty) || !hasExactKeys(value.uncertainty, ["facts", "speaker"])) {
    throw invalidAnalysis("uncertainty_shape");
  }
  if (typeof value.uncertainty.facts !== "boolean" || typeof value.uncertainty.speaker !== "boolean") {
    throw invalidAnalysis("uncertainty_type");
  }

  const confidence = value.confidence;
  if (confidence !== null && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw invalidAnalysis("confidence_invalid");
  }

  const speakerSegments: M3SpeakerSpan[] | undefined = value.speakerSegments === undefined
    ? undefined
    : validateM3SpeakerSegments(value.speakerSegments, transcript);
  const safeModel = requireText(model, 120);
  return {
    transcript,
    intent: value.intent as M3Intent,
    confirmedFacts,
    customerConcerns,
    outcome,
    intentEvidence,
    anchors,
    uncertainty: { facts: value.uncertainty.facts, speaker: value.uncertainty.speaker },
    confidence,
    model: safeModel,
    ...(speakerSegments ? { speakerSegments } : {}),
  };
}

function validateM3SpeakerSegments(value: unknown, transcript: string): M3SpeakerSpan[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SENTENCES) {
    throw invalidAnalysis("utterance_schema_invalid");
  }
  let expectedStart = 0;
  return value.map((item, index) => {
    if (!isRecord(item) || !hasExactKeys(item, ["start", "end", "speaker", "speechAct"]) ||
      !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) ||
      (item.start as number) !== expectedStart ||
      (item.end as number) <= (item.start as number) ||
      (item.end as number) > transcript.length ||
      !["caller", "agent", "unknown"].includes(String(item.speaker)) ||
      !["statement", "question", "offer", "advice", "instruction", "self_identification", "greeting", "unknown"].includes(String(item.speechAct))) {
      throw invalidAnalysis("utterance_schema_invalid");
    }
    const segment = {
      start: item.start as number, end: item.end as number,
      speaker: item.speaker as M3SentenceSpeaker,
      speechAct: item.speechAct as M3SentenceAct,
    };
    if (!transcript.slice(segment.start, segment.end).trim()) throw invalidAnalysis("utterance_schema_invalid");
    expectedStart = segment.end + (index < value.length - 1 ? 2 : 0);
    if (index < value.length - 1 && transcript.slice(segment.end, expectedStart) !== "\n\n") {
      throw invalidAnalysis("utterance_schema_invalid");
    }
    if (index === value.length - 1 && segment.end !== transcript.length) {
      throw invalidAnalysis("utterance_schema_invalid");
    }
    return segment;
  });
}

export function assessM3Quality(analysis: M3ProviderAnalysis): M3PersistedAnalysis {
  const { transcript } = analysis;
  const sentences = segmentM3Transcript(transcript);
  const beginningSentence = sentences[0]!;
  const middleSentence = sentences.reduce((closest, sentence) =>
    Math.abs(sentence.start + (sentence.end - sentence.start) / 2 - transcript.length / 2) <
        Math.abs(closest.start + (closest.end - closest.start) / 2 - transcript.length / 2)
      ? sentence
      : closest);
  const endingSentence = sentences[sentences.length - 1]!;
  const anchors = {
    beginning: beginningSentence.text,
    middle: middleSentence.text,
    ending: endingSentence.text,
  };
  const anchorsInOrder = beginningSentence.index < middleSentence.index && middleSentence.index < endingSentence.index;
  const beginningTolerance = Math.min(120, Math.max(12, Math.ceil(transcript.length * 0.2)));
  const beginningMatches = beginningSentence.start <= beginningTolerance && beginningSentence.complete;
  const middleMatches = middleSentence.start >= transcript.length * 0.2 &&
    middleSentence.start <= transcript.length * 0.8 && middleSentence.complete;
  const repeatedContent = containsRepeatedPassage(transcript);
  const truncated = looksTruncated(transcript);
  const endingTolerance = Math.min(120, Math.max(12, Math.ceil(transcript.length * 0.2)));
  const endingMatches = endingSentence.complete && endingSentence.end >= transcript.length - endingTolerance;
  const missingBeginning = !beginningMatches;
  const missingMiddle = !middleMatches;
  const missingEnding = !endingMatches;
  const reviewReasons = [
    "SOURCE_COMPLETENESS_UNVERIFIED",
    ...(analysis.intent === "other" ? ["OTHER_INTENT"] : []),
    ...(analysis.outcome.status === "unknown" ? ["OUTCOME_UNKNOWN"] : []),
    ...(!anchorsInOrder ? ["ANCHORS_OUT_OF_ORDER"] : []),
    ...(missingBeginning ? ["MISSING_BEGINNING"] : []),
    ...(missingMiddle ? ["MISSING_MIDDLE"] : []),
    ...(repeatedContent ? ["REPEATED_CONTENT"] : []),
    ...(truncated ? ["TRUNCATED_TRANSCRIPT"] : []),
    ...(missingEnding ? ["MISSING_ENDING"] : []),
    ...(analysis.uncertainty.facts ? ["UNCERTAIN_FACTS"] : []),
    ...(analysis.uncertainty.speaker ? ["UNCERTAIN_SPEAKER"] : []),
  ];
  const reviewRequired = reviewReasons.length > 0;

  return {
    provider: "gemini",
    model: analysis.model,
    transcript,
    extractedFacts: {
      intent: analysis.intent,
      confirmed_facts: analysis.confirmedFacts,
      customer_concerns: analysis.customerConcerns,
      intent_evidence: analysis.intentEvidence === null ? [] : [analysis.intentEvidence],
      provenance: {
        provider: "gemini",
        model: analysis.model,
        schema_version: "m3-transcript-v1",
        prompt_version: M3_PROMPT_VERSION,
        source_completeness: "unverified",
      },
    },
    outcome: {
      status: analysis.outcome.status,
      summary: analysis.outcome.summary,
      evidence: analysis.outcome.evidence ? [analysis.outcome.evidence] : [],
    },
    quality: {
      sourceCompleteness: "unverified",
      anchorMatches: { beginning: beginningMatches, middle: middleMatches, ending: endingMatches },
      anchorsInOrder,
      repeatedContent,
      truncated,
      missingBeginning,
      missingMiddle,
      missingEnding,
      uncertainty: analysis.uncertainty,
      reviewReasons,
    },
    confidence: analysis.confidence,
    callType: analysis.intent === "other" ? null : analysis.intent,
    callStatus: reviewRequired ? "review_required" : "completed",
    reviewStatus: reviewRequired ? "review_required" : "not_reviewed",
    durationSeconds: 0,
    qualityIndicators: {
      schema_version: "m3-transcript-v1",
      source_completeness: "unverified",
      needs_human_review: true,
      review_flags: [...reviewReasons],
      anchors,
      ...(analysis.speakerSegments ? { speaker_segments: analysis.speakerSegments,
        m4_auto_suggestions: deriveM4AutoSuggestions(analysis.intent, transcript, analysis.speakerSegments) } : {}),
    },
  };
}

function parseEvidenceItems<T extends "fact" | "concern">(
  value: unknown,
  label: T,
  transcript: string,
): Array<Record<T, string> & { evidence: string }> {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw invalidAnalysis("items_shape");
  const seenClaims = new Set<string>();
  return value.map((item): Record<T, string> & { evidence: string } => {
    if (!isRecord(item) || !hasExactKeys(item, [label, "evidence"])) throw invalidAnalysis("item_shape");
    const claim = requireClaimStatement(item[label]);
    const evidence = requireEvidence(item.evidence, transcript);
    if (!claimIsSupportedByEvidence(claim, evidence)) throw invalidAnalysis("claim_not_within_evidence");
    const normalizedClaim = claim.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();
    if (seenClaims.has(normalizedClaim)) throw invalidAnalysis("duplicate_sentence_reference");
    seenClaims.add(normalizedClaim);
    return {
      [label]: claim,
      evidence,
    } as Record<T, string> & { evidence: string };
  });
}

function requireEvidence(value: unknown, transcript: string) {
  const evidence = requireText(value, MAX_EVIDENCE_LENGTH);
  if (evidence.length < 5 || !transcript.includes(evidence)) throw invalidAnalysis("verbatim_evidence_mismatch");
  return evidence;
}

function requireClaimStatement(value: unknown) {
  const claim = requireText(value, MAX_EVIDENCE_LENGTH).trim();
  const firstLetter = claim.match(/\p{L}/u)?.[0];
  if (!firstLetter || firstLetter !== firstLetter.toLocaleUpperCase() || terminalPunctuation(claim) === null) {
    throw invalidAnalysis("text_type_or_length");
  }
  return claim;
}

function claimIsSupportedByEvidence(claim: string, evidence: string) {
  const wordPattern = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu;
  const claimWords = [...claim.matchAll(wordPattern)].map((match) => match[0].normalize("NFC").toLocaleLowerCase());
  const evidenceWords = [...evidence.matchAll(wordPattern)];
  if (claimWords.length === 0 || claimWords.length > evidenceWords.length) return false;
  const claimTerminal = terminalPunctuation(claim);

  for (let start = 0; start <= evidenceWords.length - claimWords.length; start += 1) {
    if (!claimWords.every((word, index) =>
      word === evidenceWords[start + index]![0].normalize("NFC").toLocaleLowerCase()
    )) continue;
    const firstEvidenceWord = evidenceWords[start]!;
    const lastEvidenceWord = evidenceWords[start + claimWords.length - 1]!;
    const sourceStart = firstEvidenceWord.index ?? 0;
    const sourceEnd = (lastEvidenceWord.index ?? sourceStart) + lastEvidenceWord[0].length;
    const sourceRemainder = evidence.slice(sourceEnd);
    const sourceTerminal = punctuationImmediatelyAfterSpan(sourceRemainder);
    if ((sourceTerminal === "?" || sourceTerminal === "!") && sourceTerminal !== claimTerminal) continue;
    if ((claimTerminal === "?" || claimTerminal === "!") && sourceTerminal !== claimTerminal) continue;
    const sourceSentenceStart = Math.max(
      evidence.lastIndexOf(".", sourceStart - 1),
      evidence.lastIndexOf("?", sourceStart - 1),
      evidence.lastIndexOf("!", sourceStart - 1),
      evidence.lastIndexOf("\n", sourceStart - 1),
    );
    const sentencePrefix = evidence.slice(sourceSentenceStart + 1, sourceStart);
    const followingSentenceEnd = [
      evidence.indexOf(".", sourceEnd), evidence.indexOf("?", sourceEnd), evidence.indexOf("!", sourceEnd),
    ].filter((index) => index >= 0).reduce((nearest, index) => Math.min(nearest, index), evidence.length);
    const sourceSentence = evidence.slice(sourceSentenceStart + 1, followingSentenceEnd);
    if (CLAIM_LEADING_SCOPE.test(sourceSentence) && !CLAIM_LEADING_SCOPE.test(claim)) continue;
    const contrastBoundaries = [...sentencePrefix.matchAll(
      /(?:,\s*(?:but|yet|however)\s+|,\s+and\s*|\s+(?:but|yet|however)\s+)/giu,
    )].filter((match) =>
      !/and/iu.test(match[0]) || /^(?:i|we|they|it|there|the\s+(?:caller|customer))\b/iu.test(claim)
    );
    const latestContrast = contrastBoundaries.at(-1);
    const relevantPrefix = latestContrast
      ? sentencePrefix.slice((latestContrast.index ?? 0) + latestContrast[0].length)
      : sentencePrefix;
    if (CLAIM_SCOPE_PREFIX.test(relevantPrefix)) continue;

    const sentenceSuffix = evidence.slice(sourceEnd, followingSentenceEnd);
    if (CLAIM_SCOPE_SUFFIX.test(sentenceSuffix)) continue;
    return true;
  }
  return false;
}

function terminalPunctuation(text: string) {
  let cursor = text.trimEnd().length;
  while (cursor > 0 && SENTENCE_CLOSERS.has(text[cursor - 1]!)) cursor -= 1;
  const punctuation = cursor > 0 ? text[cursor - 1] : null;
  return punctuation === "." || punctuation === "!" || punctuation === "?" ? punctuation : null;
}

function punctuationImmediatelyAfterSpan(text: string) {
  let cursor = 0;
  while (cursor < text.length && /\s/u.test(text[cursor]!)) cursor += 1;
  if (cursor < text.length && /[.!?]/u.test(text[cursor]!)) return text[cursor]!;
  while (cursor < text.length && SENTENCE_CLOSERS.has(text[cursor]!)) cursor += 1;
  const punctuation = text[cursor];
  return punctuation === "." || punctuation === "!" || punctuation === "?" ? punctuation : null;
}

function isTerminalQuestion(text: string) {
  const trimmed = text.trimEnd();
  let cursor = trimmed.length;
  while (cursor > 0 && SENTENCE_CLOSERS.has(trimmed[cursor - 1]!)) cursor -= 1;
  if (cursor > 0 && trimmed[cursor - 1] === "?") return true;
  return cursor > 1 && trimmed[cursor - 1] === "!" && trimmed[cursor - 2] === "?";
}

const BOOKING_NEGATION = /\b(?:no|not|never|without|haven't|hasn't|hadn't|didn't|doesn't|isn't|wasn't)\b(?:\W+\w+){0,3}\W+\b(?:book(?:ed|ing)?|schedul(?:e|ed|ing)|appointment|reserv(?:e|ed|ation))\b/iu;

function requireText(value: unknown, maximumLength: number) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximumLength || value.includes("\0")) {
    throw invalidAnalysis("text_type_or_length");
  }
  return value;
}

function containsRepeatedPassage(transcript: string) {
  const tokens = transcript.toLocaleLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  if (tokens.length < 24) return false;
  const counts = new Map<string, number>();
  const windowSize = 6;
  for (let index = 0; index <= tokens.length - windowSize; index += 1) {
    const window = tokens.slice(index, index + windowSize).join(" ");
    const count = (counts.get(window) ?? 0) + 1;
    if (count >= 4) return true;
    counts.set(window, count);
  }
  return false;
}

function looksTruncated(transcript: string) {
  const finalText = transcript.trim().slice(-240);
  return /(?:\.{3,}|…|\[(?:truncated|incomplete|cut off)[^\]]*\])\s*$/i.test(finalText) ||
    /\b(?:and|but|because|although|if|when|while|to|for|with|from|send|email|call|schedule|confirm|check|review|follow up)\s*$/i.test(finalText);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export type M3ValidationFailure =
  | "candidate_shape" | "parts_shape" | "invalid_json" | "top_level_shape"
  | "transcript_invalid" | "intent_invalid" | "items_shape" | "item_shape"
  | "outcome_shape" | "outcome_status" | "anchors_shape" | "uncertainty_shape"
  | "uncertainty_type" | "confidence_invalid" | "verbatim_evidence_mismatch"
  | "claim_not_within_evidence" | "text_type_or_length" | "provider_contract_version"
  | "utterance_text_invalid" | "utterance_text_oversized" | "claim_text_invalid" | "evidence_text_oversized"
  | "sentence_segmentation_invalid" | "sentence_annotations_shape" | "sentence_annotation_invalid"
  | "sentence_annotation_count_mismatch" | "sentence_annotation_schema_invalid"
  | "sentence_annotation_id_order_mismatch" | "utterance_schema_invalid" | "utterance_reference_invalid"
  | "sentence_reference_shape" | "sentence_reference_invalid" | "duplicate_sentence_reference"
  | "span_shape" | "span_bounds" | "span_length" | "span_surrogate_boundary" | "unknown_validation";

class M3AnalysisValidationError extends Error {
  constructor(readonly reason: M3ValidationFailure) {
    super("INVALID_ANALYSIS");
    this.name = "M3AnalysisValidationError";
  }
}

function invalidAnalysis(reason: M3ValidationFailure = "unknown_validation") {
  return new M3AnalysisValidationError(reason);
}

export const M3_MAX_AUDIO_BYTES = 52_428_800;
export const M3_MAX_AUDIO_SECONDS = 1_200;

export type M3SafeErrorCode =
  | "PROVIDER_429" | "PROVIDER_503" | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT" | "PROVIDER_SAFETY_BLOCKED"
  | "PROVIDER_FINISH_REASON_INVALID" | "PROVIDER_CANDIDATE_COUNT_INVALID"
  | "PROVIDER_RESPONSE_INVALID" | "PROVIDER_CLEANUP_FAILED"
  | "SOURCE_INVALID" | "SOURCE_TOO_LONG" | "STORAGE_UNAVAILABLE"
  | "JOB_LINK_INVALID" | "INTERNAL_ERROR";

export class M3ProcessingError extends Error {
  readonly code: M3SafeErrorCode;
  readonly retryAfterSeconds: number | null;
  readonly validationFailure: M3ValidationFailure | null;
  constructor(code: M3SafeErrorCode, retryAfterSeconds: number | null = null, validationFailure: M3ValidationFailure | null = null) {
    super(code);
    this.name = "M3ProcessingError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.validationFailure = validationFailure;
  }
}

export type M3ModelOutput = {
  validatedAnalysisJson: string;
  finishReason: "STOP";
};

const M3_UTTERANCE_SCHEMA = {
  type: "OBJECT",
  required: [
    "text", "speaker", "speechAct", "confirmedFacts", "customerConcerns", "supportsIntent", "supportsOutcome",
  ],
  properties: {
    text: { type: "STRING" },
    speaker: { type: "STRING", enum: ["caller", "agent", "unknown"] },
    speechAct: {
      type: "STRING",
      enum: ["statement", "question", "offer", "advice", "instruction", "self_identification", "greeting", "unknown"],
    },
    confirmedFacts: { type: "ARRAY", items: { type: "STRING" } },
    customerConcerns: { type: "ARRAY", items: { type: "STRING" } },
    supportsIntent: { type: "BOOLEAN" },
    supportsOutcome: { type: "BOOLEAN" },
  },
} as const;

export const M3_RESPONSE_SCHEMA = {
  type: "OBJECT",
  required: ["providerContractVersion", "utterances", "intent", "outcome", "uncertainty", "confidence"],
  properties: {
    providerContractVersion: { type: "STRING", enum: [M3_PROVIDER_UTTERANCE_CONTRACT_VERSION] },
    utterances: { type: "ARRAY", items: M3_UTTERANCE_SCHEMA },
    intent: { type: "STRING", enum: ["sales", "general_office", "retention", "other"] },
    outcome: {
      type: "OBJECT",
      required: ["status"],
      properties: { status: { type: "STRING", enum: ["observed", "unresolved", "unknown"] } },
    },
    uncertainty: {
      type: "OBJECT",
      required: ["facts", "speaker"],
      properties: { facts: { type: "BOOLEAN" }, speaker: { type: "BOOLEAN" } },
    },
    confidence: { type: "NUMBER", nullable: true },
  },
} as const;

export function parseGeminiGeneration(value: unknown): M3ModelOutput {
  if (!isRecord(value) || !Array.isArray(value.candidates) || value.candidates.length !== 1) {
    throw new M3ProcessingError("PROVIDER_CANDIDATE_COUNT_INVALID");
  }
  const candidate = value.candidates[0];
  if (!isRecord(candidate)) throw new M3ProcessingError("PROVIDER_RESPONSE_INVALID", null, "candidate_shape");
  if (candidate.finishReason === "SAFETY") throw new M3ProcessingError("PROVIDER_SAFETY_BLOCKED");
  if (candidate.finishReason !== "STOP") throw new M3ProcessingError("PROVIDER_FINISH_REASON_INVALID");
  if (!isRecord(candidate.content) || !Array.isArray(candidate.content.parts) ||
      candidate.content.parts.length !== 1) throw new M3ProcessingError("PROVIDER_RESPONSE_INVALID", null, "parts_shape");
  const part = candidate.content.parts[0];
  if (!isRecord(part) || typeof part.text !== "string" || part.text.length === 0) {
    throw new M3ProcessingError("PROVIDER_RESPONSE_INVALID", null, "parts_shape");
  }
  let validatedAnalysisJson: string;
  try {
    validatedAnalysisJson = materializeM3UtteranceResponse(part.text);
    parseM3Analysis(validatedAnalysisJson, "schema-validation");
  } catch (error) {
    const reason = error instanceof M3AnalysisValidationError ? error.reason : "unknown_validation";
    throw new M3ProcessingError("PROVIDER_RESPONSE_INVALID", null, reason);
  }
  return { validatedAnalysisJson, finishReason: "STOP" };
}

type M3ProviderUtterance = {
  text: string;
  speaker: M3SentenceSpeaker;
  speechAct: M3SentenceAct;
  confirmedFacts: string[];
  customerConcerns: string[];
  supportsIntent: boolean;
  supportsOutcome: boolean;
};

type M3MaterializedUtterance = M3ProviderUtterance & {
  start: number;
  end: number;
  sentences: M3TranscriptSentence[];
};

function classifyLegacySentenceAnnotations(value: Record<string, unknown>) {
  const transcript = requireTranscript(value.transcript);
  const sentences = segmentM3Transcript(transcript);
  if (!Array.isArray(value.sentenceAnnotations)) {
    throw invalidAnalysis("sentence_annotation_schema_invalid");
  }
  if (value.sentenceAnnotations.length !== sentences.length) {
    throw invalidAnalysis("sentence_annotation_count_mismatch");
  }

  for (const item of value.sentenceAnnotations) {
    if (!isRecord(item) || !hasExactKeys(item, ["sentenceId", "speaker", "speechAct"]) ||
        typeof item.sentenceId !== "string" ||
        (item.speaker !== "caller" && item.speaker !== "agent" && item.speaker !== "unknown") ||
        (item.speechAct !== "statement" && item.speechAct !== "question" && item.speechAct !== "offer" &&
          item.speechAct !== "advice" && item.speechAct !== "instruction" &&
          item.speechAct !== "self_identification" && item.speechAct !== "greeting" && item.speechAct !== "unknown")) {
      throw invalidAnalysis("sentence_annotation_schema_invalid");
    }
  }

  for (let index = 0; index < sentences.length; index += 1) {
    const annotation = value.sentenceAnnotations[index] as Record<string, unknown>;
    if (annotation.sentenceId !== sentences[index]!.id) {
      throw invalidAnalysis("sentence_annotation_id_order_mismatch");
    }
  }
}

function materializeM3UtteranceResponse(candidateText: string): string {
  let value: unknown;
  try {
    value = JSON.parse(candidateText);
  } catch {
    throw invalidAnalysis("invalid_json");
  }

  const providerKeys = ["providerContractVersion", "utterances", "intent", "outcome", "uncertainty", "confidence"];
  if (!isRecord(value)) throw invalidAnalysis("top_level_shape");
  if (value.providerContractVersion === M3_PROVIDER_LEGACY_SENTENCE_CONTRACT_VERSION) {
    classifyLegacySentenceAnnotations(value);
    throw invalidAnalysis("provider_contract_version");
  }
  if (value.providerContractVersion !== M3_PROVIDER_UTTERANCE_CONTRACT_VERSION) {
    throw invalidAnalysis("provider_contract_version");
  }
  if (!hasExactKeys(value, providerKeys)) throw invalidAnalysis("top_level_shape");
  const utterances = parseProviderUtterances(value.utterances);
  let offset = 0;
  for (let index = 0; index < utterances.length; index += 1) {
    const utterance = utterances[index]!;
    utterance.start = offset;
    utterance.end = offset + utterance.text.length;
    offset = utterance.end + (index < utterances.length - 1 ? 2 : 0);
  }
  const transcript = requireTranscript(utterances.map((utterance) => utterance.text).join("\n\n"));
  const sentences = segmentM3Transcript(transcript);
  let utteranceIndex = 0;
  for (const sentence of sentences) {
    while (utteranceIndex < utterances.length && sentence.start >= utterances[utteranceIndex]!.end) {
      utteranceIndex += 1;
    }
    const utterance = utterances[utteranceIndex];
    if (!utterance || sentence.start < utterance.start || sentence.end > utterance.end) {
      throw invalidAnalysis("sentence_segmentation_invalid");
    }
    utterance.sentences.push(sentence);
  }
  if (utterances.some((utterance) => utterance.sentences.length === 0)) {
    throw invalidAnalysis("sentence_segmentation_invalid");
  }

  if (typeof value.intent !== "string" || !INTENTS.has(value.intent as M3Intent)) throw invalidAnalysis("intent_invalid");
  const facts = materializeUtteranceItems(utterances, "fact", transcript);
  const concerns = materializeUtteranceItems(utterances, "concern", transcript);

  if (!isRecord(value.outcome) || !hasExactKeys(value.outcome, ["status"])) {
    throw invalidAnalysis("outcome_shape");
  }
  if (typeof value.outcome.status !== "string" || !OUTCOMES.has(value.outcome.status as M3OutcomeStatus)) {
    throw invalidAnalysis("outcome_status");
  }
  // Ambiguous model flags cannot certify a unique outcome or intent. Preserve
  // transcript, downgrade both to unknown/other and require human review.
  const ambiguousOutcome = utterances.filter((item) => item.supportsOutcome).length > 1;
  const ambiguousIntent = utterances.filter((item) => item.supportsIntent).length > 1;
  const outcomeUtterance = ambiguousOutcome ? null : uniqueMarkedUtterance(utterances, "supportsOutcome");
  const outcome = materializeUtteranceOutcome(value.outcome.status as M3OutcomeStatus, outcomeUtterance, transcript);

  const intentUtterance = ambiguousIntent ? null : uniqueMarkedUtterance(utterances, "supportsIntent");
  const intentIsGrounded = intentUtterance !== null && isEligibleCallerStatement(intentUtterance) &&
    utteranceEvidence(transcript, intentUtterance) !== null;
  const intent = intentIsGrounded || value.intent === "other" ? value.intent as M3Intent : "other";
  const intentEvidence = intentUtterance && intentIsGrounded ? utteranceEvidence(transcript, intentUtterance) : null;
  const anchors = deriveTranscriptAnchors(sentences, transcript);

  if (!isRecord(value.uncertainty) || !hasExactKeys(value.uncertainty, ["facts", "speaker"]) ||
      typeof value.uncertainty.facts !== "boolean" || typeof value.uncertainty.speaker !== "boolean") {
    throw invalidAnalysis("uncertainty_type");
  }
  const droppedClaim = facts.dropped || concerns.dropped || ambiguousIntent || ambiguousOutcome ||
    (!intentIsGrounded && value.intent !== "other");
  const droppedSpeakerUncertainty = facts.ambiguousSpeaker || concerns.ambiguousSpeaker ||
    intentUtterance?.speaker === "unknown";

  return JSON.stringify({
    transcript,
    intent,
    confirmedFacts: facts.items,
    customerConcerns: concerns.items,
    outcome: { status: outcome.status, summary: outcome.summary, evidence: outcome.evidence },
    intentEvidence,
    anchors,
    // Exact byte offsets derived from ordered utterance text, never model-supplied offsets.
    // Speaker attribution remains provisional until independently reviewed.
    speakerSegments: utterances.map(({ start, end, speaker, speechAct }) =>
      ({ start, end, speaker, speechAct })),
    uncertainty: {
      facts: value.uncertainty.facts || droppedClaim,
      speaker: value.uncertainty.speaker || droppedSpeakerUncertainty || outcome.ambiguousSpeaker,
    },
    confidence: value.confidence,
  });
}

function parseProviderUtterances(value: unknown): M3MaterializedUtterance[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SENTENCES) {
    throw invalidAnalysis("utterance_schema_invalid");
  }
  const utterances: M3MaterializedUtterance[] = [];
  let factCount = 0;
  let concernCount = 0;
  for (const item of value) {
    if (!isRecord(item) || !hasExactKeys(item, [
      "text", "speaker", "speechAct", "confirmedFacts", "customerConcerns", "supportsIntent", "supportsOutcome",
    ])) {
      throw invalidAnalysis("utterance_schema_invalid");
    }
    // Long utterances are legitimate transcript data. Bound the combined transcript
    // separately; overlong *evidence* cannot be persisted as a verified claim.
    if (typeof item.text !== "string" || !item.text.trim() || item.text.includes("\0")) {
      throw invalidAnalysis("utterance_text_invalid");
    }
    if (item.text.length > MAX_TRANSCRIPT_LENGTH) throw invalidAnalysis("utterance_text_oversized");
    const text = item.text.trim();
    if (
      (item.speaker !== "caller" && item.speaker !== "agent" && item.speaker !== "unknown") ||
      (item.speechAct !== "statement" && item.speechAct !== "question" && item.speechAct !== "offer" &&
        item.speechAct !== "advice" && item.speechAct !== "instruction" &&
        item.speechAct !== "self_identification" && item.speechAct !== "greeting" && item.speechAct !== "unknown") ||
      typeof item.supportsIntent !== "boolean" || typeof item.supportsOutcome !== "boolean"
    ) {
      throw invalidAnalysis("utterance_schema_invalid");
    }
    if (!Array.isArray(item.confirmedFacts) || !Array.isArray(item.customerConcerns) ||
        item.confirmedFacts.some((claim) => typeof claim !== "string") ||
        item.customerConcerns.some((claim) => typeof claim !== "string")) {
      throw invalidAnalysis("utterance_schema_invalid");
    }
    factCount += item.confirmedFacts.length;
    concernCount += item.customerConcerns.length;
    if (factCount > MAX_ITEMS || concernCount > MAX_ITEMS) throw invalidAnalysis("items_shape");
    utterances.push({
      text,
      speaker: item.speaker,
      speechAct: item.speechAct,
      confirmedFacts: item.confirmedFacts,
      customerConcerns: item.customerConcerns,
      supportsIntent: item.supportsIntent,
      supportsOutcome: item.supportsOutcome,
      start: 0,
      end: 0,
      sentences: [],
    });
  }
  return utterances;
}

function materializeUtteranceItems<T extends "fact" | "concern">(
  utterances: M3MaterializedUtterance[],
  label: T,
  transcript: string,
): { items: Array<Record<T, string> & { evidence: string }>; dropped: boolean; ambiguousSpeaker: boolean } {
  const items: Array<Record<T, string> & { evidence: string }> = [];
  const seenClaims = new Set<string>();
  let dropped = false;
  let ambiguousSpeaker = false;
  for (const utterance of utterances) {
    const claims = label === "fact" ? utterance.confirmedFacts : utterance.customerConcerns;
    // The transcript is the primary evidence. Malformed optional extraction
    // candidates fail closed individually; they must never invalidate safe audio
    // transcription or be silently represented as confirmed claims.
    const evidence = utteranceEvidence(transcript, utterance);
    for (const value of claims) {
      if (utterance.speaker === "unknown") ambiguousSpeaker = true;
      if (!evidence || !isEligibleCallerStatement(utterance)) {
        dropped = true;
        continue;
      }
      let claim: string;
      try {
        claim = requireClaimStatement(value);
      } catch (error) {
        if (!(error instanceof M3AnalysisValidationError)) throw error;
        dropped = true;
        continue;
      }
      if (!claimIsSupportedByEvidence(claim, evidence)) {
        dropped = true;
        continue;
      }
      const normalizedClaim = claim.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();
      if (seenClaims.has(normalizedClaim)) {
        dropped = true;
        continue;
      }
      seenClaims.add(normalizedClaim);
      items.push({ [label]: claim, evidence } as Record<T, string> & { evidence: string });
    }
  }
  return { items, dropped, ambiguousSpeaker };
}

function uniqueMarkedUtterance(
  utterances: M3MaterializedUtterance[],
  marker: "supportsIntent" | "supportsOutcome",
) {
  const marked = utterances.filter((utterance) => utterance[marker]);
  if (marked.length > 1) throw invalidAnalysis("utterance_reference_invalid");
  return marked[0] ?? null;
}

function isEligibleCallerStatement(utterance: M3MaterializedUtterance) {
  return utterance.speaker === "caller" && utterance.speechAct === "statement" &&
    utterance.sentences.length > 0 && utterance.sentences.every((sentence) =>
      sentence.complete && !isTerminalQuestion(sentence.text)
    );
}

function utteranceEvidence(transcript: string, utterance: M3MaterializedUtterance): string | null {
  const evidence = joinSentenceText(transcript, utterance.sentences);
  // Do not truncate or manufacture an evidence quote. An oversized/short
  // utterance remains part of the transcript but cannot certify a claim.
  return evidence.length >= 5 && evidence.length <= MAX_EVIDENCE_LENGTH ? evidence : null;
}

function materializeUtteranceOutcome(
  requestedStatus: M3OutcomeStatus,
  utterance: M3MaterializedUtterance | null,
  transcript: string,
) {
  const ambiguousSpeaker = utterance?.speaker === "unknown";
  const referencesUsable = utterance !== null && utterance.speaker !== "unknown" &&
    utteranceEvidence(transcript, utterance) !== null &&
    utterance.sentences.length > 0 && utterance.sentences.every((sentence) =>
      sentence.complete && !isTerminalQuestion(sentence.text)
    );
  let status = requestedStatus;
  let evidence = "";
  if (!referencesUsable) {
    status = "unknown";
  } else if (utterance) {
    evidence = utteranceEvidence(transcript, utterance) ?? "";
    if (status === "observed" && BOOKING_NEGATION.test(evidence)) {
      status = "unresolved";
    } else if (status === "observed" && utterance.speechAct !== "statement") {
      status = "unknown";
    }
  }
  return { status, summary: evidence, evidence, ambiguousSpeaker };
}

function requireTranscript(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_TRANSCRIPT_LENGTH ||
    value.includes("\0")
  ) {
    throw invalidAnalysis("transcript_invalid");
  }
  return value;
}

function joinSentenceText(transcript: string, sentences: M3TranscriptSentence[]) {
  if (sentences.length === 0) return "";
  return transcript.slice(sentences[0]!.start, sentences[sentences.length - 1]!.end);
}

function deriveTranscriptAnchors(sentences: M3TranscriptSentence[], transcript: string) {
  const beginning = sentences[0]!;
  const ending = sentences[sentences.length - 1]!;
  const middle = sentences.reduce((closest, sentence) =>
    Math.abs(sentence.index - (sentences.length - 1) / 2) < Math.abs(closest.index - (sentences.length - 1) / 2)
      ? sentence
      : closest);
  // Anchors are only transcript identity checks, never evidence of acoustic
  // completeness. Keep them bounded even when an utterance runs long.
  const bounded = (sentence: M3TranscriptSentence, position: "start" | "middle" | "end") => {
    if (sentence.text.length >= 5 && sentence.text.length <= MAX_EVIDENCE_LENGTH) return sentence.text;
    if (transcript.length < 5) throw invalidAnalysis("transcript_invalid");
    const size = Math.min(transcript.length, 180);
    const start = position === "start" ? 0 : position === "end"
      ? transcript.length - size
      : Math.max(0, Math.min(transcript.length - size, Math.round((sentence.start + sentence.end - size) / 2)));
    return transcript.slice(start, start + size);
  };
  return {
    beginning: bounded(beginning, "start"),
    middle: bounded(middle, "middle"),
    ending: bounded(ending, "end"),
  };
}

export function buildM3PersistedAnalysis(
  output: M3ModelOutput,
  model: string,
  durationSeconds: number,
): M3PersistedAnalysis {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > M3_MAX_AUDIO_SECONDS) {
    throw new M3ProcessingError("SOURCE_INVALID");
  }
  const validated = assessM3Quality(parseM3Analysis(output.validatedAnalysisJson, model));
  return { ...validated, durationSeconds: Math.ceil(durationSeconds) };
}

/**
 * Inspect MPEG Layer III frame headers rather than trusting a browser-supplied
 * duration. This is a conservative duration estimate, not an audio decoder.
 */
export function parseMp3Duration(audio: Uint8Array): { durationSeconds: number } {
  if (audio.length < 4 || audio.length > M3_MAX_AUDIO_BYTES) throw new M3ProcessingError("SOURCE_INVALID");
  let offset = 0;
  if (audio.length >= 10 && audio[0] === 73 && audio[1] === 68 && audio[2] === 51) {
    if (audio.slice(6, 10).some(byte => byte > 127)) throw new M3ProcessingError("SOURCE_INVALID");
    const length = (audio[6] << 21) | (audio[7] << 14) | (audio[8] << 7) | audio[9];
    offset = 10 + length + ((audio[5] & 16) !== 0 ? 10 : 0);
  }

  const bitrate1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const bitrate2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRates = [44100, 48000, 32000];
  let frames = 0;
  let duration = 0;
  while (offset + 4 <= audio.length) {
    const header = ((audio[offset] << 24) | (audio[offset + 1] << 16) |
      (audio[offset + 2] << 8) | audio[offset + 3]) >>> 0;
    const version = (header >>> 19) & 3;
    const layer = (header >>> 17) & 3;
    const bitrateIndex = (header >>> 12) & 15;
    const rateIndex = (header >>> 10) & 3;
    const padding = (header >>> 9) & 1;
    if (((header & 0xffe00000) >>> 0) !== 0xffe00000 || version === 1 || layer !== 1 ||
        bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      if (frames > 0 && audio.length - offset <= 128) break;
      throw new M3ProcessingError("SOURCE_INVALID");
    }
    const bitrate = (version === 3 ? bitrate1 : bitrate2)[bitrateIndex] * 1000;
    const sampleRate = sampleRates[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const samplesPerFrame = version === 3 ? 1152 : 576;
    const frameLength = Math.floor((version === 3 ? 144 : 72) * bitrate / sampleRate) + padding;
    if (frameLength < 24 || offset + frameLength > audio.length) throw new M3ProcessingError("SOURCE_INVALID");
    duration += samplesPerFrame / sampleRate;
    if (duration > M3_MAX_AUDIO_SECONDS + 2) throw new M3ProcessingError("SOURCE_TOO_LONG");
    offset += frameLength;
    frames += 1;
  }
  if (!frames || duration <= 0) throw new M3ProcessingError("SOURCE_INVALID");
  return { durationSeconds: duration };
}

