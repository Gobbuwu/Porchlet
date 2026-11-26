# 0014. Auth runs on the server, with HttpOnly session cookies and a nonce CSP

- Status: Accepted (PR 10 merged 2026-11-24 as f1cd5b5)

## Context

M1 builds sign-up, login, logout and password reset (design doc sections 1, 2 and 8) with `@supabase/ssr`. Two ways to use it:

1. **Browser client.** Pages call Supabase Auth from the browser. `@supabase/ssr` keeps the session in cookies that its browser client reads and writes with `document.cookie`, so they can't be `HttpOnly` (its defaults are `httpOnly: false`, no `Secure`: `node_modules/@supabase/ssr/dist/main/utils/constants.js`, 0.12.7).
2. **Server only.** Forms post to Next.js Server Actions, which call Supabase Auth with the user's cookies; no browser script ever touches the session.

OWASP ASVS 5.0.0 (ADR 0011), chapter V3 ([source](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x12-V3-Web-Frontend-Security.md)):

- 3.3.1 (L1): "cookies have the 'Secure' attribute set, and if the '\_\_Host-' prefix is not used for the cookie name, the '\_\_Secure-' prefix must be used".
- 3.3.3 (L2): "cookies have the '\_\_Host-' prefix for the cookie name unless they are explicitly designed to be shared with other hosts".
- 3.3.4 (L2): a session token cookie "must have the 'HttpOnly' attribute set".

Option 1 fails 3.3.4 by design. Option 2 can meet all three.

The design doc also asks for a nonce-based CSP (threat model row 16). The scaffold has Cache Components on (`next.config.ts`), and the Next.js CSP guide (`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`) says nonces need dynamic rendering and that a prerendered shell can't carry them.

## Measurements (2026-11-23, Next.js 16.4.6, local `next start`, Chromium 1243)

| Setup | Scripts with the nonce on `/` |
|---|---|
| Proxy sets a nonce CSP, pages left static | 0 of 14 (the browser blocks them all) |
| Root layout renders `children` inside `<Suspense>` with `await connection()` | 0 of 14 (the static shell still has no nonce) |
| Root layout `await connection()` outside Suspense | Build fails: "uncached or runtime data during prerendering ... Set `export const instant = false` to allow a blocking route" |
| Same plus `export const instant = false` in the root layout | 10 of 10, also on the 404 page |

Supabase Auth's own limits, measured against the local stack (Supabase CLI 3.1.0, GoTrue v2.197.0):

- 36 wrong-password logins and 33 sign-ups in a row from one IP: no HTTP 429, although `config.toml` sets `sign_in_sign_ups = 30` per 5 minutes. Cause, from GoTrue's source ([`internal/api/middleware.go` at v2.197.0](https://github.com/supabase/auth/blob/v2.197.0/internal/api/middleware.go)): per-IP limits apply only when `GOTRUE_RATE_LIMIT_HEADER` is set or the `Sb-Forwarded-For` header is enabled ("If no rate limit header was set, ignore rate limiting"). The CLI sets neither (not in the auth container's environment, not among the CLI's `GOTRUE_RATE_LIMIT_*` strings).
- The per-address email interval does apply locally: a second reset or confirmation email to the same address inside `max_frequency` gets HTTP 429 `over_email_send_rate_limit`.

## Decision

1. **Auth runs only in Server Actions** (`src/app/(auth)/actions.ts`). The browser never calls Supabase, so the CSP has `connect-src 'self'`. ADR 0004 still holds: requests reach Supabase with the publishable key and the user's own session, and RLS decides; the "browser talks to Supabase directly" in its title now means "the app, as the user".
2. **Session cookies are hardened** (`src/lib/supabase/config.ts`): `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`; over HTTPS also `Secure` and the name `__Host-porchlet-auth`. Plain-HTTP local runs use `porchlet-auth`, because browsers refuse `__Host-` cookies without `Secure`.
3. **`src/proxy.ts`** sets a CSP with a fresh 128-bit nonce on every page, refreshes an expired session (writing the new cookies to both the request and the response), and redirects signed-out visitors away from `/w` and `/settings`. It calls Supabase only when a session cookie is present or the page is protected. Redirects are convenience; RLS is the gate.
4. **Every page renders per request**: the root layout has `export const instant = false` and `await connection()` (measurements above). Cache Components stays on.
5. **Email links use a token hash and a button.** The confirmation and reset templates (`supabase/templates/`) link to `/auth/confirm?token_hash=...&type=...`. That page verifies nothing on GET; its button posts to a Server Action that calls `verifyOtp`. A mail scanner that opens links can't use up the token, and the link works in any browser (the PKCE `?code=` flow needs the browser that asked).
6. **429 handling.** Any Supabase Auth 429 (`over_*` codes) shows "Too many attempts, try again later." Locally the E2E test triggers a real one through `max_frequency = "60s"` (it was `1s`); the per-IP limits can only be tested on the hosted test project.
7. **Auth settings in `supabase/config.toml`**: email confirmation on, `minimum_password_length = 10` (design doc row 11), `otp_expiry = 600` (ASVS 6.5.5 caps out-of-band codes at 10 minutes), `max_frequency = "60s"`. The setup wizard (M5) must set the same values and templates on hosted projects.

## Consequences

- Without JavaScript, the forms still post to their Server Actions: login and logout work (E2E test). Their messages did not show; [ADR 0018](0018-native-form-posts-redirect-with-message.md) fixes that with a redirect.
- Next.js rejects a Server Action POST whose `Origin` doesn't match the host (measured: HTTP 500 "Invalid Server Actions request"), which covers the Origin check in threat model row 17 for these forms.
- **Unverified, to check on the hosted test project before M1 closes:** on hosted Supabase, auth requests now come from the Next.js server's IP. If hosted Auth limits per caller IP, all users of one deployment may share one sign-in budget, and one attacker could use it up. GoTrue can take the real client IP from `Sb-Forwarded-For` when that is enabled; whether hosted projects enable it, and whether a direct caller could spoof it, is not known.
- M3 uploads can't use the user's token in the browser; they need signed upload URLs created on the server with the user's session (still RLS-gated). To design in M3.
- Supabase Auth itself reveals whether an address has an account to anyone calling its API with the publishable key: a sign-up for a confirmed address answers 422 `user_already_exists`, and a second reset request inside `max_frequency` answers 429 only for real accounts. Porchlet's pages give the same answer either way, but the API is public. Recorded in docs/milestones/M1.md.
