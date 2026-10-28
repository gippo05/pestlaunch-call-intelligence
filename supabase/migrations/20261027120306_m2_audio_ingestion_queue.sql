begin;

-- Refuse a pre-existing bucket with different access or upload limits.
do $bucket$
declare
  existing_bucket storage.buckets%rowtype;
begin
  select * into existing_bucket
  from storage.buckets
  where id = 'pestlaunch-call-audio';

  if found then
    if existing_bucket.name <> 'pestlaunch-call-audio'
      or existing_bucket.public is distinct from false
      or existing_bucket.file_size_limit is distinct from 52428800::bigint
      or existing_bucket.allowed_mime_types is distinct from array['audio/mpeg']::text[] then
      raise exception 'pestlaunch-call-audio exists with incompatible bucket settings';
    end if;
  else
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'pestlaunch-call-audio',
      'pestlaunch-call-audio',
      false,
      52428800,
      array['audio/mpeg']::text[]
    );
  end if;
end;
$bucket$;

create table public.upload_intents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  user_id uuid not null,
  idempotency_key uuid not null,
  brand text not null check (brand in ('abc', 'noble_sales')),
  original_filename text not null check (char_length(btrim(original_filename)) between 1 and 255),
  mime_type text not null check (mime_type = 'audio/mpeg'),
  expected_size bigint not null check (expected_size between 1 and 52428800),
  object_path text not null unique,
  status text not null default 'issued'
    check (status in ('issued', 'uploading', 'uploaded', 'finalized', 'rejected', 'abandoned')),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  upload_lease_token uuid,
  upload_lease_expires_at timestamptz,
  cleanup_lease_token uuid,
  cleanup_lease_expires_at timestamptz,
  finalized_call_id uuid,
  cleaned_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  check (object_path = workspace_id::text || '/' || id::text || '.mp3'),
  check (
    (status = 'uploading' and upload_lease_token is not null and upload_lease_expires_at is not null)
    or (status <> 'uploading' and upload_lease_token is null and upload_lease_expires_at is null)
  ),
  check ((cleanup_lease_token is null) = (cleanup_lease_expires_at is null)),
  check (cleanup_lease_token is null or status = 'abandoned'),
  check ((status = 'finalized') = (finalized_call_id is not null)),
  check (cleaned_at is null or (status = 'abandoned' and cleanup_lease_token is null))
);

create index upload_intents_cleanup_idx
  on public.upload_intents(status, expires_at, upload_lease_expires_at, cleanup_lease_expires_at)
  where status in ('issued', 'uploading', 'uploaded', 'rejected', 'abandoned');

alter table public.upload_intents enable row level security;
revoke all on table public.upload_intents from public, anon, authenticated;
grant all on table public.upload_intents to service_role;

alter table public.calls
  add column upload_intent_id uuid unique
  references public.upload_intents(id) on delete set null;

alter table public.calls drop constraint calls_status_check;
alter table public.calls add constraint calls_status_check
  check (status in ('uploaded', 'queued', 'processing', 'completed', 'failed', 'review_required', 'test_completed'));

alter table public.analysis_jobs
  add column processor_kind text not null default 'pending_m3'
    check (processor_kind in ('pending_m3', 'm2_synthetic_test')),
  add column completion_kind text
    check (completion_kind is null or completion_kind in ('synthetic_test', 'm3')),
  add constraint analysis_jobs_completion_status_check
    check (completion_kind is null or status = 'succeeded');

create table private.m2_worker_nonces (
  nonce uuid primary key,
  issued_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index m2_worker_nonces_issued_at_idx on private.m2_worker_nonces(issued_at);
alter table private.m2_worker_nonces enable row level security;
revoke all on table private.m2_worker_nonces from public, anon, authenticated, service_role;

create table private.m2_worker_http_requests (
  request_id bigint primary key,
  queued_at timestamptz not null default clock_timestamp()
);

create index m2_worker_http_requests_queued_at_idx on private.m2_worker_http_requests(queued_at desc);
alter table private.m2_worker_http_requests enable row level security;
revoke all on table private.m2_worker_http_requests from public, anon, authenticated, service_role;

create function private.can_upload_call_audio(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.upload_intents as intent
    join public.workspace_members as member_row
      on member_row.workspace_id = intent.workspace_id
     and member_row.user_id = (select auth.uid())
     and member_row.role in ('owner', 'reviewer')
    where intent.object_path = p_object_name
      and intent.user_id = (select auth.uid())
      and intent.status = 'uploading'
      and intent.expires_at > now()
      and intent.upload_lease_expires_at > now()
  );
$function$;

revoke all on function private.can_upload_call_audio(text) from public, anon, authenticated;
grant execute on function private.can_upload_call_audio(text) to authenticated;

create policy m2_call_audio_insert_for_own_intent
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'pestlaunch-call-audio'
  and private.can_upload_call_audio(name)
);

create function public.begin_call_upload(
  p_intent_id uuid,
  p_user_id uuid,
  p_lease_seconds integer default 180
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  intent_row public.upload_intents%rowtype;
  lease_token uuid := gen_random_uuid();
  v_now timestamptz := clock_timestamp();
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'invalid upload lease duration' using errcode = '22023';
  end if;

  select * into intent_row
  from public.upload_intents
  where id = p_intent_id and user_id = p_user_id
  for update;

  if not found or intent_row.expires_at <= v_now then
    raise exception 'upload intent is missing or expired' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.workspace_members
    where workspace_id = intent_row.workspace_id
      and user_id = p_user_id
      and role in ('owner', 'reviewer')
  ) then
    raise exception 'workspace upload permission denied' using errcode = '42501';
  end if;

  if intent_row.status <> 'issued'
    and not (intent_row.status = 'uploading' and intent_row.upload_lease_expires_at <= v_now) then
    raise exception 'upload intent is not ready for transfer' using errcode = '55000';
  end if;

  update public.upload_intents
  set status = 'uploading',
      upload_lease_token = lease_token,
      upload_lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds)
  where id = p_intent_id;

  return lease_token;
end;
$function$;

create function public.mark_call_upload_uploaded(
  p_intent_id uuid,
  p_user_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  update public.upload_intents as intent
  set status = 'uploaded', upload_lease_token = null, upload_lease_expires_at = null
  where intent.id = p_intent_id
    and intent.user_id = p_user_id
    and intent.status = 'uploading'
    and intent.upload_lease_token = p_lease_token
    and intent.upload_lease_expires_at > v_now
    and intent.expires_at > v_now
    and exists (
      select 1 from public.workspace_members as member_row
      where member_row.workspace_id = intent.workspace_id
        and member_row.user_id = p_user_id
        and member_row.role in ('owner', 'reviewer')
    );

  return found;
end;
$function$;

create function public.release_call_upload(
  p_intent_id uuid,
  p_user_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.upload_intents
  set status = 'issued', upload_lease_token = null, upload_lease_expires_at = null
  where id = p_intent_id
    and user_id = p_user_id
    and status = 'uploading'
    and upload_lease_token = p_lease_token;

  return found;
end;
$function$;

create function public.finalize_call_upload(
  p_intent_id uuid,
  p_user_id uuid,
  p_lease_token uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  intent_row public.upload_intents%rowtype;
  call_id uuid;
begin
  select * into intent_row
  from public.upload_intents
  where id = p_intent_id and user_id = p_user_id
  for update;

  if not found or not exists (
    select 1 from public.workspace_members
    where workspace_id = intent_row.workspace_id
      and user_id = p_user_id
      and role in ('owner', 'reviewer')
  ) then
    raise exception 'upload finalization permission denied' using errcode = '42501';
  end if;

  if intent_row.status = 'finalized' then
    if not exists (select 1 from public.calls where id = intent_row.finalized_call_id) then
      raise exception 'finalized call record is missing' using errcode = '55000';
    end if;
    return intent_row.finalized_call_id;
  end if;

  if intent_row.status = 'uploading' then
    if p_lease_token is null
      or intent_row.upload_lease_token is distinct from p_lease_token
      or intent_row.expires_at <= clock_timestamp()
      or intent_row.upload_lease_expires_at <= clock_timestamp() then
      raise exception 'upload lease is missing, expired, or no longer current' using errcode = '55000';
    end if;
  elsif intent_row.status <> 'uploaded' then
    raise exception 'upload object has not been verified' using errcode = '55000';
  end if;

  insert into public.calls (
    workspace_id, uploader_user_id, brand, original_filename, mime_type,
    storage_path, status, upload_intent_id
  ) values (
    intent_row.workspace_id, p_user_id, intent_row.brand, intent_row.original_filename,
    intent_row.mime_type, intent_row.object_path, 'queued', intent_row.id
  ) returning id into call_id;

  insert into public.analysis_jobs (workspace_id, call_id, status, processor_kind)
  values (intent_row.workspace_id, call_id, 'queued', 'pending_m3');

  update public.upload_intents
  set status = 'finalized',
      finalized_call_id = call_id,
      upload_lease_token = null,
      upload_lease_expires_at = null
  where id = intent_row.id;

  return call_id;
end;
$function$;

create function public.claim_m2_job(p_lease_seconds integer default 180)
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
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'invalid job lease duration' using errcode = '22023';
  end if;

  for expired_job in
    select * from public.analysis_jobs
    where status = 'failed'
      and completed_at is null
      and attempts >= max_attempts
      and processor_kind = 'm2_synthetic_test'
    order by updated_at, created_at
    for update skip locked
  loop
    update public.analysis_jobs
    set completed_at = v_now, next_retry_at = null,
        safe_error_code = coalesce(safe_error_code, 'MAX_ATTEMPTS_EXHAUSTED')
    where id = expired_job.id;

    update public.calls
    set status = 'failed'
    where id = expired_job.call_id and workspace_id = expired_job.workspace_id;
  end loop;

  for expired_job in
    select * from public.analysis_jobs
    where status = 'leased'
      and processor_kind = 'm2_synthetic_test'
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

  select * into selected_job
  from public.analysis_jobs
  where processor_kind = 'm2_synthetic_test'
    and completed_at is null
    and (
      status = 'queued'
      or (status = 'failed' and next_retry_at is not null and next_retry_at <= v_now)
    )
  order by coalesce(next_retry_at, created_at), created_at
  limit 1
  for update skip locked;

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
  where id = selected_job.call_id and workspace_id = selected_job.workspace_id;

  return next selected_job;
end;
$function$;

create function public.complete_m2_job(p_job_id uuid, p_attempt_owner text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job_row public.analysis_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select * into job_row
  from public.analysis_jobs
  where id = p_job_id
    and processor_kind = 'm2_synthetic_test'
    and status = 'leased'
    and attempt_owner = p_attempt_owner
    and lease_expires_at > v_now
  for update;

  if not found then
    return false;
  end if;

  update public.analysis_jobs
  set status = 'succeeded', completion_kind = 'synthetic_test',
      completed_at = v_now, lease_expires_at = null,
      attempt_owner = null, next_retry_at = null, safe_error_code = null
  where id = job_row.id;

  update public.calls
  set status = 'test_completed'
  where id = job_row.call_id and workspace_id = job_row.workspace_id;

  return found;
end;
$function$;

create function public.fail_m2_job(p_job_id uuid, p_attempt_owner text, p_safe_error_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job_row public.analysis_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  retry_seconds integer;
begin
  if p_safe_error_code is null or p_safe_error_code not in (
    'SYNTHETIC_PROCESSOR_ERROR', 'PROCESSOR_UNAVAILABLE', 'INTERNAL_ERROR'
  ) then
    return false;
  end if;

  select * into job_row
  from public.analysis_jobs
  where id = p_job_id
    and processor_kind = 'm2_synthetic_test'
    and status = 'leased'
    and attempt_owner = p_attempt_owner
    and lease_expires_at > v_now
  for update;

  if not found then
    return false;
  end if;

  if job_row.attempts >= job_row.max_attempts then
    update public.analysis_jobs
    set status = 'failed', completed_at = v_now,
        lease_expires_at = null, attempt_owner = null, next_retry_at = null,
        safe_error_code = p_safe_error_code
    where id = job_row.id;

    update public.calls
    set status = 'failed'
    where id = job_row.call_id and workspace_id = job_row.workspace_id;
  else
    retry_seconds := least(3600, (15 * pg_catalog.power(2, greatest(job_row.attempts - 1, 0)))::integer);
    update public.analysis_jobs
    set status = 'failed', completed_at = null,
        lease_expires_at = null, attempt_owner = null,
        next_retry_at = v_now + pg_catalog.make_interval(secs => retry_seconds),
        safe_error_code = p_safe_error_code
    where id = job_row.id;

    update public.calls
    set status = 'queued'
    where id = job_row.call_id and workspace_id = job_row.workspace_id;
  end if;

  return true;
end;
$function$;

create function public.claim_abandoned_call_uploads(
  p_limit integer default 50,
  p_lease_seconds integer default 180
)
returns table (id uuid, object_path text, cleanup_lease_token uuid)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'invalid cleanup lease duration' using errcode = '22023';
  end if;

  return query
  with eligible as (
    select intent.id
    from public.upload_intents as intent
    where intent.cleaned_at is null
      and ((
        intent.status in ('issued', 'uploading', 'uploaded', 'rejected')
        and intent.expires_at <= v_now
        and (intent.upload_lease_expires_at is null or intent.upload_lease_expires_at <= v_now)
      ) or (
        intent.status = 'abandoned'
        and (intent.cleanup_lease_expires_at is null or intent.cleanup_lease_expires_at <= v_now)
      ))
    order by intent.expires_at, intent.created_at
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update skip locked
  )
  update public.upload_intents as intent
  set status = 'abandoned',
      upload_lease_token = null,
      upload_lease_expires_at = null,
      cleanup_lease_token = gen_random_uuid(),
      cleanup_lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds)
  from eligible
  where intent.id = eligible.id
  returning intent.id, intent.object_path, intent.cleanup_lease_token;
end;
$function$;

create function public.mark_call_upload_cleaned(p_intent_id uuid, p_cleanup_lease_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.upload_intents
  set cleaned_at = clock_timestamp(),
      cleanup_lease_token = null,
      cleanup_lease_expires_at = null
  where id = p_intent_id
    and status = 'abandoned'
    and cleaned_at is null
    and cleanup_lease_token = p_cleanup_lease_token
    and cleanup_lease_expires_at > clock_timestamp();

  return found;
end;
$function$;

create function public.release_call_upload_cleanup(p_intent_id uuid, p_cleanup_lease_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update public.upload_intents
  set cleanup_lease_token = null,
      cleanup_lease_expires_at = null
  where id = p_intent_id
    and status = 'abandoned'
    and cleaned_at is null
    and cleanup_lease_token = p_cleanup_lease_token;

  return found;
end;
$function$;

create function public.consume_m2_worker_nonce(p_nonce uuid, p_issued_at timestamptz)
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

  delete from private.m2_worker_nonces
  where issued_at < clock_timestamp() - interval '10 minutes';

  insert into private.m2_worker_nonces (nonce, issued_at)
  values (p_nonce, p_issued_at)
  on conflict (nonce) do nothing;

  return found;
end;
$function$;

revoke all on function public.begin_call_upload(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.mark_call_upload_uploaded(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_call_upload(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.finalize_call_upload(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_m2_job(integer) from public, anon, authenticated;
revoke all on function public.complete_m2_job(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_m2_job(uuid, text, text) from public, anon, authenticated;
revoke all on function public.claim_abandoned_call_uploads(integer, integer) from public, anon, authenticated;
revoke all on function public.mark_call_upload_cleaned(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_call_upload_cleanup(uuid, uuid) from public, anon, authenticated;
revoke all on function public.consume_m2_worker_nonce(uuid, timestamptz) from public, anon, authenticated;

grant execute on function public.begin_call_upload(uuid, uuid, integer) to service_role;
grant execute on function public.mark_call_upload_uploaded(uuid, uuid, uuid) to service_role;
grant execute on function public.release_call_upload(uuid, uuid, uuid) to service_role;
grant execute on function public.finalize_call_upload(uuid, uuid, uuid) to service_role;
grant execute on function public.claim_m2_job(integer) to service_role;
grant execute on function public.complete_m2_job(uuid, text) to service_role;
grant execute on function public.fail_m2_job(uuid, text, text) to service_role;
grant execute on function public.claim_abandoned_call_uploads(integer, integer) to service_role;
grant execute on function public.mark_call_upload_cleaned(uuid, uuid) to service_role;
grant execute on function public.release_call_upload_cleanup(uuid, uuid) to service_role;
grant execute on function public.consume_m2_worker_nonce(uuid, timestamptz) to service_role;

comment on table public.upload_intents is
  'Private upload staging state; no anonymous or authenticated table grants.';
comment on function private.can_upload_call_audio(text) is
  'Allows only the authenticated owner/reviewer to insert an object matching their active upload lease.';
comment on function public.claim_m2_job(integer) is
  'Atomically claims only explicit M2 synthetic-test jobs; ordinary M3 jobs remain queued.';

commit;
