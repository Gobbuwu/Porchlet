# 0019. New passwords are checked against a bundled common list and Pwned Passwords

- Status: Accepted (2026-11-24, M1)

## Context

ASVS 5.0.0 asks that new passwords (sign-up and password change) are checked against at least the top 3,000 passwords that fit the password policy (6.2.4, L1) and against breached passwords (6.2.12, L2). Porchlet did neither (M1.md, Gaps).

Options, measured or sourced on 2026-11-24:

| Option | Covers | Cost | Measured / source |
|---|---|---|---|
| 1. Supabase's leaked password protection | 6.2.12 | Paid plan | "Leaked password protection is available on the Pro Plan and above" ([password security docs](https://supabase.com/docs/guides/auth/password-security)). Porchlet targets the free plan. |
| 2. Bundled common-password list | 6.2.4, offline | 152 KB source, server only; +356 KB in `.next/server` with source maps; 0 copies in the browser bundle; building the set takes 17 ms once, 100,000 lookups take 8 ms | Measured locally (build and Node 22) |
| 3. Have I Been Pwned's Pwned Passwords range API | 6.2.12, and 6.2.4 while reachable | One HTTPS call per new password; sends the first 5 hex characters of the SHA-1 only | API terms: "no authorisation required", "no rate limit", "no licencing or attribution requirements"; padding entries "always have a password count of 0" ([API v3 docs](https://haveibeenpwned.com/API/v3)) |
| 4. Options 2 and 3 together | 6.2.4 always, 6.2.12 while the API answers | Both of the above | |

The API's latency could not be measured here: this cloud sandbox's proxy refuses `api.pwnedpasswords.com` (HTTP 403 on CONNECT). See "Verification" in M1.md.

## Decision

Option 4, in `src/lib/auth/password-check.ts`, called by the sign-up and new-password Server Actions before Supabase Auth.

- **The list.** The NCSC's top 100,000 passwords (from Pwned Passwords), as copied into SecLists (MIT licence), pinned to commit `fcde9140` and checked by SHA-256. `scripts/auth/build-common-passwords.sh` keeps the 9,126 entries of 10 to 72 characters (the length Porchlet accepts), lower-cased, and writes `src/lib/auth/common-passwords.ts`. Matching ignores case.
- **The API.** `GET https://api.pwnedpasswords.com/range/<first 5 of SHA-1>` with `Add-Padding: true` and a 2-second timeout. A suffix with a count above 0 means breached.
- **When the API fails** (error, network failure, timeout), the password is accepted and the server logs `breached-password check unavailable`. The list still applied, so 6.2.4 holds. Failing closed would stop every sign-up and reset whenever a third-party service is down.
- **Turning it off.** `BREACHED_PASSWORD_CHECK=off` skips the API (for hosts with no outbound internet). Any other value, or none, keeps it on.
- **Order.** Rate limit, then length (shorter than 10 is left to Supabase, which answers `weak_password`), then the list, then the API. The check runs before Supabase sees the email, so the answer is the same whether or not an account exists.
- One message for both: "Choose a different password: this one is too common or has appeared in a data breach."

## Consequences

- Every sign-up and password change makes one outbound call to Have I Been Pwned, carrying 5 hex characters of the password's SHA-1. The privacy policy must say so (to do with the policy).
- Passwords already in use are not checked; users meet the check at their next change.
- The list is a snapshot. Re-run the script with a newer SecLists commit to refresh it.
- Tests: `e2e/passwords.spec.ts` (sign-up refused with no email sent; the API client against a stand-in: prefix only, padding, case, errors, timeout) and the reset test in `e2e/auth.spec.ts`.
