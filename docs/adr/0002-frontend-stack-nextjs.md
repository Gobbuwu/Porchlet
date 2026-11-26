# 0002. Frontend stack: Next.js

- Status: Accepted (2026-11-23, by Gobbu, after the stack test below)

## Context

The design doc proposed Next.js because the Supabase Vercel integration targets it, but that was not measured. The project rules say to measure every option first, so M0 started with a stack test.

## Method

The same tiny app in three stacks: an email sign-up page (`supabase.auth.signUp` in the browser), a home page that lists and inserts rows of a `notes` table with RLS (`select` and `insert` only where `user_id = auth.uid()`), and a `GET /api/health` server route. Each app was built for production, served locally, and driven by one Playwright script that signs up a new user, adds a note and checks it appears, while recording every script the browser downloads. All three passed.

Environment: Linux 6.18 x86_64 cloud container, 4 vCPU, 15 GB RAM, Node 22.23.5, npm 10.9.9, Docker 29.10.0, Supabase CLI 3.3.0 (Postgres 17.12), Playwright 1.63.0 with Chromium 157.0.8103.78. The spike's source is archived outside the repo (project files, `porchlet-m0/stack-spike-src.tar.gz`).

| Stack (versions) | Browser JS, gzip (raw) | Production build, 3 runs | `npm ci`, warm cache | Packages | Hand-written lines |
|---|---|---|---|---|---|
| Next.js 16.4.6, React 19.3, `@supabase/ssr` 0.12.7 | 199 KB (704 KB), 6 files | 8.7, 9.0, 9.2 s | 9.7 s | 383 | 102 |
| SvelteKit 3.4.0, Svelte 5.59, `@supabase/ssr` 0.12.7 | 100 KB (333 KB), 12 files | 3.0, 3.2, 3.3 s | 3.5 s | 182 | 81 |
| Vite 8.3 + React 19.3 SPA, supabase-js 2.119.2 | 121 KB (428 KB), 1 file | 0.8, 0.8, 0.8 s | 1.6 s | 45 | 74 |

Browser JS was measured on the two pages the script visits. Raw sizes are as served; gzip sizes were computed by the script with Node's zlib. Package counts are from `npm ls --all`. The Next.js scaffold also includes Tailwind, which adds to its package count but not to its browser JS. Lines exclude blank lines and generated files.

What the numbers don't show:

- **Server routes.** Next.js and SvelteKit have them built in. The SPA has none, so the wizard and invite routes would be host-specific functions (a Vercel `api/` folder or Netlify functions), two copies of security-critical code.
- **Session storage.** Next.js and SvelteKit keep the Supabase session in cookies through `@supabase/ssr`. The SPA keeps it in `localStorage`, where any injected script can read it.
- **Maturity.** SvelteKit 3.0.0 was published on 2026-10-01 (npm). Its environment API changed from v2 (`$env/static/public` became `$app/env/public` with `src/env.ts`), and the first draft written from v2 conventions failed to build.
- **Host integration.** The Supabase Vercel integration sets `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` ([Supabase docs](https://supabase.com/docs/guides/integrations/vercel-marketplace)), which Next.js reads with no mapping.
- **Next.js 16 behaviour.** With the scaffold's defaults (`cacheComponents`), reading cookies outside `<Suspense>` fails the build. Wrapping the data read in `<Suspense>` fixed it.

Not measured: deploys to Vercel and Netlify (no accounts were used in the test). The Vercel preview of the first PR measures the Next.js deploy; Netlify is measured at the M2 milestone check. (Measured 2026-11-26, full project check 1: the build deployed, but login and the visitor IP needed [ADR 0028](0028-visitor-ip-and-https-behind-netlify.md); M2.md section 15.)

## Decision

Next.js App Router with TypeScript and `@supabase/ssr`. The SPA is out because of the two points above. SvelteKit is lighter and faster to build, but the gap (about 100 KB of gzip JS and 6 s of build) matters little for a portal, and Next.js uses the integration's variables as they are.

## Consequences

- About twice the browser JS of SvelteKit. Revisit if a page budget is set and missed.
- Session refresh goes in `src/proxy.ts` (Next.js 16 renamed `middleware` to `proxy`), built in M1.
- Tailwind is not part of this decision. It is decided when M1 builds the first real UI.
