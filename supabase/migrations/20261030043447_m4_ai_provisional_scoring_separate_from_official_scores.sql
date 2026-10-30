create table if not exists public.m4_ai_assessments (
  analysis_id uuid primary key references public.call_analyses(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id),
  rubric_version_id uuid not null references public.rubric_versions(id),
  status text not null default 'processing' check (status in ('processing','completed','failed')),
  calculation jsonb,
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,48}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint m4_ai_calculation_shape check (
    calculation is null or jsonb_typeof(calculation) = 'object'
  )
);
create index if not exists m4_ai_assessments_workspace_idx
  on public.m4_ai_assessments(workspace_id,created_at desc);
alter table public.m4_ai_assessments enable row level security;
revoke all on public.m4_ai_assessments from public, anon, authenticated;
grant select on public.m4_ai_assessments to authenticated;
grant select,insert,update,delete on public.m4_ai_assessments to service_role;
create policy "Workspace members can view their AI provisional assessments"
  on public.m4_ai_assessments for select to authenticated
  using (exists (
    select 1 from public.workspace_members m
    where m.workspace_id = m4_ai_assessments.workspace_id
      and m.user_id = (select auth.uid())
  ));
comment on table public.m4_ai_assessments is
  'Automated non-official AI rubric suggestions from saved M3 transcripts. Never authoritative employee scores; user review and calibration remain separate.';
