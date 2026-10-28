-- Run locally as a database owner after applying the local migration set.
-- This test is read-only and fails closed if any expected M2 object is absent.
do $test$
declare
  bucket_row record;
  function_signature text;
begin
  if to_regclass('public.upload_intents') is null then
    raise exception 'M2 upload_intents table is missing';
  end if;

  if not coalesce((
    select relrowsecurity from pg_class where oid = 'public.upload_intents'::regclass
  ), false) then
    raise exception 'RLS is not enabled on public.upload_intents';
  end if;

  if has_table_privilege('anon', 'public.upload_intents', 'SELECT')
    or has_table_privilege('anon', 'public.upload_intents', 'INSERT')
    or has_table_privilege('authenticated', 'public.upload_intents', 'SELECT')
    or has_table_privilege('authenticated', 'public.upload_intents', 'INSERT')
    or has_table_privilege('authenticated', 'public.upload_intents', 'UPDATE')
    or has_table_privilege('authenticated', 'public.upload_intents', 'DELETE') then
    raise exception 'upload_intents is accessible to an ordinary client role';
  end if;

  select id, public, file_size_limit, allowed_mime_types
    into bucket_row
  from storage.buckets
  where id = 'pestlaunch-call-audio';

  if not found or bucket_row.public
    or bucket_row.file_size_limit <> 52428800
    or bucket_row.allowed_mime_types <> array['audio/mpeg']::text[] then
    raise exception 'M2 audio bucket is missing or does not match its private MP3 limits';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'm2_call_audio_insert_for_own_intent'
      and cmd = 'INSERT'
      and 'authenticated' = any(roles)
      and with_check like '%can_upload_call_audio%'
  ) then
    raise exception 'M2 own-intent Storage INSERT policy is missing';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and cmd in ('SELECT', 'ALL')
  ) then
    raise exception 'private M2 Storage project unexpectedly has an object-read policy';
  end if;

  if has_function_privilege('anon', 'private.can_upload_call_audio(text)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'private.can_upload_call_audio(text)', 'EXECUTE') then
    raise exception 'Storage intent predicate has an unsafe function ACL';
  end if;

  foreach function_signature in array array[
    'public.begin_call_upload(uuid,uuid,integer)',
    'public.mark_call_upload_uploaded(uuid,uuid,uuid)',
    'public.release_call_upload(uuid,uuid,uuid)',
    'public.finalize_call_upload(uuid,uuid,uuid)',
    'public.claim_m2_job(integer)',
    'public.complete_m2_job(uuid,text)',
    'public.fail_m2_job(uuid,text,text)',
    'public.claim_abandoned_call_uploads(integer,integer)',
    'public.mark_call_upload_cleaned(uuid,uuid)',
    'public.release_call_upload_cleanup(uuid,uuid)'
  ] loop
    if has_function_privilege('anon', function_signature, 'EXECUTE')
      or has_function_privilege('authenticated', function_signature, 'EXECUTE')
      or not has_function_privilege('service_role', function_signature, 'EXECUTE') then
      raise exception 'M2 privileged RPC ACL is unsafe for %', function_signature;
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.analysis_jobs', 'SELECT')
    or has_table_privilege('authenticated', 'public.analysis_jobs', 'INSERT')
    or has_table_privilege('authenticated', 'public.analysis_jobs', 'UPDATE')
    or has_table_privilege('authenticated', 'public.analysis_jobs', 'DELETE') then
    raise exception 'M2 changed the M1 client-denied analysis_jobs boundary';
  end if;

  if has_table_privilege('anon', 'private.m2_worker_nonces', 'SELECT')
    or has_table_privilege('authenticated', 'private.m2_worker_nonces', 'SELECT')
    or has_table_privilege('service_role', 'private.m2_worker_nonces', 'SELECT')
    or has_table_privilege('anon', 'private.m2_worker_http_requests', 'SELECT')
    or has_table_privilege('authenticated', 'private.m2_worker_http_requests', 'SELECT')
    or has_table_privilege('service_role', 'private.m2_worker_http_requests', 'SELECT') then
    raise exception 'worker replay or HTTP request metadata is directly readable';
  end if;

  if has_function_privilege('anon', 'public.consume_m2_worker_nonce(uuid,timestamptz)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.consume_m2_worker_nonce(uuid,timestamptz)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.consume_m2_worker_nonce(uuid,timestamptz)', 'EXECUTE') then
    raise exception 'worker nonce-consumption RPC ACL is unsafe';
  end if;
end;
$test$;
