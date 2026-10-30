export default function CallDetailLoading() {
  return (
    <main className="space-y-6" aria-busy="true" aria-label="Loading call review">
      <div className="h-8 w-36 animate-pulse rounded-lg bg-stone-200" />
      <div className="h-36 animate-pulse rounded-xl border border-line bg-white" />
      <div className="h-56 animate-pulse rounded-xl border border-line bg-white" />
      <div className="h-80 animate-pulse rounded-xl border border-line bg-white" />
      <span className="sr-only">Loading call details…</span>
    </main>
  );
}
