import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseRouteClient } from "@/lib/supabase/route";

export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");

  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) return response;

  try {
    const supabase = createSupabaseRouteClient(request, response);
    await supabase.auth.signOut();
  } catch {
    // Return to sign-in without exposing auth provider details.
  }

  return response;
}
