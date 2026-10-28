-- Local transaction test for one-time, time-bounded worker request nonces.
begin;

do $test$
declare
  v_nonce uuid := gen_random_uuid();
  v_timestamp timestamptz := clock_timestamp();
begin
  if not public.consume_m2_worker_nonce(v_nonce, v_timestamp) then
    raise exception 'fresh worker nonce was not accepted';
  end if;
  if public.consume_m2_worker_nonce(v_nonce, v_timestamp) then
    raise exception 'replayed worker nonce was accepted';
  end if;
  if public.consume_m2_worker_nonce(gen_random_uuid(), clock_timestamp() - interval '3 minutes') then
    raise exception 'stale worker timestamp was accepted';
  end if;
  if public.consume_m2_worker_nonce(gen_random_uuid(), clock_timestamp() + interval '1 minute') then
    raise exception 'future worker timestamp was accepted';
  end if;
end;
$test$;

rollback;
