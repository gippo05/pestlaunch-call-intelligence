import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const cli = process.env.SUPABASE_CLI_PATH ?? (process.platform === "win32" ? "supabase.exe" : "supabase");
const status = spawnSync(cli, ["status", "-o", "env"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
if (status.error || status.status !== 0) throw new Error("LOCAL_SUPABASE_UNAVAILABLE");
const variables = parseEnv(status.stdout);
const supabaseUrl = variables.API_URL ?? variables.SUPABASE_URL;
const anonKey = variables.ANON_KEY ?? variables.SUPABASE_ANON_KEY;
const serviceRoleKey = variables.SERVICE_ROLE_KEY ?? variables.SUPABASE_SERVICE_ROLE_KEY;
const databaseUrl = variables.DB_URL ?? variables.DATABASE_URL;
if (!isLoopbackUrl(supabaseUrl) || !anonKey || !serviceRoleKey || !databaseUrl) {
  throw new Error("LOCAL_SUPABASE_UNAVAILABLE: status must resolve only to local loopback services");
}

const db = new URL(databaseUrl);
if (!isLoopbackHost(db.hostname)) throw new Error("LOCAL_SUPABASE_UNAVAILABLE: database URL is not loopback");
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const bucket = "pestlaunch-call-audio";
const workspaceId = randomUUID();
const userId = randomUUID();
const abandonedIntentId = randomUUID();
const finalizedIntentId = randomUUID();
const callId = randomUUID();
const abandonedPath = `${workspaceId}/${abandonedIntentId}.mp3`;
const finalizedPath = `${workspaceId}/${finalizedIntentId}.mp3`;
const psql = process.env.PSQL_PATH ?? (process.platform === "win32" ? "psql.exe" : "psql");
const pgEnv = {
  ...process.env,
  PGHOST: db.hostname,
  PGPORT: db.port || "5432",
  PGUSER: decodeURIComponent(db.username),
  PGDATABASE: db.pathname.replace(/^\//, "") || "postgres",
  PGPASSWORD: decodeURIComponent(db.password),
};
let firstWorker;
let userCreated = false;

function runPsql(sql, timeout = 10_000) {
  const result = spawnSync(psql, ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    env: pgEnv,
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("LOCAL_CLEANUP_SQL_ASSERTION_FAILED");
  return result.stdout.trim();
}

function runPsqlAsync(sql, applicationName) {
  const child = spawn(psql, ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    env: { ...pgEnv, PGAPPNAME: applicationName },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let failed = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (part) => { stdout += part; });
  child.stderr.on("data", () => { failed = true; });
  return { child, get stdout() { return stdout; }, get failed() { return failed; } };
}

async function waitForSleepQuery(applicationName, seconds, timeoutMs = 10_000) {
  const minimumRemainingSeconds = 5;
  if (seconds <= minimumRemainingSeconds) throw new Error("LOCAL_CLEANUP_HOLD_MUST_EXCEED_MINIMUM");
  const maximumQueryAgeSeconds = seconds - minimumRemainingSeconds;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isSleepQueryActive(applicationName, seconds, maximumQueryAgeSeconds)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("LOCAL_CLEANUP_WORKER_DID_NOT_REACH_LOCK_HOLD");
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

try {
  const { data: existingRows, error: existingError } = await admin
    .from("upload_intents")
    .select("id,status,expires_at,upload_lease_expires_at,cleanup_lease_expires_at,cleaned_at")
    .is("cleaned_at", null)
    .limit(1001);
  if (existingError || !existingRows || existingRows.length >= 1001) {
    throw new Error("LOCAL_CLEANUP_TEST_REQUIRES_EMPTY_CANDIDATE_SCAN");
  }
  const now = Date.now();
  const existingCandidate = existingRows.some((row) => (
    ["issued", "uploading", "uploaded", "rejected"].includes(row.status)
      && Date.parse(row.expires_at) <= now
      && (!row.upload_lease_expires_at || Date.parse(row.upload_lease_expires_at) <= now)
  ) || (
    row.status === "abandoned"
      && (!row.cleanup_lease_expires_at || Date.parse(row.cleanup_lease_expires_at) <= now)
  ));
  if (existingCandidate) throw new Error("LOCAL_CLEANUP_TEST_REQUIRES_NO_OTHER_ELIGIBLE_INTENTS");

  const { data: createdUser, error: createUserError } = await admin.auth.admin.createUser({
    id: userId,
    email: `m2-cleanup-${userId}@example.invalid`,
    password: `${randomUUID()}-Aa9!`,
    email_confirm: true,
  });
  if (createUserError || !createdUser.user) throw new Error("LOCAL_CLEANUP_USER_FIXTURE_FAILED");
  userCreated = true;

  const { error: workspaceError } = await admin.from("workspaces").insert({ id: workspaceId, name: "M2 cleanup concurrency fixture" });
  if (workspaceError) throw new Error("LOCAL_CLEANUP_WORKSPACE_FIXTURE_FAILED");
  const fixtureBytes = await readFile(fileURLToPath(new URL("./fixtures/synthetic-tone.mp3", import.meta.url)));

  const { error: abandonedInsertError } = await admin.from("upload_intents").insert({
    id: abandonedIntentId,
    workspace_id: workspaceId,
    user_id: userId,
    idempotency_key: randomUUID(),
    brand: "abc",
    original_filename: "abandoned-synthetic-tone.mp3",
    mime_type: "audio/mpeg",
    expected_size: fixtureBytes.byteLength,
    object_path: abandonedPath,
    status: "abandoned",
    expires_at: new Date("2000-01-01T00:00:00.000Z").toISOString(),
  });
  if (abandonedInsertError) throw new Error("LOCAL_ABANDONED_INTENT_FIXTURE_FAILED");

  const { error: finalizedInsertError } = await admin.from("upload_intents").insert({
    id: finalizedIntentId,
    workspace_id: workspaceId,
    user_id: userId,
    idempotency_key: randomUUID(),
    brand: "abc",
    original_filename: "finalized-synthetic-tone.mp3",
    mime_type: "audio/mpeg",
    expected_size: fixtureBytes.byteLength,
    object_path: finalizedPath,
    status: "finalized",
    finalized_call_id: callId,
    expires_at: new Date("2000-01-01T00:00:00.000Z").toISOString(),
  });
  if (finalizedInsertError) throw new Error("LOCAL_FINALIZED_INTENT_FIXTURE_FAILED");
  const { error: callError } = await admin.from("calls").insert({
    id: callId,
    workspace_id: workspaceId,
    upload_intent_id: finalizedIntentId,
    uploader_user_id: userId,
    brand: "abc",
    original_filename: "finalized-synthetic-tone.mp3",
    mime_type: "audio/mpeg",
    storage_path: finalizedPath,
    status: "queued",
  });
  if (callError) throw new Error("LOCAL_FINALIZED_CALL_FIXTURE_FAILED");

  for (const path of [abandonedPath, finalizedPath]) {
    const { error } = await admin.storage.from(bucket).upload(path, new Blob([fixtureBytes], { type: "audio/mpeg" }), {
      contentType: "audio/mpeg",
      upsert: false,
    });
    if (error) throw new Error("LOCAL_CLEANUP_OBJECT_FIXTURE_FAILED");
  }

  const firstWorkerApplication = `m2_cleanup_${randomUUID()}`;
  firstWorker = runPsqlAsync(`
    begin;
    select id::text || '|' || object_path || '|' || cleanup_lease_token::text
      from public.claim_abandoned_call_uploads(1, 180);
    select pg_sleep(15);
    commit;
  `, firstWorkerApplication);
  await waitForSleepQuery(firstWorkerApplication, 15);
  const competingClaims = Number(runPsql("select count(*) from public.claim_abandoned_call_uploads(1, 180);"));
  if (competingClaims !== 0) throw new Error("LOCAL_CLEANUP_SECOND_WORKER_OVERLAPPED_CLAIM");
  if (!isSleepQueryActive(firstWorkerApplication, 15)) {
    throw new Error("LOCAL_CLEANUP_FIRST_WORKER_LEFT_LOCK_HOLD_BEFORE_COMPETING_CLAIM_FINISHED");
  }

  const firstExit = await new Promise((resolve, reject) => {
    firstWorker.child.once("error", reject);
    firstWorker.child.once("close", (code) => resolve(code));
  });
  const claimLine = firstWorker.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (firstExit !== 0 || firstWorker.failed || !claimLine?.startsWith(`${abandonedIntentId}|${abandonedPath}|`)) {
    throw new Error("LOCAL_CLEANUP_FIRST_WORKER_CLAIM_INVALID");
  }
  const postCommitClaims = Number(runPsql("select count(*) from public.claim_abandoned_call_uploads(1, 180);"));
  if (postCommitClaims !== 0) throw new Error("LOCAL_CLEANUP_ACTIVE_LEASE_WAS_RECLAIMED");

  const { data: claimed, error: claimReadError } = await admin
    .from("upload_intents")
    .select("cleanup_lease_token,status,cleaned_at")
    .eq("id", abandonedIntentId)
    .single();
  if (claimReadError || !claimed?.cleanup_lease_token || claimed.status !== "abandoned" || claimed.cleaned_at) {
    throw new Error("LOCAL_CLEANUP_LEASE_STATE_INVALID");
  }
  const { error: removeError } = await admin.storage.from(bucket).remove([abandonedPath]);
  if (removeError) throw new Error("LOCAL_ABANDONED_OBJECT_REMOVE_FAILED");
  const { data: marked, error: markError } = await admin.rpc("mark_call_upload_cleaned", {
    p_intent_id: abandonedIntentId,
    p_cleanup_lease_token: claimed.cleanup_lease_token,
  });
  if (markError || marked !== true) throw new Error("LOCAL_CLEANUP_FINALIZATION_FAILED");

  const { data: cleaned, error: cleanedReadError } = await admin
    .from("upload_intents")
    .select("cleanup_lease_token,cleanup_lease_expires_at,cleaned_at")
    .eq("id", abandonedIntentId)
    .single();
  if (cleanedReadError || !cleaned?.cleaned_at || cleaned.cleanup_lease_token || cleaned.cleanup_lease_expires_at) {
    throw new Error("LOCAL_CLEANUP_STATE_INCONSISTENT");
  }
  const { data: missingAbandonedObject, error: abandonedReadError } = await admin.storage.from(bucket).download(abandonedPath);
  if (missingAbandonedObject || !abandonedReadError) throw new Error("LOCAL_ABANDONED_OBJECT_STILL_EXISTS");
  const { data: retainedFinalizedObject, error: finalizedReadError } = await admin.storage.from(bucket).download(finalizedPath);
  if (finalizedReadError || !retainedFinalizedObject || retainedFinalizedObject.size !== fixtureBytes.byteLength) {
    throw new Error("LOCAL_FINALIZED_OBJECT_WAS_REMOVED");
  }
  const finalClaims = Number(runPsql("select count(*) from public.claim_abandoned_call_uploads(1, 180);"));
  if (finalClaims !== 0) throw new Error("LOCAL_CLEANUP_RETURNED_A_FINALIZED_OBJECT");

  console.log("PASS: two cleanup workers did not share an active claim; the abandoned object was cleaned with a cleared lease; the finalized object remained");
} finally {
  if (firstWorker && firstWorker.child.exitCode === null) firstWorker.child.kill();
  const storageCleanup = await admin.storage.from(bucket).remove([abandonedPath, finalizedPath]);
  const callCleanup = await admin.from("calls").delete().eq("id", callId);
  const intentsCleanup = await admin.from("upload_intents").delete().in("id", [abandonedIntentId, finalizedIntentId]);
  const workspaceCleanup = await admin.from("workspaces").delete().eq("id", workspaceId);
  const userCleanup = userCreated ? await admin.auth.admin.deleteUser(userId) : { error: null };
  for (const [label, result] of [
    ["storage", storageCleanup], ["call", callCleanup],
    ["intents", intentsCleanup], ["workspace", workspaceCleanup], ["user", userCleanup],
  ]) {
    if (result.error) throw new Error("LOCAL_CLEANUP_FIXTURE_FAILED_" + label);
  }
}

function parseEnv(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "[::1]"].includes(host);
}
