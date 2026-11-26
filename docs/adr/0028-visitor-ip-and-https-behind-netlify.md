# 0028. The visitor IP counts the hosts in front of the app, and the proxy also reads HTTPS from its URL

- Status: Accepted (2026-11-26, full project check 1, F1; Gobbu chose the IP option at 04:26 UTC). Changes how [ADR 0015](0015-own-auth-rate-limiter.md) reads the visitor IP, and how `src/proxy.ts` ([ADR 0014](0014-server-side-auth.md)) tells HTTPS from HTTP. Brings forward the trusted-proxy setting M1.md planned for M5.

## Context

[ADR 0002](0002-frontend-stack-nextjs.md) promised a Netlify deploy test at the M2 check. `main` (c06fa99) was deployed to Netlify (free plan, `@netlify/plugin-nextjs` 5.16.9 as Netlify picked it) against the hosted test project on 2026-11-26. Two things that work on Vercel didn't:

1. **Login did nothing.** Supabase Auth accepted the password, but the next page sent the person back to `/login`. Server Actions run in a Netlify Function and get `X-Forwarded-Proto: https`, so they set the session cookie as `__Host-porchlet-auth` (measured: a reset request's PKCE cookies came back `__Host-`, `Secure`, `HttpOnly`). `src/proxy.ts` runs as a Netlify Edge Function, which gets no `X-Forwarded-Proto` (measured: pages' CSP lacked `upgrade-insecure-requests`, which the proxy adds only over HTTPS), so it looked for `porchlet-auth`, found no session and redirected. The adapter builds the proxy's request from the edge request's own URL (`edge-runtime/middleware.ts`, `buildNextRequest`), which is `https://`.
2. **The visitor IP.** Porchlet took the first `X-Forwarded-For` entry, trusting the host to overwrite the header as Vercel does. On Netlify the app sees two hops: Netlify's CDN appends the visitor's address to the entries the browser sent, then the edge function that runs the proxy appends its own address before calling the app, and `x-nf-client-connection-ip` names that edge function too. Many visitors share one edge function address. Measured on branch deploys by reading which rate-limit bucket each candidate source filled, from this project's cloud container and from Gobbu's browser; the measurements are in the project's private security record.

Netlify's documented runtime variables for functions are only `URL`, `SITE_NAME` and `SITE_ID` ("only the following variables are available to serverless functions during runtime", [Netlify docs](https://docs.netlify.com/build/functions/environment-variables)), and they are reserved ("You can't set or override these values manually"). `NETLIFY` is set at build time only.

## Decision

1. **The visitor IP is the `X-Forwarded-For` entry the first trusted host added, counted from the end** (`clientIp`, `src/lib/auth/rate-limit.ts`). The number of trusted hosts is `TRUSTED_PROXY_HOPS` when set (1 to 10), else 2 when Netlify's `SITE_ID` is set, else 1. On Vercel the header holds one entry (Vercel overwrites it), so nothing changes there. With fewer entries than hosts, the first entry is used.
2. **The proxy treats a request as HTTPS when `X-Forwarded-Proto` says so or its URL is `https://`** (`isHttps(headers, url)`, `src/lib/http.ts`). Server Actions and pages keep reading the header, which they get on both hosts. The header test is now Next.js's own (the value contains `https`, `next-server.js` `attachRequestMeta`), because under `next start` that test decides the scheme of the proxy's URL: with the old "first entry is `https`" test, a header such as `http, https` would have split the proxy and the actions again.

Options for the IP (measured on Netlify branch deploys; Vercel by its documented overwrite and the M1 measurement in ADR 0015):

| Option | Coverage and cost |
|---|---|
| **Detect Netlify by `SITE_ID`, plus `TRUSTED_PROXY_HOPS` (chosen)** | Right on Vercel and Netlify with no setup; the setting covers other chains. If Netlify stopped adding the edge hop, the entry used would be one the browser sent (a bypass again), so each Netlify check re-measures it |
| The setting only, default 1 | Vercel unchanged; a Netlify deployment without `TRUSTED_PROXY_HOPS=2` puts every visitor behind one edge address into one bucket (a lockout risk) |
| The last entry, documented | No new code; the same shared buckets on Netlify, so one person's wrong passwords lock an account for others for 10 minutes |

## Consequences

- With no host in front (a bare `next start`), every entry is the browser's, as before (ADR 0015, gaps).
- A wrong `TRUSTED_PROXY_HOPS` is costly either way: too low shares buckets between visitors, too high lets a visitor choose their own. `.env.example` says so.
- E2E "the limit follows the address the first trusted host added, not entries the browser sent" builds a chain of the configured length with every other entry changing, and expects the per-account limit to hold. CI runs it with 1 host; it was also run locally with `SITE_ID` set (2 hosts).
- E2E "with X-Forwarded-Proto `http, https` the proxy and the login agree on the session cookie" covers the `next start` side of the HTTPS check. The Netlify side (an `https://` URL with no header) can't be reproduced on the local stack; it was checked on a Netlify branch deploy (M2.md section 15).
- Still different on Netlify, not changed here (M2.md section 15, gaps): Netlify sends its own HSTS value (one year, `includeSubDomains; preload`) instead of ours; `/_next/static` files get none of the `next.config.ts` headers; Netlify adds a script to each page, which the CSP blocks.
