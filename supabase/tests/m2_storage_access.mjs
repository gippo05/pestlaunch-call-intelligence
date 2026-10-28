import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const cli = process.env.SUPABASE_CLI_PATH ?? (process.platform === "win32" ? "supabase.exe" : "supabase");
const status = spawnSync(cli, ["status", "-o", "env"], {
  encoding: "utf8",
  timeout: 15_000,
  windowsHide: true,
});
if (status.error || status.status !== 0) {
  throw new Error("LOCAL_SUPABASE_UNAVAILABLE: start the local Supabase stack and apply migrations first");
}

const variables = parseEnv(status.stdout);
const supabaseUrl = variables.API_URL ?? variables.SUPABASE_URL;
const anonKey = variables.ANON_KEY ?? variables.SUPABASE_ANON_KEY;
const serviceRoleKey = variables.SERVICE_ROLE_KEY ?? variables.SUPABASE_SERVICE_ROLE_KEY;
if (!isLoopbackUrl(supabaseUrl) || !anonKey || !serviceRoleKey) {
  throw new Error("LOCAL_SUPABASE_UNAVAILABLE: status must resolve only to a local loopback endpoint");
}

const localAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const localAnon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const bucket = "pestlaunch-call-audio";
const workspaceId = randomUUID();
const outsiderWorkspaceId = randomUUID();
const intentId = randomUUID();
const objectPath = `${workspaceId}/${intentId}.mp3`;
const users = [];
let ownerClient;
let outsiderClient;

async function createSignedInUser(label) {
  const userId = randomUUID();
  const email = `m2-storage-${label}-${userId}@example.invalid`;
  const password = `${randomUUID()}-Aa9!`;
  const { data: created, error: createError } = await localAdmin.auth.admin.createUser({
    id: userId,
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) throw new Error("LOCAL_AUTH_FIXTURE_CREATE_FAILED");
  users.push(created.user.id);

  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError || !signedIn.session) throw new Error("LOCAL_AUTH_FIXTURE_SIGN_IN_FAILED");
  return { id: created.user.id, client };
}

async function assertDenied(operation, label) {
  const result = await operation();
  if (!result.error || result.data) throw new Error(`STORAGE_POLICY_FAILURE: ${label}`);
}

try {
  const owner = await createSignedInUser("owner");
  const outsider = await createSignedInUser("outsider");
  ownerClient = owner.client;
  outsiderClient = outsider.client;

  const { error: workspaceError } = await localAdmin.from("workspaces").insert({ id: workspaceId, name: "M2 local storage access fixture" });
  const { error: outsiderWorkspaceError } = await localAdmin.from("workspaces").insert({ id: outsiderWorkspaceId, name: "M2 cross-workspace fixture" });
  if (workspaceError || outsiderWorkspaceError) throw new Error("LOCAL_WORKSPACE_FIXTURE_CREATE_FAILED");
  const { error: memberError } = await localAdmin.from("workspace_members").insert([
    { workspace_id: workspaceId, user_id: owner.id, role: "reviewer" },
    { workspace_id: outsiderWorkspaceId, user_id: outsider.id, role: "reviewer" },
  ]);
  if (memberError) throw new Error("LOCAL_MEMBERSHIP_FIXTURE_CREATE_FAILED");
  const { error: intentError } = await localAdmin.from("upload_intents").insert({
    id: intentId,
    workspace_id: workspaceId,
    user_id: owner.id,
    idempotency_key: randomUUID(),
    brand: "abc",
    original_filename: "synthetic-tone.mp3",
    mime_type: "audio/mpeg",
    expected_size: (await readFixture()).byteLength,
    object_path: objectPath,
    status: "issued",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  if (intentError) throw new Error("LOCAL_UPLOAD_INTENT_FIXTURE_CREATE_FAILED");
  const { data: lease, error: leaseError } = await localAdmin.rpc("begin_call_upload", {
    p_intent_id: intentId,
    p_user_id: owner.id,
    p_lease_seconds: 600,
  });
  if (leaseError || typeof lease !== "string") throw new Error("LOCAL_UPLOAD_LEASE_FIXTURE_CREATE_FAILED");

  const fixture = new Blob([await readFixture()], { type: "audio/mpeg" });
  await assertDenied(
    () => localAnon.storage.from(bucket).upload(objectPath, fixture, { contentType: "audio/mpeg", upsert: false }),
    "anonymous upload",
  );
  await assertDenied(
    () => outsiderClient.storage.from(bucket).upload(objectPath, fixture, { contentType: "audio/mpeg", upsert: false }),
    "cross-workspace upload",
  );

  const { error: allowedError } = await ownerClient.storage.from(bucket).upload(objectPath, fixture, {
    contentType: "audio/mpeg",
    upsert: false,
  });
  if (allowedError) throw new Error("AUTHORIZED_STORAGE_INSERT_FAILED");

  for (const [label, client] of [
    ["anonymous", localAnon],
    ["owner", ownerClient],
    ["cross-workspace", outsiderClient],
  ]) {
    await assertDenied(() => client.storage.from(bucket).download(objectPath), `${label} read`);
  }

  const { data: object, error: serviceReadError } = await localAdmin.storage.from(bucket).download(objectPath);
  if (serviceReadError || !object || object.size !== fixture.size || object.type !== "audio/mpeg") {
    throw new Error("SERVICE_VERIFICATION_OF_PRIVATE_OBJECT_FAILED");
  }

  const { data: firstCallId, error: firstFinalizeError } = await localAdmin.rpc("finalize_call_upload", {
    p_intent_id: intentId,
    p_user_id: owner.id,
    p_lease_token: lease,
  });
  const { data: retryCallId, error: retryFinalizeError } = await localAdmin.rpc("finalize_call_upload", {
    p_intent_id: intentId,
    p_user_id: owner.id,
    p_lease_token: null,
  });
  if (firstFinalizeError || retryFinalizeError || !firstCallId || firstCallId !== retryCallId) {
    throw new Error("IDEMPOTENT_UPLOAD_FINALIZATION_FAILED");
  }
  const { data: callRow, error: callError } = await localAdmin.from("calls").select("id,status,upload_intent_id").eq("id", firstCallId).single();
  const { data: jobs, error: jobError } = await localAdmin.from("analysis_jobs").select("processor_kind,status").eq("call_id", firstCallId);
  if (callError || jobError || callRow?.status !== "queued" || callRow?.upload_intent_id !== intentId
    || jobs?.length !== 1 || jobs[0].processor_kind !== "pending_m3" || jobs[0].status !== "queued") {
    throw new Error("LOCAL_UPLOAD_FINALIZATION_STATE_INVALID");
  }
  console.log("PASS: local Storage INSERT allowed only for the authenticated workspace owner; anonymous and client reads denied");
} finally {
  const cleanupResults = [
    ["storage", await localAdmin.storage.from(bucket).remove([objectPath])],
    ["call", await localAdmin.from("calls").delete().eq("upload_intent_id", intentId)],
    ["intent", await localAdmin.from("upload_intents").delete().eq("id", intentId)],
    ["workspace", await localAdmin.from("workspaces").delete().eq("id", workspaceId)],
    ["outsider_workspace", await localAdmin.from("workspaces").delete().eq("id", outsiderWorkspaceId)],
  ];
  for (const userId of users) {
    cleanupResults.push(["user", await localAdmin.auth.admin.deleteUser(userId)]);
  }
  for (const [label, result] of cleanupResults) {
    if (result.error) throw new Error("LOCAL_STORAGE_FIXTURE_CLEANUP_FAILED_" + label);
  }
}

async function readFixture() {
  return readFile(fileURLToPath(new URL("./fixtures/synthetic-tone.mp3", import.meta.url)));
}

function parseEnv(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

function isLoopbackUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}
