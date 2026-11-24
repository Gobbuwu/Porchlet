# 0020. Session lifetime limits set in the database

- Status: Accepted (2026-11-24, M1)

## Context

ASVS 5.0.0 7.1.1, 7.3.1 and 7.3.2 (L2) ask for an inactivity timeout and an absolute session lifetime, documented and justified against NIST SP 800-63B. Supabase sessions last until sign-out by default: "refresh tokens never expire" ([sessions docs](https://supabase.com/docs/guides/auth/sessions)).

NIST SP 800-63B-4 ([section 2, Reauthentication](https://pages.nist.gov/800-63-4/sp800-63b/aal)):
- AAL1: overall timeout "SHOULD be no more than 30 days"; "An inactivity timeout MAY be applied but is not required".
- AAL2: overall timeout "SHOULD be no more than 24 hours"; inactivity "SHOULD be no more than 1 hour".

Options, 2026-11-24:

| Option | Applies to | Cost | Measured / source |
|---|---|---|---|
| 1. Supabase's time-box and inactivity timeout | Every client | Paid plan | "This feature is only available on Pro Plans and up" (sessions docs) |
| 2. Checks in the app's proxy | The app only: a refresh token used directly against Supabase is not limited | Idle tracking needs either a signed cookie (another secret) or a database write per request | Not built |
| 3. Triggers that set `auth.sessions.not_after` | Every client | Two triggers; no request-time cost | Supabase Auth refuses a refresh once `not_after` has passed, on any plan: `Session.CheckValidity` checks it before the plan settings ([sessions.go, v2.197.0](https://github.com/supabase/auth/blob/v2.197.0/internal/models/sessions.go)). Measured locally: `400 session_expired`, and the app then clears the cookies and sends the user to `/login`. `postgres` holds TRIGGER and UPDATE on `auth.sessions` locally and on the hosted test project (read 2026-11-24). |

## Decision

Option 3 (migration `20261124010000_session_limits.sql`).

- `private.session_limits` holds one row: `absolute_lifetime` and `idle_timeout` (null for none). Defaults: **24 hours** and **2 hours**.
- On sign-in, `not_after` = the earlier of start + absolute lifetime and now + idle timeout. On each refresh (Supabase writes `refreshed_at`), it is recomputed, so activity moves the idle limit forward and never the absolute one.
- The idle timeout must be longer than 1 hour (a check constraint), because Supabase sees activity only when the 1-hour access token is refreshed. The effective idle limit is between 1 and 2 hours, which is 1 hour longer than NIST's AAL2 "no more than 1 hour" at worst.
- An access token issued before the limit stays valid until it expires (up to 1 hour), as with Supabase's own feature ("the actual duration of a session is the configured timeout plus the JWT expiration time", sessions docs). So the absolute limit is at most 25 hours in practice.
- Why AAL2 values when password-only sign-in is AAL1: Porchlet targets ASVS L2 and adds TOTP in M4, and the data (client files, invoices) is not public. An owner can relax the limits with one `update private.session_limits ...`.

## Consequences

- Users sign in again at least daily, and after 1 to 2 hours away.
- Sessions that existed when the migration ran got the absolute limit straight away.
- Relies on a Supabase Auth behaviour (`not_after`) that is used by its SSO sessions but not documented as an API. `scripts/ci/session-limit-check.sh` runs in the E2E job against the real Auth server, so a Supabase CLI or Auth update that drops it fails CI.
- Porchlet doesn't use SSO. If it does, the refresh trigger would replace an SSO session's `not_after`; revisit then.
- The M5 setup wizard needs nothing extra: the limits ship in the migration.
