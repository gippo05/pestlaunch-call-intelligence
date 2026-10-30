import { callStatusLabel } from "@/lib/calls/review-view";

export function CallStatusBadge({ status }: { status: string }) {
  const classes = status === "failed"
    ? "border-red-200 bg-red-50 text-red-800"
    : status === "review_required"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : status === "completed" || status === "test_completed"
        ? "border-emerald-200 bg-emerald-50 text-emerald-900"
        : "border-slate-200 bg-slate-50 text-slate-700";

  return <span className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs font-medium ${classes}`}>{callStatusLabel(status)}</span>;
}
