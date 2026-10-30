export type CallStatus =
  | "uploaded"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "review_required"
  | "test_completed"
  | (string & {});

export type M3AutoProcessingState =
  | "started"
  | "queued"
  | "not_allowlisted"
  | "already_handled"
  | "disabled"
  | "provider_not_configured"
  | "unavailable";

const labels: Record<string, string> = {
  uploaded: "Uploaded",
  queued: "Queued for M3",
  processing: "Processing",
  completed: "Analysis complete",
  failed: "Processing failed",
  review_required: "Review required",
  test_completed: "Synthetic test complete",
};

export function getCallStatusLabel(status: CallStatus) {
  return labels[status] ?? "Status unavailable";
}

export function isM3CallStatusActive(status: string) {
  return status === "queued" || status === "processing";
}

export function hasActiveM3Call(statuses: readonly string[]) {
  return statuses.some(isM3CallStatusActive);
}

export function getAnalysisEmptyState(status: CallStatus) {
  if (status === "failed") {
    return {
      heading: "Analysis failed",
      description: "M3 processing failed before an analysis was saved. The recording remains private. No transcript, outcome, or score is available.",
    };
  }

  if (status === "processing") {
    return {
      heading: "Analysis in progress",
      description: "M3 processing is underway. The recording remains private, and no transcript, outcome, or score is available yet.",
    };
  }

  return {
    heading: "Awaiting analysis",
    description: "The recording is stored privately. No transcript, outcome, or score has been generated yet.",
  };
}

export function getAnalysisReviewSectionHeading(section: "facts" | "concerns") {
  return section === "facts" ? "AI-extracted fact candidates" : "AI-extracted concern candidates";
}
