import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Porchlet",
  description: "A self-hosted client portal for freelancers",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
