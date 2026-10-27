import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import { LoginForm } from "@/components/login-form";
import { Button } from "@/components/ui/button";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Sign in",
};

type LoginSearchParams = Promise<{ error?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: LoginSearchParams }) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const isSignedIn = typeof data?.claims?.sub === "string";
  let hasWorkspaceAccess = false;

  if (isSignedIn) {
    const { data: memberships } = await supabase.from("workspace_members").select("workspace_id").limit(1);
    hasWorkspaceAccess = memberships !== null && memberships.length > 0;
    if (hasWorkspaceAccess) redirect("/calls");
  }

  const params = await searchParams;

  return (
    <main className="grid min-h-screen bg-paper lg:grid-cols-[minmax(0,1fr)_minmax(27rem,0.8fr)]">
      <section className="relative hidden overflow-hidden bg-ink px-12 py-14 text-white lg:flex lg:flex-col lg:justify-between xl:px-20">
        <div className="absolute -right-32 -top-40 size-[34rem] rounded-full border border-white/10" aria-hidden="true" />
        <div className="absolute -right-12 -top-20 size-[24rem] rounded-full border border-white/10" aria-hidden="true" />
        <Link className="relative flex w-fit items-center gap-3" href="/login">
          <span className="flex size-10 items-center justify-center rounded-xl bg-amber-300 text-sm font-bold tracking-tight text-ink">PL</span>
          <span>
            <span className="block text-sm font-semibold">PestLaunch</span>
            <span className="block text-xs text-white/60">Call Intelligence</span>
          </span>
        </Link>
        <div className="relative max-w-xl py-20">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-300">Private assessment workspace</p>
          <h1 className="mt-6 text-5xl font-semibold leading-[1.08] tracking-tight xl:text-6xl">A clearer view of every customer conversation.</h1>
          <p className="mt-6 max-w-lg text-base leading-7 text-white/65">A focused workspace for reviewing pest-service calls, outcomes, and coaching quality.</p>
        </div>
        <div className="relative flex items-center gap-2 text-xs text-white/50">
          <ShieldCheck aria-hidden="true" className="size-4 text-amber-300" />
          Private access · Assessment build M1
        </div>
      </section>

      <section className="flex min-h-screen items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-md">
          <div className="flex items-center gap-3 text-ink lg:hidden">
            <span className="flex size-10 items-center justify-center rounded-xl bg-ink text-sm font-bold tracking-tight text-white">PL</span>
            <span>
              <span className="block text-sm font-semibold">PestLaunch</span>
              <span className="block text-xs text-muted">Call Intelligence</span>
            </span>
          </div>
          <div className="mt-10 rounded-2xl border border-line bg-white p-7 shadow-[0_16px_60px_-36px_rgba(28,35,31,0.28)] sm:p-9 lg:mt-0">
            <div className="flex size-11 items-center justify-center rounded-xl bg-amber-100 text-amber-950">
              <LockKeyhole aria-hidden="true" className="size-5" />
            </div>
            <p className="mt-7 text-xs font-semibold uppercase tracking-[0.16em] text-amber-800">Workspace access</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-ink">Sign in to continue</h2>
            {isSignedIn ? (
              <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
                <p>{params.error === "workspace" ? "This account does not have workspace access yet." : "Your account is signed in but is not a member of this workspace."}</p>
                <p className="mt-1 text-amber-900/80">Ask the workspace owner to authorize your account, then sign in again.</p>
                <form action="/api/auth/sign-out" method="post" className="mt-4">
                  <Button variant="outline" type="submit">Sign out</Button>
                </form>
              </div>
            ) : (
              <>
                <p className="mt-2 text-sm leading-6 text-muted">Use the assessment account provided by your workspace owner.</p>
                <LoginForm errorMessage={params.error === "credentials" ? "We could not sign you in with those details." : null} />
              </>
            )}
          </div>
          <p className="mt-6 text-center text-xs text-muted">Authorized users only. Registration is not available here.</p>
        </div>
      </section>
    </main>
  );
}
