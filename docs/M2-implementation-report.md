# PestLaunch Call Intelligence V1 — M2 Independent QA Correction Report

> **2026-10-27 follow-up:** The original **BLOCKED** verdict below records the earlier Docker-unavailable attempt. Independent local QA subsequently recovered Docker, applied all migrations on PostgreSQL 17.6, passed the M1/M2 SQL and two-worker tests, exercised real private Storage RLS, and passed the full Next.js HTTP ingestion path. **Local DB/Storage/HTTP integration: PASS; hosted activation not performed.** See [M2 local integration QA](M2-local-integration-QA-20261027.md) for evidence and remaining browser/Edge-runtime checks.

Date: 2026-10-27
Project: D:/PROJECTS/Next JS projects/PestLaunch/pestlaunch-call-intelligence
Branch: m1-call-intelligence
Baseline and current HEAD: 9bad65898aa65920a317ce26bc88efb73aa6025b
Hosted changes: none

## Verdict

**BLOCKED — the requested independent M2 QA cannot close without PostgreSQL 17 and real local Supabase Storage verification.**

The source corrections and available local code checks pass. The required database, Storage RLS, two-connection queue, cleanup-overlap, and authenticated upload-flow evidence is not available because the Docker engine is unavailable. The project pins PostgreSQL 17; the installed PostgreSQL command-line binaries are version 18, which is not an acceptable substitute.

The architecture owner reported M1 real sign-in/sign-out, membership, and disabled-public-signup checks passed. This handoff accepts that result and did not repeat M1 discovery. No hosted migration, bucket, Edge Function, secret, Cron, or upload was applied or changed. No commit was created.

## P0 — Direct authenticated Storage transfer

**Source correction: PASS. Runtime/RLS verification: BLOCKED.**

The former Next.js audio proxy route was removed. The browser now calls a same-origin Next.js prepare endpoint, then sends the MP3 directly to the private Storage API with the signed-in user session JWT and publishable key. Next.js remains authoritative for verified identity, workspace role, upload-intent creation, server-held lease preparation, server-side byte verification, and idempotent finalization. No signed-upload URL or token is created or returned.

The Storage INSERT predicate checks auth.uid(), writable workspace membership, exact generated object path, active intent, and an unexpired upload lease. The bucket remains private with audio/mpeg and a 52,428,800-byte limit; client validation and server validation retain the 50 MiB ceiling. Generated object paths, idempotency, same-intent retry behavior, and normal pending_m3 jobs are preserved. Normal uploads finalize as queued and pending_m3; the M2 worker still cannot process them.

Implementation files:

- src/app/api/calls/upload-intents/route.ts
- src/app/api/calls/upload-intents/[intentId]/prepare/route.ts
- src/app/api/calls/upload-intents/[intentId]/finalize/route.ts
- Removed: src/app/api/calls/upload-intents/[intentId]/upload/route.ts
- src/components/calls/upload-call-form.tsx
- src/lib/calls/direct-storage-upload.ts
- src/lib/calls/upload-http.ts
- src/lib/calls/upload-service.ts
- src/lib/calls/supabase-upload-repository.ts
- supabase/migrations/20261027120306_m2_audio_ingestion_queue.sql
- supabase/tests/m2_storage_access.mjs
- src/lib/calls/direct-storage-upload.test.ts
- src/lib/calls/upload-service.test.ts

Evidence:

- Unit coverage verifies the browser request targets Supabase Storage, includes the signed-in user JWT and publishable key, sets audio/mpeg and x-upsert=false, reports progress, refuses a missing session, and rejects an unsafe object path.
- The upload-service test verifies prepare returns the generated path but not its server-held lease token; retry reuses an active lease; finalization passes the server-held token to the atomic RPC.
- The m2_storage_access.mjs local integration harness creates separate users/workspaces, checks anonymous and cross-workspace Storage INSERT denial, checks client read denial, performs an authenticated insert, then checks idempotent finalization and queued/pending_m3 state. It passed node --check but could not run against a local Supabase stack.
- The migration adds no Storage SELECT policy. supabase/tests/m2_permissions.sql asserts that the isolated Storage schema has no object-read policy. Neither the SQL assertion nor actual Storage API denial was executed.
- Vercel documents a 4.5 MB function request limit, below this feature's 50 MiB ceiling: https://vercel.com/docs/functions/limitations
- Supabase documents direct Storage upload and policy-based authorization: https://supabase.com/docs/reference/javascript/file-buckets-upload and https://supabase.com/docs/guides/storage/security/access-control

The code enforces MP3 structure/type/size and directs operators to synthetic-only fixtures. MP3 bytes cannot establish whether a recording is synthetic; the synthetic-only restriction remains an operational input requirement.

## P1 — Timeout and worker lifecycle

**Source correction and targeted unit evidence: PASS. Database lifecycle certification: BLOCKED.**

A timeout no longer triggers a competing failure write after an ambiguous completion RPC. The worker performs a read-only outcome reconciliation. If the database response is still ambiguous, it reports completion_unknown and leaves the lease-fenced database lifecycle to determine the final state. A delayed completion may still finish after the HTTP step timeout, but it cannot be followed by a contradictory failure transition from that worker invocation. Failure writes also use read-only reconciliation after ambiguous responses. Expired and stale attempt owners remain fenced by the queue RPCs.

Implementation and test files:

- supabase/functions/_shared/m2-worker.ts
- supabase/functions/m2-process-queue/index.ts
- src/lib/calls/m2-worker.test.ts
- supabase/tests/m2_queue.sql

Targeted unit cases cover completion committing after the timeout, completion committed before its response times out, no compensating failure after timeout, delayed failure reconciliation, lease expiry, stale attempt ownership, and the normal pending_m3 path. They are included in the passing full TypeScript unit suite below. SQL lease-expiry and stale-attempt assertions exist but were not run.

## P2 — Real MP3 and cleanup overlap

**Fixture and source harness: PASS. Database/Storage execution: BLOCKED.**

supabase/tests/fixtures/synthetic-tone.mp3 is a generated 4,284-byte synthetic tone. ffprobe identified MP3, 22,050 Hz, mono, 1.071 seconds; FFmpeg decoded it without errors. Upload-service tests use these actual fixture bytes rather than only four-byte header samples.

Cleanup now acquires a database cleanup lease while atomically changing an expired intent to abandoned. Mark-cleaned and release calls require the current cleanup token. The Edge worker deletes only the validated server-generated object path, marks it cleaned after Storage succeeds, and token-releases failed work. A finalized intent is not cleanup-eligible.

Implementation and test files:

- supabase/migrations/20261027120306_m2_audio_ingestion_queue.sql
- supabase/functions/m2-process-queue/index.ts
- supabase/tests/m2_upload_lifecycle.sql
- supabase/tests/m2_permissions.sql
- supabase/tests/m2_cleanup_concurrency.mjs

The SQL lifecycle test covers a live upload lease, expired/stale upload attempts, finalized-call idempotency, cleanup lease fencing, and exclusion of finalized rows. The cleanup integration harness uses two independent psql sessions and actual private Storage objects; it checks no overlapping claim, cleared cleanup state, removal of the abandoned object, and retention of the finalized object. Both concurrency harnesses require the first named database session to be in the PostgreSQL PgSleep wait event with at least five seconds remaining, and verify it is still in that wait event after the competing query completes. A missed barrier or delayed competitor fails the test rather than producing a false pass. The harnesses passed node --check but were not executed.

## Verification

- npm.cmd test -- --reporter=dot — PASS: 8 files, 61 tests.
- npm.cmd run typecheck — PASS.
- npm.cmd run lint — PASS, zero warnings.
- CIRCLE_NODE_TOTAL=1 npm.cmd run build — PASS. Output includes create-intent, prepare, and finalize routes and contains no proxy upload route.
- deno check --no-remote supabase/functions/_shared/m2-worker.ts — PASS.
- node --check supabase/tests/m2_storage_access.mjs — PASS.
- node --check supabase/tests/m2_cleanup_concurrency.mjs — PASS.
- node --check supabase/tests/m2_queue_concurrency.mjs — PASS.
- ffprobe and FFmpeg decode of the synthetic MP3 fixture — PASS.
- git diff --check — PASS; Git emitted only its existing LF-to-CRLF working-copy warnings.

The build initially encountered sandbox EPERM while Next.js created generated .next directories. The successful build ran serially after that failure. A stale ignored .next/dev/types/validator.ts reference to the removed proxy route was removed from generated output; no source file was removed for that cleanup.

## Database and authenticated-flow blocker

Certification preflight on 2026-10-27:

- Supabase CLI: 2.75.0. The local command help was inspected before considering stack commands.
- supabase/config.toml specifies PostgreSQL major version 17, database port 54322, API port 54321, Studio port 54323, and Inbucket port 54324.
- PostgreSQL CLI reports version 18.3; it was not used as a substitute.
- No listener was present on local Supabase ports 54321 through 54329 at preflight.
- Docker CLI and Docker Desktop are installed. Docker Desktop was not running. The user authorized starting it; hidden starts were attempted, including an elevated local process start, but no Docker Desktop process remained running and the engine did not become available.
- Exact Docker API error: permission denied while trying to connect to the Docker API at npipe:////./pipe/dockerDesktopLinuxEngine.
- Since the Docker API was inaccessible, existing containers and volumes could not be inventoried. No `supabase start`, database reset, migration, or SQL test was attempted; the pre-existing local data state could not be proven disposable.
- The hosted project reference aznfcxrlpzjnssfatzxi was not used. No hosted credentials were read, no `.env.local` was changed, and no hosted operation was attempted.

Therefore this certification attempt did not run either M1 or M2 migrations, any SQL/RLS assertion, m2_queue_concurrency.mjs, m2_cleanup_concurrency.mjs, m2_storage_access.mjs, or the authenticated Next.js upload flow. Unit tests are not substituted for those database and Storage results. Stop here until the local Docker engine can be started and its existing containers/volumes safely inventoried.

Required evidence before this QA can be upgraded:

1. An isolated Supabase-compatible PostgreSQL 17 stack that applies M1 and M2 migrations.
2. Passing M1/M2 SQL and RLS assertions.
3. Passing two-connection queue concurrency and overlapping cleanup tests.
4. Actual Storage INSERT permission for the intended authenticated member; denial for anonymous and cross-workspace users; denial of object reads.
5. The authenticated app upload and idempotent finalization flow.

## Exact local M2 change inventory

- .env.example
- README.md
- docs/M2-implementation-design.md
- docs/M2-implementation-report.md
- docs/database.md
- docs/onboarding.md
- docs/security.md
- docs/superpowers/plans/2026-10-27-pestlaunch-m2.md
- src/app/(app)/calls/page.tsx
- src/components/app-shell.tsx
- src/app/api/calls/upload-intents/route.ts
- src/app/api/calls/upload-intents/[intentId]/prepare/route.ts
- src/app/api/calls/upload-intents/[intentId]/finalize/route.ts
- src/components/calls/upload-call-form.tsx
- src/lib/calls/direct-storage-upload.ts
- src/lib/calls/direct-storage-upload.test.ts
- src/lib/calls/m2-worker.test.ts
- src/lib/calls/status.ts
- src/lib/calls/status.test.ts
- src/lib/calls/supabase-upload-repository.ts
- src/lib/calls/upload-http.ts
- src/lib/calls/upload-service.ts
- src/lib/calls/upload-service.test.ts
- src/lib/calls/upload-validation.ts
- src/lib/calls/upload-validation.test.ts
- src/lib/env/server.ts
- src/lib/env/server.test.ts
- src/lib/supabase/admin.ts
- supabase/config.toml
- tsconfig.json
- supabase/cron/enable-m2-worker.sql
- supabase/cron/inspect-m2-worker.sql
- supabase/functions/_shared/m2-worker.ts
- supabase/functions/m2-process-queue/index.ts
- supabase/functions/supabase-server.d.ts
- supabase/migrations/20261027120306_m2_audio_ingestion_queue.sql
- supabase/tests/fixtures/synthetic-tone.mp3
- supabase/tests/m2_cleanup_concurrency.mjs
- supabase/tests/m2_local_postgres_bootstrap.sql
- supabase/tests/m2_permissions.sql
- supabase/tests/m2_queue.sql
- supabase/tests/m2_queue_concurrency.mjs
- supabase/tests/m2_storage_access.mjs
- supabase/tests/m2_upload_lifecycle.sql
- supabase/tests/m2_worker_auth.sql

This report stops at the local database/Storage blocker for owner review. No hosted M2 action is requested or performed.
