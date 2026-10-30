begin;

-- Keep the review queue an RLS-invoker read over existing M1/M4 records. The
-- lateral reads choose only the current analysis and the current relevant
-- score so an obsolete analysis cannot keep a call in the queue.
create or replace view public.m5_call_review_queue
with (security_invoker = true)
as
select
  call_row.id,
  call_row.original_filename,
  call_row.brand,
  call_row.call_type,
  call_row.status,
  call_row.duration_seconds,
  call_row.created_at,
  latest_analysis.id as latest_analysis_id,
  latest_analysis.version as latest_analysis_version,
  latest_analysis.outcome as latest_analysis_outcome,
  latest_analysis.review_status as latest_analysis_review_status,
  latest_analysis.processed_at as latest_analysis_processed_at
from public.calls as call_row
left join lateral (
  select analysis_row.id, analysis_row.version, analysis_row.outcome,
         analysis_row.review_status, analysis_row.processed_at
  from public.call_analyses as analysis_row
  where analysis_row.call_id = call_row.id
  order by analysis_row.version desc, analysis_row.created_at desc, analysis_row.id desc
  limit 1
) as latest_analysis on true
left join lateral (
  select score_row.requires_human_review, rubric_row.category as rubric_category
  from public.call_scores as score_row
  join public.rubric_versions as rubric_row on rubric_row.id = score_row.rubric_version_id
  where score_row.analysis_id = latest_analysis.id
    and rubric_row.brand = call_row.brand
  order by (rubric_row.category = call_row.call_type) desc nulls last,
           rubric_row.version desc, score_row.created_at desc, score_row.scoring_version desc
  limit 1
) as latest_score on true
where call_row.status in ('failed', 'review_required')
   or latest_analysis.review_status is not null and latest_analysis.review_status <> 'reviewed'
   or coalesce(latest_score.requires_human_review, false)
   or latest_score.rubric_category is not null and latest_score.rubric_category is distinct from call_row.call_type;

revoke all on public.m5_call_review_queue from public, anon, authenticated, service_role;
grant select on public.m5_call_review_queue to authenticated;
comment on view public.m5_call_review_queue is
  'RLS-invoker M5 call review queue based on call status and each call current analysis and score; exposes no job rows.';

commit;
