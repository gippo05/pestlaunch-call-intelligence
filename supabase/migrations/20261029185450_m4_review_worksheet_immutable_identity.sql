-- Prevent authenticated REST clients from re-targeting a reviewed worksheet.
-- A worksheet remains bound to its original analysis, rubric, and author.
create function private.m4_worksheet_identity_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.analysis_id is distinct from new.analysis_id
    or old.rubric_version_id is distinct from new.rubric_version_id
    or old.reviewer_id is distinct from new.reviewer_id
    or old.created_at is distinct from new.created_at then
    raise exception 'M4 worksheet immutable identity cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.m4_worksheet_identity_guard() from public, anon, authenticated, service_role;
create trigger m4_worksheet_identity_guard
before update on public.m4_review_worksheets
for each row execute function private.m4_worksheet_identity_guard();
