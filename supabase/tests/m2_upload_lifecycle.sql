-- Local transaction test for upload leases and idempotent call/job finalization.
begin;

do $test$
declare
  v_user_id uuid := gen_random_uuid();
  v_workspace_id uuid := gen_random_uuid();
  v_intent_id uuid := gen_random_uuid();
  v_abandoned_intent_id uuid := gen_random_uuid();
  v_stale_intent_id uuid := gen_random_uuid();
  v_lease_token uuid;
  v_stale_token uuid;
  v_replacement_token uuid;
  v_call_one uuid;
  v_call_two uuid;
  v_cleanup record;
begin
  insert into auth.users (id) values (v_user_id);
  insert into public.workspaces (id, name) values (v_workspace_id, 'M2 synthetic upload test');
  insert into public.workspace_members (workspace_id, user_id, role)
    values (v_workspace_id, v_user_id, 'reviewer');

  insert into public.upload_intents (
    id, workspace_id, user_id, idempotency_key, brand, original_filename,
    mime_type, expected_size, object_path, status, expires_at
  ) values (
    v_intent_id, v_workspace_id, v_user_id, gen_random_uuid(), 'abc',
    'synthetic-call.mp3', 'audio/mpeg', 1024,
    v_workspace_id::text || '/' || v_intent_id::text || '.mp3',
    'issued', clock_timestamp() + interval '2 hours'
  );

  v_lease_token := public.begin_call_upload(v_intent_id, v_user_id, 180);
  if v_lease_token is null then
    raise exception 'upload intent did not receive an upload lease';
  end if;

  v_call_one := public.finalize_call_upload(v_intent_id, v_user_id, v_lease_token);
  v_call_two := public.finalize_call_upload(v_intent_id, v_user_id);

  if v_call_one is null or v_call_two is distinct from v_call_one then
    raise exception 'duplicate finalization did not return the original call';
  end if;

  if (select count(*) from public.calls where upload_intent_id = v_intent_id) <> 1
    or (select count(*) from public.analysis_jobs where call_id = v_call_one) <> 1 then
    raise exception 'finalization did not create exactly one linked call and job';
  end if;

  if not exists (
    select 1 from public.calls where id = v_call_one and workspace_id = v_workspace_id and status = 'queued'
  ) or not exists (
    select 1 from public.analysis_jobs
    where call_id = v_call_one and workspace_id = v_workspace_id
      and status = 'queued' and processor_kind = 'pending_m3'
  ) then
    raise exception 'normal upload was not left queued for M3';
  end if;

  if exists (
    select 1 from public.upload_intents
    where id = v_intent_id and (upload_lease_token is not null or upload_lease_expires_at is not null)
  ) then
    raise exception 'successful finalization did not clear the upload lease';
  end if;

  insert into public.upload_intents (
    id, workspace_id, user_id, idempotency_key, brand, original_filename,
    mime_type, expected_size, object_path, status, expires_at
  ) values (
    v_stale_intent_id, v_workspace_id, v_user_id, gen_random_uuid(), 'abc',
    'stale-attempt.mp3', 'audio/mpeg', 1024,
    v_workspace_id::text || '/' || v_stale_intent_id::text || '.mp3',
    'issued', clock_timestamp() + interval '2 hours'
  );
  v_stale_token := public.begin_call_upload(v_stale_intent_id, v_user_id, 180);
  update public.upload_intents
  set upload_lease_expires_at = clock_timestamp() - interval '1 second'
  where id = v_stale_intent_id;
  begin
    perform public.finalize_call_upload(v_stale_intent_id, v_user_id, v_stale_token);
    raise exception 'expired upload lease unexpectedly finalized';
  exception when sqlstate '55000' then
    null;
  end;
  v_replacement_token := public.begin_call_upload(v_stale_intent_id, v_user_id, 180);
  if v_replacement_token is null or v_replacement_token = v_stale_token then
    raise exception 'expired upload did not receive a new lease token';
  end if;
  begin
    perform public.finalize_call_upload(v_stale_intent_id, v_user_id, v_stale_token);
    raise exception 'stale upload lease unexpectedly finalized';
  exception when sqlstate '55000' then
    null;
  end;
  perform public.finalize_call_upload(v_stale_intent_id, v_user_id, v_replacement_token);

  insert into public.upload_intents (
    id, workspace_id, user_id, idempotency_key, brand, original_filename,
    mime_type, expected_size, object_path, status, expires_at
  ) values (
    v_abandoned_intent_id, v_workspace_id, v_user_id, gen_random_uuid(), 'abc',
    'interrupted.mp3', 'audio/mpeg', 1024,
    v_workspace_id::text || '/' || v_abandoned_intent_id::text || '.mp3',
    'issued', clock_timestamp() - interval '1 minute'
  );

  select * into v_cleanup from public.claim_abandoned_call_uploads(50, 180);
  if not found or v_cleanup.id <> v_abandoned_intent_id then
    raise exception 'expired upload intent was not atomically marked for cleanup';
  end if;
  if v_cleanup.cleanup_lease_token is null then
    raise exception 'cleanup intent did not receive a fencing token';
  end if;

  if exists (select 1 from public.claim_abandoned_call_uploads(50, 180)) then
    raise exception 'active cleanup lease was claimed by a second worker';
  end if;

  begin
    perform public.finalize_call_upload(v_abandoned_intent_id, v_user_id);
    raise exception 'cleanup-claimed intent unexpectedly finalized';
  exception when sqlstate '55000' then
    null;
  end;

  if public.mark_call_upload_cleaned(v_abandoned_intent_id, gen_random_uuid()) then
    raise exception 'stale cleanup token marked an object cleaned';
  end if;

  if not public.mark_call_upload_cleaned(v_abandoned_intent_id, v_cleanup.cleanup_lease_token) then
    raise exception 'claimed abandoned upload could not be marked cleaned';
  end if;
  if not exists (
    select 1 from public.upload_intents
    where id = v_abandoned_intent_id and status = 'abandoned' and cleaned_at is not null
      and cleanup_lease_token is null and cleanup_lease_expires_at is null
  ) then
    raise exception 'cleanup state was not persisted';
  end if;

  update public.upload_intents set expires_at = clock_timestamp() - interval '1 minute'
  where id = v_intent_id;
  if exists (select 1 from public.claim_abandoned_call_uploads(50, 180)) then
    raise exception 'finalized upload was returned to cleanup';
  end if;
end;
$test$;

rollback;
