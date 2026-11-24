// Content-Security-Policy with a fresh nonce for every page request (ASVS 5.0.0 3.4.3 and
// 3.4.6, design doc threat model row 16, ADR 0014). Next.js reads the nonce from this header
// and puts it on its own scripts and styles.

export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); // 128 bits
  return btoa(String.fromCharCode(...bytes));
}

export function contentSecurityPolicy(nonce: string, opts: { dev: boolean; https: boolean }): string {
  const directives = [
    "default-src 'self'",
    // 'strict-dynamic' lets the nonce'd Next.js runtime load its own chunks. React needs eval
    // only in development (Next.js CSP guide).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${opts.dev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    // The browser never calls Supabase directly: auth runs in Server Actions (ADR 0014).
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  // Only over HTTPS: on plain-HTTP local runs it would send asset requests to https://.
  if (opts.https) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
