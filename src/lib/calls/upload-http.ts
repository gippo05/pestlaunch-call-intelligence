import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseUploadRepository } from "@/lib/calls/supabase-upload-repository";
import { createM2UploadService, UploadServiceError, type UploadActor } from "@/lib/calls/upload-service";
import { authorizeAndDispatchM3, type M3AutoProcessingDiagnostic } from "@/lib/calls/m3-auto-processing";

const intentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function createUploadRequestContext() {
  const userClient = await createSupabaseServerClient();
  const { data, error } = await userClient.auth.getClaims();
  const subject = data?.claims?.sub;
  const actor: UploadActor | null =
    !error && typeof subject === "string" && subject.length > 0 ? { userId: subject } : null;
  if (!actor) return { actor: null, service: null };

  const adminClient = createSupabaseAdminClient();
  const repository = createSupabaseUploadRepository(userClient, adminClient);
  const onM3Diagnostic = (event: M3AutoProcessingDiagnostic) => {
    console.warn(JSON.stringify({ component: "m3-auto-processing", ...event }));
  };
  const service = createM2UploadService(repository, undefined, undefined, {
    onM3Diagnostic,
    afterVerifiedUpload: (callId, bytes) => authorizeAndDispatchM3(callId, bytes, {
      config: {
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
        publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY,
        workerSecret: process.env.M3_WORKER_AUTH_SECRET,
        processingEnabled: process.env.M3_PROCESSING_ENABLED === "true",
        syntheticOnly: process.env.M3_SYNTHETIC_ONLY === "true",
        generalPrivateEnabled: process.env.M3_GENERAL_PRIVATE_ENABLED === "true",
        hostedSyntheticEnabled: process.env.M3_HOSTED_SYNTHETIC_DISPATCH_ENABLED === "true",
      },
      authorize: process.env.M3_GENERAL_PRIVATE_ENABLED === "true" &&
        process.env.M3_SYNTHETIC_ONLY !== "true" && repository.authorizeM3PrivateCall
        ? repository.authorizeM3PrivateCall
        : repository.authorizeM3DemoCall,
      onDiagnostic: onM3Diagnostic,
    }),
  });
  return { actor, service };
}

export function isSameOriginRequest(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === request.nextUrl.origin;
  } catch {
    return false;
  }
}

export function isUploadIntentId(value: string) {
  return intentIdPattern.test(value);
}

export function uploadErrorResponse(error: unknown) {
  if (error instanceof UploadServiceError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof Error && error.message === "Supabase server configuration is invalid.") {
    return NextResponse.json({ error: "SERVER_CONFIG_UNAVAILABLE" }, { status: 503 });
  }
  return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
}

export async function readBoundedIntentJson(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new UploadServiceError("INVALID_REQUEST", 400);

  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > 4_096) {
    throw new UploadServiceError("INVALID_REQUEST", 413);
  }
  if (!request.body) throw new UploadServiceError("INVALID_REQUEST", 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > 4_096) {
        await reader.cancel();
        throw new UploadServiceError("INVALID_REQUEST", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new UploadServiceError("INVALID_REQUEST", 400);
  }
}
