-- Reviewer-only M4 working assessment. Never represents an approved official score.
-- Kept separate from immutable call_scores and AI-generated candidate assessments.
create table public.m4_review_worksheets (
  analysis_id uuid primary key references public.call_analyses(id) on delete cascade,
  rubric_version_id uuid not null references public.rubric_versions(id),
  reviewer_id uuid not null references auth.users(id),
  observations jsonb not null default '[]'::jsonb
    check (jsonb_typeof(observations) = 'array' and jsonb_array_length(observations) <= 20),
  whole_call_reviewed boolean not null default false,
  objection_state text not null default 'unknown'
    check (objection_state in ('unknown', 'present', 'none_confirmed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index m4_review_worksheets_reviewer_idx on public.m4_review_worksheets(reviewer_id);
create trigger m4_review_worksheets_updated_at before update on public.m4_review_worksheets
for each row execute function private.set_updated_at();

alter table public.m4_review_worksheets enable row level security;
revoke all on table public.m4_review_worksheets from public, anon, authenticated;
grant select, insert, update on public.m4_review_worksheets to authenticated;
grant all on public.m4_review_worksheets to service_role;

-- A reviewer must be a member of the same workspace as the selected analysis.
-- No access for ordinary members or other workspaces. The client cannot claim
-- to be another reviewer on write, and cannot modify existing owner/keys.
create policy m4_worksheet_reviewer_read on public.m4_review_worksheets
for select to authenticated using (
  exists (
    select 1 from public.call_analyses a
    join public.calls c on c.id = a.call_id
    join public.workspace_members m on m.workspace_id = c.workspace_id
    where a.id = m4_review_worksheets.analysis_id
      and m.user_id = (select auth.uid()) and m.role in ('owner', 'reviewer')
  )
);
create policy m4_worksheet_reviewer_insert on public.m4_review_worksheets
for insert to authenticated with check (
  reviewer_id = (select auth.uid()) and
  exists (
    select 1 from public.call_analyses a
    join public.calls c on c.id = a.call_id
    join public.workspace_members m on m.workspace_id = c.workspace_id
    join public.rubric_versions r on r.id = rubric_version_id
    where a.id = m4_review_worksheets.analysis_id
      and m.user_id = (select auth.uid()) and m.role in ('owner', 'reviewer')
      and r.brand = c.brand and r.category = c.call_type and r.is_active
  )
);
create policy m4_worksheet_reviewer_update on public.m4_review_worksheets
for update to authenticated
using (
  exists (
    select 1 from public.call_analyses a
    join public.calls c on c.id = a.call_id
    join public.workspace_members m on m.workspace_id = c.workspace_id
    where a.id = m4_review_worksheets.analysis_id
      and m.user_id = (select auth.uid()) and m.role in ('owner', 'reviewer')
  )
)
with check (
  reviewer_id = (select auth.uid()) and
  exists (
    select 1 from public.call_analyses a
    join public.calls c on c.id = a.call_id
    join public.workspace_members m on m.workspace_id = c.workspace_id
    join public.rubric_versions r on r.id = rubric_version_id
    where a.id = m4_review_worksheets.analysis_id
      and m.user_id = (select auth.uid()) and m.role in ('owner', 'reviewer')
      and r.brand = c.brand and r.category = c.call_type and r.is_active
  )
);
comment on table public.m4_review_worksheets is
  'Reviewer-authored, unapproved QA working notes only; never an official call score, approved rubric, or assertion of verified M3 speaker attribution.';
