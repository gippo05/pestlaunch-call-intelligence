# Owner onboarding

1. In the Supabase dashboard, open project `PestLaunch Test` and verify its reference is `aznfcxrlpzjnssfatzxi` before making any change.
2. Apply the versioned M1 migrations in order: `supabase/migrations/20261027062949_m1_foundation.sql`, then `supabase/migrations/20261027063558_m1_foreign_key_indexes.sql`.
3. Create or invite the single assessment user manually in Supabase Auth. Keep public signup disabled in the hosted Auth settings; this app itself exposes no signup route. The hosted signup setting was not changed or independently verified during M1.
4. Create the assessment workspace and membership through a trusted owner/database-admin session. Use the authenticated Auth user UUID; do not grant the assessment user write privileges to membership tables.
5. Configure local `.env.local` with only the project URL and publishable key from the authorized project.

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
