-- Owner-only behavioral RLS test with two synthetic JWT subjects.
-- Auth and application fixture rows plus the temporary ID table are rolled back.
-- No credentials or email addresses are created and no Auth API is called.
begin;

do $fixture_preflight$
begin
  if not has_table_privilege(current_user, 'auth.users', 'INSERT') then
    raise exception 'RLS fixture requires INSERT on auth.users';
  end if;
  if exists (
    select 1 from pg_trigger
    where tgrelid = 'auth.users'::regclass and not tgisinternal
  ) then
    raise exception 'RLS fixture refuses to run while auth.users has user-defined triggers';
  end if;
end;
$fixture_preflight$;

create temporary table m1_rls_fixture_ids on commit drop as
select gen_random_uuid() as user_one,
       gen_random_uuid() as user_two,
       gen_random_uuid() as workspace_one,
       gen_random_uuid() as workspace_two,
       gen_random_uuid() as call_one,
       gen_random_uuid() as call_two,
       gen_random_uuid() as analysis_one,
       gen_random_uuid() as analysis_two,
       gen_random_uuid() as rubric_version,
       gen_random_uuid() as score_one,
       gen_random_uuid() as score_two;

grant select on pg_temp.m1_rls_fixture_ids to authenticated;

insert into auth.users (id)
select user_one from pg_temp.m1_rls_fixture_ids
union all
select user_two from pg_temp.m1_rls_fixture_ids;

insert into public.workspaces (id, name)
select workspace_one, 'M1 synthetic RLS workspace one' from pg_temp.m1_rls_fixture_ids
union all
select workspace_two, 'M1 synthetic RLS workspace two' from pg_temp.m1_rls_fixture_ids;

insert into public.workspace_members (workspace_id, user_id, role)
select workspace_one, user_one, 'reviewer' from pg_temp.m1_rls_fixture_ids
union all
select workspace_two, user_two, 'reviewer' from pg_temp.m1_rls_fixture_ids;

insert into public.calls (
  id, workspace_id, brand, call_type, original_filename, mime_type, duration_seconds, storage_path
)
select call_one, workspace_one, 'abc', 'sales', 'm1-synthetic-one.wav', 'audio/wav', 1,
       workspace_one::text || '/m1-synthetic-one.wav'
from pg_temp.m1_rls_fixture_ids
union all
select call_two, workspace_two, 'abc', 'sales', 'm1-synthetic-two.wav', 'audio/wav', 1,
       workspace_two::text || '/m1-synthetic-two.wav'
from pg_temp.m1_rls_fixture_ids;

insert into public.call_analyses (id, call_id, transcript)
select analysis_one, call_one, 'Synthetic fixture one' from pg_temp.m1_rls_fixture_ids
union all
select analysis_two, call_two, 'Synthetic fixture two' from pg_temp.m1_rls_fixture_ids;

insert into public.rubric_versions (id, brand, category, version, definition)
select fixture.rubric_version, 'abc', 'sales', coalesce(max(existing.version), 0) + 1,
       jsonb_build_object('synthetic', true, 'fixture_id', fixture.rubric_version::text)
from pg_temp.m1_rls_fixture_ids as fixture
left join public.rubric_versions as existing
  on existing.brand = 'abc' and existing.category = 'sales'
group by fixture.rubric_version;

insert into public.call_scores (id, analysis_id, rubric_version_id, total_score)
select score_one, analysis_one, rubric_version, 80 from pg_temp.m1_rls_fixture_ids
union all
select score_two, analysis_two, rubric_version, 80 from pg_temp.m1_rls_fixture_ids;

set local role authenticated;

select set_config('request.jwt.claim.sub', user_one::text, true),
       set_config('request.jwt.claims', jsonb_build_object('sub', user_one, 'role', 'authenticated')::text, true)
from pg_temp.m1_rls_fixture_ids;

do $user_one_test$
declare
  fixture record;
begin
  select * into fixture from pg_temp.m1_rls_fixture_ids;

  if current_user <> 'authenticated'
    or (select auth.uid()) is distinct from fixture.user_one
    or (select count(*) from public.workspaces) <> 1
    or not exists (select 1 from public.workspaces where id = fixture.workspace_one)
    or exists (select 1 from public.workspaces where id = fixture.workspace_two)
    or (select count(*) from public.workspace_members) <> 1
    or (select count(*) from public.calls) <> 1
    or not exists (select 1 from public.calls where id = fixture.call_one)
    or exists (select 1 from public.calls where id = fixture.call_two)
    or (select count(*) from public.call_analyses) <> 1
    or not exists (select 1 from public.call_analyses where id = fixture.analysis_one)
    or exists (select 1 from public.call_analyses where id = fixture.analysis_two)
    or (select count(*) from public.call_scores) <> 1
    or not exists (select 1 from public.call_scores where id = fixture.score_one)
    or exists (select 1 from public.call_scores where id = fixture.score_two)
    or not exists (select 1 from public.rubric_versions where id = fixture.rubric_version) then
    raise exception 'M1 workspace-one RLS isolation assertion failed';
  end if;
end;
$user_one_test$;

select set_config('request.jwt.claim.sub', user_two::text, true),
       set_config('request.jwt.claims', jsonb_build_object('sub', user_two, 'role', 'authenticated')::text, true)
from pg_temp.m1_rls_fixture_ids;

do $user_two_test$
declare
  fixture record;
begin
  select * into fixture from pg_temp.m1_rls_fixture_ids;

  if current_user <> 'authenticated'
    or (select auth.uid()) is distinct from fixture.user_two
    or (select count(*) from public.workspaces) <> 1
    or not exists (select 1 from public.workspaces where id = fixture.workspace_two)
    or exists (select 1 from public.workspaces where id = fixture.workspace_one)
    or (select count(*) from public.workspace_members) <> 1
    or (select count(*) from public.calls) <> 1
    or not exists (select 1 from public.calls where id = fixture.call_two)
    or exists (select 1 from public.calls where id = fixture.call_one)
    or (select count(*) from public.call_analyses) <> 1
    or not exists (select 1 from public.call_analyses where id = fixture.analysis_two)
    or exists (select 1 from public.call_analyses where id = fixture.analysis_one)
    or (select count(*) from public.call_scores) <> 1
    or not exists (select 1 from public.call_scores where id = fixture.score_two)
    or exists (select 1 from public.call_scores where id = fixture.score_one)
    or not exists (select 1 from public.rubric_versions where id = fixture.rubric_version) then
    raise exception 'M1 workspace-two RLS isolation assertion failed';
  end if;
end;
$user_two_test$;

select 'PASS: both synthetic JWT subjects see only their own workspace and child rows' as result,
       user_one as fixture_user_one,
       user_two as fixture_user_two,
       workspace_one as fixture_workspace_one,
       workspace_two as fixture_workspace_two,
       call_one as fixture_call_one,
       call_two as fixture_call_two,
       analysis_one as fixture_analysis_one,
       analysis_two as fixture_analysis_two,
       rubric_version as fixture_rubric_version,
       score_one as fixture_score_one,
       score_two as fixture_score_two
from pg_temp.m1_rls_fixture_ids;

rollback;
