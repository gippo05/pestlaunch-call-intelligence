-- Fix private-upload persistence: accept either privileged approval type.
-- All transcript validation, queue/lease checks, and one-attempt caps remain intact.
-- Does not replay or mutate any existing processing jobs.
CREATE OR REPLACE FUNCTION public.complete_m3_job(p_job_id uuid, p_attempt_owner text, p_transcript text, p_model text, p_call_type text, p_extracted_facts jsonb, p_outcome jsonb, p_quality_indicators jsonb, p_duration_seconds integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if not found or not (
    exists (
      select 1 from private.m3_synthetic_approvals as approval
      where approval.workspace_id = job_row.workspace_id
        and approval.call_id = job_row.call_id
    )
    or exists (
      select 1 from private.m3_private_upload_approvals as approval
      where approval.workspace_id = job_row.workspace_id
        and approval.call_id = job_row.call_id
    )
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
$function$
;
notify pgrst, 'reload schema';
