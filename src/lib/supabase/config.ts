import type { CookieOptions, CookieOptionsWithName } from "@supabase/ssr";

// Supabase settings read at request time, so `next build` works without them.
// Both values are public by design (ADR 0004): RLS protects the data, not the key.
export function supabaseEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set (see .env.example)",
    );
  }
  return { url, key };
}

// The session cookie's name. Over HTTPS it carries the __Host- prefix (ASVS 5.0.0 3.3.1 and
// 3.3.3), which browsers accept only with Secure, Path=/ and no Domain. Plain-HTTP local runs
// can't set prefixed cookies, so they use the bare name. @supabase/ssr adds ".0", ".1"... when
// it splits a large session, and "-code-verifier" for its PKCE cookie.
const AUTH_COOKIE = "porchlet-auth";

export function authCookieOptions(secure: boolean): CookieOptionsWithName {
  return { name: secure ? `__Host-${AUTH_COOKIE}` : AUTH_COOKIE };
}

// Set at login when the password the user signed in with is common or breached (ADR 0021). While
// it is present, the proxy sends app pages to /reset; a password change or logout removes it.
// It holds no secret: removing it by hand only skips the prompt for the user's own account.
const PASSWORD_CHANGE_COOKIE = "porchlet-password-change";

export function passwordChangeCookieName(secure: boolean): string {
  return secure ? `__Host-${PASSWORD_CHANGE_COOKIE}` : PASSWORD_CHANGE_COOKIE;
}

export function isAuthCookie(name: string): boolean {
  return name.startsWith(AUTH_COOKIE) || name.startsWith(`__Host-${AUTH_COOKIE}`);
}

// Porchlet talks to Supabase Auth from the server only (ADR 0014), so no browser script ever
// needs to read the session cookie. @supabase/ssr defaults to httpOnly: false and no Secure flag
// (dist/main/utils/constants.js), so every auth cookie is rewritten here: HttpOnly always,
// SameSite=Lax, Path=/, no Domain, and Secure whenever the site is served over HTTPS.
export function hardenCookie(options: CookieOptions, secure: boolean): CookieOptions {
  return { ...options, httpOnly: true, sameSite: "lax", path: "/", domain: undefined, secure };
}
