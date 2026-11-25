# 0027. Sign-up asks only for the email; the password is chosen after the address is confirmed

- Status: Accepted (2026-11-25, M2). Changes the sign-up form from M1 ([ADR 0014](0014-server-only-auth-httponly-cookie.md)), widens the confirm trigger of [ADR 0024](0024-invite-delivery.md) section 7 to every account, and extends the "emailed-link sessions must save a password" rule of [ADR 0023](0023-current-password-to-change-it.md) to confirmation links.

## Context

A sign-up stores its password before anyone has shown they own the address, and Supabase Auth keeps that password through the confirmation, also when the address is signed up again later (it only re-sends the link). Porchlet's rule from now on: a password counts as the account owner's only when it was chosen after the address was proven, by whoever holds the emailed link. Supabase Auth already applies this rule to one path: a reset link that confirms an address empties the password (measured on GoTrue v2.198.0: the reset request keeps it, the verify empties it). Sign-ups can reach Supabase Auth without the app (the publishable key is public by design), so the app's own form can't be the only control. The measurements behind this ADR are in the project's private security record.

## Decision

1. **The database drops a password stored before the address was confirmed.** Trigger `clear_password_on_confirm` (before update on `auth.users`, `private.clear_password_on_confirm()`, migration `20261125060000`) empties `encrypted_password` on the update that sets `email_confirmed_at`, when an emailed link was sent to the address before (`confirmation_sent_at`, `recovery_sent_at` or `invited_at` set) and the update doesn't write the password itself. It replaces ADR 0024's `clear_invited_password_on_confirm`, which did the same only for addresses an unaccepted Porchlet invitation named.
2. **Sign-up asks only for the email.** The action gives Supabase Auth a random 32-byte password (it requires one), which nobody knows and the confirmation drops. A `password` field added to the form by hand is ignored (E2E).
3. **Every `type=email` link's session must choose a password before it can use the app.** `/auth/confirm` flags it (as ADR 0023 does for reset links) and sends it to `/reset?notice=email-confirmed` ("Your email is confirmed. Choose a password to continue."). It started from an emailed link, so Supabase Auth doesn't ask for a current password. A Supabase sign-in link to an already confirmed account (`/auth/v1/otp`, which Porchlet never sends) is treated the same way.

Options (Gobbu chose 2 + 1 on 2026-11-25, 16:49 UTC; both measured for the database part, which is the same in both):

| Option | Coverage and cost |
|---|---|
| **Email-only sign-up, password after the confirm link (chosen)** | Every path that confirms an address leaves no earlier password; one password entry for the person. The sign-up page's password checks move to the first-password page (same `newPasswordProblem`, E2E moved) |
| Keep the password field at sign-up, drop it on confirm, ask again | Same coverage; the person types a password that is then thrown away, then types one again |
| Drop the password only when the address is signed up again | Misses the plain case: a single sign-up confirmed through its own link keeps the password it was made with |

Why the "emailed link was sent" condition: without it, an admin creating a confirmed account (`POST /auth/v1/admin/users` with `email_confirm: true`, which inserts and then confirms in the same request) or confirming an account it made lost the password it was given (measured: `scripts/e2e/make-admin.sh` and `scripts/ci/session-limit-check.sh` failed). Every Supabase Auth path that confirms through a link sets one of the three columns first (measured: sign-up, and a sign-in link to an unconfirmed account, set `confirmation_sent_at`; a reset sets `recovery_sent_at`; an invite sets `invited_at`; a sign-up whose email can't be sent answers 500 and leaves no account). An address confirmed without any link (an admin, or a project with email confirmations off) proves nothing either way, and is left as it was.

## Consequences

- Porchlet requires email confirmations (`[auth.email] enable_confirmations = true`, set in `supabase/config.toml`; the M5 wizard must set it). Without them a sign-up is confirmed at once with the random password, and the person must use "Forgot your password?" to get in.
- A confirmed account can have no password until its session saves one. If the person leaves the page, "Forgot your password?" sets one.
- Accounts already confirmed keep their passwords; the trigger acts only on future confirmations. Unconfirmed accounts that exist when the migration runs lose their sign-up password when they are confirmed.
- On a hosted project with Supabase's default email templates (no custom SMTP, ADR 0024 Consequences) the confirmation link confirms through Supabase's own `/auth/v1/verify`, not `/auth/confirm`: the account is confirmed with no password and the app doesn't ask for one; the person uses "Forgot your password?". Custom SMTP and Porchlet's templates (M5) are required.
- `/reset` after a first password shows "Your password has been changed." (as after any change).
- Tests: `090_clear_password_on_confirm.test.sql` (15 tests), `080` updated (its never-invited and dashboard-invite accounts now lose their passwords on confirm); `e2e/signup-confirm.spec.ts` (4 tests). With the trigger disabled, 080 tests 20, 21, 23, 28, 090 tests 5, 6, 12 and the first two E2E tests fail (M2.md section 11).
- `AuthForm` now starts over when Next.js shows its page again from React Activity, or when the page passes it a different initial message (found by these E2E tests; M2.md section 11).
