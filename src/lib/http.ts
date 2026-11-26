// True when the browser reached the site over HTTPS. Hosts end TLS in front of the app and say so
// in X-Forwarded-Proto (Vercel; Netlify's functions, which run Server Actions and pages). Netlify
// runs src/proxy.ts as an edge function without that header, but with the https:// URL the browser
// used (measured, ADR 0028), so the proxy also passes its request URL. Both must agree: the
// session cookie's name depends on it (src/lib/supabase/config.ts).
export function isHttps(headers: Headers, url?: URL): boolean {
  return headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https" || url?.protocol === "https:";
}
