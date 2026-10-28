# M1 database foundation and M2 local preparation

Migration `20261027062949_m1_foundation.sql` creates seven public tables: `workspaces`, `workspace_members`, `calls`, `analysis_jobs`, `call_analyses`, `rubric_versions`, and `call_scores`. It also creates the non-exposed `private` schema with the narrowly scoped `is_workspace_member(uuid)` predicate and an `updated_at` trigger function. Migration `20261027063558_m1_foreign_key_indexes.sql` adds the two child-side indexes identified by the post-migration performance advisor.

The migrations add primary and foreign keys, tenant-aware unique constraints, checks for roles/statuses/JSON shapes/scores/leases, and lookup indexes. The follow-up indexes cover `calls.uploader_user_id` and `analysis_jobs(workspace_id, call_id)`. They do not insert seed workspace, rubric, call, account, or score data. They do not create or modify extensions, Storage buckets, Edge Functions, cron schedules, or Auth settings.

## M2 additive migration (local only)

`20261027120306_m2_audio_ingestion_queue.sql` is prepared locally and has not been applied to the hosted project. It adds:

- A private `pestlaunch-call-audio` MP3 bucket with a 50 MiB limit and one authenticated Storage `INSERT` policy that matches `auth.uid()` to writable workspace membership, the exact server-generated path, active intent, and upload lease. The browser uploads directly with its signed-in session JWT; no signed-upload token or Storage read/update/delete policy is issued.
- `upload_intents`, with workspace/user ownership, idempotency key, server-generated workspace-prefixed path, 2-hour intent expiry, upload lease, verification/finalization state, and token-fenced cleanup lease. The table is RLS-enabled and has no ordinary client grants.
- A unique link from `calls` to its upload intent, the explicit `test_completed` call status, and `processor_kind`/`completion_kind` on `analysis_jobs`. Existing jobs default to `pending_m3`.
- Service-only, fixed-search-path RPCs for upload leases, uploaded verification, atomic call/job finalization, one-job `FOR UPDATE SKIP LOCKED` claiming, lease-fenced completion/failure, retry backoff, and cleanup.
- Private one-use worker nonce and pg_net request-ID tables. A worker request HMAC is verified and the nonce is consumed once; the app's tracking table stores only request IDs, and the prepared inspection query omits request headers and response bodies. Supabase `pg_net` still keeps its own asynchronous responses for its configured retention period.

The M2 claim function intentionally returns only `m2_synthetic_test` jobs, and the Edge Function leaves `pending_m3` rows queued. Synthetic completion is labeled on both job and call; it creates no transcript or score. Cleanup marks an expired intent abandoned before deletion and assigns a cleanup lease; a finalization cannot race into creating a call, and overlapping workers cannot claim the same live cleanup lease. A failed cleanup releases its token or becomes retryable after lease expiry.

Independent QA executed the M1/M2 migrations on the **isolated Supabase PostgreSQL 17.6 stack**. `m2_permissions.sql`, `m2_upload_lifecycle.sql`, `m2_queue.sql`, `m2_worker_auth.sql`, both two-session concurrency harnesses and real authenticated Storage RLS tests **passed**. The actual Next.js upload HTTP route, owner-confirmed browser upload and live signed Edge worker also **passed**. The compatibility-only `m2_local_postgres_bootstrap.sql` is not used as certification evidence. See `docs/M2-local-integration-QA-20261027.md` and `docs/M2-edge-runtime-certification-20261028.md`. These local results do not certify hosted deployment.

The migration creates `private` without `IF NOT EXISTS`, so a pre-existing schema collision aborts the transaction instead of changing another schema's ACLs. The `calls.storage_path` value must be workspace-prefixed (`{workspace_id}/...`). M2 supplies the private bucket and enforces upload-intent path ownership through the authenticated Storage INSERT policy. M1 by itself created no bucket or upload workflow.

## Client grants and row policies

- `authenticated` receives `SELECT` only on the six user-facing tables. No client has `INSERT`, `UPDATE`, or `DELETE` access.
- `analysis_jobs` has RLS enabled, no policies, and no `anon`/`authenticated` grants. The Supabase security advisor reports this as one informational `rls_enabled_no_policy` finding; the absence of a policy is intentional default-deny behavior for the private queue.
- `anon` receives no table grants.
- Membership reads are limited to the caller's own membership row. Workspace and call reads use the membership helper. Analyses and scores are authorized through their parent call. Rubrics are readable only by an authenticated workspace member.
- `private.is_workspace_member` is `SECURITY DEFINER`, uses `SET search_path = ''`, references fully qualified relations and `auth.uid()`, and is executable only by `authenticated`.
- Service-role privileges are for trusted server-side workers only. The service-role key is never used by the browser or Next.js frontend.

The remote catalog/permission checks in `supabase/tests/m1_permissions.sql` passed. `supabase/tests/m1_rls_behavior.sql` passed with two synthetic JWT subjects in the `authenticated` database role; the transaction created temporary Auth and application fixtures, then rolled them all back. The architecture owner later confirmed that M1 real sign-in/sign-out, membership, and disabled-public-signup checks passed; this M2 correction relies on that handoff and did not repeat M1 discovery.

The performance advisor no longer reports unindexed foreign keys after the follow-up index migration. It reports unused indexes on the empty M1 tables, which is expected before application traffic exists.
