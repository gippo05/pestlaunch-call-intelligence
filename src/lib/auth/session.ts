import "server-only";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AuthenticatedIdentity = {
  id: string;
  email: string | null;
};

export async function requireUser(): Promise<AuthenticatedIdentity> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  const subject = claims?.sub;

  if (error || !claims || typeof subject !== "string" || subject.length === 0) {
    redirect("/login");
  }

  const { data: memberships, error: membershipError } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .limit(1);

  if (membershipError || memberships.length === 0) {
    redirect("/login?error=workspace");
  }

  const email = claims.email;
  return {
    id: subject,
    email: typeof email === "string" ? email : null,
  };
}
