# PestLaunch M2 — Local Live Edge Runtime Certification

**Date:** 2026-10-28 (Philippine time)  
**Environment:** Isolated Supabase CLI, local PostgreSQL 17.6, local Edge Runtime  
**Scope:** `m2-process-queue` and existing `pending_m3` preservation  
**Verdict:** **PASS — M2 LOCAL INTEGRATION CERTIFICATION**  
**Hosted activation:** **NOT EXECUTED / NOT AUTHORIZED**

## Objective and baseline

Continue the previously successful M2 PostgreSQL, RLS, Storage, concurrency, HTTP-route and owner-confirmed real-browser upload certifications.

Before the worker test, local PostgreSQL showed **one queued `pending_m3` job**, associated with the owner's successful `synthetic-tone.mp3` browser upload. No incomplete `m2_synthetic_test` jobs or eligible abandoned-upload cleanup candidates existed.

## Real Edge Function test evidence

Executed the actual function served by the local Supabase CLI, using `node supabase/tests/m2_edge_live_integration.mjs` and a one-time HMAC secret stored only in a temporary, removed test env file. The script refused any non-loopback Supabase target.

| Assertion | Result |
|---|---|
| Live local Edge runtime started; anonymous POST rejected | PASS |
| Wrong HTTP method rejected (405) | PASS |
| Invalid HMAC signature rejected (401) | PASS |
| Expired timestamp rejected (401) | PASS |
| Valid signed request and no synthetic jobs: `outcome=empty` | PASS |
| Replayed signed nonce rejected (401) | PASS |
| One explicit synthetic job claimed and completed | PASS |
| Database job: `succeeded`, `completion_kind=synthetic_test`, `attempts=1` | PASS |
| Synthetic call transitioned to `test_completed` | PASS |
| Subsequent authorized request returned `empty` | PASS |
| Pre-existing `pending_m3` job remains `queued` and call status unchanged | PASS |
| Temporary test secret and synthetic fixture cleanup attempted | PASS; database state independently verified |

Final PostgreSQL verification: **0** synthetic worker jobs remain, **1** `pending_m3` queued job remains, **1** queued `synthetic-tone.mp3` call remains, and **0** transient Edge-test workspaces remain.

## Integration defects found and corrected

1. **Deno import-graph failure.** Edge bootstrap rejected a bare `@supabase/supabase-js` type import. Removed the unnecessary explicit `SupabaseClient` type annotation and allowed the `withSupabase` callback to infer its context type. The function now loads in Deno without a TypeScript compiler-path workaround.
2. **Local CLI/new wrapper key configuration mismatch.** The installed Supabase CLI (2.75.0) exposes legacy key variables, while `@supabase/server@1` expects a configured default publishable and secret key. Added an **explicitly opt-in test-only** `M2_LOCAL_SUPABASE_COMPAT=true` branch with `M2_LOCAL_PUBLISHABLE_KEY` and `M2_LOCAL_SECRET_KEY`, sourced only from local `supabase status` inside the testing harness. In all other runtimes, `withSupabase` uses its normal native environment resolution. The HMAC authentication requirement is never bypassed.
3. **Toolchain differences.** The local Next.js TypeScript build and standalone Deno checker use different default configuration/resolution. Removing the redundant type import avoided duplicate `SupabaseClient` class types. Use `deno check --no-config --node-modules-dir=none ...` to check standalone function code without inheriting the Next.js `tsconfig.json`.

## Regression evidence after final source changes

- `npm.cmd test`: **62 passed / 8 files**.
- `npm.cmd run typecheck`: **PASS**.
- `npm.cmd run lint`: **PASS**.
- `npm.cmd run build`: **PASS**, Next.js 16.4.3 webpack production build.
- `deno check --no-config --node-modules-dir=none supabase/functions/m2-process-queue/index.ts`: **PASS**.
- `git diff --check`: **PASS** (benign Windows CRLF conversion notices).
- Full live local Edge worker harness independently rerun after final code changes: **PASS**.

## Reproduction

With Docker Desktop and the isolated PestLaunch Supabase stack running:

```powershell
cd "D:\PROJECTS\Next JS projects\PestLaunch\pestlaunch-call-intelligence"
supabase start
node supabase/tests/m2_edge_live_integration.mjs
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
deno check --no-config --node-modules-dir=none supabase/functions/m2-process-queue/index.ts
```

The Edge harness is deliberately **local-only**, requires an existing queued `pending_m3` browser-upload fixture, creates and deletes only its own synthetic test job, and removes its one-time secret file. It does not create hosted resources, enable Cron, process Gemini data, or change any real customer recording.

## Milestone decision

**M2 local integration certified PASS:** migrations, PostgreSQL RLS and lease behavior, private Storage, real authenticated browser upload, Next.js upload HTTP E2E and real local Edge worker now all have successful evidence.

**Hosted M2 remains a separate release gate** requiring architecture-owner approval for migration, Storage bucket, Edge deployment, environment secret provisioning, hosted smoke test, and eventually Cron activation. Do not mark the hosted project PASS or begin M3 solely from local results.

All code and QA changes remain uncommitted pending owner checkpoint authorization.
