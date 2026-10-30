import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { authorizeAndDispatchM3 } from "@/lib/calls/m3-auto-processing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AUDIO_BUCKET = "pestlaunch-call-audio";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validBearer(value: string | null, secret: string | undefined) {
  if (!secret || secret.length < 32 || !value?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(value.slice(7));
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Server-side synthetic-only queue recovery for the *exact* authorized PestLaunch
 * assessment deployment. Does not claim jobs directly, dispatch arbitrary
 * call IDs, reuse approvals, or invoke a second provider request by itself.
 *
 * Do not configure a hosted schedule until the paid-call and fixture policy
 * has been explicitly approved. Deploying this route alone is inert.
 */
export async function GET(request: NextRequest) {
  if (!validBearer(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (process.env.M3_PROCESSING_ENABLED !== "true" ||
      !(process.env.M3_SYNTHETIC_ONLY === "true" || process.env.M3_GENERAL_PRIVATE_ENABLED === "true")) {
    return NextResponse.json({ state: "disabled" });
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  // The pure dispatch function applies its own host, HMAC, and allowlist policy.
  const config = {
    supabaseUrl,
    publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.SUPABASE_PUBLISHABLE_KEY,
    workerSecret: process.env.M3_WORKER_AUTH_SECRET,
    processingEnabled: true,
    syntheticOnly: process.env.M3_SYNTHETIC_ONLY === "true",
    generalPrivateEnabled: process.env.M3_GENERAL_PRIVATE_ENABLED === "true",
    hostedSyntheticEnabled: process.env.M3_HOSTED_SYNTHETIC_DISPATCH_ENABLED === "true",
  };
  let approvedTarget = false;
  try {
    const url = new URL(config.supabaseUrl ?? "");
    approvedTarget = url.pathname === "/" && !url.username && !url.password &&
      !url.search && !url.hash &&
      ((url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
       (config.hostedSyntheticEnabled &&
        url.protocol === "https:" && url.hostname === "aznfcxrlpzjnssfatzxi.supabase.co"));
  } catch {
    // Unknown or malformed hosted targets remain disabled.
  }
  if (!approvedTarget) return NextResponse.json({ state: "disabled" });
  const db = createSupabaseAdminClient();
  const { data: jobs, error } = await db.from("analysis_jobs")
    .select("call_id,workspace_id,status,processor_kind,attempts,max_attempts,next_retry_at")
    .eq("processor_kind", "pending_m3")
    .in("status", ["queued", "failed"])
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) return NextResponse.json({ state: "unavailable" }, { status: 503 });

  for (const job of jobs ?? []) {
    if (!UUID.test(job.call_id) || !UUID.test(job.workspace_id) ||
        job.attempts >= job.max_attempts) continue;
    if (job.status === "failed" &&
        (!job.next_retry_at || !Number.isFinite(Date.parse(job.next_retry_at)) ||
         Date.parse(job.next_retry_at) > Date.now())) continue;
    const { data: call, error: callError } = await db.from("calls")
      .select("id,workspace_id,storage_path,mime_type")
      .eq("id", job.call_id).eq("workspace_id", job.workspace_id).maybeSingle();
    if (callError || !call ||
        call.mime_type !== "audio/mpeg" ||
        typeof call.storage_path !== "string" ||
        !call.storage_path.startsWith(job.workspace_id + "/") ||
        !call.storage_path.endsWith(".mp3")) continue;
    const { data: blob, error: downloadError } = await db.storage.from(AUDIO_BUCKET).download(call.storage_path);
    if (downloadError || !blob || blob.size > 50 * 1024 * 1024) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length === 0) continue;
    const outcome = await authorizeAndDispatchM3(call.id, bytes, {
      config,
      authorize: async (callId, audioSha256) => {
        if (callId !== job.call_id || createHash("sha256").update(bytes).digest("hex") !== audioSha256) {
          return "not_allowlisted";
        }
        const { data, error: authError } = await db.rpc(
          config.generalPrivateEnabled && !config.syntheticOnly
            ? "authorize_m3_private_upload" : "authorize_m3_synthetic_demo_call", {
          p_call_id: callId,
          p_audio_sha256: audioSha256,
        });
        if (authError || !["approved", "already_authorized", "not_allowlisted", "not_eligible"].includes(String(data))) {
          return "not_eligible";
        }
        return data as "approved" | "already_authorized" | "not_allowlisted" | "not_eligible";
      },
    });
    // At most one targeted worker dispatch per scheduled invocation.
    if (outcome === "started" || outcome === "queued") {
      return NextResponse.json({ state: "dispatched" });
    }
    if (outcome === "disabled" || outcome === "provider_not_configured") {
      return NextResponse.json({ state: outcome });
    }
  }
  return NextResponse.json({ state: "no_eligible_synthetic_jobs" });
}
