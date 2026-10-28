# PestLaunch Call Intelligence M2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local-only authenticated MP3 intake, durable queue processing foundations, a guarded synthetic worker, and truthful Calls upload/status UI.

**Architecture:** Next.js route handlers authorize users through the existing Supabase Auth session and membership relation, create server-generated upload intents, and prepare server-held upload leases. The signed-in browser sends bytes directly to a private Storage bucket using its session JWT and no signed-upload token. A transactional finalizer creates call/job records; locked service-only RPCs claim and complete jobs. A Supabase Edge Function uses an independent worker secret and only processes explicitly marked synthetic jobs.

**Tech Stack:** Next.js 16.4.3 App Router, React 19.3.1, TypeScript, Supabase JS 2.118.0, Supabase CLI, PostgreSQL 17, Supabase Edge Functions, Vitest.

**Spec:** `docs/M2-implementation-design.md` and the user's pasted M2 request.

## Global Constraints

- Local M2 implementation and testing only; do not apply hosted migrations, create hosted buckets, deploy functions, set hosted secrets, or activate Cron.
- Preserve M1 auth, membership, workspace RLS, and read-only client table grants.
- Accept synthetic MP3 (`audio/mpeg`) files only, maximum 50 MiB; private bucket `pestlaunch-call-audio`.
- No customer recordings, Gemini, transcription, classification, scoring, coaching, new paid infrastructure, Railway, or deployment.
- Never log or report a Supabase secret key, worker secret, signed upload token, private audio URL, raw file bytes, or customer data.
- Normal uploaded jobs remain queued for M3; only explicit test jobs can complete in M2 and must be labeled synthetic test results.
- Keep every M2 implementation change local and uncommitted after the one requested M1 checkpoint.

## Review Focus

- Forged or missing identity, nonmember role, and cross-workspace intent: reject before privileged operations.
- Replayed idempotency key or finalization: return one existing intent/call/job without duplicate rows.
- Filename traversal, unsupported MIME/signature, mismatched bytes, and 50 MiB boundary: reject safely and retain cleanup eligibility.
- Concurrent claims, expired lease, max attempts, and stale attempt token: only the current unexpired lease may complete or retry.
- Normal upload and disabled test mode: keep the call queued and never create a false completed analysis.

---

### Task 1: Upload domain validation

**Files:**
- Create: `src/lib/calls/upload-validation.ts`
- Test: `src/lib/calls/upload-validation.test.ts`
- Modify: `src/lib/calls/` only as later tasks require

**Interfaces:**
- `validateUploadIntent(input)` validates brand, filename, MIME, size, and UUID idempotency key without accepting workspace/path fields.
- `isMp3Signature(bytes)` recognizes an ID3 tag or MPEG audio frame header.

- [x] Write tests for valid/invalid names, MP3-only MIME, size boundaries, bad brands, path separators, and byte signatures.
- [x] Run the focused tests and confirm they fail because the exports do not exist.
- [x] Implement the pure validators and safe public error codes.
- [x] Run focused tests and the existing full Vitest suite.

### Task 2: Additive Storage and queue migration

**Files:**
- Create via `supabase migration new`: one timestamped M2 migration in `supabase/migrations/`
- Create: `supabase/tests/m2_permissions.sql`
- Create: `supabase/tests/m2_queue.sql`
- Create: `supabase/tests/m2_upload_lifecycle.sql`
- Create: `supabase/tests/m2_queue_concurrency.mjs`
- Create: `supabase/tests/m2_cleanup_concurrency.mjs`
- Create: `supabase/tests/m2_storage_access.mjs`
- Create: `supabase/tests/m2_worker_auth.sql`
- Modify: `supabase/tests/` only to preserve M1 checks

**Interfaces:**
- Add private bucket configuration, locked-down upload intents, storage insert predicate, idempotent finalization, claim, complete, fail, and token-leased cleanup functions.
- Add only the `calls`/`analysis_jobs` fields and status values required to preserve test-result truth and finalization idempotency.
- Queue RPCs are callable only by `service_role`; storage insert is limited to the caller's own unexpired intent.

- [x] Write SQL assertions for table grants, bucket privacy/limits, Storage policy ACLs, RPC ACLs, call/job idempotency, retries, and lease fencing.
- [ ] Run assertions against the local M1 schema and confirm they fail on missing M2 objects. BLOCKED: Docker engine unavailable; project config requires PostgreSQL 17.
- [x] Create the migration with the installed Supabase CLI and implement additive SQL with fixed `search_path` and explicit grants.
- [ ] Run M1 and M2 SQL tests locally; add concurrent queue and cleanup claim checks using independent connections. NOT RUN: Docker is unavailable; installed PostgreSQL 18 binaries do not satisfy the configured PostgreSQL 17 requirement.

### Task 3: Authorized upload API

**Files:**
- Create: `src/lib/env/server.ts` and tests
- Create: `src/lib/calls/upload-service.ts` and tests
- Create: `src/app/api/calls/upload-intents/route.ts`
- Create: `src/app/api/calls/upload-intents/[intentId]/prepare/route.ts`
- Create: `src/app/api/calls/upload-intents/[intentId]/finalize/route.ts`
- Create: `src/lib/calls/direct-storage-upload.ts`
- Modify: `src/lib/auth/session.ts` only if shared identity plumbing requires it
- Modify: `.env.example`, `README.md`, and `docs/security.md`

**Interfaces:**
- The signed-in user client verifies claims and membership; a server-only `SUPABASE_SECRET_KEY` client performs narrowly scoped privileged database and verification reads.
- Intent creation derives exactly one authorized workspace from the user's membership. The server prepares an upload lease and returns only the generated object path; authenticated Storage RLS checks caller, membership, path, intent, and lease during direct browser transfer. Finalization checks object metadata and bytes before the lease-fenced database RPC.

- [x] Add service-level tests for authorization, malformed/forged request shape, duplicate intent, invalid file, owner mismatch, upload recovery, and idempotent finalization. Route-level Supabase integration remains untested.
- [x] Run the service and application unit tests after implementation; real route and Storage integration tests are prepared but BLOCKED by the unavailable local PostgreSQL 17 stack.
- [x] Implement the injected service and route handlers; never return or log any signed upload URL/token.
- [x] Remove the proxied audio route and use direct authenticated browser-to-Storage transport to stay below the Vercel function request-size limit.
- [x] Run unit tests, typecheck, lint, and production build.

### Task 4: Guarded queue worker

**Files:**
- Create: `supabase/functions/_shared/m2-worker.ts`
- Create: `supabase/functions/m2-process-queue/index.ts`
- Create: `src/lib/calls/m2-worker.test.ts`
- Modify: `supabase/config.toml`

**Interfaces:**
- Worker accepts only `POST` plus a verified HMAC bearer proof bound to a short-lived timestamp and one-use nonce; the signing secret stays in Edge Function configuration and Vault.
- Injected processor registry exposes a synthetic-only processor; disabled/default mode is a safe no-op and never claims ordinary pending-M3 jobs.
- Each invocation has a bounded batch of one, fixed safe error codes, and structured non-sensitive logs.

- [x] Write worker tests for missing/invalid secret, empty queue, synthetic test completion labeling, retry/final failure, and disabled processor behavior.
- [x] Run worker unit tests with the full Vitest suite.
- [x] Implement the shared worker and Edge Function entry point; disable platform JWT verification only for this function because the handler checks the independent worker proof.
- [x] Run `deno check --no-remote` for the dependency-free shared worker module. The Edge Function entry point could not be checked because `npm:@supabase/server` is not cached and network access is restricted.

### Task 5: Calls upload and status UI

**Files:**
- Create: `src/components/calls/upload-call-form.tsx`
- Create: `src/lib/calls/status.ts` and tests
- Modify: `src/app/(app)/calls/page.tsx`
- Modify: `src/components/app-shell.tsx`

**Interfaces:**
- The existing server-rendered Calls page continues to read calls under RLS. A client form uses XHR progress against private Storage with the user's session token; it shows validated errors, retries, and status without exposing a signed upload token.
- Status copy differentiates uploaded, queued for M3, failed, and synthetic test completion.

- [x] Add unit tests for status labels and upload behavior.
- [x] Implement file selection, brand choice, progress, visible errors, retry, call list/status states, and the M3-not-enabled note.
- [x] Run unit/type/lint checks and confirm the logged-out `/calls` route redirects to `/login` in the local browser.
- [ ] Inspect the authenticated Calls page at desktop and mobile sizes. BLOCKED: local Supabase/Auth/Storage stack unavailable; M1 owner checks were accepted from the handoff and not repeated.

### Task 6: Guarded Cron, operations notes, and final evidence

**Files:**
- Create: `supabase/cron/enable-m2-worker.sql`
- Create: `supabase/cron/inspect-m2-worker.sql`
- Create: `docs/M2-implementation-report.md`
- Modify: `README.md`, `docs/database.md`, and `docs/security.md`

**Interfaces:**
- Activation requires preexisting Vault names for project URL, publishable key, and an independent high-entropy worker secret; it verifies `pg_cron`/`pg_net`, HMAC availability, bucket/RPC presence, Vault values, and schedule-name collisions before creating a one-minute job.
- The activation file is preparation only. It is never run in this task. Diagnostics inspect Cron runs separately from asynchronous `pg_net` HTTP responses.

- [x] Add the non-activating guarded SQL and owner activation steps.
- [x] Run the local M1 and M2 unit suites, typecheck, lint, diff check, build, and logged-out browser route check.
- [x] Record local and hosted evidence separately, preserve the owner-reported M1 pass without repeating discovery, confirm no hosted mutation, and stop for owner review.
- [ ] Run SQL/RLS integration, two-connection queue/cleanup tests, actual Storage upload/read-denial, and authenticated upload flow when a Supabase-compatible PostgreSQL 17 stack is available.

## Captured verification

See `docs/M2-implementation-report.md` for exact results and limitations. Source corrections and local code checks pass; the requested independent M2 QA is BLOCKED by unavailable PostgreSQL 17/Storage integration. No hosted action was authorized or performed.
