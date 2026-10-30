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
    <nav aria-label="Main navigation" className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0">
      {items.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 md:gap-3",
              active ? "bg-blue-50 text-blue-900" : "text-muted hover:bg-stone-100 hover:text-ink",
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
