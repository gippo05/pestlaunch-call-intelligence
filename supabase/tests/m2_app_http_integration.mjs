// Isolated local Next.js + Supabase HTTP integration test. No hosted credentials or customer data.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";

const raw = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8" });
const entries = Object.fromEntries(raw.split(/\r?\n/).filter((v) => /^[A-Z_]+=/.test(v)).map((s) => {
  const idx = s.indexOf("=");
  return [s.slice(0, idx), s.slice(idx + 1).replace(/^["']|["']$/g, "")];
}));
if (entries.API_URL !== "http://127.0.0.1:54321" ||
    !entries.PUBLISHABLE_KEY?.startsWith("sb_publishable_") ||
    !entries.SECRET_KEY?.startsWith("sb_secret_")) {
  throw new Error("LOCAL_STACK_GUARD_FAILED");
}
const base = "http://localhost:3002";
const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
const admin = createClient(entries.API_URL, entries.SECRET_KEY, options);
const browserUser = createClient(entries.API_URL, entries.PUBLISHABLE_KEY, options);
const cookies = new Map();
const key = randomUUID();
let server = null, userId = null, workspaceId = null, intentId = null, callId = null, objectPath = null;
const bytes = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, ...Array.from({length:2048}, (_,i) => i % 250)]);
function requireOk(value, label) { if (!value) throw new Error(label); return value; }
function ensure(result, label) { if (result.error) throw new Error(label + ":" + (result.error.code ?? result.error.message)); return result.data; }
function acceptCookies(response) {
  for (const header of (response.headers.getSetCookie?.() ?? [])) {
    const part = header.split(";")[0];
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0,eq), value = part.slice(eq+1);
    if (value) cookies.set(name,value);
    else cookies.delete(name);
  }
}
async function app(path, { method = "GET", headers = {}, body } = {}) {
  const init = { method, headers: { ...headers }, redirect: "manual" };
  if (cookies.size) init.headers.cookie = [...cookies].map(([k,v]) => k+"="+v).join("; ");
  if (method !== "GET") init.headers.origin = base;
  if (body !== undefined) init.body = body;
  const res = await fetch(base + path, init);
  acceptCookies(res);
  return res;
}
async function waitReady() {
  for (let i = 0; i < 110; i++) {
    if (server.exitCode !== null) throw new Error("NEXT_DEV_EXITED");
    try {
      const r = await fetch(base + "/login", { signal: AbortSignal.timeout(1300) });
      if (r.status === 200) return;
    } catch {}
    await delay(500);
  }
  throw new Error("NEXT_DEV_NOT_READY");
}
async function json(response, label, status = 200) {
  const body = await response.json().catch(() => ({}));
  if (response.status !== status) throw new Error(label + ":HTTP_" + response.status + ":" + (body.error || ""));
  return body;
}
async function finish() {
  if (objectPath) await admin.storage.from("pestlaunch-call-audio").remove([objectPath]);
  if (callId) await admin.from("calls").delete().eq("id", callId);
  if (intentId) await admin.from("upload_intents").delete().eq("id", intentId);
  if (workspaceId) await admin.from("workspaces").delete().eq("id",workspaceId);
  if (userId) await admin.auth.admin.deleteUser(userId);
  if (server?.pid) {
    try {
      if (process.platform === "win32") execFileSync("taskkill",["/PID",String(server.pid),"/T","/F"], {stdio:"ignore"});
      else server.kill("SIGTERM");
    } catch {}
  }
}
try {
  try {
    const existing = await fetch(base + "/login", { signal: AbortSignal.timeout(800) });
    if (existing) throw new Error("APP_TEST_PORT_3002_ALREADY_IN_USE");
  } catch (e) {
    if (e.message === "APP_TEST_PORT_3002_ALREADY_IN_USE") throw e;
  }
  const env = {
    ...process.env, NODE_ENV: "development",
    NEXT_PUBLIC_SUPABASE_URL: entries.API_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: entries.PUBLISHABLE_KEY,
    NEXT_PUBLIC_ALLOW_LOCAL_SUPABASE_HTTP: "true",
    SUPABASE_SECRET_KEY: entries.SECRET_KEY,
  };
  const npmArgs = ["/d","/s","/c","npm.cmd run dev -- -p 3002"];
  server = spawn("cmd.exe", npmArgs, { cwd:process.cwd(),env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  // Never print process environment or stdout, which could contain credentials.
  server.stdout.on("data",()=>{});
  server.stderr.on("data",()=>{});
  await waitReady();
  console.log("PASS: isolated Next.js dev app connected to local Supabase");

  const email = "m2-app-qa-" + randomUUID() + "@example.test";
  const password = "LocalSecure-2026!" + randomUUID().slice(0,7);
  const created = ensure(await admin.auth.admin.createUser({email,password,email_confirm:true}),"CREATE_USER");
  userId = created.user.id;
  workspaceId = randomUUID();
  ensure(await admin.from("workspaces").insert({id:workspaceId,name:"Local App QA " + key}),"CREATE_WS");
  ensure(await admin.from("workspace_members").insert({workspace_id:workspaceId,user_id:userId,role:"owner"}),"CREATE_MEMBER");
  const signin = await app("/api/auth/sign-in",{
    method:"POST", headers:{"content-type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({email,password}).toString(),
  });
  const signinLocation = new URL(signin.headers.get("location") || "/", base);
  requireOk(signin.status===303 && signinLocation.pathname==="/calls", "NEXT_SIGN_IN_FAILED_"+signin.status+":"+signinLocation.pathname+signinLocation.search);
  console.log("PASS: actual Next.js sign-in route sets /calls redirect");
  const callsPage = await app("/calls");
  requireOk(callsPage.status===200,"PROTECTED_CALLS_PAGE_FAILED_"+callsPage.status);
  const pageHtml = await callsPage.text();
  requireOk(pageHtml.includes("Add a synthetic call"),"UPLOAD_FORM_NOT_RENDERED");
  console.log("PASS: protected Calls UI served for locally authorized identity");

  intentId = randomUUID();
  const intentResponse = await json(await app("/api/calls/upload-intents",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({
      brand:"abc",filename:"local-synthetic-qa.mp3",contentType:"audio/mpeg",
      fileSize:bytes.length,idempotencyKey:randomUUID(),
    }),
  }),"CREATE_INTENT",201);
  intentId = intentResponse.intentId;
  requireOk(typeof intentId === "string","INTENT_MISSING");
  const prep = await json(await app("/api/calls/upload-intents/" + intentId + "/prepare",{method:"POST"}),"PREPARE_UPLOAD");
  requireOk(prep.status==="ready","PREPARE_NOT_READY");
  objectPath = prep.objectPath;
  requireOk(objectPath?.startsWith(workspaceId+"/"),"CROSS_WORKSPACE_PATH");
  console.log("PASS: Next.js authenticated upload intent and lease");

  ensure(await browserUser.auth.signInWithPassword({email,password}),"SDK_SESSION_FOR_DIRECT_UPLOAD");
  ensure(await browserUser.storage.from("pestlaunch-call-audio").upload(
    objectPath,bytes,{contentType:"audio/mpeg",upsert:false}
  ),"STORAGE_DIRECT_UPLOAD");
  console.log("PASS: direct authenticated Storage upload");
  const finalized = await json(await app("/api/calls/upload-intents/"+intentId+"/finalize",{method:"POST"}),"APP_FINALIZE");
  callId = finalized.callId;
  requireOk(typeof callId === "string","CALL_ID_MISSING");
  const finalAgain = await json(await app("/api/calls/upload-intents/"+intentId+"/finalize",{method:"POST"}),"APP_FINALIZE_AGAIN");
  requireOk(finalAgain.callId===callId,"DUPLICATE_FINALIZATION");
  const jobs = ensure(await admin.from("analysis_jobs").select("id,status,processor_kind").eq("call_id",callId),"JOB_READ");
  requireOk(jobs.length===1 && jobs[0].status==="queued" && jobs[0].processor_kind==="pending_m3","DURABLE_JOB_NOT_QUEUED");
  const after = await app("/calls");
  const html = await after.text();
  requireOk(after.status===200 && html.includes("local-synthetic-qa.mp3") && html.includes("Queued for M3"),"CALL_NOT_VISIBLE");
  console.log("PASS: Next.js finalization idempotent, durable queued job and Calls UI listing");

  const signout = await app("/api/auth/sign-out",{method:"POST"});
  requireOk(signout.status===303,"NEXT_SIGN_OUT_FAILED");
  const afterSignout = await app("/calls");
  requireOk([302,303,307,308].includes(afterSignout.status),"PROTECTED_ROUTE_NOT_REDIRECTING");
  console.log("PASS: sign-out and protected route redirect");
  console.log("PASS: LOCAL_M2_APP_HTTP_END_TO_END");
} catch (e) {
  console.error("FAIL:",String(e?.message??e).slice(0,300));
  process.exitCode=1;
} finally {
  await finish();
  console.log("Local app test fixtures and spawned Next.js server cleanup attempted.");
}
