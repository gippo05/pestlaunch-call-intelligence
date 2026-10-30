import { NextRequest, NextResponse } from "next/server";
import { createSupabaseRouteClient } from "@/lib/supabase/route";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Authenticated, workspace-scoped initiation only. Gemini credentials stay in Supabase.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin)
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const { callId } = await params;
  if (!UUID.test(callId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const response = NextResponse.json({ ok: true });
  const db = createSupabaseRouteClient(request, response);
  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: call } = await db.from("calls")
    .select("id,workspace_id,brand,call_type,status").eq("id", callId).maybeSingle();
  if (!call || call.status !== "review_required")
    return NextResponse.json({ error: "not_ready" }, { status: 422 });
  const { data: membership } = await db.from("workspace_members")
    .select("role").eq("workspace_id", call.workspace_id).eq("user_id", user.id).maybeSingle();
  if (membership?.role !== "owner" && membership?.role !== "reviewer")
    return NextResponse.json({ error: "reviewer_required" }, { status: 403 });

  const { data: analysis } = await db.from("call_analyses")
    .select("id,review_status").eq("call_id", callId)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  if (!analysis || analysis.review_status !== "review_required")
    return NextResponse.json({ error: "analysis_not_ready" }, { status: 422 });

  // Idempotence is enforced by the analysis_id primary key in M4.
  const { data: existing } = await db.from("m4_ai_assessments")
    .select("status").eq("analysis_id", analysis.id).maybeSingle();
  if (existing) return NextResponse.json({ ok: true, status: existing.status }, { headers: response.headers });
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.functions.invoke("m4-ai-score", {
      body: { analysis_id: analysis.id },
    });
    if (error) return NextResponse.json({ error: "m4_dispatch_unavailable" }, { status: 503 });
    return NextResponse.json({ ok: true, status: data?.outcome ?? "processing" }, { headers: response.headers });
  } catch {
    return NextResponse.json({ error: "m4_dispatch_unavailable" }, { status: 503 });
  }
}
