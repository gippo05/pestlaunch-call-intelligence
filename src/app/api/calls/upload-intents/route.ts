import { NextResponse, type NextRequest } from "next/server";
import {
  createUploadRequestContext,
  isSameOriginRequest,
  readBoundedIntentJson,
  uploadErrorResponse,
} from "@/lib/calls/upload-http";

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "REQUEST_ORIGIN_REJECTED" }, { status: 403 });
  }
  try {
    const { actor, service } = await createUploadRequestContext();
    if (!actor || !service) return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

    const input = await readBoundedIntentJson(request);
    const result = await service.createIntent(actor, input);
    return NextResponse.json(result, { status: result.reused ? 200 : 201 });
  } catch (error) {
    return uploadErrorResponse(error);
  }
}
