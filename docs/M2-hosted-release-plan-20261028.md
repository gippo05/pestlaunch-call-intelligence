# PestLaunch M2 — Hosted Release Plan (NOT YET EXECUTED)

**Prepared:** 2026-10-28 (PHT)  
**Target:** PestLaunch Test — Supabase project `aznfcxrlpzjnssfatzxi` in `ap-south-1`  
**Owner:** Gipps  
**Status:** LOCAL CERTIFIED / HOSTED RELEASE NOT AUTHORIZED IN THIS PLAN

## Evidence and preflight

- Local M2 certification **PASS**, with PostgreSQL 17.6 migrations, SQL and RLS, queue/cleanup concurrency, real authenticated private Storage, owner-confirmed real browser upload and live Edge Function HMAC/replay tests.
- Regression suite **62/62 PASS**, Next.js typecheck, ESLint, production build and standalone Deno check all passed after Edge compatibility corrections.
- Hosted PestLaunch project **ACTIVE_HEALTHY**, PostgreSQL **17.11**.
- Read-only hosted preflight: only M1 migrations `20261027062949`, `20261027063558` present; **no M2 `upload_intents`**, **no `pestlaunch-call-audio` bucket**, **no `m2-process-queue` Edge function**, **no `pestlaunch-m2-worker` Cron**, **no M2 Vault secret names**, and **one existing workspace membership**.
- Existing M0.5 functions (`m05-cron-ping`, `m05-dashboard-20m-benchmark`) must not be changed or redeployed.

## Controlled release, following owner authorization

1. **Freeze Git checkpoint.** Audit the staged tree for secrets and unintended files; create an explicit M2 commit on `m1-call-intelligence`. Never stage `.env`, `.env.local`, local credentials, `NUL`, generated Supabase state, or arbitrary files.
2. **Confirm target and recovery.** Recheck project ref/region/schema/migration history; record existing tables, policy counts, relevant row counts and current Auth signup restriction. Use the platform's available backup/export capability and verify a recovery procedure before schema mutation.
3. **Apply only the additive M2 migration** `20261027120306_m2_audio_ingestion_queue.sql` to the authorized PestLaunch Test project. Do not reapply M1 or use `supabase db reset` / broad `db push`. Stop on errors; perform smallest forward-fix migration only after review.
4. **Inspect hosted database boundaries.** Verify bucket is private, 50 MiB and MP3-only; exact RLS INSERT predicate, no client data grants to upload-intent/queue tables, correct `SECURITY DEFINER` search paths, RPC ACLs, constraints, indexes, worker nonce table and one-job queue ownership.
5. **Configure app deployment secret safely.** Set `SUPABASE_SECRET_KEY` as server-only in the authorized Next.js hosting environment; preserve modern publishable key in client. Never expose secret in `NEXT_PUBLIC_*`. Do not enable the isolated local HTTP override in hosted environments.
6. **Deploy only `m2-process-queue`.** Use the production Supabase Edge runtime; `verify_jwt = false` is intentional only with the independent HMAC challenge. Set a new independent 32+-byte random HMAC secret in protected Edge settings; keep `M2_TEST_PROCESSOR_ENABLED=false`. Confirm hosted `@supabase/server` default-key injection works (the old local CLI needed an isolated compatibility override).
7. **Manual hosted synthetic smoke test.** Use the pre-existing authorized assessment account; verify login, direct private Storage upload, idempotent finalization and exactly one queued `pending_m3` job. Verify anonymous and cross-workspace denial where disposable hosted test identities can be safely created and removed. No real customer audio.
8. **Worker manual HTTP smoke test.** Verify invalid/no HMAC is denied; a valid HMAC produces `outcome=disabled` with zero processing when synthetic processor is disabled. Verify the queued M3 call remains untouched. Check logs for safe metadata only and restore/rotate any ephemeral testing secret if required.
9. **Cron is a separate gate.** Do not run `supabase/cron/enable-m2-worker.sql` until owner specifically approves scheduled execution and Vault values (`m2_project_url`, `m2_publishable_key`, `m2_worker_auth_secret`). Check `pg_net` request outcomes, not just successful enqueue.
10. **Document results and stop.** Mark hosted M2 PASS only with deployed evidence. M3 remains unstarted.

## Stop conditions

- Wrong project ref or database version, unexpected migration drift or object collision.
- Hosted Auth public signup unexpectedly enabled, missing workspace authorization, or client privilege expansion.
- Secret/API-key mismatch, Edge import/runtime failure, HMAC acceptance without nonce validation or access-control failure.
- Any change to existing M0.5 functions or other projects.
- Any request to turn on Cron or process real customer audio without separate permission.

## References

- `docs/M2-local-integration-QA-20261027.md`
- `docs/M2-edge-runtime-certification-20261028.md`
- `supabase/migrations/20261027120306_m2_audio_ingestion_queue.sql`
- `supabase/cron/enable-m2-worker.sql` (prepared, DO NOT execute)
- `supabase/cron/inspect-m2-worker.sql`
