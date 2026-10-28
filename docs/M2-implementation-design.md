# PestLaunch Call Intelligence V1 — M2 local design

Date: 2026-10-27
Scope: local implementation and verification only. No hosted migration, bucket, function, secret, or Cron changes.

## Intent

Add authenticated synthetic-audio intake, private workspace-scoped storage, an idempotent call/job handoff, a recoverable lease queue, a guarded worker, and visible Calls status to the existing M1 application. M1 authentication and membership checks remain authoritative. M2 does not perform transcription or AI analysis.

## M1 facts this design preserves

- The application already uses Next.js 16 App Router, Supabase SSR Auth, and a server-checked membership gate.
- `calls` requires `storage_path` to begin with its `workspace_id`; `brand` is `abc` or `noble_sales`; client table grants are read-only.
- `analysis_jobs` already has queued/leased/succeeded/failed/cancelled states, attempts, retry time, lease expiry, and attempt owner. It is hidden from ordinary clients.
- The owner reports that M1 real sign-in/sign-out, membership, and disabled-public-signup checks passed. This handoff does not repeat M1 discovery. Hosted M2 changes remain expressly out of scope.

## Goals and boundaries

- Accept only MP3 (`audio/mpeg`) up to 50 MiB. Generate the object path from verified workspace and server UUID; reject path-like filenames and invalid request shapes.
- Store audio in a private `pestlaunch-call-audio` bucket using authenticated browser-to-Storage transfer. Next.js authorizes identity/workspace, creates the intent, prepares the server-side lease, and finalizes. The browser receives no signed-upload token. The Storage `INSERT` policy checks `auth.uid()`, workspace membership, exact generated path, active intent, and active lease. Do not add client table writes or Storage read/update/delete policies.
- Create an upload intent with an idempotency key, user/workspace ownership, generated path, expected size/type, and expiry. Verify the stored object and MP3 signature before a single database transaction creates the call and its initial queue job. Repeated finalization returns the same call.
- Claim only explicitly marked synthetic test jobs in M2. Ordinary uploaded jobs stay visibly queued for M3. A synthetic worker completion is recorded and displayed as a test result, never as AI analysis.
- Use `FOR UPDATE SKIP LOCKED`, a unique per-attempt lease token, a bounded lease, a maximum of five attempts, bounded exponential retry, safe error codes, and stale-lease checks.
- Prepare a one-minute Cron activation script that reads its URL, publishable key, and independent high-entropy worker secret from Vault. PostgreSQL signs a short-lived timestamp-and-nonce HMAC; the raw worker secret is never placed in `pg_net` request headers. Keep the activation script separate and do not execute it.
- Use synthetic fixtures only. No Gemini, transcription, scoring, real customer audio, Railway, remote writes, or deployment.

## Transport correction

The prior implementation proxied audio through a Next.js route. QA rejected it because the 50 MiB file ceiling exceeds Vercel's 4.5 MB function request limit. The corrected flow prepares an upload lease on the server, then uses the signed-in browser's Supabase session JWT for a direct Storage `INSERT`. It does not create or return a signed-upload URL or token. The server retains identity, workspace authorization, lease preparation, byte verification, and idempotent finalization authority. Storage RLS binds the actual transfer to the caller, workspace membership, generated path, active intent, and lease.

## Implementation choices

- The API derives the single authorized workspace from the authenticated user's membership; it ignores client-supplied workspace and object paths. Only `owner` and `reviewer` membership roles may upload.
- The intent record is not readable or writable by `anon`/`authenticated`. A narrowly scoped `SECURITY DEFINER` predicate checks Storage inserts against the caller, active intent, path, and membership. Privileged RPCs have fixed empty `search_path` and explicit `service_role` grants.
- Normal M2 uploads create a `pending_m3` job. The worker does not claim those jobs. It can claim `m2_synthetic_test` jobs only when a local test-mode flag is enabled; production defaults to disabled.
- Cron signs a canonical POST path, timestamp, and UUID nonce with HMAC-SHA256 using the Vault secret. The worker checks the signature and time window, then atomically consumes the nonce before any cleanup or queue operation. This avoids placing the raw worker secret in `net.http_request_queue` headers and blocks request replay.
- Abandoned intents are eligible for cleanup after expiry and after any active upload lease ends. A cleanup lease prevents overlapping workers from claiming the same object; cleanup deletes only the server-recorded path and marks it cleaned only after Storage confirms deletion.
- Remote activation remains a human step after M1 authentication certification and explicit owner clearance.

## Success evidence

Run the full M1/M2 TypeScript suite, typecheck, lint, production build, local PostgreSQL 17 SQL/RLS assertions, two-connection queue and cleanup concurrency, real Storage access checks, and an authenticated direct-upload/finalization flow. Report source, local database, and hosted evidence separately. Hosted deployment is not authorized by this task.
