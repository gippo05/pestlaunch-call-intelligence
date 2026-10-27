import { NextResponse, type NextRequest } from "next/server";
import { validateLoginCredentials } from "@/lib/auth/credentials";
import { createSupabaseRouteClient } from "@/lib/supabase/route";

function setPrivateAuthHeaders(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
}

export async function POST(request: NextRequest) {
  const destination = new URL("/login?error=credentials", request.url);
  const response = NextResponse.redirect(destination, 303);
  setPrivateAuthHeaders(response);

  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) return response;

  try {
    const formData = await request.formData();
    const email = formData.get("email");
    const password = formData.get("password");
    const validation = validateLoginCredentials(
      typeof email === "string" ? email : "",
      typeof password === "string" ? password : "",
    );
    if (!validation.ok) return response;

    const supabase = createSupabaseRouteClient(request, response);
    const { error } = await supabase.auth.signInWithPassword(validation.credentials);
    if (!error) response.headers.set("Location", new URL("/calls", request.url).toString());
  } catch {
    // Auth failures return the same generic destination without logging submitted credentials.
  }

  return response;
}
