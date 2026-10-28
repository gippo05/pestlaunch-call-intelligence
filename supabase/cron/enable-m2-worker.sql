-- PREPARATION ONLY. Do not execute until M1 sign-in/sign-out and membership checks
-- are certified and the owner/reviewer explicitly authorizes hosted M2 activation.
-- This sends a publishable apikey and a one-use HMAC proof; the raw worker secret
-- is read from Vault only to sign the request and is not placed in pg_net headers.
begin;

do $preflight$
declare
  v_project_url text;
  v_publishable_key text;
  v_worker_secret text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
    or to_regclass('cron.job') is null then
    raise exception 'M2 activation requires the existing pg_cron extension';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net')
    or to_regclass('net.http_request_queue') is null
    or to_regclass('net._http_response') is null then
    raise exception 'M2 activation requires the existing pg_net extension';
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'M2 activation requires Supabase Vault';
  end if;
  if to_regprocedure('extensions.hmac(bytea,bytea,text)') is null then
    raise exception 'M2 activation requires pgcrypto HMAC in the extensions schema';
  end if;
  if to_regclass('public.upload_intents') is null
    or to_regclass('private.m2_worker_nonces') is null
    or to_regclass('private.m2_worker_http_requests') is null
    or to_regprocedure('public.claim_m2_job(integer)') is null
    or to_regprocedure('public.consume_m2_worker_nonce(uuid,timestamptz)') is null then
    raise exception 'Apply and verify the local M2 migration before preparing hosted Cron activation';
  end if;
  if not exists (
    select 1 from storage.buckets
    where id = 'pestlaunch-call-audio'
      and public is false
      and file_size_limit = 52428800
      and allowed_mime_types = array['audio/mpeg']::text[]
  ) then
    raise exception 'The private M2 audio bucket is missing or incompatible';
  end if;

  select max(decrypted_secret) filter (where name = 'm2_project_url'),
         max(decrypted_secret) filter (where name = 'm2_publishable_key'),
         max(decrypted_secret) filter (where name = 'm2_worker_auth_secret')
  into v_project_url, v_publishable_key, v_worker_secret
  from vault.decrypted_secrets
  where name in ('m2_project_url', 'm2_publishable_key', 'm2_worker_auth_secret');

  if v_project_url is distinct from 'https://aznfcxrlpzjnssfatzxi.supabase.co' then
    raise exception 'Vault m2_project_url does not match the authorized PestLaunch Test project';
  end if;
  if v_publishable_key is null or v_publishable_key not like 'sb_publishable_%' then
    raise exception 'Vault m2_publishable_key must be a modern publishable key';
  end if;
  if v_worker_secret is null or v_worker_secret !~ '^[0-9a-fA-F]{64,}$'
    or v_worker_secret = v_publishable_key then
    raise exception 'Vault m2_worker_auth_secret must be an independent 32-byte-or-longer hex secret';
  end if;
  if exists (select 1 from cron.job where jobname = 'pestlaunch-m2-worker') then
    raise exception 'Cron job pestlaunch-m2-worker already exists; inspect it before changing schedules';
  end if;
end;
$preflight$;

select cron.schedule(
  'pestlaunch-m2-worker',
  '* * * * *',
  $cron$
    with secrets as (
      select max(decrypted_secret) filter (where name = 'm2_project_url') as project_url,
             max(decrypted_secret) filter (where name = 'm2_publishable_key') as publishable_key,
             max(decrypted_secret) filter (where name = 'm2_worker_auth_secret') as worker_secret
      from vault.decrypted_secrets
      where name in ('m2_project_url', 'm2_publishable_key', 'm2_worker_auth_secret')
    ),
    request_data as (
      select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as issued_at,
             gen_random_uuid() as nonce
    ),
    dispatched as (
      select net.http_post(
        url := secrets.project_url || '/functions/v1/m2-process-queue',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', secrets.publishable_key,
          'Authorization', 'Bearer ' || encode(
            extensions.hmac(
              convert_to(
                'POST' || E'\n' || '/functions/v1/m2-process-queue' || E'\n' ||
                request_data.issued_at || E'\n' || request_data.nonce::text,
                'UTF8'
              ),
              convert_to(secrets.worker_secret, 'UTF8'),
              'sha256'
            ),
            'hex'
          ),
          'X-M2-Timestamp', request_data.issued_at,
          'X-M2-Nonce', request_data.nonce::text
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 90000
      ) as request_id
      from secrets cross join request_data
    ),
    prune_old_request_ids as (
      delete from private.m2_worker_http_requests
      where queued_at < clock_timestamp() - interval '7 days'
      returning request_id
    )
    insert into private.m2_worker_http_requests (request_id)
    select request_id from dispatched;
  $cron$
);

commit;
