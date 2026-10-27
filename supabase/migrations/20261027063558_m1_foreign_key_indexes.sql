begin;

-- Cover child-side foreign-key lookups without changing application behavior.
create index calls_uploader_user_id_idx
  on public.calls(uploader_user_id);

create index analysis_jobs_workspace_call_idx
  on public.analysis_jobs(workspace_id, call_id);

commit;
