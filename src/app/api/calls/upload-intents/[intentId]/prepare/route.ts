import { NextResponse, type NextRequest } from "next/server";
import {
  createUploadRequestContext,
  isSameOriginRequest,
  isUploadIntentId,
  uploadErrorResponse,
} from "@/lib/calls/upload-http";

type RouteContext = { params: Promise<{ intentId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "REQUEST_ORIGIN_REJECTED" }, { status: 403 });
  }
  const { intentId } = await context.params;
  if (!isUploadIntentId(intentId)) {
    return NextResponse.json({ error: "INTENT_NOT_FOUND" }, { status: 404 });
  }

  try {
    const { actor, service } = await createUploadRequestContext();
    if (!actor || !service) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
    const result = await service.prepareUpload(actor, intentId);
    return NextResponse.json(result);
  } catch (error) {
    return uploadErrorResponse(error);
  }
}
