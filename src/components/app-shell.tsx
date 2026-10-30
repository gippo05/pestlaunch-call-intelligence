import type { ReactNode } from "react";
import Link from "next/link";
import type { AuthenticatedIdentity } from "@/lib/auth/session";
import { AppNav } from "@/components/app-nav";
import { Button } from "@/components/ui/button";

export function AppShell({ identity, children }: { identity: AuthenticatedIdentity; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-paper text-ink md:grid md:grid-cols-[14.5rem_minmax(0,1fr)]">
      <aside className="border-b border-line bg-white px-4 py-4 md:sticky md:top-0 md:flex md:h-screen md:flex-col md:border-b-0 md:border-r md:px-4 md:py-6">
        <Link className="flex items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700" href="/calls">
            <span className="flex size-10 items-center justify-center rounded-xl bg-ink text-sm font-bold tracking-tight text-white">PL</span>
            <span>
              <span className="block text-sm font-semibold tracking-tight">PestLaunch</span>
              <span className="block text-[11px] text-muted">Review workspace</span>
            </span>
          </Link>
        <div className="mt-4 md:mt-9">
          <p className="mb-2 hidden px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted md:block">Workspace</p>
          <AppNav />
        </div>
        <div className="mt-5 hidden rounded-lg border border-line bg-paper/70 p-3 md:block">
          <p className="text-xs font-semibold text-ink">Local demo processing</p>
          <p className="mt-1 text-xs leading-5 text-muted">Only server-verified, hash-allowlisted synthetic MP3s are eligible for the bounded M3 worker.</p>
          <span className="mt-3 inline-flex rounded-full border border-slate-200 bg-white px-2 py-1 text-[10px] font-medium text-slate-700">Synthetic fixtures only</span>
        </div>
        <div className="mt-auto hidden border-t border-line pt-5 md:block">
          <p className="truncate px-3 text-xs font-medium text-ink" title={identity.email ?? "Assessment workspace"}>
            {identity.email ?? "Assessment workspace"}
          </p>
          <form action="/api/auth/sign-out" method="post" className="mt-3">
            <Button className="w-full justify-start" variant="ghost" type="submit">Sign out</Button>
          </form>
        </div>
      </aside>
      <div className="flex min-h-screen min-w-0 flex-col">
        <header className="flex min-h-14 items-center justify-between border-b border-line bg-white/70 px-5 sm:px-8">
          <p className="text-xs font-medium text-muted">Private assessment workspace</p>
          <form action="/api/auth/sign-out" method="post" className="md:hidden">
            <Button className="min-h-9 px-3" variant="ghost" type="submit">Sign out</Button>
          </form>
        </header>
        <div className="w-full flex-1 px-4 py-6 sm:px-8 sm:py-8 lg:px-10">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </div>
        <footer className="border-t border-line px-5 py-4 text-center text-[11px] leading-5 text-muted sm:px-8">Private workspace · Synthetic MP3 intake only · M3 requires a server-verified fixture and a configured worker</footer>
      </div>
    </div>
  );
}
