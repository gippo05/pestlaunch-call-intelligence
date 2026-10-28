export type CallStatus =
  | "uploaded"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "review_required"
  | "test_completed"
  | (string & {});

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
