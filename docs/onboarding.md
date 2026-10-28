# Owner onboarding

1. In the Supabase dashboard, open project `PestLaunch Test` and verify its reference is `aznfcxrlpzjnssfatzxi` before making any change.
2. Apply the versioned M1 migrations in order: `supabase/migrations/20261027062949_m1_foundation.sql`, then `supabase/migrations/20261027063558_m1_foreign_key_indexes.sql`.
3. Create or invite the single assessment user manually in Supabase Auth. Keep public signup disabled in the hosted Auth settings; this app itself exposes no signup route. The architecture owner confirmed the disabled-signup setting and real M1 authentication/membership checks passed in the M2 QA handoff; this task did not repeat those checks.
4. Create the assessment workspace and membership through a trusted owner/database-admin session. Use the authenticated Auth user UUID; do not grant the assessment user write privileges to membership tables.
5. Configure `.env.local` with the project URL and publishable key; for M2 upload endpoints also supply the modern server-only `SUPABASE_SECRET_KEY`. Never expose that key in browser variables or version control. For isolated local testing, use `scripts/start-m2-local.ps1` instead of changing hosted configuration.

Example owner-only bootstrap SQL (replace the two placeholders after verifying identity; run once):

```sql
with new_workspace as (
  insert into public.workspaces (name)
  values ('PestLaunch Assessment')
  returning id
)
insert into public.workspace_members (workspace_id, user_id, role)
select id, '<AUTHORIZED_AUTH_USER_UUID>'::uuid, 'owner'
from new_workspace;
```

Do not run this sample as `anon` or `authenticated`; client writes are intentionally denied. No account, workspace, or call is pre-created by the migration.

## M2 hosted activation gate

The owner verified M1 real sign-in/sign-out, membership and disabled-public-signup behavior. Independent local certification then **passed** on PostgreSQL 17.6, Storage RLS, worker concurrency, authenticated Next.js/browser uploads and live Edge worker; see the dated M2 local and Edge certification reports. **Hosted M2 remains undeployed.** Before applying `20261027120306_m2_audio_ingestion_queue.sql`, deploying `m2-process-queue`, setting hosted secrets or running `supabase/cron/enable-m2-worker.sql`, obtain an explicit hosted release decision and verify target project, baseline, backup/recovery plan and deployment prerequisites.

After those decisions, the owner can apply the M2 migration to the verified `PestLaunch Test` project. The migration creates the private `pestlaunch-call-audio` bucket, upload-intent records, access policies, and service-only queue RPCs. It does not configure an AI provider.

The Next.js server requires `SUPABASE_SECRET_KEY` as a server-only deployment variable for M2 upload operations. The Edge Function requires `M2_WORKER_AUTH_SECRET` as a separate 64-character-or-longer hex secret and `M2_TEST_PROCESSOR_ENABLED=false` by default. The matching value is also stored in Supabase Vault under `m2_worker_auth_secret`; the other Vault names are `m2_project_url` and `m2_publishable_key`. Do not place the worker secret in browser code or log output.

The prepared Cron SQL signs each POST with an HMAC proof derived from the Vault secret, timestamp, and one-time nonce. The raw secret is not put in the `pg_net` request headers. Its activation preflight requires `pg_cron`, `pg_net`, Vault, the M2 migration, and `extensions.hmac`; it aborts rather than enabling an extension or changing an existing schedule. Only after the function is deployed with JWT verification disabled for its custom HMAC check should the owner deliberately run `supabase/cron/enable-m2-worker.sql`. Use `supabase/cron/inspect-m2-worker.sql` to inspect Cron runs and asynchronous HTTP responses separately.

These steps are instructions for a future owner-controlled activation. No M2 hosted action has been performed as part of this local implementation.
