import { ClipboardCheck } from "lucide-react";
import { requireUser } from "@/lib/auth/session";

export default async function ScorecardsPage() {
  await requireUser();
  return (
    <main className="space-y-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-800">Evaluation</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">Scorecards</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
          Versioned rubric foundations are being prepared for a later milestone.
        </p>
      </div>
      <section className="rounded-2xl border border-dashed border-line bg-white/70 px-6 py-16 text-center sm:px-12">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-900">
          <ClipboardCheck aria-hidden="true" className="size-5" />
        </div>
        <h2 className="mt-5 text-lg font-semibold text-ink">No scorecards yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
          Call analysis and deterministic scoring are not part of this milestone. No scores or coaching recommendations have been generated.
        </p>
        <span className="mt-6 inline-flex rounded-full border border-line px-3 py-1 text-xs font-medium text-muted">Planned for a later milestone</span>
      </section>
    </main>
  );
}
