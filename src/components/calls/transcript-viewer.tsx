"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TranscriptLocation } from "@/lib/calls/review-view";

type TranscriptViewerProps = {
  transcript: string | null;
  locations: TranscriptLocation[];
};

export function TranscriptViewer({ transcript, locations }: TranscriptViewerProps) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const sourceText = transcript ?? "";
  const codepoints = useMemo(() => Array.from(sourceText), [sourceText]);
  const validLocations = useMemo(() => locations.filter((location) =>
    Number.isSafeInteger(location.start) && Number.isSafeInteger(location.end) &&
    location.start >= 0 && location.end > location.start && location.end <= codepoints.length &&
    codepoints.slice(location.start, location.end).join("") === location.quote), [locations, codepoints]);
  const segments = useMemo(() => {
    const boundaries = new Set<number>([0, codepoints.length]);
    for (const location of validLocations) {
      boundaries.add(location.start);
      boundaries.add(location.end);
    }
    const ordered = [...boundaries].sort((left, right) => left - right);
    return ordered.slice(0, -1).map((start, index) => {
      const end = ordered[index + 1];
      return {
        start,
        end,
        text: codepoints.slice(start, end).join(""),
        active: validLocations.some((location) => location.start <= start && location.end >= end),
        anchors: validLocations.filter((location) => location.start === start),
      };
    });
  }, [codepoints, validLocations]);

  async function copyTranscript() {
    try {
      await navigator.clipboard.writeText(sourceText);
      setCopyStatus("Transcript copied.");
    } catch {
      setCopyStatus("Clipboard access is unavailable in this browser.");
    }
  }

  if (!sourceText) {
    return <p className="mt-3 rounded-lg bg-stone-50 p-4 text-sm text-muted">Transcript unavailable. No transcript text was saved for this analysis.</p>;
  }

  return (
    <div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-5 text-muted">Transcript text as stored. Speaker attribution is Unknown because speaker mappings are not persisted; timestamps were not inferred.</p>
        <Button type="button" variant="outline" className="w-fit" onClick={copyTranscript}>Copy transcript</Button>
      </div>
      {copyStatus && <p className="mt-2 text-xs text-muted" role="status" aria-live="polite">{copyStatus}</p>}
      <p className="mt-2 text-xs leading-5 text-muted">Highlights locate saved text only. A text match does not confirm an extracted claim or its interpretation.</p>
      <div id="transcript" className="mt-4 max-h-[36rem] overflow-auto scroll-mt-6 whitespace-pre-wrap break-words rounded-lg border border-line bg-stone-50 p-4 text-sm leading-7 text-ink" tabIndex={0} aria-label="Complete call transcript">
        {segments.map((segment) => (
          <span key={`${segment.start}-${segment.end}`}>
            {segment.anchors.map((location) => (
              <span key={location.anchorId} id={location.anchorId} className="scroll-mt-6" aria-hidden="true" />
            ))}
            {segment.active
              ? <mark className="rounded-sm bg-blue-100 text-ink">{segment.text}</mark>
              : segment.text}
          </span>
        ))}
      </div>
    </div>
  );
}
