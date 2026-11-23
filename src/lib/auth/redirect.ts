// Where to go after login. Only same-site relative paths are accepted (design doc section 2,
// threat model row 17), so `?next=https://evil.example` or `//evil.example` can't send a user
// off-site.
const BASE = "http://porchlet.invalid";

export function safeNext(value: unknown, fallback = "/w"): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return fallback;
  if (value.includes("\\") || /[\u0000-\u001f]/.test(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;
  return url.pathname + url.search + url.hash;
}
