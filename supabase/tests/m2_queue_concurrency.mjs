import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const port = process.env.M2_TEST_DB_PORT ?? "54322";
if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
  throw new Error("M2_TEST_DB_PORT must be a valid local PostgreSQL port");
}

const env = {
  ...process.env,
  PGHOST: "127.0.0.1",
  PGPORT: port,
  PGUSER: "postgres",
  PGDATABASE: "postgres",
  PGPASSWORD: process.env.M2_TEST_DB_PASSWORD ?? "postgres",
};
const psql = process.env.PSQL_PATH ?? "psql";
const userId = randomUUID();
const workspaceId = randomUUID();
const callId = randomUUID();
const jobId = randomUUID();
const objectId = randomUUID();
let firstWorker;

function runPsql(sql, timeout = 10_000) {
  const result = spawnSync(
    psql,
    ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { env, encoding: "utf8", timeout, windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Local PostgreSQL assertion failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function waitForSleepQuery(applicationName, seconds, timeoutMs = 10_000) {
  const minimumRemainingSeconds = 5;
  if (seconds <= minimumRemainingSeconds) throw new Error("Local PostgreSQL hold must exceed the minimum remaining time");
  const maximumQueryAgeSeconds = seconds - minimumRemainingSeconds;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isSleepQueryActive(applicationName, seconds, maximumQueryAgeSeconds)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Local PostgreSQL worker did not reach its lock hold");
}

function isSleepQueryActive(applicationName, seconds, maximumQueryAgeSeconds = null) {
  const queryAgeFilter = maximumQueryAgeSeconds === null
    ? ""
    : `and query_start > clock_timestamp() - interval '${maximumQueryAgeSeconds} seconds'`;
  return Number(runPsql(`
    select count(*) from pg_stat_activity
    where application_name = '${applicationName}'
      and state = 'active'
      and wait_event_type = 'Timeout'
      and wait_event = 'PgSleep'
      and query ilike '%pg_sleep(${seconds})%'
      ${queryAgeFilter};
  `)) === 1;
}

function cleanup() {
  runPsql(`
    delete from public.calls where id = '${callId}';
    delete from public.workspaces where id = '${workspaceId}';
    delete from auth.users where id = '${userId}';
  `);
}

try {
  const pendingTestJobs = Number(runPsql(`
    select count(*) from public.analysis_jobs
    where processor_kind = 'm2_synthetic_test' and completed_at is null;
  `));
  if (pendingTestJobs !== 0) {
    throw new Error("Use an empty local synthetic queue; this test will not claim another fixture");
  }

  runPsql(`
    begin;
    insert into auth.users (id) values ('${userId}');
    insert into public.workspaces (id, name) values ('${workspaceId}', 'M2 local concurrency fixture');
    insert into public.workspace_members (workspace_id, user_id, role)
      values ('${workspaceId}', '${userId}', 'reviewer');
    insert into public.calls (
      id, workspace_id, uploader_user_id, brand, original_filename, mime_type, storage_path, status
    ) values (
      '${callId}', '${workspaceId}', '${userId}', 'abc', 'synthetic-test.mp3', 'audio/mpeg',
      '${workspaceId}/${objectId}.mp3', 'queued'
    );
    insert into public.analysis_jobs (id, workspace_id, call_id, processor_kind)
      values ('${jobId}', '${workspaceId}', '${callId}', 'm2_synthetic_test');
    commit;
  `);

  const firstWorkerApplication = `m2_queue_${randomUUID()}`;
  firstWorker = spawn(
    psql,
    [
      "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c",
      `begin; select id from public.claim_m2_job(180); select pg_sleep(15); commit;`,
    ],
    { env: { ...env, PGAPPNAME: firstWorkerApplication }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  let firstOutput = "";
  let firstError = "";
  firstWorker.stdout.setEncoding("utf8");
  firstWorker.stderr.setEncoding("utf8");
  firstWorker.stdout.on("data", (chunk) => { firstOutput += chunk; });
  firstWorker.stderr.on("data", (chunk) => { firstError += chunk; });

  await waitForSleepQuery(firstWorkerApplication, 15);
  const competingClaims = Number(runPsql(`
    set statement_timeout = '2s';
    select count(*) from public.claim_m2_job(180);
  `, 5_000));
  if (competingClaims !== 0) {
    throw new Error(`Concurrent claim returned ${competingClaims} job(s) while the first lease was uncommitted`);
  }
  if (!isSleepQueryActive(firstWorkerApplication, 15)) {
    throw new Error("First worker left its lock hold before the competing claim finished");
  }

  const firstExitCode = await new Promise((resolve, reject) => {
    firstWorker.once("error", reject);
    firstWorker.once("close", (code) => resolve(code));
  });
  if (firstExitCode !== 0 || !firstOutput.includes(jobId)) {
    throw new Error(`First claim did not return the fixture job: ${firstError.trim()}`);
  }

  const persisted = runPsql(`
    select status || ':' || attempts
    from public.analysis_jobs where id = '${jobId}';
  `);
  if (persisted !== "leased:1") {
    throw new Error(`Expected exactly one persisted lease attempt, received ${persisted}`);
  }

  console.log("PASS: two concurrent PostgreSQL sessions leased the fixture job once");
} finally {
  if (firstWorker && firstWorker.exitCode === null) firstWorker.kill();
  cleanup();
}
