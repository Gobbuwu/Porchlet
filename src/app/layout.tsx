import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "Porchlet",
  description: "A self-hosted client portal for freelancers",
};

// Every page renders per request so Next.js can put the proxy's CSP nonce on its scripts.
// A prerendered shell has no nonce, and its scripts would be blocked (measured: 0 of 14
// scripts carried a nonce with Cache Components' static shell). `instant = false` allows the
// whole route to wait for the request; see ADR 0014.
export const instant = false;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
