export default function CallsLoading() {
  return (
    <main className="space-y-6" aria-busy="true" aria-label="Loading calls">
      <div className="h-10 w-48 animate-pulse rounded-lg bg-stone-200" />
      <div className="h-28 animate-pulse rounded-xl border border-line bg-white" />
      <div className="h-16 animate-pulse rounded-xl border border-line bg-white" />
      <div className="h-72 animate-pulse rounded-xl border border-line bg-white" />
      <span className="sr-only">Loading call records…</span>
    </main>
  );
}
