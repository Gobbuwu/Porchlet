// True when the browser reached the site over HTTPS. Hosts end TLS in front of the app and say so
// in X-Forwarded-Proto (Vercel; Netlify's functions, which run Server Actions and pages). The test
// is Next.js's own (`includes('https')`, next/dist/server/next-server.js attachRequestMeta), which is
// how `next start` decides the scheme of the proxy's request URL, so both always agree. Netlify
// runs src/proxy.ts as an edge function without that header, but with the https:// URL the browser
// used (measured, ADR 0028), so the proxy also passes its request URL. The session cookie's name
// depends on this answer (src/lib/supabase/config.ts), so the proxy and the Server Actions must
// agree on it.
export function isHttps(headers: Headers, url?: URL): boolean {
  return headers.get("x-forwarded-proto")?.includes("https") === true || url?.protocol === "https:";
}
