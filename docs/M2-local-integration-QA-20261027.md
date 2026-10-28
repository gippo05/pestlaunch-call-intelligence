# PestLaunch M2 — Independent Local Integration QA, 2026-10-27

> **2026-10-28 update:** The remaining live local Edge Function smoke test subsequently passed, along with the browser upload check and final regressions. **M2 LOCAL INTEGRATION: PASS.** Hosted activation remains unapproved and untested. See [M2 Edge runtime certification](M2-edge-runtime-certification-20261028.md) for the exact evidence.

## Verdict

**LOCAL DATABASE + STORAGE + APPLICATION HTTP INTEGRATION: PASS.**

This is an independent follow-up to `docs/M2-implementation-report.md`, whose original BLOCKED verdict was accurate *before* Docker was available. Local PostgreSQL 17 migrations, security assertions, concurrency harnesses, real session-backed Storage integration and actual Next.js HTTP-route integration have now run and passed.

**NOT A HOSTED DEPLOYMENT CERTIFICATION.** The remote PestLaunch Test project (`aznfcxrlpzjnssfatzxi`) was never mutated. Edge Function runtime invocation and a real browser/XHR file-picker smoke test were not executed during this follow-up. Keep hosted migration, Storage provisioning, function deployment and Cron activation behind owner review.

## Local environment and isolation

- Original local branch: `m1-call-intelligence`, M1 checkpoint `9bad658`; M2 and QA changes remain uncommitted.
- Docker Desktop engine recovered and responded to Docker API commands.
- Fresh project-scoped Supabase stack named `pestlaunch-call-intelligence`. No pre-existing container or named volume for this project existed.
- Database: **PostgreSQL 17.6**, verified inside the `supabase_db_pestlaunch-call-intelligence` container.
- Local URL `http://127.0.0.1:54321`; database `127.0.0.1:54322`.
- The hosted Supabase project and existing root `.env` were not changed.
- Unrelated Docker containers/volumes were preserved.

## Defects found and corrected locally

1. **Migration SQL name collision** — Initial `supabase start` failed with SQLSTATE 42710, because an inline CHECK on `analysis_jobs.completion_kind` acquired the same generated name as the following explicit constraint. Changed only the explicit M2 constraint name to `analysis_jobs_completion_status_check`. This migration had never been deployed remotely.
2. **Test assertion snapshot issue** — `supabase/tests/m2_upload_lifecycle.sql` initially combined `mark_call_upload_cleaned(...)` and a same-expression verification query. Split the state mutation and verification into separate PL/pgSQL statements. The test then passed.
3. **Local Auth provider configuration** — `[auth.email].enable_signup = false` disabled Email authentication locally. Set it to `true` while keeping global `[auth].enable_signup = false`. Verified with a real rejected public signup and successful administrator-provisioned user sign-ins. No hosted Auth setting changed.
4. **Strict HTTPS production validator blocked local integration** — Added an *explicit*, development-only, exact-host exception in `src/lib/env/public.ts` and `src/lib/env/server.ts` for `http://127.0.0.1:54321` when `NEXT_PUBLIC_ALLOW_LOCAL_SUPABASE_HTTP=true` and `NODE_ENV=development`. Production/non-loopback HTTP remains rejected. Added a regression test.
5. **Test-only fixture cleanup order** — `m2_cleanup_concurrency.mjs` and `m2_storage_access.mjs` previously attempted workspace deletion before dependent call/intent rows and suppressed cleanup errors. Fixed order and fail-on-error checks. Removed precisely identified earlier local-only fixtures and re-ran. No product cleanup-lease algorithm changes were needed.

## Tests actually run

| Test / invariant | Result |
|---|---|
| All three M1/M2 migrations apply to PostgreSQL 17.6 | **PASS** |
| M1 catalog permissions | **PASS** |
| M1 two-subject, cross-tenant SQL RLS | **PASS** |
| M2 catalog permissions and functions ACLs | **PASS** |
| M2 upload lifecycle, idempotency and lease fencing SQL | **PASS** |
| M2 queue retry, lease expiry and stale ownership SQL | **PASS** |
| M2 worker nonce rejection/replay SQL | **PASS** |
| Two-session queue claim concurrency, actual PostgreSQL | **PASS** |
| Two-session overlapping cleanup-lease concurrency, actual PostgreSQL | **PASS** |
| Existing `m2_storage_access.mjs`, real private Storage with synthetic MP3 | **PASS** |
| Added `m2_storage_integration.mjs`, three real JWT sessions and private Storage RLS | **PASS** |
| Direct owner Storage INSERT | **PASS** |
| Anonymous/member/cross-workspace/wrong-path/expired-intent INSERT denial | **PASS** |
| Private download and overwrite denial | **PASS** |
| Idempotent finalize creates one call plus one queued `pending_m3` job | **PASS** |
| Local public signup denied while email/password sign-in works | **PASS** |
| Added `m2_app_http_integration.mjs`: Next.js sign-in, protected Calls page, intent, prepare, direct Storage, finalize, list and sign-out | **PASS** |
| Vitest (8 files, 62 tests) | **PASS** |
| `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd run build` | **PASS** |

All test users and assets were disposable local fixtures. A final direct PostgreSQL query after rerunning cleanup and Storage tests returned **0** for `upload_intents`, `calls`, `analysis_jobs`, `workspaces`, private audio `storage.objects` and test Auth accounts.

## Limitations and remaining release gates

- The local Next.js **HTTP E2E** tested real auth cookies, Next.js route handlers, private Storage using an authenticated SDK client, idempotent finalization and protected page HTML. It did **not** automate the browser's actual file-input selection or its `XMLHttpRequest`/CORS behavior. Execute a real browser smoke test before asserting full UI certification.
- The local synthetic Edge Function entry point was not invoked against the running Edge runtime. Prior worker unit tests and Deno checks were reported by the implementor; a live runtime smoke test remains advisable before enabling hosted Cron.
- Do not present any local results as evidence that the hosted migration, bucket, Edge Function, Vault, or Cron currently exists or works.
- Do not process any real customer recordings, use Gemini, or proceed to M3 solely because local M2 ingestion integration passed.
- Review the uncommitted diffs, retest the exact final build when moving toward hosted activation, and obtain explicit owner authorization for remote changes.

## Commands to reproduce (isolated local project)

```powershell
supabase start
# Run m1_permissions.sql, m1_rls_behavior.sql, m2_permissions.sql,
# m2_upload_lifecycle.sql, m2_queue.sql and m2_worker_auth.sql
# against ONLY the local PostgreSQL 17 service, with ON_ERROR_STOP=1.
node supabase/tests/m2_queue_concurrency.mjs
node supabase/tests/m2_cleanup_concurrency.mjs
node supabase/tests/m2_storage_access.mjs
node supabase/tests/m2_storage_integration.mjs
node supabase/tests/m2_app_http_integration.mjs
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
```

**Certification ownership:** GPT-6 independent read-only + local QA execution. No hosted mutation, commit, or push.
