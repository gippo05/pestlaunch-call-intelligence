begin;

-- M4 extends the existing rubric_versions and call_scores tables. Rubric
-- semantics remain flagged for manual calibration because the company
-- procedure manuals are not present in this checkout.
alter table public.rubric_versions
  add column calibration_status text not null default 'manual_calibration_required'
    check (calibration_status in ('manual_calibration_required', 'owner_approved')),
  add column calibration_approved_at timestamptz,
  add column calibration_approved_by uuid references auth.users(id) on delete restrict,
  add column calibration_approval_reference text,
  add constraint rubric_versions_m4_calibration_metadata_check check (
    definition ->> 'schema_version' is distinct from 'm4.rubric.v1'
    or (
      calibration_status = 'manual_calibration_required'
      and calibration_approved_at is null
      and calibration_approved_by is null
      and calibration_approval_reference is null
    )
    or (
      calibration_status = 'owner_approved'
      and calibration_approved_at is not null
      and calibration_approved_by is not null
      and calibration_approval_reference is not null
      and char_length(btrim(calibration_approval_reference)) between 1 and 500
    )
  );

with brands(brand) as (
  values ('abc'::text), ('noble_sales'::text)
), rubric_specs(category, max_points, gold_points, green_minimum) as (
  values
    ('sales'::text, 17, 17, 14),
    ('general_office'::text, 12, 12, 11),
    ('retention'::text, 12, 12, 11)
), criterion_specs(category, criterion_id, label, criterion_order, applicability) as (
  values
    ('sales', 'sales.validate', 'Validate', 1, 'always'),
    ('sales', 'sales.confidence_statement', 'Confidence Statement', 2, 'always'),
    ('sales', 'sales.expectation_statement.first', 'Expectation Statement', 3, 'always'),
    ('sales', 'sales.investigate', 'Investigate', 4, 'always'),
    ('sales', 'sales.summary_statement', 'Summary Statement', 5, 'always'),
    ('sales', 'sales.expectation_statement.second', 'Expectation Statement', 6, 'always'),
    ('sales', 'sales.present_solution', 'Present Solution', 7, 'always'),
    ('sales', 'sales.consensus', 'Consensus', 8, 'always'),
    ('sales', 'sales.close', 'Close', 9, 'always'),
    ('sales', 'sales.pricing', 'Pricing', 10, 'always'),
    ('sales', 'sales.agree', 'Agree', 11, 'sales_objection'),
    ('sales', 'sales.restate_insinuate', 'Restate & Insinuate', 12, 'sales_objection'),
    ('sales', 'sales.resolve', 'Resolve', 13, 'sales_objection'),
    ('sales', 'sales.reclose', 'Re-Close', 14, 'sales_objection'),
    ('sales', 'sales.provide_conclusion', 'Provide a Conclusion', 15, 'always'),
    ('sales', 'sales.offer_final_information', 'Offer final information', 16, 'always'),
    ('sales', 'sales.thank_customer', 'Thank the Customer', 17, 'always'),

    ('general_office', 'general_office.validate', 'Validate', 1, 'always'),
    ('general_office', 'general_office.confidence_statement', 'Confidence Statement', 2, 'always'),
    ('general_office', 'general_office.expectation_statement.first', 'Expectation Statement', 3, 'always'),
    ('general_office', 'general_office.investigate', 'Investigate', 4, 'always'),
    ('general_office', 'general_office.summary_statement', 'Summary Statement', 5, 'always'),
    ('general_office', 'general_office.expectation_statement.second', 'Expectation Statement', 6, 'always'),
    ('general_office', 'general_office.present_solution', 'Present Solution', 7, 'always'),
    ('general_office', 'general_office.consensus', 'Consensus', 8, 'always'),
    ('general_office', 'general_office.close', 'Close', 9, 'always'),
    ('general_office', 'general_office.provide_conclusion', 'Provide a Conclusion', 10, 'always'),
    ('general_office', 'general_office.thank_customer', 'Thank the Customer', 11, 'always'),
    ('general_office', 'general_office.offer_final_information', 'Offer final information', 12, 'always'),

    ('retention', 'retention.validate_confidence_statement', 'Validate & Confidence Statement', 1, 'always'),
    ('retention', 'retention.transition_statement', 'Transition Statement', 2, 'always'),
    ('retention', 'retention.do_your_research', 'Do Your Research', 3, 'always'),
    ('retention', 'retention.investigate', 'Investigate', 4, 'always'),
    ('retention', 'retention.validate_summary_statement', 'Validate & Summary Statement', 5, 'always'),
    ('retention', 'retention.validate_expectation_statement', 'Validate & Expectation Statement', 6, 'always'),
    ('retention', 'retention.present_solution', 'Present Solution', 7, 'always'),
    ('retention', 'retention.consensus', 'Consensus', 8, 'always'),
    ('retention', 'retention.repeat', 'Repeat (when necessary)', 9, 'retention_repeat'),
    ('retention', 'retention.provide_conclusion', 'Provide a Conclusion', 10, 'always'),
    ('retention', 'retention.thank_customer', 'Thank the Customer', 11, 'always'),
    ('retention', 'retention.leave_teaser', 'Leave a Teaser', 12, 'always')
), criterion_sets as (
  select
    category,
    jsonb_agg(jsonb_build_object(
      'id', criterion_id,
      'label', label,
      'order', criterion_order,
      'weight', 1,
      'applicability', applicability,
      'calibrationRequired', true
    ) order by criterion_order) as criteria
  from criterion_specs
  group by category
)
insert into public.rubric_versions(brand, category, version, definition, calibration_status, is_active)
select
  brands.brand,
  rubric_specs.category,
  1,
  jsonb_build_object(
    'schema_version', 'm4.rubric.v1',
    'rubric_id', brands.brand || '.' || rubric_specs.category || '.v1',
    'brand', brands.brand,
    'category', rubric_specs.category,
    'version', 1,
    'max_points', rubric_specs.max_points,
    'thresholds', jsonb_build_object(
      'gold', rubric_specs.gold_points,
      'green_minimum', rubric_specs.green_minimum
    ),
    'criteria', criterion_sets.criteria
  ),
  'manual_calibration_required',
  true
from brands
cross join rubric_specs
join criterion_sets using (category);

create function private.protect_m4_rubric_version()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.definition ->> 'schema_version' = 'm4.rubric.v1' then
    if tg_op = 'DELETE' then
      raise exception 'M4 rubric versions are immutable' using errcode = '55000';
    end if;
    if new.id is distinct from old.id
      or new.brand is distinct from old.brand
      or new.category is distinct from old.category
      or new.version is distinct from old.version
      or new.definition is distinct from old.definition
      or new.created_at is distinct from old.created_at then
      raise exception 'M4 rubric content is immutable; insert a new version' using errcode = '55000';
    end if;
    if old.calibration_status = 'manual_calibration_required'
      and new.calibration_status = 'owner_approved' then
      if old.calibration_approved_at is not null
        or old.calibration_approved_by is not null
        or old.calibration_approval_reference is not null
        or new.calibration_approved_at is null
        or new.calibration_approved_by is null
        or new.calibration_approval_reference is null
        or char_length(btrim(new.calibration_approval_reference)) not between 1 and 500 then
        raise exception 'M4 rubric approval metadata is incomplete or already set' using errcode = '55000';
      end if;
    elsif new.calibration_status is distinct from old.calibration_status
      or new.calibration_approved_at is distinct from old.calibration_approved_at
      or new.calibration_approved_by is distinct from old.calibration_approved_by
      or new.calibration_approval_reference is distinct from old.calibration_approval_reference then
      raise exception 'M4 calibration approval is write-once; insert a new rubric version' using errcode = '55000';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke all on function private.protect_m4_rubric_version() from public, anon, authenticated, service_role;

create trigger protect_m4_rubric_version
before update or delete on public.rubric_versions
for each row execute function private.protect_m4_rubric_version();

-- The sole calibration transition is server-trusted, explicit, and recorded
-- against a real Auth identity plus the owner's reviewable approval reference.
create function public.approve_m4_rubric(
  p_rubric_version_id uuid,
  p_approver_id uuid,
  p_approval_reference text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_status text;
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role' then
    raise exception 'service role required for M4 rubric approval' using errcode = '42501';
  end if;
  if p_rubric_version_id is null or p_approver_id is null
    or p_approval_reference is null
    or char_length(btrim(p_approval_reference)) not between 1 and 500 then
    raise exception 'M4 rubric approval requires a rubric, approver, and review reference' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users as auth_user where auth_user.id = p_approver_id) then
    raise exception 'M4 rubric approver must be an existing Auth user' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.workspace_members as member_row
    where member_row.user_id = p_approver_id and member_row.role = 'owner'
  ) then
    raise exception 'M4 rubric approval must be attributed to a workspace owner' using errcode = '42501';
  end if;

  select version_row.calibration_status
  into current_status
  from public.rubric_versions as version_row
  where version_row.id = p_rubric_version_id
    and version_row.definition ->> 'schema_version' = 'm4.rubric.v1'
  for update;
  if not found then
    raise exception 'M4 rubric version not found' using errcode = '22023';
  end if;
  if current_status is distinct from 'manual_calibration_required' then
    raise exception 'M4 rubric calibration is already approved; create a new version for changes' using errcode = '55000';
  end if;

  update public.rubric_versions
  set calibration_status = 'owner_approved',
      calibration_approved_at = now(),
      calibration_approved_by = p_approver_id,
      calibration_approval_reference = btrim(p_approval_reference)
  where id = p_rubric_version_id;
end;
$function$;

revoke all on function public.approve_m4_rubric(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.approve_m4_rubric(uuid, uuid, text) to service_role;
comment on function public.approve_m4_rubric(uuid, uuid, text) is
  'Trusted, write-once M4 calibration approval. Call only after the rubric owner approves the cited manual/policy review; insert a new rubric version for any later policy change.';

create function private.protect_m4_call_score()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.criterion_results ->> 'schemaVersion' = 'm4.score-result.v1' then
    raise exception 'M4 score history is immutable' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke all on function private.protect_m4_call_score() from public, anon, authenticated, service_role;

create trigger protect_m4_call_score
before update or delete on public.call_scores
for each row execute function private.protect_m4_call_score();

-- The database is the final score authority. The trusted TypeScript scorer
-- submits criterion states and evidence, while this function validates every
-- point, threshold, identity, citation, and idempotency condition atomically.
create function public.persist_m4_score(
  p_analysis_id uuid,
  p_scoring_version integer,
  p_calculation jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source_row record;
  reviewer_role text;
  rubric_id uuid;
  rubric_definition jsonb;
  rubric_calibration_status text;
  rubric_brand text;
  rubric_category text;
  context_value jsonb;
  criteria_value jsonb;
  criterion_value jsonb;
  expected_criterion jsonb;
  evidence_value jsonb;
  evidence_refs jsonb;
  result_status text;
  criterion_id text;
  start_offset integer;
  end_offset integer;
  point_value numeric;
  point_possible numeric;
  partial_points numeric := 0;
  max_points numeric := 0;
  criteria_count integer;
  span_evidence_count integer;
  full_review_evidence_count integer;
  index_value integer;
  unresolved boolean := false;
  review_required boolean;
  review_reasons jsonb;
  result_total numeric;
  result_grade text;
  provisional_grade text;
  expected_grade text;
  expected_provisional_grade text;
  result_id uuid;
  existing_row public.call_scores%rowtype;
  rows_inserted integer;
  objection_state text;
  repeat_applicability text;
  special_cancellation boolean;
  auto_objection_count integer;
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role' then
    raise exception 'service role required for M4 persistence' using errcode = '42501';
  end if;
  if p_analysis_id is null or p_scoring_version is null or p_scoring_version < 1
    or p_calculation is null or jsonb_typeof(p_calculation) is distinct from 'object' then
    raise exception 'invalid M4 persistence input' using errcode = '22023';
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
    or (jsonb_typeof(p_calculation -> 'provisionalGrade') is distinct from 'null'
      and jsonb_typeof(p_calculation -> 'provisionalGrade') is distinct from 'string')
    or p_calculation -> 'rubric' ->> 'calibrationStatus' not in (
      'manual_calibration_required', 'owner_approved'
    ) then
    raise exception 'invalid M4 calculation shape' using errcode = '22023';
  end if;

  rubric_brand := p_calculation -> 'rubric' ->> 'brand';
  rubric_category := p_calculation -> 'rubric' ->> 'category';
  context_value := p_calculation -> 'assessmentContext';
  criteria_value := p_calculation -> 'criteria';
  objection_state := context_value ->> 'objectionState';
  repeat_applicability := context_value ->> 'retentionRepeatApplicability';
  special_cancellation := (context_value -> 'exceptionFlags' ->> 'specialCancellation')::boolean;

  select version_row.id, version_row.definition, version_row.calibration_status
  into rubric_id, rubric_definition, rubric_calibration_status
  from public.rubric_versions as version_row
  where version_row.brand = rubric_brand
    and version_row.category = rubric_category
    and version_row.version = (p_calculation -> 'rubric' ->> 'version')::integer
    and version_row.definition ->> 'rubric_id' = p_calculation -> 'rubric' ->> 'id'
    and version_row.definition ->> 'schema_version' = 'm4.rubric.v1';
  if not found then
    raise exception 'approved M4 rubric version not found' using errcode = '22023';
  end if;
  if p_calculation -> 'rubric' ->> 'calibrationStatus' is distinct from rubric_calibration_status then
    raise exception 'M4 calculation calibration state does not match the database rubric' using errcode = '42501';
  end if;
  result_total := nullif(p_calculation ->> 'totalPoints', '')::numeric;
  result_grade := p_calculation ->> 'grade';
  if rubric_calibration_status is distinct from 'owner_approved'
    and (result_total is not null or result_grade is not null) then
    raise exception 'unapproved M4 rubric cannot persist an official score or grade' using errcode = '42501';
  end if;

  select
    analysis_row.id,
    analysis_row.call_id,
    analysis_row.version,
    analysis_row.review_status,
    analysis_row.transcript,
    call_row.workspace_id,
    call_row.brand
  into source_row
  from public.call_analyses as analysis_row
  join public.calls as call_row on call_row.id = analysis_row.call_id
  where analysis_row.id = p_analysis_id
  for update of analysis_row, call_row;
  if not found then
    raise exception 'M4 analysis not found' using errcode = '22023';
  end if;

  if source_row.review_status is distinct from 'reviewed'
    or source_row.transcript is null
    or char_length(btrim(source_row.transcript)) = 0 then
    raise exception 'M4 persistence requires a human-reviewed analysis and transcript' using errcode = '22023';
  end if;

  if context_value ->> 'analysisId' is distinct from source_row.id::text
    or context_value ->> 'workspaceId' is distinct from source_row.workspace_id::text
    or context_value ->> 'transcriptVersion' is distinct from source_row.version::text
    or context_value ->> 'analysisReviewStatus' is distinct from 'reviewed'
    or context_value ->> 'transcriptCompleteness' is distinct from 'verified'
    or context_value ->> 'speakerAttribution' is distinct from 'verified'
    or context_value ->> 'brand' is distinct from source_row.brand
    or context_value ->> 'brand' is distinct from rubric_brand
    or context_value ->> 'category' is distinct from rubric_category
    or context_value ->> 'companyConfirmed' is distinct from 'true'
    or context_value ->> 'intentValidated' is distinct from 'true'
    or context_value ->> 'adjudicationStatus' is distinct from 'human_validated'
    or context_value ->> 'wholeTranscriptReviewed' is distinct from 'true'
    or p_calculation -> 'rubric' ->> 'version' is distinct from rubric_definition ->> 'version'
    or jsonb_typeof(context_value -> 'exceptionFlags') is distinct from 'object'
    or jsonb_typeof(context_value -> 'exceptionFlags' -> 'specialCancellation') is distinct from 'boolean' then
    raise exception 'M4 assessment context does not match the authorized source' using errcode = '42501';
  end if;

  if context_value ->> 'adjudicatorId' is null then
    raise exception 'M4 adjudicator identity required' using errcode = '42501';
  end if;
  if (rubric_category = 'sales' and (
        objection_state is null or objection_state not in ('none_confirmed', 'present', 'ambiguous', 'unknown')
      )) or (rubric_category = 'retention' and (
        repeat_applicability is null or repeat_applicability not in ('applicable', 'not_applicable', 'uncertain')
      )) then
    raise exception 'M4 conditional applicability state is invalid' using errcode = '22023';
  end if;
  perform 1
  from public.workspace_members as member_row
  where member_row.workspace_id = source_row.workspace_id
    and member_row.user_id = (context_value ->> 'adjudicatorId')::uuid
    and member_row.role in ('owner', 'reviewer')
  for key share;
  if not found then
    raise exception 'M4 adjudicator is not an authorized workspace reviewer' using errcode = '42501';
  end if;
  select member_row.role into reviewer_role
  from public.workspace_members as member_row
  where member_row.workspace_id = source_row.workspace_id
    and member_row.user_id = (context_value ->> 'adjudicatorId')::uuid;
  if reviewer_role is distinct from context_value ->> 'reviewerRole' then
    raise exception 'M4 reviewer role does not match workspace membership' using errcode = '42501';
  end if;

  criteria_count := jsonb_array_length(criteria_value);
  if criteria_count = 0
    or criteria_count <> jsonb_array_length(rubric_definition -> 'criteria')
    or (p_calculation ->> 'maxPoints')::numeric is distinct from (rubric_definition ->> 'max_points')::numeric then
    raise exception 'M4 criterion registry does not match the selected rubric' using errcode = '22023';
  end if;

  for index_value in 0 .. criteria_count - 1 loop
    criterion_value := criteria_value -> index_value;
    expected_criterion := rubric_definition -> 'criteria' -> index_value;
    criterion_id := criterion_value ->> 'id';
    result_status := criterion_value ->> 'status';
    point_possible := nullif(criterion_value ->> 'pointsPossible', '')::numeric;
    point_value := nullif(criterion_value ->> 'pointsEarned', '')::numeric;
    evidence_refs := criterion_value -> 'evidenceReferences';
    max_points := max_points + (expected_criterion ->> 'weight')::numeric;

    if jsonb_typeof(criterion_value) is distinct from 'object'
      or criterion_id is distinct from expected_criterion ->> 'id'
      or criterion_value ->> 'label' is distinct from expected_criterion ->> 'label'
      or criterion_value ->> 'order' is distinct from expected_criterion ->> 'order'
      or point_possible is distinct from (expected_criterion ->> 'weight')::numeric
      or result_status is null
      or result_status not in ('met', 'missed', 'auto_awarded', 'insufficient_evidence', 'not_applicable')
      or jsonb_typeof(criterion_value -> 'rationale') is distinct from 'string'
      or char_length(btrim(criterion_value ->> 'rationale')) = 0
      or jsonb_typeof(evidence_refs) is distinct from 'array' then
      raise exception 'M4 criterion result is invalid' using errcode = '22023';
    end if;

    span_evidence_count := 0;
    full_review_evidence_count := 0;
    for evidence_value in select reference.value from jsonb_array_elements(evidence_refs) as reference(value) loop
      if jsonb_typeof(evidence_value) is distinct from 'object'
        or evidence_value ->> 'analysisId' is distinct from source_row.id::text
        or evidence_value ->> 'transcriptVersion' is distinct from source_row.version::text then
        raise exception 'M4 evidence reference belongs to a different analysis' using errcode = '22023';
      end if;

      if evidence_value ->> 'kind' = 'transcript_span' then
        if evidence_value ->> 'speaker' is distinct from 'agent'
          or jsonb_typeof(evidence_value -> 'start') is distinct from 'number'
          or jsonb_typeof(evidence_value -> 'end') is distinct from 'number'
          or jsonb_typeof(evidence_value -> 'quote') is distinct from 'string' then
          raise exception 'M4 transcript span is invalid' using errcode = '22023';
        end if;
        if trunc((evidence_value ->> 'start')::numeric) <> (evidence_value ->> 'start')::numeric
          or trunc((evidence_value ->> 'end')::numeric) <> (evidence_value ->> 'end')::numeric
          or (evidence_value ->> 'start')::numeric < 0
          or (evidence_value ->> 'end')::numeric <= (evidence_value ->> 'start')::numeric
          or (evidence_value ->> 'start')::numeric > 2147483647
          or (evidence_value ->> 'end')::numeric > 2147483647 then
          raise exception 'M4 transcript span offsets must be bounded integers' using errcode = '22023';
        end if;
        start_offset := (evidence_value ->> 'start')::integer;
        end_offset := (evidence_value ->> 'end')::integer;
        if start_offset < 0 or end_offset <= start_offset
          or end_offset > char_length(source_row.transcript)
          or substring(source_row.transcript from start_offset + 1 for end_offset - start_offset) is distinct from evidence_value ->> 'quote' then
          raise exception 'M4 transcript span does not match the reviewed transcript' using errcode = '22023';
        end if;
        span_evidence_count := span_evidence_count + 1;
      elsif evidence_value ->> 'kind' = 'full_transcript_review' then
        if evidence_value ->> 'scope' is distinct from 'complete_call'
          or evidence_value ->> 'adjudicatorId' is distinct from context_value ->> 'adjudicatorId' then
          raise exception 'M4 full-transcript review reference is invalid' using errcode = '22023';
        end if;
        full_review_evidence_count := full_review_evidence_count + 1;
      else
        raise exception 'unsupported M4 evidence reference kind' using errcode = '22023';
      end if;
    end loop;
    if full_review_evidence_count > 1 then
      raise exception 'M4 criterion cannot repeat its full-transcript attestation' using errcode = '22023';
    end if;

    if result_status = 'met' then
      if point_value is distinct from point_possible or span_evidence_count = 0 or full_review_evidence_count > 0 then
        raise exception 'M4 met criterion requires one point and agent evidence' using errcode = '22023';
      end if;
      partial_points := partial_points + point_value;
    elsif result_status = 'missed' then
      if point_value is distinct from 0 or span_evidence_count = 0 or full_review_evidence_count > 0 then
        raise exception 'M4 missed criterion requires an explicit zero and agent evidence' using errcode = '22023';
      end if;
      partial_points := partial_points + point_value;
    elsif result_status = 'auto_awarded' then
      if rubric_category is distinct from 'sales'
        or expected_criterion ->> 'applicability' is distinct from 'sales_objection'
        or objection_state is distinct from 'none_confirmed'
        or point_value is distinct from point_possible
        or full_review_evidence_count <> 1
        or span_evidence_count > 0 then
        raise exception 'M4 automatic points require a positively reviewed no-objection state' using errcode = '22023';
      end if;
      partial_points := partial_points + point_value;
    elsif result_status = 'not_applicable' then
      if rubric_category is distinct from 'retention'
        or expected_criterion ->> 'applicability' is distinct from 'retention_repeat'
        or repeat_applicability is distinct from 'not_applicable'
        or point_value is not null
        or full_review_evidence_count <> 1
        or span_evidence_count > 0 then
        raise exception 'M4 N/A is unsupported for this criterion or policy' using errcode = '22023';
      end if;
      unresolved := true;
    else
      if point_value is not null then
        raise exception 'M4 insufficient evidence cannot carry points' using errcode = '22023';
      end if;
      if full_review_evidence_count > 0 and not (
        (rubric_category = 'sales' and expected_criterion ->> 'applicability' = 'sales_objection'
          and objection_state in ('ambiguous', 'unknown'))
        or (rubric_category = 'retention' and expected_criterion ->> 'applicability' = 'retention_repeat'
          and repeat_applicability = 'uncertain')
      ) then
        raise exception 'M4 full-transcript reference is not valid for this unresolved criterion' using errcode = '22023';
      end if;
      unresolved := true;
    end if;
  end loop;

  if max_points is distinct from (rubric_definition ->> 'max_points')::numeric
    or (p_calculation ->> 'provisionalPoints')::numeric is distinct from partial_points then
    raise exception 'M4 point totals do not match criterion results' using errcode = '22023';
  end if;

  provisional_grade := p_calculation ->> 'provisionalGrade';
  if unresolved then
    if provisional_grade is not null then
      raise exception 'incomplete M4 calculations cannot carry a provisional grade' using errcode = '22023';
    end if;
  else
    expected_provisional_grade := case
      when partial_points >= (rubric_definition -> 'thresholds' ->> 'gold')::numeric then 'Gold'
      when partial_points >= (rubric_definition -> 'thresholds' ->> 'green_minimum')::numeric then 'Green'
      else 'Below Standard'
    end;
    if provisional_grade is distinct from expected_provisional_grade then
      raise exception 'M4 provisional grade does not match the configured threshold' using errcode = '22023';
    end if;
  end if;

  if rubric_category = 'sales' then
    select count(*) into auto_objection_count
    from jsonb_array_elements(criteria_value) as criterion(value)
    where criterion.value ->> 'id' in (
      'sales.agree', 'sales.restate_insinuate', 'sales.resolve', 'sales.reclose'
    ) and criterion.value ->> 'status' = 'auto_awarded';

    if special_cancellation and exists (
      select 1 from jsonb_array_elements(criteria_value) as criterion(value)
      where criterion.value ->> 'id' in (
        'sales.agree', 'sales.restate_insinuate', 'sales.resolve', 'sales.reclose'
      ) and criterion.value ->> 'status' is distinct from 'insufficient_evidence'
    ) then
      raise exception 'special cancellation keeps conditional criteria unscored pending policy' using errcode = '22023';
    elsif not special_cancellation and objection_state = 'none_confirmed' and auto_objection_count <> 4 then
      raise exception 'confirmed no-objection calls must auto-award exactly four criteria' using errcode = '22023';
    elsif not special_cancellation and objection_state = 'present' and auto_objection_count <> 0 then
      raise exception 'present objections cannot receive automatic points' using errcode = '22023';
    elsif not special_cancellation and objection_state in ('ambiguous', 'unknown') and (
      auto_objection_count <> 0 or exists (
        select 1 from jsonb_array_elements(criteria_value) as criterion(value)
        where criterion.value ->> 'id' in (
          'sales.agree', 'sales.restate_insinuate', 'sales.resolve', 'sales.reclose'
        ) and criterion.value ->> 'status' is distinct from 'insufficient_evidence'
      )
    ) then
      raise exception 'unresolved objections must leave all four conditional criteria unknown' using errcode = '22023';
    end if;
  end if;

  if rubric_category = 'retention' then
    if repeat_applicability = 'not_applicable' and not exists (
      select 1 from jsonb_array_elements(criteria_value) as criterion(value)
      where criterion.value ->> 'id' = 'retention.repeat'
        and criterion.value ->> 'status' = 'not_applicable'
    ) then
      raise exception 'retention Repeat N/A requires human review and no automatic point' using errcode = '22023';
    elsif repeat_applicability = 'uncertain' and not exists (
      select 1 from jsonb_array_elements(criteria_value) as criterion(value)
      where criterion.value ->> 'id' = 'retention.repeat'
        and criterion.value ->> 'status' = 'insufficient_evidence'
    ) then
      raise exception 'uncertain retention Repeat applicability must remain unscored' using errcode = '22023';
    end if;
  end if;

  review_required := (p_calculation ->> 'reviewRequired')::boolean;
  review_reasons := p_calculation -> 'reviewReasons';
  if rubric_calibration_status is distinct from 'owner_approved' then
    if not review_required or not exists (
      select 1 from jsonb_array_elements(review_reasons) as reason(value)
      where reason.value #>> '{}' = 'rubric_calibration_pending'
    ) then
      raise exception 'pending M4 rubric requires a calibration review reason and withheld official grade' using errcode = '42501';
    end if;
  elsif exists (
    select 1 from jsonb_array_elements(review_reasons) as reason(value)
    where reason.value #>> '{}' = 'rubric_calibration_pending'
  ) then
    raise exception 'approved M4 rubric cannot retain the calibration-pending reason' using errcode = '22023';
  end if;
  if (special_cancellation and exists (
      select 1 from jsonb_array_elements(criteria_value) as criterion(value)
      where criterion.value ->> 'status' is distinct from 'insufficient_evidence'
    )) then
    raise exception 'special cancellation requires all criteria to remain unscored' using errcode = '22023';
  end if;

  if review_required then
    if result_total is not null or result_grade is not null or jsonb_array_length(review_reasons) = 0
      or exists (
        select 1 from jsonb_array_elements(review_reasons) as reason(value)
        where jsonb_typeof(reason.value) is distinct from 'string'
          or char_length(btrim(reason.value #>> '{}')) = 0
      ) then
      raise exception 'review-required M4 results must withhold score and grade' using errcode = '22023';
    end if;
  else
    if unresolved or jsonb_array_length(review_reasons) <> 0 or result_total is distinct from partial_points
      or exists (
        select 1 from jsonb_array_elements(review_reasons) as reason(value)
        where jsonb_typeof(reason.value) is distinct from 'string'
          or char_length(btrim(reason.value #>> '{}')) = 0
      ) then
      raise exception 'complete M4 result is inconsistent with its criteria' using errcode = '22023';
    end if;
    expected_grade := case
      when result_total >= (rubric_definition -> 'thresholds' ->> 'gold')::numeric then 'Gold'
      when result_total >= (rubric_definition -> 'thresholds' ->> 'green_minimum')::numeric then 'Green'
      else 'Below Standard'
    end;
    if result_grade is distinct from expected_grade then
      raise exception 'M4 grade does not match the approved threshold' using errcode = '22023';
    end if;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('criterionId', criterion.value ->> 'id', 'reference', reference.value)
      order by criterion.ordinality, reference.ordinality
    ),
    '[]'::jsonb
  ) into evidence_refs
  from jsonb_array_elements(criteria_value) with ordinality as criterion(value, ordinality)
  cross join lateral jsonb_array_elements(criterion.value -> 'evidenceReferences') with ordinality as reference(value, ordinality);

  insert into public.call_scores(
    analysis_id,
    rubric_version_id,
    total_score,
    grade,
    criterion_results,
    evidence_references,
    requires_human_review,
    scoring_version
  ) values (
    p_analysis_id,
    rubric_id,
    case when review_required then null else result_total end,
    case when review_required then null else result_grade end,
    p_calculation,
    evidence_refs,
    review_required,
    p_scoring_version
  ) on conflict (analysis_id, rubric_version_id, scoring_version) do nothing
  returning id into result_id;

  get diagnostics rows_inserted = row_count;
  if rows_inserted = 1 then
    return result_id;
  end if;

  select * into existing_row
  from public.call_scores as score_row
  where score_row.analysis_id = p_analysis_id
    and score_row.rubric_version_id = rubric_id
    and score_row.scoring_version = p_scoring_version;
  if not found then
    raise exception 'M4 idempotent score row disappeared' using errcode = '40001';
  end if;
  if existing_row.total_score is distinct from (case when review_required then null else result_total end)
    or existing_row.grade is distinct from (case when review_required then null else result_grade end)
    or existing_row.criterion_results is distinct from p_calculation
    or existing_row.evidence_references is distinct from evidence_refs
    or existing_row.requires_human_review is distinct from review_required then
    raise exception 'M4 idempotency key reused with different calculation context' using errcode = '23505';
  end if;
  return existing_row.id;
end;
$function$;

revoke all on function public.persist_m4_score(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.persist_m4_score(uuid, integer, jsonb) to service_role;

-- All historical score writes must pass the validated RPC, even for the
-- service role. Authenticated workspace members retain their existing RLS reads.
revoke all privileges on table public.call_scores from public, anon, authenticated, service_role;
grant select on public.call_scores to authenticated, service_role;
revoke all privileges on table public.rubric_versions from public, anon, authenticated, service_role;
grant select on public.rubric_versions to authenticated, service_role;

comment on function public.persist_m4_score(uuid, integer, jsonb) is
  'Service-role-only deterministic M4 persistence. Validates rubric version, reviewer, analysis scope, transcript evidence, point arithmetic, grades, and idempotency before an immutable insert.';
comment on column public.call_scores.criterion_results is
  'M4 uses the immutable m4.score-result.v1 JSON result shape; official score and grade are NULL whenever review is required.';
comment on column public.call_scores.evidence_references is
  'M4 uses an ordered array of {criterionId, reference} entries bound to the same reviewed analysis and transcript version.';

commit;
