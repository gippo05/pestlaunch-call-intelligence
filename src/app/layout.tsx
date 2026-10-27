import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "PestLaunch Call Intelligence", template: "%s | PestLaunch Call Intelligence" },
  description: "A private workspace for reviewing pest-service call quality.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
