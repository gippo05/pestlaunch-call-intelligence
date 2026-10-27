import { Headphones, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type CallRow = {
  id: string;
  original_filename: string;
  brand: string;
  call_type: string | null;
  status: string;
  created_at: string;
};

export default async function CallsPage() {
  await requireUser();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("calls")
    .select("id, original_filename, brand, call_type, status, created_at")
    .order("created_at", { ascending: false });

  const calls = (data ?? []) as CallRow[];

  return (
    <main className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-800">Call library</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">Calls</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            Review call records and their processing status in your assessment workspace.
          </p>
        </div>
        <Button disabled aria-label="Call upload will be available in a later milestone">
          <Plus aria-hidden="true" />
          Add a call
          <span className="ml-1 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">Later</span>
        </Button>
      </div>

      {error ? (
        <section className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-900" role="status">
          Call records are temporarily unavailable. Refresh the page or contact the workspace owner.
        </section>
      ) : calls.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-line bg-white/70 px-6 py-16 text-center sm:px-12">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-900">
            <Headphones aria-hidden="true" className="size-5" />
          </div>
          <h2 className="mt-5 text-lg font-semibold text-ink">No calls in this workspace yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
            Call intake is planned for a later milestone. This view will list recordings after that workflow is authorized and available.
          </p>
          <p className="mt-6 text-xs font-medium uppercase tracking-[0.14em] text-muted">Nothing has been uploaded or analyzed</p>
        </section>
      ) : (
        <section className="overflow-hidden rounded-2xl border border-line bg-white">
          <div className="hidden grid-cols-[minmax(0,1.8fr)_minmax(8rem,1fr)_minmax(8rem,1fr)] gap-4 border-b border-line px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted sm:grid">
            <span>Recording</span><span>Brand / type</span><span>Status</span>
          </div>
          <ul className="divide-y divide-line">
            {calls.map((call) => (
              <li key={call.id} className="grid grid-cols-1 gap-1 px-5 py-4 text-sm sm:grid-cols-[minmax(0,1.8fr)_minmax(8rem,1fr)_minmax(8rem,1fr)] sm:gap-4">
                <span className="truncate font-medium text-ink">{call.original_filename}</span>
                <span className="capitalize text-muted">{call.brand.replaceAll("_", " ")} · {call.call_type?.replaceAll("_", " ") ?? "Unclassified"}</span>
                <span className="capitalize text-muted">{call.status.replaceAll("_", " ")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
