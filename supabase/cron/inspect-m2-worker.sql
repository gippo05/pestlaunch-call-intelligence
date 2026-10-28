-- Read-only diagnostics. Cron SQL execution and the asynchronous pg_net response
-- are separate signals. Do not query request headers or response bodies here.
select jobid, jobname, schedule, active
from cron.job
where jobname = 'pestlaunch-m2-worker';

select runid, status, start_time, end_time, return_message
from cron.job_run_details
where jobid in (
  select jobid from cron.job where jobname = 'pestlaunch-m2-worker'
)
order by start_time desc
limit 30;

select request.request_id,
       request.queued_at,
       response.status_code,
       response.timed_out,
       response.error_msg,
       response.created as response_at
from private.m2_worker_http_requests as request
left join net._http_response as response on response.id = request.request_id
where request.queued_at >= clock_timestamp() - interval '24 hours'
order by request.queued_at desc
limit 100;
