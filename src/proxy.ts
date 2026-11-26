import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { startedFromEmailedLink } from "@/lib/auth/session";
import { contentSecurityPolicy, newNonce } from "@/lib/csp";
import { isHttps } from "@/lib/http";
import {
  authCookieOptions,
  hardenCookie,
  isAuthCookie,
  passwordChangeCookieName,
  supabaseEnv,
} from "@/lib/supabase/config";

// Runs before every page and route (design doc section 2, ADR 0014):
// 1. A Content-Security-Policy with a fresh nonce.
// 2. Refreshes the Supabase session cookie when the access token has expired.
// 3. Sends signed-out visitors from protected pages to /login, and signed-in ones away from
//    /login and /signup. This is for convenience only: RLS is what protects data (ADR 0004).
// 4. Sends a session that logged in with a common or breached password (ADR 0021), or that a
//    reset link started (ADR 0023), from protected pages to /reset until the password is changed.
//    This gates pages only: Server Actions can be posted to any path, so an action that works on
//    users' data must not rely on it (RLS decides what a session can read or change).

const PROTECTED = ["/w", "/settings", "/invite"];
const SIGNED_OUT_ONLY = ["/login", "/signup"];

const under = (path: string, prefixes: string[]) =>
  prefixes.some((p) => path === p || path.startsWith(`${p}/`));

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const https = isHttps(request.headers, request.nextUrl);
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === "development", https });

  // Cookies and cache headers the Supabase client asks us to set (token refresh or sign-out).
  let pendingCookies: { name: string; value: string; options: CookieOptions }[] = [];
  let pendingHeaders: Record<string, string> = {};
  let signedIn = false;
  let sessionId = "";
  let emailedLinkSession = false;

  // Visitors without a session cookie have no session to refresh, so they cost no auth call.
  const hasSession = request.cookies.getAll().some((c) => isAuthCookie(c.name));
  if (hasSession || under(path, PROTECTED)) {
    const { url, key } = supabaseEnv();
    const supabase = createServerClient(url, key, {
      cookieOptions: authCookieOptions(https),
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet, headers) {
          // Update the request too, so this render sees the refreshed session.
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          pendingCookies = cookiesToSet;
          pendingHeaders = headers;
        },
      },
    });
    // getClaims() checks the JWT signature (against Supabase Auth's keys), unlike getSession().
    const { data } = await supabase.auth.getClaims();
    signedIn = !!data?.claims?.sub;
    sessionId = typeof data?.claims?.session_id === "string" ? data.claims.session_id : "";
    emailedLinkSession = startedFromEmailedLink(data?.claims?.amr);
  }

  let response: NextResponse;
  if (!signedIn && under(path, PROTECTED)) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", path + request.nextUrl.search);
    response = NextResponse.redirect(login);
  } else if (
    signedIn &&
    under(path, PROTECTED) &&
    !!sessionId &&
    request.cookies.get(passwordChangeCookieName(https))?.value === sessionId
  ) {
    // A reset link's session is flagged until it saves a new password (ADR 0023); it didn't log in
    // with a password, so the login check's text would be wrong for it.
    const reason = emailedLinkSession ? "new-password-required" : "password-change-required";
    response = NextResponse.redirect(new URL(`/reset?error=${reason}`, request.url));
  } else if (signedIn && under(path, SIGNED_OUT_ONLY)) {
    response = NextResponse.redirect(new URL("/w", request.url));
  } else {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("content-security-policy", csp);
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  response.headers.set("content-security-policy", csp);
  for (const { name, value, options } of pendingCookies) {
    response.cookies.set(name, value, hardenCookie(options, https));
  }
  for (const [name, value] of Object.entries(pendingHeaders)) response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: [
    // Everything except build assets and the favicon (Next.js CSP guide), each matched exactly so
    // that look-alike paths such as /favicon.icox still run the proxy. Link prefetches are
    // included: they can carry a refreshed cookie.
    "/((?!_next/static/|_next/image$|favicon\\.ico$).*)",
    // Server Actions can be posted to any path, the skipped ones too. Run the proxy for every
    // action so that each one reaches the app through the same hosts (ADR 0029: on Netlify the
    // visitor IP is counted from the proxy's own hop).
    { source: "/:path*", has: [{ type: "header", key: "next-action" }] },
  ],
};
