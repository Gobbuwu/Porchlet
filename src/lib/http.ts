// True when the browser reached the site over HTTPS (ADR 0029). Hosts end TLS in front of the app
// and say so in X-Forwarded-Proto (Vercel; Netlify's functions, which run Server Actions and pages).
// The header test is Next.js's own (`includes('https')`, next/dist/server/next-server.js
// attachRequestMeta), which is how `next start` decides the scheme of the proxy's request URL.
// Netlify runs src/proxy.ts as an edge function without that header, but with the https:// URL the
// browser used (measured), so the proxy passes its URL, which counts only when the header is
// missing: the Server Actions see the same header, so both always decide the same way. The session
// cookie's name depends on this answer (src/lib/supabase/config.ts).
export function isHttps(headers: Headers, url?: URL): boolean {
  const proto = headers.get("x-forwarded-proto");
  if (proto !== null) return proto.includes("https");
  return url?.protocol === "https:";
}
