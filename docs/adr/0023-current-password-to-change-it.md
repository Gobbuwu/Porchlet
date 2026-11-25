# 0023. A password change asks for the current password; a reset link's session must save a new one

- Status: Accepted (2026-11-25, M1). Amends [ADR 0021](0021-password-length-and-login-check.md) (the forced-change flag); does not change its decisions otherwise.

## Context

Until now any signed-in session could change the account's password without knowing the current one. `setNewPassword` sent only the new password, and Supabase Auth accepted it. Measured on the local stack (Supabase CLI 3.2.0, GoTrue v2.198.0, supabase-js 2.119.0, `secure_password_change = false`):

| Case | Result |
|---|---|
| Password session, no current password | Changed |
| Password session, wrong current password | Changed (ignored) |
| Reset-link session | Changed |
| Sign-in backdated 25 hours | Changed |

So a stolen session (cookie or access token) could take over the account for good: the change also ends the owner's other sessions. The publishable key is public (ADR 0004), so the thief can call `PUT /auth/v1/user` directly and a check in the app alone doesn't stop it. ASVS 5.0.0 6.2.3 asks for the current and the new password on a change.

The same review reproduced three problems in ADR 0021's forced-change flag (R1 to R3, below).

## Options (measured 2026-11-25, local stack)

| | A. Keep, document the gap | B. `secure_password_change = true` | C. `require_current_password = true` | D. App re-checks the current password with a sign-in |
|---|---|---|---|---|
| Result | as above | Asks only when the sign-in is over 24 h old (`reauthentication_needed`); fresher sessions change freely | No current password: 400 `current_password_required`. Wrong: 400 `current_password_invalid`. Right: changed. Reset link: changed without it. 25 h old: still asked | Not measured |
| Stops a stolen session calling Supabase directly | No | Only sessions over 24 h old, which ADR 0020's 24 h limit nearly rules out | Yes | No (Supabase still takes the direct call) |
| User sees | nothing | an emailed code, almost never | a "Current password" field for password sessions | the same field |
| Cost | doc | config + emailed-code flow (`reauthenticate`) | config line, one field, two messages, one hosted setting | an extra Supabase sign-in per change (shares the token-refresh backstop), a second session to revoke |
| ASVS 6.2.3 | not met | not met | met | met in the app only |

C is the only option that also covers direct calls, and it costs the least of the ones that meet 6.2.3. Gobbu chose C (2026-11-25).

## Decision

1. **`require_current_password = true`** under `[auth.email]` in `supabase/config.toml` (GoTrue: `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD`). Hosted projects need the same setting (steps in M1.md; the M5 setup wizard must set it, through the Management API field `security_update_password_require_current_password`).
2. **`/reset` shows a "Current password" field exactly when Supabase will check it.** GoTrue skips the check for a session whose `amr` has `otp`, `magiclink` or `recovery` (`Session.IsRecovery()` in [internal/models/sessions.go](https://github.com/supabase/auth/blob/v2.198.0/internal/models/sessions.go) with `AuthenticationMethod.IsRecovery()` in [internal/models/factor.go](https://github.com/supabase/auth/blob/v2.198.0/internal/models/factor.go); the check is in [internal/api/user.go](https://github.com/supabase/auth/blob/v2.198.0/internal/api/user.go)). Measured: a reset link and a sign-up confirmation link both give `amr: [{"method":"otp"}]`, a password login gives `password`, and a token refresh keeps the session's `amr`. `startedFromEmailedLink` (`src/lib/auth/session.ts`) mirrors that rule. The field only helps the user: leaving it out of a forged post gets `current_password_required` from Supabase. The action decides from the live session's claims, not from the form, which may have been rendered for an earlier session; a form without the field that gets `current_password_required` reloads `/reset`, which then shows it (found by /code-review).
3. The action sends it as `current_password` (the field in auth-js 2.119.0's `UserAttributes` and in GoTrue's `UserUpdateParams`; measured working). Supabase's password guide shows `currentPassword` instead; auth-js 2.119.0's `_updateUser` sends the attributes object as the request body unchanged (`dist/module/GoTrueClient.js`), so that spelling would not reach GoTrue's `current_password` field. Not used.
4. New messages: "Enter your current password." (`current_password_required`) and "Your current password is wrong." (`current_password_invalid`). Wrong guesses through the app count against the existing new-password limit (10 per 10 minutes per IP, ADR 0015).
5. **R1: a reset link's session must save a new password before it can open the app.** Reproduced: a flagged user logged out on `/reset` (which drops the flag), opened a reset link, and reached `/w` with the common password still set. More generally, a reset-link session can change the password without the current one, so it should be used for that and nothing else. `confirmEmailLink` now flags every `recovery` session, and the proxy sends it to `/reset?error=new-password-required` ("Save a new password to continue, or log out."). This changes behaviour: someone who opens a reset link and then changes their mind must log out (the button is on `/reset`).
6. **R2: the flag follows only its own user.** Reproduced: with account A flagged in a browser, account B's link opened there was flagged with A's message. The carry-over now also needs the link's user (`verifyOtp`'s `user.id`) to match the flagged session's `sub`. B's reset link is still flagged by R1, with the reset-link message, not the login one. A flagged link session is sent straight to `/reset` by `confirmEmailLink`: a redirect from a Server Action renders its target in the same response without the proxy, so redirecting to `/w` showed `/w` once (measured with the user's own sign-in link, which Supabase's `/auth/v1/otp` sends to anyone who asks).
7. **R3: a session that has ended is told to log in again.** Reproduced: a flagged session whose session ended server-side and whose access token expired saw "Your reset link has expired" on `/reset`, though it never had a link. `/reset` with no session now reads the `error=password-change-required` code the proxy sent it with and says "Your session has ended. Log in again." Posting the form after the session ended server-side but while the access token was still valid gave "Something went wrong": auth-js answers `AuthSessionMissingError` (400, no code; measured), which the action didn't recognise. It now does, ends the browser's session too (otherwise the still-valid access token sends `/login` to `/w` and back to `/reset` until it expires; found by /code-review), and answers "Your session has ended. Log in again." for a password session or the reset-link text for a link session. `/reset` shows the same text for `error=session-ended`, where that answer lands without JavaScript.

## Consequences

- ASVS 5.0.0 6.2.3 met for password sessions, including direct calls to Supabase Auth with a stolen token.
- A session started from an emailed link (reset or sign-up confirmation) can still change the password without the current one, for as long as it lives (up to 24 h, ADR 0020). That is Supabase's rule and can't be changed by config; holding such a session means the holder had the email link, which is what a reset proves anyway. A reset session can do nothing else until it saves (R1); a confirmation session can open the app.
- The forced change (ADR 0021) now asks a flagged password session for the password it just logged in with, as well as the new one.
- A stolen session could guess the current password by calling `PUT /auth/v1/user` directly. Supabase puts a rate limiter on that route (`limitHandler(api.limiterOpts.User)` in [internal/api/api.go](https://github.com/supabase/auth/blob/v2.198.0/internal/api/api.go)); its rate on hosted projects is **unverified**.
- A deployment whose Supabase project lacks the setting shows the field but Supabase ignores it: the app can't detect this without an extra call. The hosted setting is part of deployment (M1.md now, the M5 wizard later).
- Tests: `e2e/password-change.spec.ts` (current password missing, wrong and right through the form, and missing in a direct Supabase call; no field for link sessions; R1, R2 and R3 each as reproduced; the same user's sign-in link keeps the flag; a stale form reloads with the field). The first five failed 4 of 5 against the code before this ADR, and the /code-review fixes' three tests each failed with that fix taken out (runs 2026-11-25, Chromium); `e2e/passwords.spec.ts` now fills the current password in the forced change.
