# 0019. New passwords are checked against a bundled common list and Pwned Passwords

- Status: Accepted (2026-11-24, M1); amended 2026-11-24 ("Direct calls to Supabase Auth" and "How length is counted" below)

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
- gitleaks skips `src/lib/auth/common-passwords.ts` (exact path, `.gitleaks.toml`): three of its lines tripped the generic-api-key rule on the PR's first CI run. The file only changes through the build script, so a change to it in a diff is a change to that script's output.
- CodeQL's password-hashing rule flags SHA-1 on a password. Here SHA-1 is the Pwned Passwords protocol, not storage (Supabase stores bcrypt), and only 5 hex characters leave the server; the alert is dismissed as a false positive with this reason.
- The list is a snapshot. Re-run the script with a newer SecLists commit to refresh it.
- Tests: `e2e/passwords.spec.ts` (sign-up refused with no email sent; the API client against a stand-in: prefix only, padding, case, errors, timeout) and the reset test in `e2e/auth.spec.ts`.

## Direct calls to Supabase Auth (added 2026-11-24)

The check runs in Porchlet's Server Actions, not in Supabase Auth, so a request that goes to Supabase Auth directly skips it. Measured on the local stack (Supabase CLI 3.2.0, GoTrue v2.198.0, the version porchlet-test ran on 2026-11-24):

- `POST /auth/v1/signup` with the publishable key and `password123` (in the bundled list) answered 200 and made the account.
- `PUT /auth/v1/user` with the publishable key and that account's own access token changed the password to `password1234` (also listed): 200, and the new password signed in.

What it takes and what it reaches:

- Sign-up needs the publishable key. Porchlet doesn't send it to browsers (a build with a marker key had it in 0 files under `.next/static`; SiegeKit's `served-secrets` found none), but ADR 0004 treats it as public, so this ADR doesn't rely on it staying private.
- A password change needs the account's own session (the access token in the HttpOnly cookie, which only that user's browser holds) as well as the key. Someone who has stolen a session can already do anything the account can.
- Either way, the person who skips the check weakens only their own account. No control stops an account holder from weakening their own password on purpose (they could also share it).

Options, measured or sourced on 2026-11-24:

| Option | Closes | Cost or problem | Source |
|---|---|---|---|
| Supabase's leaked password protection | Both paths, breached list only | Pro plan and above | [password security docs](https://supabase.com/docs/guides/auth/password-security) |
| An auth hook | Nothing | No hook gets the new password. Password Verification Attempt is Teams and Enterprise only and gets `user_id` and `valid`; Before User Created (free) gets the user record without the password | [auth hooks docs](https://supabase.com/docs/guides/auth/auth-hooks) |
| `password_requirements` (character classes) | Nothing | Composition rules, which ASVS 6.2.5 says not to use; even the strictest setting (lower, upper, digit, symbol) lets `Password123!` through | ASVS 5.0.0 6.2.5 |
| Turn off public sign-up, create accounts with the secret key on the server | Sign-up only | Puts the secret key on the sign-up path (ADR 0005 keeps it to two routes), Porchlet would have to send confirmation emails itself, and password change stays open | ADR 0005 |
| Check the password at every login too, and make a flagged account change it | Both paths, plus passwords set before this ADR or breached later | A new gate on every page, a Pwned Passwords call on every login (up to the 2-second timeout), and a user who skipped the check can still use the Supabase API directly | Design only, not built |

Decision: accepted as a known gap and documented here and in M1.md. Every way Porchlet offers to set a password runs the check (ASVS 6.2.4 and 6.2.12 are about the passwords the app accepts), the bypass needs the account holder's own deliberate API call, and no option at $0 closes both paths. The login-time check is the one to revisit if a hosted Porchlet ever needs to protect users from themselves.

## How length is counted (added 2026-11-24)

Passwords under 10 characters are left to Supabase Auth (see "Order" above), so Porchlet and Supabase must count length the same way. Both count characters (Unicode code points), not bytes or UTF-16 units: `[...password].length` in `password-check.ts`, and GoTrue v2.198.0 as measured on the local stack (9 × `é`, 18 bytes, refused with `weak_password`; 10 × `é` accepted; 5 emoji, 20 bytes, refused; 10 emoji accepted). Supabase's 72 maximum is in bytes, but anything over it is refused, so nothing passes unchecked. The sign-up field's `minlength` counts UTF-16 units, so 5 emoji pass the browser and the server decides. `e2e/passwords.spec.ts` pins both sides: 5 emoji are refused at sign-up through the app, and `newPasswordProblem` skips 9 two-byte characters and checks 10.
