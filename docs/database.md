# M1 database foundation

Migration `20261027062949_m1_foundation.sql` creates seven public tables: `workspaces`, `workspace_members`, `calls`, `analysis_jobs`, `call_analyses`, `rubric_versions`, and `call_scores`. It also creates the non-exposed `private` schema with the narrowly scoped `is_workspace_member(uuid)` predicate and an `updated_at` trigger function. Migration `20261027063558_m1_foreign_key_indexes.sql` adds the two child-side indexes identified by the post-migration performance advisor.

The migrations add primary and foreign keys, tenant-aware unique constraints, checks for roles/statuses/JSON shapes/scores/leases, and lookup indexes. The follow-up indexes cover `calls.uploader_user_id` and `analysis_jobs(workspace_id, call_id)`. They do not insert seed workspace, rubric, call, account, or score data. They do not create or modify extensions, Storage buckets, Edge Functions, cron schedules, or Auth settings.

The migration creates `private` without `IF NOT EXISTS`, so a pre-existing schema collision aborts the transaction instead of changing another schema's ACLs. The `calls.storage_path` value must be workspace-prefixed (`{workspace_id}/...`). A later audio milestone should use a private bucket and validate path ownership against the caller's workspace membership before storage access. M1 deliberately creates no bucket and no upload workflow.

## Client grants and row policies

- `authenticated` receives `SELECT` only on the six user-facing tables. No client has `INSERT`, `UPDATE`, or `DELETE` access.
- `analysis_jobs` has RLS enabled, no policies, and no `anon`/`authenticated` grants. The Supabase security advisor reports this as one informational `rls_enabled_no_policy` finding; the absence of a policy is intentional default-deny behavior for the private queue.
- `anon` receives no table grants.
- Membership reads are limited to the caller's own membership row. Workspace and call reads use the membership helper. Analyses and scores are authorized through their parent call. Rubrics are readable only by an authenticated workspace member.
- `private.is_workspace_member` is `SECURITY DEFINER`, uses `SET search_path = ''`, references fully qualified relations and `auth.uid()`, and is executable only by `authenticated`.
- Service-role privileges are for trusted server-side workers only. The service-role key is never used by the browser or Next.js frontend.

The remote catalog/permission checks in `supabase/tests/m1_permissions.sql` passed. `supabase/tests/m1_rls_behavior.sql` passed with two synthetic JWT subjects in the `authenticated` database role; the transaction created temporary Auth and application fixtures, then rolled them all back. A follow-up query confirmed that every emitted fixture ID was absent. This verifies SQL policy isolation, not a signed JWT or a real password-auth session; account-level sign-in remains pending.

The performance advisor no longer reports unindexed foreign keys after the follow-up index migration. It reports unused indexes on the empty M1 tables, which is expected before application traffic exists.
