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
| [0013](0013-security-headers.md) | Security response headers | Proposed |
| [0014](0014-server-side-auth.md) | Auth on the server, HttpOnly session cookies, nonce CSP | Proposed (M1 auth PR) |
| [0015](0015-own-auth-rate-limiter.md) | Porchlet counts auth attempts per visitor IP in Postgres | Proposed (M1 auth PR) |
| [0016](0016-held-back-dependency-majors.md) | Hold back @types/node and TypeScript majors; take ESLint 10 | Accepted |
| [0017](0017-rls-on-private-tables.md) | Row level security on every private table, with no policies | Accepted |
| [0018](0018-native-form-posts-redirect-with-message.md) | Native form posts get their message through a redirect | Accepted |
| [0019](0019-common-and-breached-password-check.md) | New passwords are checked against a bundled common list and Pwned Passwords | Accepted |
| [0020](0020-session-limits-in-the-database.md) | Session lifetime limits set in the database | Accepted |
| [0021](0021-password-length-and-login-check.md) | Password length checked like Supabase counts it; passwords checked again at every login | Accepted |

ADRs 0006-0010 are written when their milestone starts (see the M0 doc).
