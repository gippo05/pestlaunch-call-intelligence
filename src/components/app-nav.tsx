"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClipboardCheck, Headphones } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { href: "/calls", label: "Calls", icon: Headphones },
  { href: "/scorecards", label: "Scorecards", icon: ClipboardCheck },
];

export function AppNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Main navigation" className="space-y-1">
      {items.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700",
              active ? "bg-amber-100 text-amber-950" : "text-muted hover:bg-stone-100 hover:text-ink",
            )}
            href={href}
            key={href}
          >
            <Icon aria-hidden="true" className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
