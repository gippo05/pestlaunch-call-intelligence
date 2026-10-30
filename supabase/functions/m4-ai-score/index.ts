import { withSupabase } from "npm:@supabase/server@1";

// M4 runs independently from M3 and never writes to call_scores or reviewer worksheets.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL = Deno.env.get("M4_GEMINI_MODEL") || Deno.env.get("M3_GEMINI_MODEL") || "";
const API_KEY = Deno.env.get("M3_GEMINI_API_KEY") || "";

type Row = Record<string, unknown>;
type RubricCriterion = { id: string; label: string; order: number; applicability: string };
type Status = "met" | "missed" | "insufficient_evidence";
type Assessment = {
  id: string;
  label: string;
  order: number;
  status: Status;
  pointsEarned: number | null;
  pointsPossible: 1;
  quote: string | null;
  rationale: string;
  evidenceSource: "model_speaker_unverified" | "none";
};
function object(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}
function text(value: unknown, max=1000): string {
  return typeof value === "string" ? value.trim().slice(0,max) : "";
}
function validSegmentQuote(transcript: string, quote: string, segments: unknown): boolean {
  if (!quote || quote.length < 8 || !Array.isArray(segments)) return false;
  return segments.some((entry) => {
    const seg = object(entry);
    if (!seg || seg.speaker !== "agent" || !Number.isSafeInteger(seg.start) ||
        !Number.isSafeInteger(seg.end)) return false;
    const start = seg.start as number;
    const end = seg.end as number;
    return start >= 0 && end > start && end <= transcript.length &&
      transcript.slice(start,end).includes(quote);
  });
}
async function scoreWithGemini(
  transcript: string,
  rubric: RubricCriterion[],
  segments: unknown,
  brand: string,
  category: string,
): Promise<Row> {
  if (!MODEL || !API_KEY) throw new Error("PROVIDER_NOT_CONFIGURED");
  const criteria = rubric.map((c) => ({ id:c.id, label:c.label, applicability:c.applicability }));
  const instructions = [
    "Assess the following call transcript against each named employee-handling criterion.",
    "The transcript is model-generated, with provisional, unverified speaker attribution.",
    "Return one JSON object with criteria array of exactly the supplied ids.",
    "Each criterion must contain {id,status,quote,rationale}.",
    "status is met, missed, or insufficient_evidence.",
    "met: a specific agent utterance explicitly demonstrates the criterion; quote must be an exact substring of an agent utterance.",
    "missed: an agent explicitly demonstrates contrary behavior; do NOT mark missed merely because a step is absent.",
    "insufficient_evidence: any ambiguity, missing behavior, inaudible content, uncertain speaker, or incomplete call.",
    "Never invent evidence, conversation, actions, prices, bookings, or customer consent.",
    "A short clip may contain only fragments; lack of evidence is not evidence of failure.",
    "For unsupported items return status insufficient_evidence, quote empty, rationale brief.",
    "For met/missed quote the exact unmodified transcript text (no speaker prefix unless spoken).",
    "Do not treat a caller's words as an employee's actions.",
    "Criteria: " + JSON.stringify(criteria),
    "Brand: " + brand + ", category: " + category,
    "Transcript:\n" + transcript,
  ].join("\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100_000);
  let payload: Row;
  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(MODEL) + ":generateContent?key=" + encodeURIComponent(API_KEY),
      { method:"POST", signal:controller.signal,
        headers:{"content-type":"application/json"},
        body:JSON.stringify({
          contents:[{ role:"user",parts:[{text:instructions}] }],
          generationConfig:{ responseMimeType:"application/json", maxOutputTokens:8192, temperature:0 },
        }),
      },
    );
    if (!res.ok) throw new Error(res.status === 429 ? "PROVIDER_QUOTA" : "PROVIDER_FAILURE");
    payload = (await res.json()) as Row;
  } finally {
    clearTimeout(timer);
  }
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length !== 1) throw new Error("INVALID_PROVIDER_RESPONSE");
  const candidate = object(candidates[0]);
  if (candidate?.finishReason !== "STOP") throw new Error("INCOMPLETE_PROVIDER_RESPONSE");
  const parts = object(candidate.content)?.parts;
  if (!Array.isArray(parts)) throw new Error("INVALID_PROVIDER_RESPONSE");
  const raw = parts.map((p) => object(p)?.text).filter((s) => typeof s === "string").join("");
  if (!raw || raw.length > 100_000) throw new Error("INVALID_PROVIDER_RESPONSE");
  let parsed: unknown;
  try { parsed=JSON.parse(raw); } catch { throw new Error("INVALID_PROVIDER_RESPONSE"); }
  const predicted = object(parsed)?.criteria;
  if (!Array.isArray(predicted) || predicted.length !== rubric.length) throw new Error("INVALID_PROVIDER_RESPONSE");
  const predictions = new Map<string,Row>();
  for(const item of predicted) {
    const p=object(item);
    if (!p || typeof p.id !== "string" || predictions.has(p.id)) throw new Error("INVALID_PROVIDER_RESPONSE");
    predictions.set(p.id,p);
  }
  if (predictions.size !== rubric.length || rubric.some(c=>!predictions.has(c.id)))
    throw new Error("INVALID_PROVIDER_RESPONSE");
  const decisions:Assessment[] = rubric.map((criterion)=>{
    const pred=predictions.get(criterion.id)!;
    const q=text(pred.quote, 500);
    const rationale=text(pred.rationale, 500) || "Insufficient verified evidence to assign a point.";
    const status=pred.status;
    // Never award / deduct provisional points from an ungrounded passage.
    const grounded = validSegmentQuote(transcript,q,segments);
    const accepted:Status =
      (status === "met" || status === "missed") && grounded
      ? status : "insufficient_evidence";
    return {
      id:criterion.id,label:criterion.label,order:criterion.order,
      status:accepted,
      pointsEarned:accepted === "met" ? 1 : accepted === "missed" ? 0 : null,
      pointsPossible:1,
      quote:accepted === "insufficient_evidence" ? null : q,
      rationale:accepted === "insufficient_evidence" && status !== "insufficient_evidence"
        ? "AI evidence could not be verified against an agent-labeled transcript span." : rationale,
      evidenceSource:accepted === "insufficient_evidence" ? "none" : "model_speaker_unverified",
    };
  });
  const provisionalPoints=decisions.reduce((total,d)=>total+(d.pointsEarned??0),0);
  const assessedCriteria=decisions.filter(d=>d.pointsEarned!==null).length;
  return {
    schemaVersion:"m4.ai-provisional.v1",
    scoringEngine:"gemini-with-deterministic-transcript-span-validation",
    model:MODEL,
    provisionalPoints,
    maxPoints:rubric.length,
    assessedCriteria,
    insufficientCriteria:rubric.length-assessedCriteria,
    totalPoints:null,grade:null,reviewRequired:true,calibrationPending:true,
    scoreDisclaimer:"AI-estimated provisional points only. Speaker attribution, criterion judgments and rubric calibration are unverified; not an official employee grade.",
    criteria:decisions,
  };
}
async function process(admin: any, analysisId: string, transcript: string,
  rubric: RubricCriterion[], segments: unknown, brand: string, category: string) {
  try {
    const calculation=await scoreWithGemini(transcript,rubric,segments,brand,category);
    const {error}=await admin.from("m4_ai_assessments")
      .update({status:"completed",calculation,error_code:null,updated_at:new Date().toISOString()})
      .eq("analysis_id",analysisId).eq("status","processing");
    if(error) throw new Error("PERSISTENCE_FAILED");
    console.info(JSON.stringify({component:"m4-ai-score",event:"completed",analysis_id:analysisId,
      assessed:calculation.assessedCriteria}));
  } catch(error) {
    const code=error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message.slice(0,48) : "SCORING_FAILED";
    await admin.from("m4_ai_assessments")
      .update({status:"failed",error_code:code,updated_at:new Date().toISOString()})
      .eq("analysis_id",analysisId).eq("status","processing");
    console.error(JSON.stringify({component:"m4-ai-score",event:"failed",analysis_id:analysisId,error_code:code}));
  }
}
export default {
  fetch: withSupabase({auth:"secret"}, async (request,context)=>{
    if(request.method!=="POST") return Response.json({error:"method_not_allowed"},{status:405});
    let input:unknown;
    try {input=await request.json();} catch {return Response.json({error:"invalid_payload"},{status:400});}
    const analysisId=object(input)?.analysis_id;
    if(typeof analysisId!=="string"||!UUID.test(analysisId))
      return Response.json({error:"invalid_analysis_id"},{status:400});
    const admin=context.supabaseAdmin;
    const {data:analysis,error:analysisError}=await admin.from("call_analyses")
      .select("id,call_id,transcript,review_status,quality_indicators")
      .eq("id",analysisId).maybeSingle();
    if(analysisError||!analysis||analysis.review_status!=="review_required"||
       typeof analysis.transcript!=="string"||!analysis.transcript.trim())
      return Response.json({error:"analysis_not_ready"},{status:422});
    const {data:call}=await admin.from("calls").select("id,workspace_id,brand,call_type,status")
      .eq("id",analysis.call_id).maybeSingle();
    if(!call||call.status!=="review_required"||
      !["sales","general_office","retention"].includes(call.call_type) ||
      !["abc","noble_sales"].includes(call.brand))
      return Response.json({error:"rubric_not_available"},{status:422});
    const {data:rubricRow}=await admin.from("rubric_versions")
      .select("id,version,definition,calibration_status").eq("brand",call.brand)
      .eq("category",call.call_type).eq("is_active",true)
      .order("version",{ascending:false}).limit(1).maybeSingle();
    const definition=object(rubricRow?.definition);
    const inputCriteria=definition?.criteria;
    if(!rubricRow||!Array.isArray(inputCriteria)||inputCriteria.length<1||
      inputCriteria.length>20 || typeof definition?.max_points!=="number" ||
      definition.max_points!==inputCriteria.length)
      return Response.json({error:"rubric_not_available"},{status:422});
    const criteria:RubricCriterion[]=[];
    for(const item of inputCriteria) {
      const criterion=object(item);
      if(!criterion||typeof criterion.id!=="string" ||typeof criterion.label!=="string"
        ||typeof criterion.order!=="number"||typeof criterion.applicability!=="string")
        return Response.json({error:"invalid_rubric"},{status:422});
      criteria.push({id:criterion.id,label:criterion.label,order:criterion.order,
        applicability:criterion.applicability});
    }
    // Atomic single winner on duplicate invocations. No more Gemini quota for a completed analysis.
    const {data:claimed,error:claimError}=await admin.from("m4_ai_assessments")
      .upsert({analysis_id:analysisId,workspace_id:call.workspace_id,
        rubric_version_id:rubricRow.id,status:"processing"},
        {onConflict:"analysis_id",ignoreDuplicates:true})
      .select("analysis_id").maybeSingle();
    if(claimError) return Response.json({error:"claim_unavailable"},{status:503});
    if(!claimed) return Response.json({accepted:false,outcome:"already_exists"});
    if(!MODEL||!API_KEY) {
      await admin.from("m4_ai_assessments")
        .update({status:"failed",error_code:"PROVIDER_NOT_CONFIGURED"}).eq("analysis_id",analysisId);
      return Response.json({error:"provider_not_configured"},{status:503});
    }
    const quality=object(analysis.quality_indicators);
    const task=process(admin,analysisId,analysis.transcript,criteria,
      quality?.speaker_segments,call.brand,call.call_type);
    const runtime=(globalThis as typeof globalThis & {
      EdgeRuntime?:{waitUntil(task:Promise<unknown>):void}
    }).EdgeRuntime;
    if(!runtime) {
      await admin.from("m4_ai_assessments")
        .update({status:"failed",error_code:"BACKGROUND_UNAVAILABLE"}).eq("analysis_id",analysisId);
      return Response.json({error:"background_unavailable"},{status:503});
    }
    runtime.waitUntil(task);
    return Response.json({accepted:true,outcome:"processing"},{status:202});
  }),
};
