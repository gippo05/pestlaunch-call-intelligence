export default function ScorecardsLoading() {
  return (
    <main className="space-y-5" aria-busy="true" aria-label="Loading scorecards">
      <div className="h-14 w-64 animate-pulse rounded-lg bg-stone-200" />
      <div className="h-40 animate-pulse rounded-xl border border-line bg-white" />
      <div className="h-40 animate-pulse rounded-xl border border-line bg-white" />
      <span className="sr-only">Loading scorecards…</span>
    </main>
  );
}
