import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CallLibraryFilters } from "@/lib/calls/review-view";

export function CallLibraryFiltersForm({ filters }: { filters: CallLibraryFilters }) {
  return (
    <form action="/calls" method="get" className="grid gap-3 rounded-xl border border-line bg-white p-4 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1.4fr)_repeat(4,minmax(8rem,1fr))_auto_auto] lg:items-end">
      <div className="sm:col-span-2 lg:col-span-1">
        <label htmlFor="call-search" className="mb-1.5 block text-xs font-semibold text-ink">Search filename</label>
        <Input id="call-search" name="q" type="search" maxLength={80} defaultValue={filters.search} placeholder="Search call files" />
      </div>
      <div>
        <label htmlFor="call-company" className="mb-1.5 block text-xs font-semibold text-ink">Company</label>
        <select id="call-company" name="company" defaultValue={filters.brand} className="h-11 w-full rounded-lg border border-line bg-white px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">
          <option value="">All companies</option>
          <option value="abc">ABC</option>
          <option value="noble_sales">Noble Sales</option>
        </select>
      </div>
      <div>
        <label htmlFor="call-category" className="mb-1.5 block text-xs font-semibold text-ink">Call category</label>
        <select id="call-category" name="category" defaultValue={filters.category} className="h-11 w-full rounded-lg border border-line bg-white px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">
          <option value="">All categories</option>
          <option value="sales">Sales</option>
          <option value="general_office">General Office</option>
          <option value="retention">Retention</option>
        </select>
      </div>
      <div>
        <label htmlFor="call-status" className="mb-1.5 block text-xs font-semibold text-ink">Status</label>
        <select id="call-status" name="status" defaultValue={filters.status} className="h-11 w-full rounded-lg border border-line bg-white px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">
          <option value="">All statuses</option>
          <option value="uploaded">Uploaded</option>
          <option value="queued">Queued</option>
          <option value="processing">Processing</option>
          <option value="completed">Analysis saved</option>
          <option value="failed">Failed</option>
          <option value="review_required">Review required</option>
          <option value="test_completed">Synthetic test complete</option>
          <option value="needs_review">Needs human review</option>
        </select>
      </div>
      <div>
        <label htmlFor="call-sort" className="mb-1.5 block text-xs font-semibold text-ink">Sort</label>
        <select id="call-sort" name="sort" defaultValue={filters.sort} className="h-11 w-full rounded-lg border border-line bg-white px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      <Button type="submit" className="w-full justify-center sm:w-auto">Apply</Button>
      <Link href="/calls" className="inline-flex min-h-10 items-center justify-center rounded-lg px-3 text-sm font-semibold text-muted underline-offset-4 hover:bg-stone-50 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">Clear</Link>
    </form>
  );
}
