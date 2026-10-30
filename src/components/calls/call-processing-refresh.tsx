"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { hasActiveM3Call } from "@/lib/calls/status";

const REFRESH_INTERVAL_MS = 3_000;
const MAX_REFRESHES = 20;

export function CallProcessingRefresh({ statuses }: { statuses: readonly string[] }) {
  const router = useRouter();
  const active = hasActiveM3Call(statuses);

  useEffect(() => {
    if (!active) return;
    let refreshes = 0;
    const timer = window.setInterval(() => {
      refreshes += 1;
      router.refresh();
      if (refreshes >= MAX_REFRESHES) window.clearInterval(timer);
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, router]);

  if (!active) return null;
  return <p className="sr-only" aria-live="polite">This page refreshes while M3 processing is queued or active.</p>;
}
