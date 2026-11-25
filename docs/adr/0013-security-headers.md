# 0013. Security response headers

- Status: Accepted (PR 8 merged 2026-11-23 as 7836836)

## Context

ADR 0011 makes OWASP ASVS 5.0.0 Level 2 our standard. Its section V3.4 ("Browser Security Mechanism Headers", [source](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x12-V3-Web-Frontend-Security.md)) asks for these at L1 or L2:

- 3.4.1 (L1): "A maximum age of at least 1 year must be defined, and for L2 and up, the policy must apply to all subdomains as well."
- 3.4.3 (L2): a Content-Security-Policy with `object-src 'none'`, `base-uri 'none'` and an allowlist, nonces or hashes.
- 3.4.4 (L2): "all HTTP responses contain an 'X-Content-Type-Options: nosniff' header field".
- 3.4.5 (L2): "a referrer policy to prevent leakage of technically sensitive data to third-party services".
- 3.4.6 (L2): "the frame-ancestors directive of the Content-Security-Policy header field for every HTTP response ... the X-Frame-Options header field, although supported by browsers, is obsolete and may not be relied upon."

The [OWASP Secure Headers Project](https://owasp.org/www-project-secure-headers/) publishes recommended values in [`ci/headers_add.json`](https://github.com/OWASP/www-project-secure-headers/blob/2c9702a2e49f46599ed6fab9f6b5fa6286b85e1f/ci/headers_add.json) (read at commit `2c9702a`, file dated 2026-11-23). The design doc's threat model (section 6, rows 16 and 17) lists `frame-ancestors 'none'`, HSTS, and an Origin check on every POST route.

Next.js sets headers for every path with `headers()` in `next.config.ts` (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/headers.md`, Next 16.4.6).

## Decision

`next.config.ts` sends these on every response (`source: "/:path*"`):

| Header | Value | Why this value |
|---|---|---|
| Strict-Transport-Security | `max-age=63072000; includeSubDomains` | ASVS 3.4.1 L2 needs 1 year and subdomains; 2 years is the OWASP Secure Headers value. No `preload`: it is hard to undo and each self-hoster's domain is their own call. |
| Content-Security-Policy | `frame-ancestors 'none'` | ASVS 3.4.6. Only this directive for now: the full policy needs a per-request nonce and comes with M1 auth (design doc, row 16). |
| X-Frame-Options | `DENY` | Same as OWASP. Kept for browsers without frame-ancestors; ASVS says not to rely on it alone. |
| X-Content-Type-Options | `nosniff` | ASVS 3.4.4, same as OWASP. |
| Referrer-Policy | `same-origin` | ASVS 3.4.5. OWASP lists `no-referrer`; see below for why not. |
| Permissions-Policy | 13 powerful features set to `()` (camera, microphone, geolocation, payment, USB and so on) | Porchlet uses none of them. Unlike the OWASP list, `clipboard-write` is left on for the "Copy invite link" button, and features Chromium doesn't recognise are left out (see below). |

`poweredByHeader: false` also drops `X-Powered-By: Next.js` (ASVS 13.4.6 is L3, but this is free to do).

### Why `same-origin` and not `no-referrer`

Under `no-referrer`, the Fetch standard ([append a request Origin header](https://fetch.spec.whatwg.org/#append-a-request-origin-header)) makes the browser send `Origin: null` on non-CORS POST requests, even same-origin ones. That would break the Origin check on our POST routes (design doc row 17) and Next.js Server Actions, which "compare the Origin header to the Host header" (`node_modules/next/dist/docs/01-app/02-guides/data-security.md`). Measured in Chromium 1243: with `no-referrer` a same-origin form POST sent `Origin: null` (a same-origin `fetch()` POST still sent the real origin). With `same-origin`, both sent `http://127.0.0.1:3000`. `same-origin` still sends no Referer to any other site, which is what 3.4.5 asks.

### Permissions-Policy feature list

Chromium logs `Unrecognized feature` for names it doesn't know. The first draft had `bluetooth=()`, and Chromium 1243 logged `Error with Permissions-Policy header: Unrecognized feature: 'bluetooth'.`, so it was removed. `browsing-topics=()` passed locally but CI's Chromium (the build Playwright downloads) logged `Unrecognized feature: 'browsing-topics'` ([run 45252085307](https://github.com/Gobbuwu/porchlet/actions/runs/45252085307/job/137964111674)): which names are known depends on the Chromium build, so the list keeps only features both builds accept. The E2E test fails on any such message. Firefox and Safari don't support this header ([MDN browser-compat-data](https://github.com/mdn/browser-compat-data/blob/2f696a2565efa5303ffd9e6a13365a0ef1a4f114/http/headers/Permissions-Policy.json): `version_added: false` for both), so it protects Chromium users only.

### Not added here

- The rest of CSP (ASVS 3.4.3, L2): M1, with nonces in middleware. When M1 adds it, `frame-ancestors 'none'` moves into that policy and the CSP entry in `next.config.ts` is deleted, so one policy is sent.
- Cross-Origin-Opener-Policy (ASVS 3.4.8, L3), Cross-Origin-Embedder-Policy, Cross-Origin-Resource-Policy, Cache-Control and Clear-Site-Data from the OWASP list: not L2 requirements, and COEP `require-corp` could block files served from the Supabase storage domain. Revisit with the file features in M3.

## Consequences

- `e2e/headers.spec.ts` checks each value on a page, a build script, a route handler, `favicon.ico` and a 404, in Chromium, Firefox and WebKit. It also checks that browsers refuse to show the app in a frame (the parent is the app itself, since `frame-ancestors 'none'` blocks same-origin parents too), that same-origin POSTs keep a real Origin, and (Chromium only) that every Permissions-Policy feature is recognised and applied.
- Planted failures, Chromium 1243, local: removing both frame headers made the frame test find the app's heading inside the frame (expected 0, got 1); switching to `no-referrer` failed the Origin test (form POST got `"null"`).
- HSTS has no effect over plain HTTP (local `next start`); it takes effect on the HTTPS deployment. The Vercel preview of this PR (fetched 2026-11-23 through the Vercel connector) returned all six headers with our values, and one HSTS value, `max-age=63072000; includeSubDomains`. The connector returns headers as a map, so whether Vercel also sends a second identical HSTS line is unverified; RFC 6797 section 8.1 has browsers use only the first one, so it would not change behaviour.
- The preview's HTML also carried `Access-Control-Allow-Origin: *`. Porchlet doesn't send it: no code sets it, and local `next start` responses for `/` and `/api/health` have no such header. So it comes from Vercel's layer; which Vercel rule adds it is unverified. It doesn't matter for today's public static page, because a wildcard origin can't be combined with credentials, and ASVS 3.4.2 allows `*` when the response holds nothing sensitive. M1 must check that signed-in pages and API routes on Vercel don't get it, or else override it. (Checked in M1, PR 10, locally rather than on Vercel, with a proxy adding the header as Vercel does, on `/w` and `/api/health` only: a cross-site fetch of a signed-in page with credentials was blocked, because a wildcard can't be used with credentials, and without credentials the `SameSite=Lax` session cookie isn't sent, so only signed-out content comes back. No override is needed. See [M1.md](../milestones/M1.md), "ACAO=\* checked against signed-in pages".)
