begin;

create schema private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'reviewer' check (role in ('owner', 'reviewer', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_id_idx on public.workspace_members(user_id, workspace_id);

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  uploader_user_id uuid references auth.users(id) on delete set null,
  brand text not null check (brand in ('abc', 'noble_sales')),
  call_type text check (call_type in ('sales', 'general_office', 'retention')),
  original_filename text not null check (char_length(btrim(original_filename)) between 1 and 255),
  mime_type text not null check (mime_type like 'audio/%'),
  duration_seconds integer check (duration_seconds between 0 and 86400),
  storage_path text not null,
  status text not null default 'uploaded'
    check (status in ('uploaded', 'queued', 'processing', 'completed', 'failed', 'review_required')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (storage_path like workspace_id::text || '/%')
);

create index calls_workspace_created_at_idx on public.calls(workspace_id, created_at desc);
create index calls_workspace_status_idx on public.calls(workspace_id, status);

create table public.analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  call_id uuid not null,
  status text not null default 'queued'
    check (status in ('queued', 'leased', 'succeeded', 'failed', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  lease_expires_at timestamptz,
  attempt_owner text check (attempt_owner is null or char_length(attempt_owner) between 1 and 160),
  next_retry_at timestamptz,
  safe_error_code text check (safe_error_code is null or safe_error_code ~ '^[A-Z0-9_]{1,64}$'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, call_id) references public.calls(workspace_id, id) on delete cascade,
  check (
    (status = 'leased' and lease_expires_at is not null and attempt_owner is not null)
    or (status <> 'leased' and lease_expires_at is null and attempt_owner is null)
  ),
  check (attempts <= max_attempts),
  check (completed_at is null or status in ('succeeded', 'failed', 'cancelled'))
);

create index analysis_jobs_queue_idx on public.analysis_jobs(status, next_retry_at, created_at)
  where status in ('queued', 'failed');
create index analysis_jobs_call_id_idx on public.analysis_jobs(call_id, created_at desc);

create table public.call_analyses (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  provider text check (provider is null or char_length(provider) between 1 and 80),
  model text check (model is null or char_length(model) between 1 and 120),
  transcript text,
  extracted_facts jsonb not null default '{}'::jsonb check (jsonb_typeof(extracted_facts) = 'object'),
  outcome jsonb not null default '{}'::jsonb check (jsonb_typeof(outcome) = 'object'),
  quality_indicators jsonb not null default '{}'::jsonb check (jsonb_typeof(quality_indicators) = 'object'),
  confidence numeric(5, 4) check (confidence between 0 and 1),
  review_status text not null default 'not_reviewed'
    check (review_status in ('not_reviewed', 'review_required', 'reviewed')),
  version integer not null default 1 check (version > 0),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (call_id, version),
  unique (id, call_id)
);

create index call_analyses_call_created_idx on public.call_analyses(call_id, created_at desc);

create table public.rubric_versions (
  id uuid primary key default gen_random_uuid(),
  brand text not null check (brand in ('abc', 'noble_sales')),
  category text not null check (category in ('sales', 'general_office', 'retention')),
  version integer not null check (version > 0),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand, category, version)
);

create unique index rubric_versions_one_active_idx on public.rubric_versions(brand, category)
  where is_active;

create table public.call_scores (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.call_analyses(id) on delete cascade,
  rubric_version_id uuid not null references public.rubric_versions(id) on delete restrict,
  total_score numeric(5, 2) check (total_score between 0 and 100),
  grade text check (grade is null or char_length(grade) <= 32),
  criterion_results jsonb not null default '{}'::jsonb check (jsonb_typeof(criterion_results) = 'object'),
  evidence_references jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_references) = 'array'),
  requires_human_review boolean not null default false,
  scoring_version integer not null default 1 check (scoring_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (analysis_id, rubric_version_id, scoring_version)
);

create index call_scores_analysis_created_idx on public.call_scores(analysis_id, created_at desc);
create index call_scores_rubric_version_idx on public.call_scores(rubric_version_id);

create function private.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.workspace_members as member_row
    where member_row.workspace_id = p_workspace_id
      and member_row.user_id = (select auth.uid())
  );
$function$;

revoke all on function private.is_workspace_member(uuid) from public, anon, authenticated;
grant execute on function private.is_workspace_member(uuid) to authenticated;

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

revoke all on function private.set_updated_at() from public, anon, authenticated;

create trigger workspaces_set_updated_at before update on public.workspaces
for each row execute function private.set_updated_at();
create trigger calls_set_updated_at before update on public.calls
for each row execute function private.set_updated_at();
create trigger analysis_jobs_set_updated_at before update on public.analysis_jobs
for each row execute function private.set_updated_at();
create trigger call_analyses_set_updated_at before update on public.call_analyses
for each row execute function private.set_updated_at();
create trigger rubric_versions_set_updated_at before update on public.rubric_versions
for each row execute function private.set_updated_at();
create trigger call_scores_set_updated_at before update on public.call_scores
for each row execute function private.set_updated_at();

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.calls enable row level security;
alter table public.analysis_jobs enable row level security;
alter table public.call_analyses enable row level security;
alter table public.rubric_versions enable row level security;
alter table public.call_scores enable row level security;

create policy workspaces_select_for_members on public.workspaces
for select to authenticated
using ((select private.is_workspace_member(id)));

create policy workspace_members_select_self on public.workspace_members
for select to authenticated
using (user_id = (select auth.uid()));

create policy calls_select_for_members on public.calls
for select to authenticated
using ((select private.is_workspace_member(workspace_id)));

-- Queue rows are intentionally inaccessible through the client Data API.
-- No policies or grants are created for analysis_jobs.

create policy call_analyses_select_via_call on public.call_analyses
for select to authenticated
using (exists (
  select 1 from public.calls as parent_call
  where parent_call.id = call_analyses.call_id
));

create policy rubric_versions_select_for_members on public.rubric_versions
for select to authenticated
using (exists (
  select 1 from public.workspace_members as member_row
  where member_row.user_id = (select auth.uid())
));

create policy call_scores_select_via_analysis on public.call_scores
for select to authenticated
using (exists (
  select 1
  from public.call_analyses as parent_analysis
  join public.calls as parent_call on parent_call.id = parent_analysis.call_id
  where parent_analysis.id = call_scores.analysis_id
));

revoke all on table public.workspaces from public, anon, authenticated;
revoke all on table public.workspace_members from public, anon, authenticated;
revoke all on table public.calls from public, anon, authenticated;
revoke all on table public.analysis_jobs from public, anon, authenticated;
revoke all on table public.call_analyses from public, anon, authenticated;
revoke all on table public.rubric_versions from public, anon, authenticated;
revoke all on table public.call_scores from public, anon, authenticated;

grant select on public.workspaces to authenticated;
grant select on public.workspace_members to authenticated;
grant select on public.calls to authenticated;
grant select on public.call_analyses to authenticated;
grant select on public.rubric_versions to authenticated;
grant select on public.call_scores to authenticated;

grant all on public.workspaces to service_role;
grant all on public.workspace_members to service_role;
grant all on public.calls to service_role;
grant all on public.analysis_jobs to service_role;
grant all on public.call_analyses to service_role;
grant all on public.rubric_versions to service_role;
grant all on public.call_scores to service_role;

comment on table public.analysis_jobs is 'Internal processing queue; no anon/authenticated grants or RLS policies.';
comment on table public.calls is 'Private call metadata. Audio objects are planned for a later milestone in a private workspace-scoped bucket.';
comment on function private.is_workspace_member(uuid) is 'Narrow membership predicate used by RLS; fixed search path and no client-write capability.';

commit;
