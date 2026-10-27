-- Read-only catalog assertions for the M1 grants and row-level-security boundary.
-- Run in a transaction as a database owner after applying the migration.
do $test$
declare
  table_name text;
  expected_tables text[] := array[
    'workspaces', 'workspace_members', 'calls', 'analysis_jobs',
    'call_analyses', 'rubric_versions', 'call_scores'
  ];
begin
  foreach table_name in array expected_tables loop
    if not coalesce((
      select c.relrowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = table_name
    ), false) then
      raise exception 'RLS is not enabled on public.%', table_name;
    end if;

    if has_table_privilege('anon', format('public.%I', table_name), 'SELECT') then
      raise exception 'anon can SELECT public.%', table_name;
    end if;
  end loop;

  foreach table_name in array array[
    'workspaces', 'workspace_members', 'calls', 'analysis_jobs',
    'call_analyses', 'rubric_versions', 'call_scores'
  ] loop
    if has_table_privilege('authenticated', format('public.%I', table_name), 'INSERT')
      or has_table_privilege('authenticated', format('public.%I', table_name), 'UPDATE')
      or has_table_privilege('authenticated', format('public.%I', table_name), 'DELETE') then
      raise exception 'authenticated has client write access to public.%', table_name;
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.analysis_jobs', 'SELECT') then
    raise exception 'authenticated can SELECT internal analysis_jobs';
  end if;

  if has_function_privilege('anon', 'private.is_workspace_member(uuid)', 'EXECUTE') then
    raise exception 'anon can execute private.is_workspace_member';
  end if;

  if not has_function_privilege('authenticated', 'private.is_workspace_member(uuid)', 'EXECUTE') then
    raise exception 'authenticated cannot execute private.is_workspace_member';
  end if;
end;
$test$;
