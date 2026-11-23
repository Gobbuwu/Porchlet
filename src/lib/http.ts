// True when the browser reached the site over HTTPS. Hosts such as Vercel and Netlify end TLS
// in front of the app and say so in X-Forwarded-Proto.
export function isHttps(headers: Headers): boolean {
  return headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}
