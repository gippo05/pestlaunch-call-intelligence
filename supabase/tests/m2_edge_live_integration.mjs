// Live local-only Edge Function certification. Never connects to hosted project.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";

const raw = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8" });
const envVars = Object.fromEntries(raw.split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => {
  const i = line.indexOf("=");
  return [line.slice(0, i), line.slice(i + 1).replace(/^["']|["']$/g, "")];
}));
const base = "http://127.0.0.1:54321";
if (envVars.API_URL !== base || !envVars.PUBLISHABLE_KEY?.startsWith("sb_publishable_") || !envVars.SECRET_KEY?.startsWith("sb_secret_") || !envVars.DB_URL?.startsWith("postgresql://postgres:postgres@127.0.0.1:54322/")) {
  throw new Error("LOCAL_ONLY_PREFLIGHT_FAILED");
}
const admin = createClient(base, envVars.SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});
const endpoint = base + "/functions/v1/m2-process-queue";
const secret = randomBytes(48).toString("hex");
const tempDir = mkdtempSync(join(tmpdir(), "pestlaunch-m2-edge-"));
const envPath = join(tempDir, "worker.env");
const localFunctionEnv = [
  "M2_WORKER_AUTH_SECRET=" + secret,
  "M2_TEST_PROCESSOR_ENABLED=true",
  "M2_LOCAL_SUPABASE_COMPAT=true",
  "M2_LOCAL_PUBLISHABLE_KEY=" + envVars.PUBLISHABLE_KEY,
  "M2_LOCAL_SECRET_KEY=" + envVars.SECRET_KEY,
].join("\n") + "\n";
writeFileSync(envPath, localFunctionEnv, { mode: 0o600 });
let processChild = null;
let fixtureUserId = null;
let workspaceId = null;
let callId = null;
let jobId = null;
let success = false;
let stderrSummary = "";
const assert = (yes, label) => { if (!yes) throw new Error(label); };
function checked(result, label) {
  if (result.error) throw new Error(label + ":" + (result.error.code || "UNKNOWN"));
  return result.data;
}
async function postWithHeaders(headers = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: envVars.PUBLISHABLE_KEY, ...headers },
    body: "{}",
    signal: AbortSignal.timeout(9000),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}
function signedHeaders(at = new Date(), nonce = randomUUID()) {
  const timestamp = at.toISOString().replace(/\.\d{3}Z$/, "Z");
  const message = "POST\n/functions/v1/m2-process-queue\n" + timestamp + "\n" + nonce;
  const hmac = createHmac("sha256", secret).update(message).digest("hex");
  return {
    authorization: "Bearer " + hmac,
    "x-m2-timestamp": timestamp,
    "x-m2-nonce": nonce,
  };
}
async function pingTillReady() {
  let lastResponse = 'none';
  for (let i=0;i<60;i++){
    if (processChild.exitCode !== null) throw new Error("EDGE_SERVE_EXITED_EARLY");
    try {
      const { response, body } = await postWithHeaders();
      if (response.status === 401 && body.error === "UNAUTHORIZED") return;
      lastResponse = String(response.status) + ':' + String(body.error ?? body.message ?? JSON.stringify(body)).slice(0,130);
    } catch(e) { lastResponse = 'transport:' + String(e?.name ?? 'unknown'); }
    await delay(550);
  }
  throw new Error("EDGE_RUNTIME_ENDPOINT_NOT_READY last=" + lastResponse + ' log=' + stderrSummary.slice(-300));
}
async function getDbCounts(){
 const calls = checked(await admin.from("calls").select("id,status,workspace_id"), "READ_CALLS");
 const jobs = checked(await admin.from("analysis_jobs").select("id,processor_kind,status,attempts,call_id"), "READ_JOBS");
 return { calls, jobs };
}
async function cleanUp(){
 if (jobId) await admin.from("analysis_jobs").delete().eq("id",jobId);
 if (callId) await admin.from("calls").delete().eq("id",callId);
 if (workspaceId) await admin.from("workspaces").delete().eq("id",workspaceId);
 if (fixtureUserId) await admin.auth.admin.deleteUser(fixtureUserId);
}
function stopChild() {
 if (processChild?.pid && processChild.exitCode === null) {
   try {
     if (process.platform === "win32") {
       spawnSync("taskkill.exe", ["/PID", String(processChild.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 6000 });
     } else processChild.kill("SIGTERM");
   } catch {}
 }
}
try {
 const existing = await getDbCounts();
 assert(existing.jobs.filter(j=>j.processor_kind==="m2_synthetic_test" && j.status!=="succeeded").length===0,"EXISTING_SYNTHETIC_JOB_UNSAFE");
 const queuedM3 = existing.jobs.filter(j=>j.processor_kind==="pending_m3" && j.status==="queued");
 assert(queuedM3.length===1,"EXPECT_EXACTLY_ONE_EXISTING_PENDING_M3");
 console.log("PASS: local queue preflight — one existing pending_m3 call; no synthetic processing candidates");

 processChild = spawn(process.platform === "win32" ? "supabase.exe" : "supabase",
   ["functions","serve","m2-process-queue","--no-verify-jwt","--env-file",envPath],
   { cwd: process.cwd(), windowsHide: true, stdio: ["ignore","pipe","pipe"] });
 processChild.stdout.on("data", () => {});
 processChild.stderr.on("data", data => { stderrSummary = (stderrSummary + String(data).replace(secret, "[REDACTED]")).slice(-1800); });
 await pingTillReady();
 console.log("PASS: local live Edge endpoint started and anonymous request denied");

 const getResp = await fetch(endpoint, {method:"GET", headers:{apikey:envVars.PUBLISHABLE_KEY},signal:AbortSignal.timeout(6000)});
 assert(getResp.status===405, "GET_NOT_405:"+getResp.status);
 console.log("PASS: wrong HTTP method rejected");

 const invalid = await postWithHeaders({ authorization: "Bearer " + "a".repeat(64), "x-m2-timestamp": new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),"x-m2-nonce": randomUUID() });
 assert(invalid.response.status===401,"INVALID_SIGNATURE_NOT_401:"+invalid.response.status);
 console.log("PASS: invalid signature rejected");

 const stale = await postWithHeaders(signedHeaders(new Date(Date.now()-180_000)));
 assert(stale.response.status===401,"STALE_SIGNATURE_NOT_401:"+stale.response.status);
 console.log("PASS: stale timestamp rejected");

 const emptyHeaders = signedHeaders();
 const empty = await postWithHeaders(emptyHeaders);
 assert(empty.response.status===200 && empty.body.outcome==="empty" && empty.body.processed===0,
   "EMPTY_QUEUE_UNEXPECTED:"+empty.response.status+":"+JSON.stringify(empty.body));
 console.log("PASS: HMAC signed request accepted with empty synthetic queue");

 const replay = await postWithHeaders(emptyHeaders);
 assert(replay.response.status===401,"REPLAY_NOT_401:"+replay.response.status);
 console.log("PASS: replayed nonce rejected");

 fixtureUserId = checked(await admin.auth.admin.createUser({
   email: "m2-edge-" + randomUUID() + "@example.test",
   password: "LocalOnly-" + randomUUID() + "-Aa9!",
   email_confirm: true,
 }),"CREATE_TEST_USER").user.id;
 workspaceId = randomUUID(); callId=randomUUID(); jobId=randomUUID();
 checked(await admin.from("workspaces").insert({id:workspaceId,name:"M2 local Edge worker fixture"}),"CREATE_WORKSPACE");
 checked(await admin.from("workspace_members").insert({workspace_id:workspaceId,user_id:fixtureUserId,role:"reviewer"}),"CREATE_MEMBER");
 checked(await admin.from("calls").insert({
   id:callId,workspace_id:workspaceId,uploader_user_id:fixtureUserId,brand:"abc", original_filename:"synthetic-worker-only.mp3",
   mime_type:"audio/mpeg",storage_path:workspaceId+"/"+randomUUID()+".mp3",status:"queued"
 }),"CREATE_SYNTHETIC_CALL");
 checked(await admin.from("analysis_jobs").insert({
   id:jobId,workspace_id:workspaceId,call_id:callId,processor_kind:"m2_synthetic_test"
 }),"CREATE_SYNTHETIC_JOB");

 const worked = await postWithHeaders(signedHeaders());
 assert(worked.response.status===200 && worked.body.outcome==="synthetic_test" && worked.body.processed===1,
   "SYNTHETIC_RUN_UNEXPECTED:"+worked.response.status+":"+JSON.stringify(worked.body));
 const j = checked(await admin.from("analysis_jobs").select("status,completion_kind,attempts").eq("id",jobId).single(),"VERIFY_JOB");
 const c = checked(await admin.from("calls").select("status").eq("id",callId).single(),"VERIFY_CALL");
 assert(j.status==="succeeded" && j.completion_kind==="synthetic_test" && j.attempts===1 && c.status==="test_completed",
   "SYNTHETIC_DB_POSTCONDITION_FAILED");
 console.log("PASS: one explicit synthetic job completed on live Edge endpoint; DB job and call states match");

 const subsequent = await postWithHeaders(signedHeaders());
 assert(subsequent.response.status===200 && subsequent.body.outcome==="empty","SECOND_CALL_NOT_EMPTY");
 const after = await getDbCounts();
 for (const before of queuedM3) {
   const row=after.jobs.find(x=>x.id===before.id);
   assert(row?.status==="queued" && row.attempts===before.attempts,"PENDING_M3_JOB_CHANGED");
 }
 for (const before of existing.calls) {
   const row=after.calls.find(x=>x.id===before.id);
   assert(row?.status===before.status,"EXISTING_CALL_CHANGED");
 }
 console.log("PASS: real uploaded pending_m3 job and call remained untouched");
 success=true;
} catch (error) {
 console.error("FAIL:", String(error?.message||error).slice(0,900));
 process.exitCode=1;
} finally {
 await cleanUp();
 stopChild();
 rmSync(tempDir,{recursive:true,force:true});
 console.log("Temporary Edge HMAC file removed; synthetic test fixture cleanup attempted.");
}
if(success) console.log("PASS: LOCAL_EDGE_WORKER_RUNTIME_CERTIFICATION");
