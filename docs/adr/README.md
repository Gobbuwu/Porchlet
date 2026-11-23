# Architecture Decision Records

One file per decision: `NNNN-short-title.md` with Status, Context, Options (with measurements where there was a real choice), Decision and Consequences. A decision that changes gets a new ADR that supersedes the old one; old ADRs are not rewritten.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-supabase-over-firebase.md) | Supabase over Firebase | Accepted |
| [0002](0002-frontend-stack-nextjs.md) | Frontend stack: Next.js | Accepted |
| [0003](0003-licence-mit.md) | Licence: MIT | Accepted |
| [0004](0004-rls-is-the-only-gate.md) | Browser talks to Supabase directly; RLS is the only gate | Accepted |
| [0005](0005-secret-key-two-server-routes.md) | Secret key used in two server routes only | Accepted |
| [0011](0011-owasp-asvs-level-2.md) | Secure-coding standard: OWASP ASVS 5.0.0 Level 2 | Accepted |
| [0012](0012-ci-pipeline.md) | CI pipeline: jobs, tools and lockdown | Proposed (PR 2) |
| [0014](0014-server-side-auth.md) | Auth on the server, HttpOnly session cookies, nonce CSP | Proposed (M1 auth PR) |

ADRs 0006-0010 are written when their milestone starts (see the M0 doc).
