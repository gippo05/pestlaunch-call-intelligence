-- Explicitly authorized private MP3 processing. Never grants direct browser access.
-- The app requires an authenticated owner/reviewer upload plus server byte verification.
create table private.m3_private_upload_approvals (
 call_id uuid primary key references public.calls(id) on delete cascade,
 workspace_id uuid not null references public.workspaces(id),
 audio_sha256 text not null check (audio_sha256 ~ '^[a-f0-9]{64}$'),
 approved_at timestamptz not null default now()
);
revoke all on private.m3_private_upload_approvals from public, anon, authenticated;
grant select, insert on private.m3_private_upload_approvals to service_role;

create function public.authorize_m3_private_upload(p_call_id uuid, p_audio_sha256 text)
returns text language plpgsql security definer set search_path = '' as $$
declare j public.analysis_jobs%rowtype; c public.calls%rowtype;
begin
 if p_call_id is null or p_audio_sha256 !~ '^[a-fA-F0-9]{64}$' then return 'not_eligible'; end if;
 select * into c from public.calls where id=p_call_id for update;
 if not found or c.status <> 'queued' then return 'not_eligible'; end if;
 if not exists (
    select 1 from public.upload_intents i
    join public.workspace_members m on m.workspace_id=i.workspace_id and m.user_id=i.user_id
    where i.id=c.upload_intent_id and i.workspace_id=c.workspace_id
      and i.user_id=c.uploader_user_id and i.object_path=c.storage_path
      and i.finalized_call_id=c.id and i.status='finalized'
      and i.mime_type='audio/mpeg' and i.expected_size between 4 and 52428800
      and m.role in ('owner','reviewer')
 ) then return 'not_eligible'; end if;
 select * into j from public.analysis_jobs
   where call_id=c.id and workspace_id=c.workspace_id and processor_kind='pending_m3'
   for update;
 if not found or j.status <> 'queued' or j.attempts <> 0 or j.completed_at is not null
   or exists(select 1 from public.call_analyses a where a.call_id=c.id) then return 'not_eligible'; end if;
 if exists(select 1 from private.m3_private_upload_approvals a where a.call_id=c.id) then
   if exists(select 1 from private.m3_private_upload_approvals a where a.call_id=c.id and a.audio_sha256=lower(p_audio_sha256))
   then return 'already_authorized'; end if;
   return 'not_eligible';
 end if;
 update public.analysis_jobs set max_attempts=1 where id=j.id and status='queued' and attempts=0;
 insert into private.m3_private_upload_approvals(call_id, workspace_id, audio_sha256)
 values(c.id,c.workspace_id,lower(p_audio_sha256));
 return 'approved';
end $$;
revoke all on function public.authorize_m3_private_upload(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.authorize_m3_private_upload(uuid,text) to service_role;

-- Preserve one-attempt targeted job claim and legacy synthetic behavior.
create or replace function public.claim_m3_demo_job(p_call_id uuid,p_lease_seconds integer default 600)
returns setof public.analysis_jobs language plpgsql security definer set search_path='' as $$
declare j public.analysis_jobs%rowtype;
begin
 if p_call_id is null or p_lease_seconds not between 60 and 600 then
   raise exception 'invalid M3 claim' using errcode='22023'; end if;
 select job.* into j from public.analysis_jobs job
 join public.calls c on c.id=job.call_id and c.workspace_id=job.workspace_id and c.status='queued'
 join public.upload_intents i on i.id=c.upload_intent_id and i.workspace_id=c.workspace_id
   and i.object_path=c.storage_path and i.status='finalized' and i.finalized_call_id=c.id and i.mime_type='audio/mpeg'
 where job.call_id=p_call_id and job.processor_kind='pending_m3'
   and job.status='queued' and job.attempts=0 and job.max_attempts=1
   and job.completed_at is null
   and (
     exists(select 1 from private.m3_synthetic_approvals s where s.call_id=job.call_id and s.workspace_id=job.workspace_id)
     or exists(select 1 from private.m3_private_upload_approvals p where p.call_id=job.call_id and p.workspace_id=job.workspace_id)
   )
   and not exists(select 1 from public.call_analyses a where a.call_id=job.call_id)
 for update of job,c skip locked;
 if not found then return; end if;
 update public.analysis_jobs set status='leased',attempts=1,
  lease_expires_at=clock_timestamp()+pg_catalog.make_interval(secs=>p_lease_seconds),
  attempt_owner=gen_random_uuid()::text, next_retry_at=null,safe_error_code=null,
  started_at=coalesce(started_at,clock_timestamp())
  where id=j.id and status='queued' and attempts=0 and max_attempts=1 returning * into j;
 if not found then return; end if;
 update public.calls set status='processing' where id=j.call_id and workspace_id=j.workspace_id and status='queued';
 if not found then raise exception 'call state changed' using errcode='40001'; end if;
 return next j;
end $$;
revoke all on function public.claim_m3_demo_job(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_m3_demo_job(uuid,integer) to service_role;

-- Same worker source contract as synthetic mode; hash comes from the
-- app-verifiable private MP3 digest for a real, authenticated upload.
create or replace function public.get_m3_job_source(p_job_id uuid,p_attempt_owner text)
returns table(job_status text,processor_kind text,workspace_id uuid,call_id uuid,attempt_owner text,
lease_expires_at timestamptz,call_status text,call_workspace_id uuid,call_storage_path text,
upload_intent_id uuid,call_brand text,call_uploader_user_id uuid,intent_id uuid,
intent_workspace_id uuid,intent_user_id uuid,intent_object_path text,intent_status text,
intent_finalized_call_id uuid,intent_mime_type text,intent_expected_size bigint,
synthetic_fixture_ref text,synthetic_fixture_sha256 text)
language sql volatile security definer set search_path='' as $$
 select j.status,j.processor_kind,j.workspace_id,j.call_id,j.attempt_owner,j.lease_expires_at,
 c.status,c.workspace_id,c.storage_path,c.upload_intent_id,c.brand,c.uploader_user_id,
 i.id,i.workspace_id,i.user_id,i.object_path,i.status,i.finalized_call_id,i.mime_type,i.expected_size,
 coalesce('private-upload-'||p.call_id::text,s.fixture_reference),
 coalesce(p.audio_sha256,f.sha256)
 from public.analysis_jobs j
 join public.calls c on c.id=j.call_id and c.workspace_id=j.workspace_id
 join public.upload_intents i on i.id=c.upload_intent_id and i.workspace_id=c.workspace_id
   and i.object_path=c.storage_path
 left join private.m3_synthetic_approvals s on s.call_id=j.call_id and s.workspace_id=j.workspace_id
 left join private.m3_synthetic_fixtures f on f.fixture_reference=s.fixture_reference
 left join private.m3_private_upload_approvals p on p.call_id=j.call_id and p.workspace_id=j.workspace_id
 where j.id=p_job_id and j.attempt_owner=p_attempt_owner
   and j.processor_kind='pending_m3' and j.status='leased'
   and j.lease_expires_at>clock_timestamp()
   and c.status='processing' and i.status='finalized'
   and i.finalized_call_id=c.id and i.mime_type='audio/mpeg'
   and (f.sha256 is not null or p.audio_sha256 is not null);
$$;
revoke all on function public.get_m3_job_source(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.get_m3_job_source(uuid,text) to service_role;
notify pgrst,'reload schema';
