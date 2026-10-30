import { NextRequest, NextResponse } from "next/server";
import { createSupabaseRouteClient } from "@/lib/supabase/route";
import { DEFAULT_RUBRIC_REGISTRY } from "@/lib/scoring/rubrics";
import { parseWorksheetInput, summarizeReviewWorksheet } from "@/lib/scoring/review-worksheet";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  if (!request.headers.get("content-type")?.includes("application/json") ||
      Number(request.headers.get("content-length") ?? 0) > 32768) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  const { callId } = await params;
  if (!UUID.test(callId)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const response = NextResponse.json({ ok: true });
  const db = createSupabaseRouteClient(request, response);
  const { data: { user }, error: userError } = await db.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: call } = await db.from("calls").select("id,workspace_id,brand,call_type")
    .eq("id", callId).maybeSingle();
  if (!call) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { data: membership } = await db.from("workspace_members").select("role")
    .eq("workspace_id", call.workspace_id).eq("user_id", user.id).maybeSingle();
  if (membership?.role !== "owner" && membership?.role !== "reviewer") {
    return NextResponse.json({ error: "reviewer_required" }, { status: 403 });
  }

  const key = `${call.brand}.${call.call_type}` as keyof typeof DEFAULT_RUBRIC_REGISTRY;
  const rubric = DEFAULT_RUBRIC_REGISTRY[key];
  if (!rubric) return NextResponse.json({ error: "rubric_unavailable" }, { status: 422 });

  const [{ data: analysis }, { data: rubricRow }] = await Promise.all([
    db.from("call_analyses").select("id,transcript,version").eq("call_id", callId)
      .order("version", { ascending: false }).limit(1).maybeSingle(),
    db.from("rubric_versions").select("id,version,calibration_status")
      .eq("brand", rubric.brand).eq("category", rubric.category)
      .eq("version", rubric.version).eq("is_active", true).maybeSingle(),
  ]);
  if (!analysis?.transcript || !rubricRow || rubricRow.version !== rubric.version) {
    return NextResponse.json({ error: "review_source_unavailable" }, { status: 422 });
  }

  let validated;
  try {
    const raw = await request.json();
    validated = parseWorksheetInput(raw, rubric, analysis.transcript);
  } catch (error) {
    return NextResponse.json({
      error: "invalid_review",
      message: error instanceof Error ? error.message : "Invalid assessment.",
    }, { status: 422 });
  }

  // RLS independently verifies workspace ownership and owner/reviewer role.
  // This stores an explicitly provisional worksheet, never an official call_scores row.
  const { error: writeError } = await db.from("m4_review_worksheets").upsert({
    analysis_id: analysis.id,
    rubric_version_id: rubricRow.id,
    reviewer_id: user.id,
    observations: validated.observations,
    whole_call_reviewed: validated.wholeCallReviewed,
    objection_state: validated.objectionState,
  }, { onConflict: "analysis_id" });
  if (writeError) {
    return NextResponse.json({ error: "review_save_failed" }, { status: 409 });
  }
  return NextResponse.json({
    ok: true,
    summary: summarizeReviewWorksheet(validated, rubric),
    official: false,
    calibration: rubricRow.calibration_status,
  }, { headers: response.headers });
}
