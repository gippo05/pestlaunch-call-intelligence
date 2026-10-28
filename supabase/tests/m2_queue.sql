-- Local transaction test for queue eligibility, retries, lease recovery, and fencing.
begin;

do $test$
declare
  v_user_id uuid := gen_random_uuid();
  v_workspace_id uuid := gen_random_uuid();
  v_pending_call_id uuid := gen_random_uuid();
  v_test_call_id uuid := gen_random_uuid();
  v_exhausted_call_id uuid := gen_random_uuid();
  v_pending_job_id uuid := gen_random_uuid();
  v_test_job_id uuid := gen_random_uuid();
  v_exhausted_job_id uuid := gen_random_uuid();
  v_first_claim public.analysis_jobs%rowtype;
  v_second_claim public.analysis_jobs%rowtype;
  v_expired_token text;
begin
  insert into auth.users (id) values (v_user_id);
  insert into public.workspaces (id, name) values (v_workspace_id, 'M2 synthetic queue test');
  insert into public.workspace_members (workspace_id, user_id, role)
    values (v_workspace_id, v_user_id, 'reviewer');

  insert into public.calls (
    id, workspace_id, uploader_user_id, brand, original_filename, mime_type, storage_path, status
  ) values
    (v_pending_call_id, v_workspace_id, v_user_id, 'abc', 'pending.mp3', 'audio/mpeg',
     v_workspace_id::text || '/' || gen_random_uuid()::text || '.mp3', 'queued'),
    (v_test_call_id, v_workspace_id, v_user_id, 'abc', 'synthetic-test.mp3', 'audio/mpeg',
     v_workspace_id::text || '/' || gen_random_uuid()::text || '.mp3', 'queued'),
    (v_exhausted_call_id, v_workspace_id, v_user_id, 'abc', 'exhausted-test.mp3', 'audio/mpeg',
     v_workspace_id::text || '/' || gen_random_uuid()::text || '.mp3', 'queued');

  insert into public.analysis_jobs (id, workspace_id, call_id, processor_kind)
    values
      (v_pending_job_id, v_workspace_id, v_pending_call_id, 'pending_m3'),
      (v_test_job_id, v_workspace_id, v_test_call_id, 'm2_synthetic_test'),
      (v_exhausted_job_id, v_workspace_id, v_exhausted_call_id, 'm2_synthetic_test');

  update public.analysis_jobs
  set status = 'leased', attempts = max_attempts, attempt_owner = gen_random_uuid()::text,
      lease_expires_at = clock_timestamp() - interval '1 second', next_retry_at = null
  where id = v_exhausted_job_id;

  select * into v_first_claim from public.claim_m2_job(180);
  if not found or v_first_claim.id <> v_test_job_id
    or v_first_claim.status <> 'leased' or v_first_claim.attempts <> 1
    or v_first_claim.attempt_owner is null
    or v_first_claim.lease_expires_at <= clock_timestamp() then
    raise exception 'worker did not atomically lease exactly one synthetic test job';
  end if;

  select * into v_second_claim from public.claim_m2_job(180);
  if found then
    raise exception 'worker claimed a second job while the only synthetic job was leased';
  end if;

  if public.complete_m2_job(v_test_job_id, '00000000-0000-4000-8000-000000000000') then
    raise exception 'stale attempt token completed a leased job';
  end if;

  if not public.fail_m2_job(v_test_job_id, v_first_claim.attempt_owner, 'SYNTHETIC_PROCESSOR_ERROR') then
    raise exception 'current lease could not persist a retryable failure';
  end if;

  if not exists (
    select 1 from public.analysis_jobs
    where id = v_test_job_id and status = 'failed' and attempts = 1
      and completed_at is null and next_retry_at > clock_timestamp()
      and safe_error_code = 'SYNTHETIC_PROCESSOR_ERROR'
  ) then
    raise exception 'failed attempt did not persist a bounded retry delay';
  end if;

  select * into v_second_claim from public.claim_m2_job(180);
  if found then
    raise exception 'worker ignored the retry delay';
  end if;

  update public.analysis_jobs
  set status = 'leased', attempts = attempts + 1, attempt_owner = gen_random_uuid()::text,
      lease_expires_at = clock_timestamp() - interval '1 second', next_retry_at = null
  where id = v_test_job_id
  returning attempt_owner into v_expired_token;

  select * into v_second_claim from public.claim_m2_job(180);
  if found then
    raise exception 'expired lease bypassed its retry backoff';
  end if;
  if not exists (
    select 1 from public.analysis_jobs
    where id = v_test_job_id and status = 'failed' and completed_at is null
      and attempt_owner is null and next_retry_at > clock_timestamp()
  ) then
    raise exception 'expired lease was not recovered into a delayed retry';
  end if;

  update public.analysis_jobs set next_retry_at = clock_timestamp() - interval '1 second'
  where id = v_test_job_id;
  select * into v_second_claim from public.claim_m2_job(180);
  if not found or v_second_claim.id <> v_test_job_id or v_second_claim.attempts <> 3
    or v_second_claim.attempt_owner = v_expired_token then
    raise exception 'recovered job was not reclaimed with a new attempt token';
  end if;

  if public.complete_m2_job(v_test_job_id, v_first_claim.attempt_owner) then
    raise exception 'stale worker completed after lease ownership changed';
  end if;
  if not public.complete_m2_job(v_test_job_id, v_second_claim.attempt_owner) then
    raise exception 'current synthetic attempt could not complete';
  end if;

  if not exists (
    select 1 from public.analysis_jobs
    where id = v_test_job_id and status = 'succeeded' and completion_kind = 'synthetic_test'
  ) or not exists (
    select 1 from public.calls where id = v_test_call_id and status = 'test_completed'
  ) then
    raise exception 'synthetic completion was not explicitly labeled';
  end if;

  select * into v_second_claim from public.claim_m2_job(180);
  if found then
    raise exception 'job beyond its maximum attempts was claimed';
  end if;
  if not exists (
    select 1 from public.analysis_jobs
    where id = v_exhausted_job_id and status = 'failed' and completed_at is not null
      and safe_error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS'
  ) then
    raise exception 'expired lease at the attempt limit was not terminally failed';
  end if;
end;
$test$;

rollback;
