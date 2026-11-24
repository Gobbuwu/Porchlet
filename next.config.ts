import type { NextConfig } from "next";

// Security headers sent on every response. Values and the reason for each are in
// docs/adr/0013-security-headers.md. The Content-Security-Policy is not here: src/proxy.ts sends
// a per-request nonce policy, frame-ancestors included (ADR 0014). Paths the proxy skips get
// frameOnlyCsp below instead, so every response has exactly one policy.
const securityHeaders = [
  // ASVS 5.0.0 3.4.1 (L2): at least 1 year and includeSubDomains. Two years is the OWASP
  // Secure Headers Project value. No `preload`: it is hard to undo and each self-hoster's
  // domain is their own call.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // ASVS 3.4.6: frame-ancestors (in the CSP) is the control; X-Frame-Options stays for older
  // browsers.
  { key: "X-Frame-Options", value: "DENY" },
  // ASVS 3.4.4.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // ASVS 3.4.5. Not `no-referrer`: under it browsers send `Origin: null` on same-origin
  // POSTs, which breaks Origin checks (ours and Next.js Server Actions). `same-origin` still
  // sends nothing to other sites.
  { key: "Referrer-Policy", value: "same-origin" },
  // Turns off powerful browser features the app never uses. clipboard-write stays on for
  // "Copy invite link".
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "camera=()",
      "display-capture=()",
      "geolocation=()",
      "gyroscope=()",
      "hid=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      "serial=()",
      "usb=()",
      "xr-spatial-tracking=()",
    ].join(", "),
  },
] as const;

// For the paths src/proxy.ts's matcher skips (build assets, image optimizer, favicon). They are
// not documents, so frame-ancestors is all they need. Keep in sync with the matcher.
const frameOnlyCsp = [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }] as const;
const proxySkipped = ["/_next/static/:path*", "/_next/image", "/favicon.ico"];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Drops `X-Powered-By: Next.js` (ASVS 13.4.6, L3; free to do).
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: [...securityHeaders] },
      ...proxySkipped.map((source) => ({ source, headers: [...frameOnlyCsp] })),
    ];
  },
};

export default nextConfig;
