begin;

-- A server-side upload verifier supplies a digest computed from private
-- Storage bytes. This function only authorizes a matching registry entry;
-- the M3 worker independently downloads and verifies the bytes again.
create function public.authorize_m3_synthetic_demo_call(
  p_call_id uuid,
  p_audio_sha256 text
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  fixture_reference_value text;
  existing_fixture_reference text;
  job_record public.analysis_jobs%rowtype;
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role' then
    raise exception 'service role required for M3 demo authorization' using errcode = '42501';
  end if;

  if p_call_id is null or p_audio_sha256 is null
    or p_audio_sha256 !~ '^[a-fA-F0-9]{64}$' then
    return 'not_allowlisted';
  end if;

  select fixture.fixture_reference into fixture_reference_value
  from private.m3_synthetic_fixtures as fixture
  where fixture.sha256 = lower(p_audio_sha256);
  if not found then
    return 'not_allowlisted';
  end if;

  select job_entry.* into job_record
  from public.analysis_jobs as job_entry
  join public.calls as call_entry
    on call_entry.workspace_id = job_entry.workspace_id and call_entry.id = job_entry.call_id
  join public.upload_intents as intent_entry
    on intent_entry.workspace_id = call_entry.workspace_id
   and intent_entry.id = call_entry.upload_intent_id
   and intent_entry.object_path = call_entry.storage_path
  where call_entry.id = p_call_id
    and call_entry.status = 'queued'
    and job_entry.processor_kind = 'pending_m3'
    and job_entry.status = 'queued'
    and job_entry.attempts = 0
    and job_entry.completed_at is null
    and job_entry.max_attempts >= 1
    and intent_entry.status = 'finalized'
    and intent_entry.finalized_call_id = call_entry.id
    and intent_entry.mime_type = 'audio/mpeg'
  for update of job_entry, call_entry;

  if not found then
    select approval.fixture_reference into existing_fixture_reference
    from private.m3_synthetic_approvals as approval
    where approval.call_id = p_call_id;
    if existing_fixture_reference = fixture_reference_value then
      return 'already_authorized';
    end if;
    return 'not_eligible';
  end if;

  select approval.fixture_reference into existing_fixture_reference
  from private.m3_synthetic_approvals as approval
  where approval.workspace_id = job_record.workspace_id
    and approval.call_id = job_record.call_id;
  if found then
    if existing_fixture_reference = fixture_reference_value then
      return 'already_authorized';
    end if;
    return 'not_eligible';
  end if;

  update public.analysis_jobs
  set max_attempts = 1
  where id = job_record.id
    and status = 'queued'
    and attempts = 0
    and completed_at is null;
  if not found then
    return 'not_eligible';
  end if;

  insert into private.m3_synthetic_approvals(workspace_id, call_id, fixture_reference)
  values (job_record.workspace_id, job_record.call_id, fixture_reference_value);

  return 'approved';
end;
$function$;

revoke all on function public.authorize_m3_synthetic_demo_call(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.authorize_m3_synthetic_demo_call(uuid, text) to service_role;

comment on function public.authorize_m3_synthetic_demo_call(uuid, text) is
  'Authorizes only server-hashed allowlisted synthetic bytes and caps that new demo job to one provider attempt.';

commit;
