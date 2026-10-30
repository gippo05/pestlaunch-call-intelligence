begin;

-- Opaque Supabase secret API keys are authorized by the service_role EXECUTE
-- grant. Do not require the legacy JWT role claim in this Edge RPC.
create or replace function public.claim_m3_demo_job(
  p_call_id uuid,
  p_lease_seconds integer default 600
)
returns setof public.analysis_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  selected_job public.analysis_jobs%rowtype;
begin
  if p_call_id is null or p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 600 then
    raise exception 'invalid M3 demo claim request' using errcode = '22023';
  end if;

  select job_row.* into selected_job
  from public.analysis_jobs as job_row
  join public.calls as call_row
    on call_row.workspace_id = job_row.workspace_id
   and call_row.id = job_row.call_id
   and call_row.status = 'queued'
  join public.upload_intents as intent_row
    on intent_row.workspace_id = call_row.workspace_id
   and intent_row.id = call_row.upload_intent_id
   and intent_row.object_path = call_row.storage_path
   and intent_row.status = 'finalized'
   and intent_row.finalized_call_id = call_row.id
   and intent_row.mime_type = 'audio/mpeg'
  where call_row.id = p_call_id
    and (
      exists (select 1 from private.m3_synthetic_approvals a
              where a.workspace_id=job_row.workspace_id and a.call_id=job_row.call_id)
      or exists (select 1 from private.m3_private_upload_approvals a
              where a.workspace_id=job_row.workspace_id and a.call_id=job_row.call_id)
    )
    and job_row.processor_kind = 'pending_m3'
    and job_row.status = 'queued'
    and job_row.attempts = 0
    and job_row.max_attempts = 1
    and job_row.completed_at is null
    and not exists (
      select 1 from public.call_analyses as analysis
      where analysis.call_id = job_row.call_id
    )
  for update of job_row, call_row skip locked;

  if not found then
    return;
  end if;

  update public.analysis_jobs
  set status = 'leased',
      attempts = 1,
      lease_expires_at = clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
      attempt_owner = gen_random_uuid()::text,
      next_retry_at = null,
      safe_error_code = null,
      started_at = coalesce(started_at, clock_timestamp())
  where id = selected_job.id
    and status = 'queued'
    and attempts = 0
    and max_attempts = 1
    and completed_at is null
  returning * into selected_job;
  if not found then
    return;
  end if;

  update public.calls
  set status = 'processing'
  where id = selected_job.call_id
    and workspace_id = selected_job.workspace_id
    and status = 'queued';
  if not found then
    raise exception 'M3 demo call state changed during claim' using errcode = '40001';
  end if;

  return next selected_job;
end;
$function$;

revoke all on function public.claim_m3_demo_job(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.claim_m3_demo_job(uuid, integer) to service_role;
comment on function public.claim_m3_demo_job(uuid, integer) is
  'Claims one already-authorized synthetic M3 job by exact call id and permits one provider attempt; execute permission is restricted to service_role.';

notify pgrst, 'reload schema';
commit;
