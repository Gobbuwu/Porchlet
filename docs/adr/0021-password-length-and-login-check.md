# 0021. Password length is checked like Supabase counts it; passwords are checked again at every login

- Status: Accepted (2026-11-24, M1). Adds to [ADR 0019](0019-common-and-breached-password-check.md); does not change its decision.

## Context

A code review of PR 21 asked two things about ADR 0019's new-password check (`src/lib/auth/password-check.ts`), which runs in Porchlet's Server Actions before Supabase Auth:

1. Can a short password of multi-byte characters skip the check, because Porchlet leaves passwords under 10 characters to Supabase and the two might count length differently?
2. Does a request that goes straight to Supabase Auth skip the check?

Both were tested on the local stack (Supabase CLI 3.2.0, GoTrue v2.198.0, the version porchlet-test ran on 2026-11-24). Testing the first also turned up a third problem: a password over Supabase's maximum got the wrong message.

## Part 1: length is counted in characters at the minimum and in bytes at the maximum

Measured with direct `POST /auth/v1/signup` calls:

| Password | Bytes | Code points | Supabase |
|---|---|---|---|
| 9 × `é` | 18 | 9 | 422 `weak_password` |
| 10 × `é` | 20 | 10 | 200 |
| 5 emoji | 20 | 5 | 422 `weak_password` |
| 10 emoji | 40 | 10 | 200 |
| 72 × `x` | 72 | 72 | 200 |
| 73 × `x` | 73 | 73 | 400 `validation_failed`, "Password cannot be longer than 72 characters" |
| 18 emoji | 72 | 18 | 200 |
| 19 emoji | 76 | 19 | 400 `validation_failed` |

- **Minimum: no bypass.** Supabase counts code points, as `[...password].length` does, so nothing under 10 characters reaches Supabase unrefused and nothing of 10 or more skips Porchlet's check. Review question 1 is answered no.
- **Maximum: wrong message (fixed).** Supabase's maximum is 72 UTF-8 bytes (bcrypt's limit), and it answers `validation_failed`, the code it also uses for a malformed email, which Porchlet showed as "Enter a valid email address." (measured: 19 emoji at sign-up through the app). The field's `maxlength="72"` doesn't count bytes (Chromium counts UTF-16 units), so 19 emoji (38 units) get past the browser.

**Decision (Part 1):** `newPasswordProblem` refuses a password over 72 UTF-8 bytes first, with its own message ("Choose a shorter password: at most 72 bytes, …"), before the list and the API. The reset action no longer maps `validation_failed` to the email message, since its page has no email field. The 10-character minimum stays with Supabase.

## Part 2: direct calls to Supabase Auth skip the check

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
| Check the password at every login too, and make a flagged account change it | Both paths, plus passwords set before this ADR or breached later | A new gate on every page, a Pwned Passwords call on every login (up to the 2-second timeout), and a user who skipped the check can still use the Supabase API directly | Chosen by Gobbu (2026-11-24) |

**Decision (Part 2):** check the password again at every login (Gobbu's choice, 2026-11-24), in the login Server Action, which sees the password:

- Only after Supabase accepted the password, so a wrong password never costs a Pwned Passwords call and the answer to a wrong password is unchanged.
- `newPasswordProblem` as for a new password: the bundled list, then Pwned Passwords (fail-open, as ADR 0019).
- A bad password still signs the user in, so they can change it without email, but sets an HttpOnly cookie (`porchlet-password-change`, `__Host-` prefixed over HTTPS, SameSite=Lax, Path=/) holding that session's id (its `session_id` claim), and lands on `/reset` with "The password you logged in with is too common or has appeared in a data breach. Choose a new one to continue." While the cookie matches the signed-in session's id, the proxy sends every protected page (`/w`, `/settings`) back to `/reset`. Saving an accepted new password or logging out removes it; every clean login clears it too.
- The cookie lives as long as the session cookies (400 days, @supabase/ssr's default), so closing the browser doesn't drop the prompt while the session survives. Because it holds the session id, a cookie left behind by a session that ended some other way (expiry, revocation) doesn't affect the next sign-in in that browser.
- `/reset` has a Log out button, since a flagged session can't reach `/w`.
- If the token has no session id, the login fails closed: the session is signed out again and the form shows "Something went wrong".

Why a cookie and not a flag in the database: the flag only matters to the browser that just logged in with the password, the login check runs again on every other device's login, and a cookie needs no migration, no per-request database call in the proxy and no hosted change. What it doesn't do, recorded as gaps in M1.md:

- A user who deletes the cookie, or calls the Supabase API directly with their token, skips the prompt. Both are the account holder's own deliberate action on their own account, the same as the bypass itself. When M2 adds shared data, RLS still decides what any token can read.
- Other devices that were already signed in are not sent to `/reset`; they meet the check at their next login (sessions end within 24 hours, ADR 0020).
- If Pwned Passwords is unreachable at login, only the list applies (logged as for sign-up).
- Every successful login waits for one Pwned Passwords call (2-second cap; when the API is unreachable, every login takes the full 2 seconds). Not measured from Vercel; the sandbox's proxy blocks the API.
- After a forced change the user lands on `/w`, not on the page they were going to before logging in.

## Consequences

- ASVS 5.0.0 6.2.9 (at least 64 characters allowed) holds for ASCII passwords only. A passphrase in a script that needs 2 to 4 bytes per character is limited to 18 to 36 characters by Supabase's bcrypt limit. Porchlet can't raise it on the free plan. Recorded in M1.md.
- Tests in `e2e/passwords.spec.ts`: 5 emoji refused as too short and 19 emoji refused as too long at sign-up through the app, with the browser's own check off (no email sent); `e2e/auth.spec.ts`: 19 emoji refused as too long on `/reset`; `newPasswordProblem` skips 9 two-byte characters, checks 10, refuses 73 bytes and 19 emoji with no lookup, and checks 18 emoji. The lookup tests now turn the breach check on for themselves, so `BREACHED_PASSWORD_CHECK=off` in the runner's environment doesn't fail them.
- If a Supabase upgrade changes how it counts either limit, the two sign-up tests fail.
- `e2e/passwords.spec.ts` "a login with a common password set outside the app must change it first": sets `password1234` through `PUT /auth/v1/user`, then checks the login lands on `/reset`, `/w` sends it back, a listed new password is refused, a strong one opens `/w`, and the next login with it goes straight to `/w` with no flag cookie. Planted bad case: with the proxy's check turned off, the test fails at `/w`. Also: the flag cookie is HttpOnly and persistent; a leftover flag holding another session's id doesn't send a new sign-in to `/reset` (planted bad case: matching on the cookie's presence alone fails it); a flagged session can log out from `/reset`.
