// Isolated local-only Storage/Auth integration certification; no hosted credentials.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const raw = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8" });
const entries = Object.fromEntries(raw.split(/\r?\n/).filter((s) => /^[A-Z_]+=/.test(s)).map((line) => {
  const equal = line.indexOf("=");
  return [line.slice(0, equal), line.slice(equal + 1).replace(/^["']|["']$/g, "")];
}));
const url = entries.API_URL;
if (url !== "http://127.0.0.1:54321" || !entries.PUBLISHABLE_KEY?.startsWith("sb_publishable_") || !entries.SECRET_KEY?.startsWith("sb_secret_")) {
  throw new Error("LOCAL_STACK_GUARD_FAILED");
}
const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
const admin = createClient(url, entries.SECRET_KEY, options);
const anon = createClient(url, entries.PUBLISHABLE_KEY, options);
const owner = createClient(url, entries.PUBLISHABLE_KEY, options);
const member = createClient(url, entries.PUBLISHABLE_KEY, options);
const outsider = createClient(url, entries.PUBLISHABLE_KEY, options);
const key = randomUUID();
const createdUsers = [];
const workspaces = [];
const intents = [];
const uploadedPaths = [];
let callId = null;
let complete = false;
const bytes = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, ...Array.from({ length: 1024 }, (_, i) => i % 255)]);
const bucket = "pestlaunch-call-audio";
const ok = (value, code) => { if (!value) throw new Error(code); };
function assertNoError(result, label) { if (result.error) throw new Error(label + ":" + (result.error.code ?? result.error.message)); return result.data; }
async function addUser(role) {
  const email = "m2-local-" + role + "-" + randomUUID() + "@example.test";
  const password = "SecureLocalOnly-2026!" + randomUUID().slice(0, 8);
  const response = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const user = assertNoError(response, "CREATE_USER_" + role).user;
  createdUsers.push(user.id);
  return { id: user.id, email, password };
}
async function signIn(client, person, role) {
  const result = await client.auth.signInWithPassword({ email: person.email, password: person.password });
  assertNoError(result, "SIGN_IN_" + role);
  ok(result.data?.session?.access_token, "MISSING_JWT_" + role);
}
async function addWorkspace(name) {
  const id = randomUUID();
  assertNoError(await admin.from("workspaces").insert({ id, name }), "CREATE_WORKSPACE");
  workspaces.push(id);
  return id;
}
async function uploadAttempt(client, path) {
  return client.storage.from(bucket).upload(path, bytes, { contentType: "audio/mpeg", upsert: false });
}
async function createIntent(userId, workspaceId, intentId, expired = false) {
  const path = workspaceId + "/" + intentId + ".mp3";
  assertNoError(await admin.from("upload_intents").insert({
    id: intentId, workspace_id: workspaceId, user_id: userId,
    idempotency_key: randomUUID(), brand: "abc", original_filename: "local-synthetic-test.mp3",
    mime_type: "audio/mpeg", expected_size: bytes.length, object_path: path,
    status: "issued", expires_at: new Date(Date.now() + (expired ? -60_000 : 60 * 60_000)).toISOString(),
  }), "CREATE_INTENT");
  intents.push(intentId);
  return path;
}
async function checkReject(label, promise) {
  const result = await promise;
  if (!result.error) {
    throw new Error(label + "_UNEXPECTEDLY_AUTHORIZED");
  }
  console.log("PASS:", label, "denied");
}
try {
  const signupEmail = "m2-local-signup-denied-" + randomUUID() + "@example.test";
  const attemptedSignup = await anon.auth.signUp({
    email: signupEmail, password: "LocalSignupDenied-2026!" + randomUUID().slice(0, 8),
  });
  if (!attemptedSignup.error) {
    if (attemptedSignup.data?.user?.id) await admin.auth.admin.deleteUser(attemptedSignup.data.user.id);
    throw new Error("LOCAL_PUBLIC_SIGNUP_UNEXPECTEDLY_ALLOWED");
  }
  console.log("PASS: local public signup remains disabled");
  const a = await addUser("owner");
  const b = await addUser("member");
  const c = await addUser("outsider");
  const workspaceA = await addWorkspace("LOCAL M2 QA A " + key);
  const workspaceB = await addWorkspace("LOCAL M2 QA B " + key);
  assertNoError(await admin.from("workspace_members").insert([
    { workspace_id: workspaceA, user_id: a.id, role: "owner" },
    { workspace_id: workspaceA, user_id: b.id, role: "member" },
    { workspace_id: workspaceB, user_id: c.id, role: "owner" },
  ]), "CREATE_MEMBERSHIPS");
  await Promise.all([signIn(owner, a, "owner"), signIn(member, b, "member"), signIn(outsider, c, "outsider")]);
  console.log("PASS: three authenticated local sessions");

  const intentId = randomUUID();
  const objectPath = await createIntent(a.id, workspaceA, intentId);
  const token = assertNoError(await admin.rpc("begin_call_upload", {
    p_intent_id: intentId, p_user_id: a.id, p_lease_seconds: 600,
  }), "BEGIN_LEASE");
  ok(typeof token === "string", "LEASE_TOKEN_MISSING");

  await checkReject("anonymous Storage INSERT", uploadAttempt(anon, objectPath));
  await checkReject("same-workspace read-only member Storage INSERT", uploadAttempt(member, objectPath));
  await checkReject("cross-workspace owner Storage INSERT", uploadAttempt(outsider, objectPath));
  await checkReject("wrong object path Storage INSERT", uploadAttempt(owner, workspaceB + "/" + randomUUID() + ".mp3"));

  assertNoError(await uploadAttempt(owner, objectPath), "OWNER_STORAGE_UPLOAD");
  uploadedPaths.push(objectPath);
  console.log("PASS: owner uploaded via JWT-backed private Storage INSERT");
  await checkReject("duplicate object overwrite", uploadAttempt(owner, objectPath));
  await checkReject("anonymous private download", anon.storage.from(bucket).download(objectPath));
  await checkReject("cross-workspace private download", outsider.storage.from(bucket).download(objectPath));
  const stored = assertNoError(await admin.storage.from(bucket).download(objectPath), "ADMIN_VERIFY_DOWNLOAD");
  const storedBytes = new Uint8Array(await stored.arrayBuffer());
  ok(storedBytes.length === bytes.length && storedBytes[0] === 0x49, "STORAGE_BYTES_MISMATCH");
  console.log("PASS: private download denial and object byte verification");

  const finalized = assertNoError(await admin.rpc("finalize_call_upload", {
    p_intent_id: intentId, p_user_id: a.id, p_lease_token: token,
  }), "FINALIZE");
  ok(typeof finalized === "string", "FINALIZE_ID_MISSING");
  callId = finalized;
  const repeat = assertNoError(await admin.rpc("finalize_call_upload", {
    p_intent_id: intentId, p_user_id: a.id, p_lease_token: null,
  }), "IDEMPOTENT_FINALIZE");
  ok(repeat === finalized, "FINALIZE_NOT_IDEMPOTENT");
  const calls = assertNoError(await admin.from("calls").select("id,status,workspace_id").eq("upload_intent_id", intentId), "FETCH_CALLS");
  const jobs = assertNoError(await admin.from("analysis_jobs").select("id,status,processor_kind").eq("call_id", finalized), "FETCH_JOBS");
  ok(calls.length === 1 && calls[0].status === "queued" && calls[0].workspace_id === workspaceA, "CALL_FINALIZATION_INVARIANT");
  ok(jobs.length === 1 && jobs[0].status === "queued" && jobs[0].processor_kind === "pending_m3", "JOB_FINALIZATION_INVARIANT");
  console.log("PASS: idempotent finalization created exactly one queued call and one pending_m3 job");

  const expiredId = randomUUID();
  const expiredPath = await createIntent(a.id, workspaceA, expiredId, true);
  await checkReject("expired-intent Storage INSERT", uploadAttempt(owner, expiredPath));

  complete = true;
} catch (error) {
  console.error("FAIL:", String(error?.message ?? error).slice(0, 250));
  process.exitCode = 1;
} finally {
  // All resources are disposable in an isolated local stack. Never clean unrelated objects.
  for (const path of uploadedPaths) {
    const r = await admin.storage.from(bucket).remove([path]);
    if (r.error) console.error("CLEANUP_STORAGE_FAILED", r.error.code ?? "");
  }
  if (callId) await admin.from("calls").delete().eq("id", callId);
  for (const id of intents) await admin.from("upload_intents").delete().eq("id", id);
  for (const id of workspaces) await admin.from("workspaces").delete().eq("id", id);
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
  console.log("Local test fixture cleanup attempted.");
}
if (complete) console.log("PASS: LOCAL_AUTHENTICATED_STORAGE_INTEGRATION");
