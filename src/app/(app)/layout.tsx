import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/auth/session";

export default async function PrivateAppLayout({ children }: { children: ReactNode }) {
  const identity = await requireUser();
  return <AppShell identity={identity}>{children}</AppShell>;
}
