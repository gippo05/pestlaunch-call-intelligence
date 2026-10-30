begin;

-- Opaque service API keys use the effective service_role database role but may not set the legacy JWT role claim.
create or replace function public.persist_m4_provisional_assessment(
  p_analysis_id uuid,
  p_scoring_version integer,
  p_calculation jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  source_row record;
  rubric_row record;
  assessment_context jsonb;
  rubric_context jsonb;
  actual_criteria jsonb;
  expected_criteria jsonb;
  actual_criterion jsonb;
  expected_criterion jsonb;
  actual_count integer;
  expected_count integer;
  result_id uuid;
  existing_row public.call_provisional_assessments%rowtype;
  rows_inserted integer;
begin
  if current_user is distinct from 'service_role' then
    raise exception 'service role required for M4 provisional persistence' using errcode = '42501';
  end if;
  if p_analysis_id is null or p_scoring_version is null or p_scoring_version < 1
    or p_calculation is null or jsonb_typeof(p_calculation) is distinct from 'object' then
    raise exception 'invalid M4 provisional persistence input' using errcode = '22023';
  end if;
  if p_calculation ->> 'schemaVersion' is distinct from 'm4.score-result.v1'
    or (p_calculation ->> 'scoringEngineVersion')::integer is distinct from p_scoring_version
    or jsonb_typeof(p_calculation -> 'rubric') is distinct from 'object'
    or jsonb_typeof(p_calculation -> 'criteria') is distinct from 'array'
    or jsonb_typeof(p_calculation -> 'assessmentContext') is distinct from 'object'
    or jsonb_typeof(p_calculation -> 'reviewReasons') is distinct from 'array'
    or jsonb_typeof(p_calculation -> 'reviewRequired') is distinct from 'boolean'
    or jsonb_typeof(p_calculation -> 'maxPoints') is distinct from 'number'
    or jsonb_typeof(p_calculation -> 'provisionalPoints') is distinct from 'number'
    or p_calculation -> 'totalPoints' is distinct from 'null'::jsonb
    or p_calculation -> 'grade' is distinct from 'null'::jsonb
    or p_calculation -> 'provisionalGrade' is distinct from 'null'::jsonb
    or (p_calculation ->> 'provisionalPoints')::numeric <> 0
    or (p_calculation ->> 'reviewRequired')::boolean is distinct from true
    or jsonb_array_length(p_calculation -> 'reviewReasons') = 0 then
    raise exception 'M4 provisional assessment must withhold all points and grades' using errcode = '22023';
  end if;

  assessment_context := p_calculation -> 'assessmentContext';
  rubric_context := p_calculation -> 'rubric';
  if assessment_context ->> 'analysisId' is distinct from p_analysis_id::text
    or assessment_context ->> 'companyConfirmed' is distinct from 'true'
    or assessment_context ->> 'intentValidated' is distinct from 'false'
    or assessment_context ->> 'analysisReviewStatus' is distinct from 'review_required'
    or assessment_context ->> 'transcriptCompleteness' not in ('partial', 'unverified')
    or assessment_context ->> 'speakerAttribution' is distinct from 'uncertain'
    or assessment_context ->> 'adjudicationStatus' is distinct from 'unreviewed'
    or assessment_context -> 'adjudicatorId' is distinct from 'null'::jsonb
    or assessment_context ->> 'reviewerRole' is distinct from 'unknown'
    or assessment_context ->> 'wholeTranscriptReviewed' is distinct from 'false' then
    raise exception 'M4 provisional context must remain explicitly unreviewed' using errcode = '22023';
  end if;

  select
    analysis_row.id,
    analysis_row.call_id,
    analysis_row.transcript,
    analysis_row.extracted_facts,
    analysis_row.quality_indicators,
    analysis_row.review_status,
    analysis_row.version,
    call_row.workspace_id,
    call_row.brand as source_brand,
    call_row.call_type as source_category,
    call_row.status as call_status
  into source_row
  from public.call_analyses as analysis_row
  join public.calls as call_row on call_row.id = analysis_row.call_id
  where analysis_row.id = p_analysis_id
  for update of analysis_row, call_row;
  if not found then
    raise exception 'M4 provisional analysis not found' using errcode = '22023';
  end if;
  if source_row.review_status is distinct from 'review_required'
    or source_row.call_status is distinct from 'review_required'
    or source_row.transcript is null or char_length(btrim(source_row.transcript)) = 0
    or source_row.version is distinct from (assessment_context ->> 'transcriptVersion')::integer
    or source_row.workspace_id is distinct from (assessment_context ->> 'workspaceId')::uuid
    or source_row.source_brand is distinct from (rubric_context ->> 'brand')
    or source_row.source_category is distinct from (rubric_context ->> 'category')
    or assessment_context ->> 'brand' is distinct from source_row.source_brand
    or assessment_context ->> 'category' is distinct from source_row.source_category
    or source_row.quality_indicators ->> 'schema_version' is distinct from 'm3-transcript-v1'
    or source_row.quality_indicators ->> 'source_completeness' is distinct from 'unverified'
    or source_row.quality_indicators ->> 'needs_human_review' is distinct from 'true'
    or source_row.extracted_facts -> 'provenance' ->> 'provider' is distinct from 'gemini'
    or source_row.extracted_facts -> 'provenance' ->> 'schema_version' is distinct from 'm3-transcript-v1' then
    raise exception 'M4 provisional source is not a saved unreviewed M3 candidate' using errcode = '42501';
  end if;

  select version_row.id, version_row.definition, version_row.calibration_status
  into rubric_row
  from public.rubric_versions as version_row
  where version_row.brand = source_row.source_brand
    and version_row.category = source_row.source_category
    and version_row.version = (rubric_context ->> 'version')::integer
    and version_row.is_active
    and version_row.definition ->> 'schema_version' = 'm4.rubric.v1';
  if not found
    or rubric_context ->> 'id' is distinct from rubric_row.definition ->> 'rubric_id'
    or rubric_context ->> 'brand' is distinct from rubric_row.definition ->> 'brand'
    or rubric_context ->> 'category' is distinct from rubric_row.definition ->> 'category'
    or rubric_context ->> 'calibrationStatus' is distinct from rubric_row.calibration_status
    or p_calculation ->> 'maxPoints' is distinct from rubric_row.definition ->> 'max_points' then
    raise exception 'M4 provisional rubric identity does not match the active database rubric' using errcode = '22023';
  end if;

  actual_criteria := p_calculation -> 'criteria';
  expected_criteria := rubric_row.definition -> 'criteria';
  actual_count := jsonb_array_length(actual_criteria);
  expected_count := jsonb_array_length(expected_criteria);
  if actual_count <> expected_count then
    raise exception 'M4 provisional assessment criterion count does not match its rubric' using errcode = '22023';
  end if;

  for actual_criterion in
    select value from jsonb_array_elements(actual_criteria)
  loop
    select value into expected_criterion
    from jsonb_array_elements(expected_criteria)
    where value ->> 'id' = actual_criterion ->> 'id';
    if not found
      or actual_criterion ->> 'label' is distinct from expected_criterion ->> 'label'
      or (actual_criterion ->> 'order')::integer is distinct from (expected_criterion ->> 'order')::integer
      or actual_criterion ->> 'status' is distinct from 'insufficient_evidence'
      or actual_criterion -> 'pointsEarned' is distinct from 'null'::jsonb
      or jsonb_typeof(actual_criterion -> 'pointsPossible') is distinct from 'number'
      or (actual_criterion ->> 'pointsPossible')::numeric is distinct from (expected_criterion ->> 'weight')::numeric
      or actual_criterion -> 'evidenceReferences' is distinct from '[]'::jsonb
      or char_length(btrim(coalesce(actual_criterion ->> 'rationale', ''))) = 0 then
      raise exception 'M4 provisional criteria must all be unknown, unscored, and evidence-free' using errcode = '22023';
    end if;
  end loop;

  if not (p_calculation -> 'reviewReasons' @> '["classification_unreviewed"]'::jsonb)
    or (select count(distinct value ->> 'id') from jsonb_array_elements(actual_criteria)) <> expected_count then
    raise exception 'M4 provisional assessment must retain the unreviewed classification gate' using errcode = '22023';
  end if;

  insert into public.call_provisional_assessments(
    workspace_id, analysis_id, rubric_version_id, scoring_version, calculation
  ) values (
    source_row.workspace_id, p_analysis_id, rubric_row.id, p_scoring_version, p_calculation
  ) on conflict (analysis_id, rubric_version_id, scoring_version) do nothing
  returning id into result_id;

  get diagnostics rows_inserted = row_count;
  if rows_inserted = 1 then return result_id; end if;

  select * into existing_row
  from public.call_provisional_assessments as assessment_row
  where assessment_row.analysis_id = p_analysis_id
    and assessment_row.rubric_version_id = rubric_row.id
    and assessment_row.scoring_version = p_scoring_version;
  if not found or existing_row.workspace_id is distinct from source_row.workspace_id
    or existing_row.calculation is distinct from p_calculation then
    raise exception 'M4 provisional idempotency key reused with a different context' using errcode = '23505';
  end if;
  return existing_row.id;
end;
$function$;
revoke all on function public.persist_m4_provisional_assessment(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.persist_m4_provisional_assessment(uuid, integer, jsonb) to service_role;
comment on function public.persist_m4_provisional_assessment(uuid, integer, jsonb) is
  'Service-role-only, invoker-rights persistence for saved M3 candidates. Authorization uses the effective service_role ACL and role; database validation requires every criterion to remain insufficient evidence with zero points and no evidence references.';
notify pgrst, 'reload schema';
commit;