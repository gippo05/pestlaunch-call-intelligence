begin;

-- M3 requires an explicit per-call approval and byte-for-byte fixture
-- provenance. A reference string alone never authorizes provider processing.
create table private.m3_synthetic_fixtures (
  fixture_reference text primary key check (fixture_reference ~ '^[A-Za-z0-9._/-]{1,120}$'),
  sha256 text not null unique check (sha256 ~ '^[a-f0-9]{64}$')
);

-- This supplied fixture is a silent tone. It certifies MP3 parsing and byte
-- provenance only; it is not evidence of transcription fidelity.
insert into private.m3_synthetic_fixtures(fixture_reference, sha256)
values ('synthetic-tone', 'ebe65a9c5ad0b181428f0db22c3a4d03e78d99fe7582c226b1b576faa0b6f1b2');

alter table private.m3_synthetic_fixtures enable row level security;
revoke all on table private.m3_synthetic_fixtures from public, anon, authenticated, service_role;

-- Normal M2 upload clients cannot create or read per-call approvals.
create table private.m3_synthetic_approvals (
  workspace_id uuid not null,
  call_id uuid primary key,
  fixture_reference text not null references private.m3_synthetic_fixtures(fixture_reference),
  approved_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, call_id) references public.calls(workspace_id, id) on delete cascade
);

alter table private.m3_synthetic_approvals enable row level security;
revoke all on table private.m3_synthetic_approvals from public, anon, authenticated, service_role;

create table private.m3_worker_nonces (
  nonce uuid primary key,
  issued_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);

create index m3_worker_nonces_issued_at_idx on private.m3_worker_nonces(issued_at);
alter table private.m3_worker_nonces enable row level security;
revoke all on table private.m3_worker_nonces from public, anon, authenticated, service_role;

create function public.approve_m3_synthetic_call(p_call_id uuid, p_fixture_reference text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  workspace_id uuid;
begin
  if p_call_id is null or p_fixture_reference is null
    or not exists (
      select 1 from private.m3_synthetic_fixtures as fixture
      where fixture.fixture_reference = p_fixture_reference
    ) then
    return false;
  end if;

  select call_row.workspace_id into workspace_id
  from public.calls as call_row
  join public.upload_intents as intent_row
    on intent_row.id = call_row.upload_intent_id
   and intent_row.workspace_id = call_row.workspace_id
   and intent_row.object_path = call_row.storage_path
   and intent_row.status = 'finalized'
   and intent_row.finalized_call_id = call_row.id
   and intent_row.mime_type = 'audio/mpeg'
  where call_row.id = p_call_id
    and call_row.status = 'queued'
    and exists (
      select 1 from public.analysis_jobs as job_row
      where job_row.workspace_id = call_row.workspace_id
        and job_row.call_id = call_row.id
        and job_row.processor_kind = 'pending_m3'
        and job_row.status in ('queued', 'failed')
        and job_row.completed_at is null
        and job_row.attempts < job_row.max_attempts
    )
  for update of call_row;

  if not found then
    return false;
  end if;

  insert into private.m3_synthetic_approvals(workspace_id, call_id, fixture_reference)
  values (workspace_id, p_call_id, p_fixture_reference)
  on conflict (call_id) do update
    set workspace_id = excluded.workspace_id,
        fixture_reference = excluded.fixture_reference,
        approved_at = clock_timestamp();
  return true;
end;
$function$;

create function public.consume_m3_worker_nonce(p_nonce uuid, p_issued_at timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_nonce is null or p_issued_at is null
    or p_issued_at < clock_timestamp() - interval '2 minutes'
    or p_issued_at > clock_timestamp() + interval '30 seconds' then
    return false;
  end if;

  delete from private.m3_worker_nonces
  where issued_at < clock_timestamp() - interval '10 minutes';

  insert into private.m3_worker_nonces(nonce, issued_at)
  values (p_nonce, p_issued_at)
  on conflict (nonce) do nothing;
  return found;
end;
$function$;

create function public.claim_m3_job(p_lease_seconds integer default 600)
returns setof public.analysis_jobs
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  expired_job public.analysis_jobs%rowtype;
  selected_job public.analysis_jobs%rowtype;
  retry_seconds integer;
begin
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 600 then
    raise exception 'invalid M3 lease duration' using errcode = '22023';
  end if;

  for expired_job in
    select * from public.analysis_jobs
    where processor_kind = 'pending_m3'
      and status = 'failed'
      and completed_at is null
      and attempts >= max_attempts
    order by updated_at, created_at
    for update skip locked
  loop
    update public.analysis_jobs
    set completed_at = v_now,
        next_retry_at = null,
        safe_error_code = coalesce(safe_error_code, 'MAX_ATTEMPTS_EXHAUSTED')
    where id = expired_job.id;

    update public.calls
    set status = 'failed'
    where id = expired_job.call_id
      and workspace_id = expired_job.workspace_id
      and status in ('queued', 'processing');
  end loop;

  for expired_job in
    select * from public.analysis_jobs
    where processor_kind = 'pending_m3'
      and status = 'leased'
      and lease_expires_at <= v_now
    order by lease_expires_at, created_at
    for update skip locked
  loop
    if expired_job.attempts >= expired_job.max_attempts then
      update public.analysis_jobs
      set status = 'failed', lease_expires_at = null, attempt_owner = null,
          next_retry_at = null, completed_at = v_now,
          safe_error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS'
      where id = expired_job.id;

      update public.calls
      set status = 'failed'
      where id = expired_job.call_id and workspace_id = expired_job.workspace_id;
    else
      retry_seconds := least(3600, (15 * pg_catalog.power(2, greatest(expired_job.attempts - 1, 0)))::integer);
      update public.analysis_jobs
      set status = 'failed', lease_expires_at = null, attempt_owner = null,
          next_retry_at = v_now + pg_catalog.make_interval(secs => retry_seconds),
          completed_at = null, safe_error_code = 'LEASE_EXPIRED'
      where id = expired_job.id;

      update public.calls
      set status = 'queued'
      where id = expired_job.call_id and workspace_id = expired_job.workspace_id;
    end if;
  end loop;

  select job_row.* into selected_job
  from public.analysis_jobs as job_row
  join public.calls as call_row
    on call_row.workspace_id = job_row.workspace_id
   and call_row.id = job_row.call_id
   and call_row.status = 'queued'
  join private.m3_synthetic_approvals as approval
    on approval.workspace_id = job_row.workspace_id
   and approval.call_id = job_row.call_id
  where job_row.processor_kind = 'pending_m3'
    and job_row.completed_at is null
    and job_row.attempts < job_row.max_attempts
    and (
      job_row.status = 'queued'
      or (job_row.status = 'failed' and job_row.next_retry_at is not null and job_row.next_retry_at <= v_now)
    )
    and not exists (
      select 1 from public.call_analyses as analysis
      where analysis.call_id = job_row.call_id and analysis.version = 1
    )
  order by coalesce(job_row.next_retry_at, job_row.created_at), job_row.created_at
  limit 1
  for update of job_row skip locked;

  if not found then
    return;
  end if;

  update public.analysis_jobs
  set status = 'leased',
      attempts = attempts + 1,
      lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
      attempt_owner = gen_random_uuid()::text,
      next_retry_at = null,
      safe_error_code = null,
      started_at = coalesce(started_at, v_now)
  where id = selected_job.id
  returning * into selected_job;

  update public.calls
  set status = 'processing'
  where id = selected_job.call_id
    and workspace_id = selected_job.workspace_id
    and status = 'queued';

  if not found then
    raise exception 'M3 call state changed during claim' using errcode = '55000';
  end if;

  return next selected_job;
end;
$function$;

create function public.get_m3_job_source(p_job_id uuid, p_attempt_owner text)
returns table (
  job_status text,
  processor_kind text,
  workspace_id uuid,
  call_id uuid,
  attempt_owner text,
  lease_expires_at timestamptz,
  call_status text,
  call_workspace_id uuid,
  call_storage_path text,
  upload_intent_id uuid,
  call_brand text,
  call_uploader_user_id uuid,
  intent_id uuid,
  intent_workspace_id uuid,
  intent_user_id uuid,
  intent_object_path text,
  intent_status text,
  intent_finalized_call_id uuid,
  intent_mime_type text,
  intent_expected_size bigint,
  synthetic_fixture_ref text,
  synthetic_fixture_sha256 text
)
language sql
volatile
security definer
set search_path = ''
as $function$
  select job_row.status, job_row.processor_kind, job_row.workspace_id, job_row.call_id,
    job_row.attempt_owner, job_row.lease_expires_at,
    call_row.status, call_row.workspace_id, call_row.storage_path, call_row.upload_intent_id,
    call_row.brand, call_row.uploader_user_id,
    intent_row.id, intent_row.workspace_id, intent_row.user_id, intent_row.object_path,
    intent_row.status, intent_row.finalized_call_id, intent_row.mime_type, intent_row.expected_size,
    approval.fixture_reference,
    fixture.sha256
  from public.analysis_jobs as job_row
  join public.calls as call_row
    on call_row.workspace_id = job_row.workspace_id and call_row.id = job_row.call_id
  join public.upload_intents as intent_row
    on intent_row.workspace_id = call_row.workspace_id
   and intent_row.id = call_row.upload_intent_id
   and intent_row.object_path = call_row.storage_path
  join private.m3_synthetic_approvals as approval
    on approval.workspace_id = job_row.workspace_id and approval.call_id = job_row.call_id
  join private.m3_synthetic_fixtures as fixture
    on fixture.fixture_reference = approval.fixture_reference
  where job_row.id = p_job_id
    and job_row.processor_kind = 'pending_m3'
    and job_row.status = 'leased'
    and job_row.attempt_owner = p_attempt_owner
    and job_row.lease_expires_at > clock_timestamp()
    and call_row.status = 'processing'
    and intent_row.status = 'finalized'
    and intent_row.finalized_call_id = call_row.id
    and intent_row.mime_type = 'audio/mpeg';
$function$;

create function public.complete_m3_job(
  p_job_id uuid,
  p_attempt_owner text,
  p_transcript text,
  p_model text,
  p_call_type text,
  p_extracted_facts jsonb,
  p_outcome jsonb,
  p_quality_indicators jsonb,
  p_duration_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job_row public.analysis_jobs%rowtype;
  call_row public.calls%rowtype;
  intent_value text;
  expected_call_type text;
  v_now timestamptz;
begin
  if p_transcript is null or char_length(btrim(p_transcript)) not between 1 and 150000
    or p_model is null or char_length(btrim(p_model)) not between 1 and 120
    or p_extracted_facts is null or jsonb_typeof(p_extracted_facts) <> 'object'
    or p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
    or p_quality_indicators is null or jsonb_typeof(p_quality_indicators) <> 'object'
    or p_duration_seconds is null or p_duration_seconds not between 1 and 1200
    or p_quality_indicators ->> 'schema_version' is distinct from 'm3-transcript-v1'
    or p_quality_indicators ->> 'source_completeness' is distinct from 'unverified'
    or p_quality_indicators ->> 'needs_human_review' is distinct from 'true'
    or jsonb_typeof(p_quality_indicators -> 'review_flags') is distinct from 'array'
    or jsonb_typeof(p_extracted_facts -> 'confirmed_facts') is distinct from 'array'
    or jsonb_typeof(p_extracted_facts -> 'customer_concerns') is distinct from 'array'
    or jsonb_typeof(p_extracted_facts -> 'intent_evidence') is distinct from 'array'
    or jsonb_typeof(p_extracted_facts -> 'provenance') is distinct from 'object'
    or p_extracted_facts -> 'provenance' ->> 'provider' is distinct from 'gemini'
    or p_extracted_facts -> 'provenance' ->> 'model' is distinct from p_model
    or p_extracted_facts -> 'provenance' ->> 'schema_version' is distinct from 'm3-transcript-v1'
    or p_extracted_facts -> 'provenance' ->> 'source_completeness' is distinct from 'unverified'
    or jsonb_typeof(p_outcome -> 'evidence') is distinct from 'array'
    or p_outcome ->> 'summary' is null
    or p_outcome ->> 'status' is null then
    return false;
  end if;

  if jsonb_array_length(p_extracted_facts -> 'intent_evidence') not between 1 and 3
    or jsonb_array_length(p_extracted_facts -> 'confirmed_facts') > 100
    or jsonb_array_length(p_extracted_facts -> 'customer_concerns') > 100
    or jsonb_array_length(p_outcome -> 'evidence') not between 1 and 10
    or not (p_quality_indicators -> 'review_flags' @> '["SOURCE_COMPLETENESS_UNVERIFIED"]'::jsonb)
    or char_length(btrim(p_outcome ->> 'summary')) not between 5 and 2000
    or strpos(p_transcript, p_outcome ->> 'summary') = 0
    or not (p_outcome -> 'evidence' @> jsonb_build_array(p_outcome ->> 'summary')) then
    return false;
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_extracted_facts -> 'intent_evidence') as item(value)
    where jsonb_typeof(item.value) is distinct from 'string'
      or char_length(btrim(item.value #>> '{}')) not between 5 and 2000
      or strpos(p_transcript, item.value #>> '{}') = 0
  ) or exists (
    select 1 from jsonb_array_elements(p_extracted_facts -> 'confirmed_facts') as item(value)
    where jsonb_typeof(item.value) is distinct from 'object'
      or jsonb_typeof(item.value -> 'fact') is distinct from 'string'
      or jsonb_typeof(item.value -> 'evidence') is distinct from 'string'
      or char_length(btrim(item.value ->> 'fact')) not between 5 and 2000
      or char_length(btrim(item.value ->> 'evidence')) not between 5 and 2000
      or strpos(p_transcript, item.value ->> 'fact') = 0
      or strpos(p_transcript, item.value ->> 'evidence') = 0
      or strpos(item.value ->> 'evidence', item.value ->> 'fact') = 0
  ) or exists (
    select 1 from jsonb_array_elements(p_extracted_facts -> 'customer_concerns') as item(value)
    where jsonb_typeof(item.value) is distinct from 'object'
      or jsonb_typeof(item.value -> 'concern') is distinct from 'string'
      or jsonb_typeof(item.value -> 'evidence') is distinct from 'string'
      or char_length(btrim(item.value ->> 'concern')) not between 5 and 2000
      or char_length(btrim(item.value ->> 'evidence')) not between 5 and 2000
      or strpos(p_transcript, item.value ->> 'concern') = 0
      or strpos(p_transcript, item.value ->> 'evidence') = 0
      or strpos(item.value ->> 'evidence', item.value ->> 'concern') = 0
  ) or exists (
    select 1 from jsonb_array_elements(p_outcome -> 'evidence') as item(value)
    where jsonb_typeof(item.value) is distinct from 'string'
      or char_length(btrim(item.value #>> '{}')) not between 5 and 2000
      or strpos(p_transcript, item.value #>> '{}') = 0
  ) then
    return false;
  end if;

  intent_value := p_extracted_facts ->> 'intent';
  expected_call_type := case intent_value
    when 'sales' then 'sales'
    when 'general_office' then 'general_office'
    when 'retention' then 'retention'
    when 'other' then null
    else '__invalid__'
  end;
  if expected_call_type = '__invalid__'
    or p_call_type is distinct from expected_call_type
    or p_outcome ->> 'status' not in ('observed', 'unresolved', 'unknown') then
    return false;
  end if;

  select * into job_row
  from public.analysis_jobs
  where id = p_job_id
    and processor_kind = 'pending_m3'
    and status = 'leased'
    and attempt_owner = p_attempt_owner
  for update;
  if not found then
    return false;
  end if;

  select * into call_row
  from public.calls
  where id = job_row.call_id
    and workspace_id = job_row.workspace_id
    and status = 'processing'
  for update;
  if not found or not exists (
    select 1 from private.m3_synthetic_approvals as approval
    where approval.workspace_id = job_row.workspace_id and approval.call_id = job_row.call_id
  ) then
    return false;
  end if;

  -- Sample wall time only after the job and call locks are held. The job may
  -- have expired while either SELECT FOR UPDATE was waiting.
  v_now := clock_timestamp();
  if job_row.lease_expires_at <= v_now then
    return false;
  end if;

  if not exists (
    select 1 from public.upload_intents as intent_row
    where intent_row.id = call_row.upload_intent_id
      and intent_row.workspace_id = call_row.workspace_id
      and intent_row.object_path = call_row.storage_path
      and intent_row.status = 'finalized'
      and intent_row.finalized_call_id = call_row.id
      and intent_row.mime_type = 'audio/mpeg'
  ) or exists (
    select 1 from public.call_analyses where call_id = call_row.id and version = 1
  ) then
    return false;
  end if;

  insert into public.call_analyses (
    call_id, provider, model, transcript, extracted_facts, outcome,
    quality_indicators, confidence, review_status, version, processed_at
  ) values (
    call_row.id, 'gemini', p_model, p_transcript, p_extracted_facts, p_outcome,
    p_quality_indicators, null, 'review_required', 1, v_now
  );

  update public.analysis_jobs
  set status = 'succeeded', completion_kind = 'm3', completed_at = v_now,
      lease_expires_at = null, attempt_owner = null, next_retry_at = null,
      safe_error_code = null
  where id = job_row.id
    and status = 'leased'
    and attempt_owner = p_attempt_owner
    and lease_expires_at > clock_timestamp();
  if not found then
    raise exception 'M3 lease changed during completion' using errcode = '55000';
  end if;

  update public.calls
  set status = 'review_required', call_type = p_call_type,
      duration_seconds = p_duration_seconds
  where id = call_row.id and workspace_id = call_row.workspace_id;
  if not found then
    raise exception 'M3 call disappeared during completion' using errcode = '55000';
  end if;

  return true;
end;
$function$;

create function public.fail_m3_job(
  p_job_id uuid,
  p_attempt_owner text,
  p_safe_error_code text,
  p_retry_after_seconds integer default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job_row public.analysis_jobs%rowtype;
  v_now timestamptz;
  retry_seconds integer;
begin
  if p_safe_error_code is null or p_safe_error_code not in (
    'PROVIDER_429', 'PROVIDER_503', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT',
    'PROVIDER_SAFETY_BLOCKED', 'PROVIDER_FINISH_REASON_INVALID',
    'PROVIDER_CANDIDATE_COUNT_INVALID', 'PROVIDER_RESPONSE_INVALID',
    'PROVIDER_CLEANUP_FAILED', 'SOURCE_INVALID', 'SOURCE_TOO_LONG',
    'STORAGE_UNAVAILABLE', 'JOB_LINK_INVALID', 'INTERNAL_ERROR'
  ) or (p_retry_after_seconds is not null and p_retry_after_seconds not between 0 and 3600)
    or (p_retry_after_seconds is not null and p_safe_error_code not in ('PROVIDER_429', 'PROVIDER_503')) then
    return false;
  end if;

  select * into job_row
  from public.analysis_jobs
  where id = p_job_id
    and processor_kind = 'pending_m3'
    and status = 'leased'
    and attempt_owner = p_attempt_owner
  for update;
  if not found then
    return false;
  end if;

  -- Sample the lease clock only after the row lock is acquired, so a request
  -- that waited behind another transaction cannot act for an expired owner.
  v_now := clock_timestamp();
  if job_row.lease_expires_at <= v_now then
    return false;
  end if;

  if job_row.attempts >= job_row.max_attempts then
    update public.analysis_jobs
    set status = 'failed', completed_at = v_now,
        lease_expires_at = null, attempt_owner = null,
        next_retry_at = null, safe_error_code = p_safe_error_code
    where id = job_row.id
      and status = 'leased'
      and attempt_owner = p_attempt_owner
      and lease_expires_at > clock_timestamp();
    if not found then
      raise exception 'M3 lease changed during failure recording' using errcode = '55000';
    end if;

    update public.calls
    set status = 'failed'
    where id = job_row.call_id and workspace_id = job_row.workspace_id;
  else
    retry_seconds := least(3600, (15 * pg_catalog.power(2, greatest(job_row.attempts - 1, 0)))::integer);
    if p_retry_after_seconds is not null then
      retry_seconds := least(3600, greatest(retry_seconds, p_retry_after_seconds));
    end if;

    update public.analysis_jobs
    set status = 'failed', completed_at = null,
        lease_expires_at = null, attempt_owner = null,
        next_retry_at = v_now + pg_catalog.make_interval(secs => retry_seconds),
        safe_error_code = p_safe_error_code
    where id = job_row.id
      and status = 'leased'
      and attempt_owner = p_attempt_owner
      and lease_expires_at > clock_timestamp();
    if not found then
      raise exception 'M3 lease changed during failure recording' using errcode = '55000';
    end if;

    update public.calls
    set status = 'queued'
    where id = job_row.call_id and workspace_id = job_row.workspace_id;
  end if;
  return true;
end;
$function$;

revoke all on function public.approve_m3_synthetic_call(uuid, text) from public, anon, authenticated;
revoke all on function public.consume_m3_worker_nonce(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.claim_m3_job(integer) from public, anon, authenticated;
revoke all on function public.get_m3_job_source(uuid, text) from public, anon, authenticated;
revoke all on function public.complete_m3_job(uuid, text, text, text, text, jsonb, jsonb, jsonb, integer) from public, anon, authenticated;
revoke all on function public.fail_m3_job(uuid, text, text, integer) from public, anon, authenticated;

grant execute on function public.approve_m3_synthetic_call(uuid, text) to service_role;
grant execute on function public.consume_m3_worker_nonce(uuid, timestamptz) to service_role;
grant execute on function public.claim_m3_job(integer) to service_role;
grant execute on function public.get_m3_job_source(uuid, text) to service_role;
grant execute on function public.complete_m3_job(uuid, text, text, text, text, jsonb, jsonb, jsonb, integer) to service_role;
grant execute on function public.fail_m3_job(uuid, text, text, integer) to service_role;

comment on table private.m3_synthetic_approvals is
  'Explicit per-call synthetic approval; no browser access and required by the M3 claim RPC.';
comment on function public.claim_m3_job(integer) is
  'Claims only approved pending_m3 calls and fences processing with a single bounded lease owner.';
comment on function public.complete_m3_job(uuid, text, text, text, text, jsonb, jsonb, jsonb, integer) is
  'Atomically persists one version-1 M3 transcript, job completion, and review-required call state.';

commit;
