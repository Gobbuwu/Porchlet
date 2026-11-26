# 0028. The visitor IP is the last X-Forwarded-For entry, and the proxy also reads HTTPS from its URL

- Status: Accepted (2026-11-26, full project check 1, F1). Changes how [ADR 0015](0015-own-auth-rate-limiter.md) reads the visitor IP, and how `src/proxy.ts` ([ADR 0014](0014-server-side-auth.md)) tells HTTPS from HTTP.

## Context

[ADR 0002](0002-frontend-stack-nextjs.md) promised a Netlify deploy test at the M2 check. `main` (c06fa99) was deployed to Netlify (free plan, `@netlify/plugin-nextjs` 5.16.9 as Netlify picked it) against the hosted test project on 2026-11-26. Two things that work on Vercel didn't:

1. **Login did nothing.** Supabase Auth accepted the password, but the next page sent the person back to `/login`. Server Actions run in a Netlify Function and get `X-Forwarded-Proto: https`, so they set the session cookie as `__Host-porchlet-auth` (measured: a reset request's PKCE cookies came back `__Host-`, `Secure`, `HttpOnly`). `src/proxy.ts` runs as a Netlify Edge Function, which gets no `X-Forwarded-Proto` (measured: pages' CSP lacked `upgrade-insecure-requests`, which the proxy adds only over HTTPS), so it looked for `porchlet-auth`, found no session and redirected. The adapter builds the proxy's request from the edge request's own URL (`edge-runtime/middleware.ts`, `buildNextRequest`), which is `https://`.
2. **The visitor IP.** Porchlet took the first `X-Forwarded-For` entry, trusting the host to overwrite the header as Vercel does. Netlify keeps the entries the browser sent and appends the address it saw; it also sets `x-nf-client-connection-ip` to that address, replacing any value the browser sent. Measured on a branch deploy by reading which rate-limit bucket each candidate source filled; the measurements are in the project's private security record.

Netlify's documented runtime variables for functions are only `URL`, `SITE_NAME` and `SITE_ID` ([Netlify docs](https://docs.netlify.com/build/functions/environment-variables)); `NETLIFY` is set at build time only. So the code can't reliably tell at runtime that it runs on Netlify.

## Decision

1. **The visitor IP is the last `X-Forwarded-For` entry** (`clientIp`, `src/lib/auth/rate-limit.ts`): the entry the host in front of the app added. On Vercel the header holds one entry (Vercel overwrites it), so nothing changes there. On Netlify it is the address Netlify saw. A reverse proxy that appends (nginx's `$proxy_add_x_forwarded_for`) gives the same.
2. **The proxy treats a request as HTTPS when `X-Forwarded-Proto` says so or its URL is `https://`** (`isHttps(headers, url)`, `src/lib/http.ts`). Server Actions and pages keep reading the header, which they get on both hosts. The header test is now Next.js's own (the value contains `https`, `next-server.js` `attachRequestMeta`), because under `next start` that test decides the scheme of the proxy's URL: with the old "first entry is `https`" test, a header such as `http, https` would have split the proxy and the actions again.

Options for the IP (measured on Netlify as above; Vercel by its documented overwrite and the M1 measurement in ADR 0015):

| Option | Coverage and cost |
|---|---|
| **Last `X-Forwarded-For` entry (chosen)** | Right on Vercel, Netlify and an appending reverse proxy, with no setting. Two hosts in a row that both append (for example a CDN in front of Netlify, unverified) would put the inner host's address last: every visitor shares one bucket, so one person's failures could use up the limit for everyone (a lockout, instead of the bypass the first entry gives there) |
| `x-nf-client-connection-ip` when on Netlify | Right on Netlify, but the app can't detect Netlify at runtime, so it needs a new setting each Netlify self-hoster must get right; a header any browser can send elsewhere |
| A trusted-proxy setting (how many appending hosts to skip) | Needed for chains of two or more hosts; one more setting to document and test. Not needed by either measured host, so it stays where M1.md planned it (M5, before v0.1.0) |

## Consequences

- With no host in front (a bare `next start`), every entry is the browser's, as before (ADR 0015, gaps).
- E2E "the limit follows the address the host added, not entries the browser sent" sends a changing first entry with a fixed last one and expects the per-account limit to hold.
- E2E "with X-Forwarded-Proto `http, https` the proxy and the login agree on the session cookie" covers the `next start` side. The Netlify side (an `https://` URL with no header) can't be reproduced on the local stack; it was checked on a Netlify branch deploy (M2.md section 15).
- Until the M5 trusted-proxy setting, a deployment behind two appending hosts shares one rate-limit IP across visitors (see the options table).
- Still different on Netlify, not changed here (M2.md section 15, gaps): Netlify sends its own HSTS value (one year, `includeSubDomains; preload`) instead of ours; `/_next/static` files get none of the `next.config.ts` headers; Netlify adds a script to each page, which the CSP blocks.
