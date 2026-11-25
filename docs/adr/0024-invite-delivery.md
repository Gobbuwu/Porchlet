# 0024. Invites: Supabase's invite email, a link to copy, accept on POST, and cleanup of unused invited accounts

- Status: Accepted (2026-11-25, M2 PR 3). Builds on decision D2 in [M2.md](../milestones/M2.md) (option A, `auth.admin.inviteUserByEmail`), [ADR 0005](0005-secret-key-two-server-routes.md) (secret key), [ADR 0006](0006-inserts-through-security-definer-rpcs.md) (`create_invitation`, `accept_invitation`), [ADR 0018](0018-native-form-posts-redirect-with-message.md) and [ADR 0025](0025-workspace-pages-and-forms.md) (forms), [ADR 0023](0023-current-password-to-change-it.md) (emailed-link sessions).

## Context

M2 PR 3 builds the invite UI on PR 1's RPCs. D2 measured Supabase's side; building it raised six more questions. Measured on the local stack (Supabase CLI 3.2.0, `supabase/gotrue:v2.198.0`, `supabase/postgres:17.12.0.000`, Mailpit v1.31.3, Next.js 16.4.6 `next start`, Playwright 1.65.1 with Chromium 1243, Node 22.23.5, Linux cloud container), with throwaway scripts against the stack:

| # | Measurement | Result |
|---|---|---|
| M1 | `inviteUserByEmail(email, { redirectTo })` with an `invite.html` template that prints `{{ .RedirectTo }}` inside a link's query | Supabase Auth's template is contextually escaped: in the query it comes out URL-encoded (`http%3a%2f%2f127.0.0.1%3a3000%2finvite%3ftoken%3d…`) |
| M1b | The same with `redirectTo` on another host (`https://evil.example/x?invite=1`) | Replaced by the site URL (`http://127.0.0.1:3000`); the invite is still sent |
| M2 | An invite is pending, the person signs up on their own after 61 s, then confirms | Sign-up answers OK and sends "Confirm your Porchlet account"; the invite email's link then answers `403 otp_expired`; the confirmation link works, but the password chosen at sign-up then answers `invalid_credentials` (a 60-character hash is stored, not theirs) |
| M3 | "Forgot password" for a pending invited account | Works: the reset link confirms the address and a new password can be set (then the invite link answers `403 otp_expired`) |
| M4 | Inviting a pending address again | A new invite email; the first link answers `403 otp_expired` |
| M5 | `delete from auth.users` (as `postgres`) of a pending invited account | Its `auth.identities` and `auth.one_time_tokens` rows go with it (0 left); its invite link answers `403 otp_expired`; a sign-up for that address afterwards stores the chosen password |
| M6 | The session the invite link gives | `amr` `[{"method":"otp"}]`, the same as a reset link, so ADR 0023's emailed-link rules apply |
| M7 | A cleanup delete while a confirmation of that account holds its row (two sessions) | The delete waited 2.1 s for the lock, re-checked, deleted 0 rows; the account stayed, confirmed |
| M8 | How long the invite email's sign-in part lasts (`invited_at` and `confirmation_sent_at` moved back) | 9 minutes: works; 11 minutes: `403 otp_expired`. It follows `otp_expiry` (600 s in `config.toml`, ASVS 5.0.0 6.5.5; 3600 s by default on hosted), not the invitation's 7 days |
| M9 | An address signs up (not confirmed yet), then is invited | `200`; Supabase Auth reuses that account and sets `invited_at` on it; the password hash the person chose stays (60 characters). An account an invite email created has none (0) |
| M10 | The cleanup's lookup with 10,000 accounts | 1.0 to 2.2 ms a call (3 calls), a sequential scan (0.6 ms): `lower(email)` has no index without `instance_id`. Supabase Auth stores addresses lower-cased (measured: `M4-Mixed-…@Example.TEST` stored lower case), but rows written another way may not be, so `lower()` stays |

## 1. Who sends the email, and with what key

As D2 chose: `auth.admin.inviteUserByEmail` with the secret key, in `src/lib/supabase/admin.ts` (one function, `sendInviteEmail`). The Server Action `inviteClient` calls it only after `create_invitation` succeeded **as the signed-in owner** (publishable key), so the owner check, the 20-pending and the 20-per-hour caps all run before any email. A client replaying the owner's request gets "You can't do that in this workspace." and no email is sent (E2E; planted case A6: sending first fails that test).

The design's `/api/invite` route became this Server Action (decision D5), so ADR 0005 is updated. `scripts/ci/check-secret-key-use.sh` (CI, Lint and types job) fails when the key's variable name, `sb_secret_`, `service_role` or `.auth.admin` appears in `src/` outside `admin.ts`, when anything but `src/app/w/actions.ts` imports `admin.ts`, or when `admin.ts` doesn't start with `import "server-only"` (Next.js then fails the build if a browser bundle imports it: `node_modules/next/dist/docs/01-app/02-guides/data-security.md`). Planted cases: each of those four fails the script. The existing bundle grep (`check-client-bundle.sh`) still passes on the build.

## 2. What the email's link is, and where its host comes from (threat T9)

`supabase/templates/invite.html`: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&invite={{ .RedirectTo }}`. The link's host is Supabase Auth's own `site_url`, never anything the app or the request supplies. The Porchlet invite link travels inside it as `invite` (URL-encoded by Supabase Auth, M1), and `/auth/confirm` takes only the 64-hex token from it (`tokenFromInviteLink`: path `/invite`, `token` matching the format), never its host or path. A `redirectTo` on another host is replaced by the site URL (M1b), whose link then carries no token and is refused ("This link is not valid").

The app builds `redirectTo` and the copy link from a new server-only setting, `SITE_URL` (a bare http(s) origin; anything else and the invite is refused with "Something went wrong" and a log line).

| Option for the app's own URL | Coverage |
|---|---|
| The request's `Host` / `X-Forwarded-Host` | Rejected: T9 is exactly this. |
| **`SITE_URL` (chosen)** | Fixed per deployment, like Supabase's `site_url`, which it must match (hostname) for `redirectTo` to be kept (M1b). The M5 wizard sets both |
| Vercel's `VERCEL_URL` | Differs per deployment, so it wouldn't match Supabase's `site_url` on previews (**unverified**, not measured: no hosted invite test in this PR) |

## 3. How the invited person joins

- **Address with an account** (Supabase answers `422 email_exists`, D2): the owner copies the link `SITE_URL/invite?token=…` and sends it. `/invite` needs a session (the proxy sends signed-out visitors to `/login?next=…`), shows who is logged in, and accepts only when **Join workspace** is pressed (POST, threat T6). `accept_invitation` decides (wrong account, used, expired, withdrawn).
- **New address**: the email's link opens `/auth/confirm`, which shows **Accept invitation**. That POST verifies the Supabase token (`verifyOtp type invite`), accepts the Porchlet invitation in the same request, flags the new session as one that must choose a password (ADR 0021's cookie, as ADR 0023 does for reset links: the account has no password the person knows), and sends it to `/reset` with "You joined the workspace. Choose a password…". After saving, `/w` lists the workspace.

| Option for the new address | Coverage |
|---|---|
| Plan's wording: verify, set the password, then accept on `/invite` | The token has to survive `/reset`; the proxy's redirect to `/reset` (any app page while flagged) drops a query parameter, and a cookie adds state. Not built |
| **Verify and accept in one POST, then set the password (chosen)** | Nothing to carry. If accepting fails (withdrawn, expired), the person still gets a working account and is told to ask for a new invitation (`invite-not-joined`) |

**When the email's sign-in part has expired or is already used** (after `otp_expiry`, M8; or the person signed up on their own while invited, M2, or reset their password, M3): verifying fails, but the invitation may still be open. The action then sends a signed-in visitor to `/invite?token=…` with "The sign-in part of this email's link was already used…" and a **Join workspace** button, and a signed-out one to `/login` with that message and `/invite` as `next`. (A redirect to `/invite` that let the page itself redirect to `/login` showed the login form under the old URL: measured in E2E, so the action picks the page.) The email itself asks people not to sign up separately, because Supabase keeps no usable password then (M2), and says the button signs in only for a short while; "Forgot your password?" gives the invited address a password in both cases (M3), after which the email's button joins.

| Option for the short sign-in window (M8) | Coverage |
|---|---|
| **Keep `otp_expiry` at 10 minutes; say so in the email and the pages, and route an expired link to logging in, with "Forgot your password?" for a person with no password yet (chosen)** | Works for 7 days with one extra email after the window. ASVS 6.5.5 kept for every emailed link |
| Raise `otp_expiry` to its 24-hour maximum | One setting covers confirmation and reset links too, so all of them would break ASVS 6.5.5's 10 minutes, and 24 hours is still short of 7 days |
| A "send the email again" button for owners | Withdraw and invite again does this today (M4: a new email; the cleanup and a new account in between). Not built |

## 4. Showing the link to copy

The database keeps only the token's hash (PR 1), so the link exists only in `create_invitation`'s answer. `inviteClient` sets a cookie, `__Host-porchlet-new-invite` (`porchlet-new-invite` on plain-HTTP local runs) = `<workspace id>.<token>`, HttpOnly, `SameSite=Strict`, 5 minutes, then redirects to `/w/<id>?notice=…` on both paths (as ADR 0025 does for every success). The owner's page shows **Invite link** when that cookie is for this workspace.

| Option | Coverage |
|---|---|
| Token in the redirect's query (the first version) | Works with and without JavaScript, but the token lands in the owner's history and request logs (the project's rule: no secrets in logs), and a crafted URL could make an owner's page show another workspace's link as this one's (`/code-review` findings). Replaced |
| **A short-lived HttpOnly cookie bound to the workspace (chosen)** | Works with and without JavaScript; in no URL or log; a URL can't set it (E2E: a crafted `?invite=` shows no link; planted case: reading the query again fails that test). The link shows on each load for 5 minutes (Server Components can't delete a cookie), on that browser only |
| Return it as form state (React only) | No link at all for a native post (ADR 0018). Rejected |

The invitee's own link, `/invite?token=…`, still carries the token in its URL by nature (T6's open item: whether Vercel logs query strings is **unverified**). The token is useless without a confirmed session of the invited address (T5; 050's wrong-account tests, E2E).

## 5. Withdrawn and expired invitations delete the unused invited account (threat T8)

While Supabase's invited account exists, the person's own sign-up keeps no usable password (M2). D2 asked that revoking and expiry delete it.

| Option | Cost | Coverage |
|---|---|---|
| **A. In the database: an after-delete trigger on `invitations`, and an hourly Supabase Cron (`pg_cron`) job, both calling `private.delete_unused_invited_users()` (chosen)** | Migration `20261125030000_invite_cleanup.sql` (an index, two definer functions, a trigger, the job); `070_invite_cleanup.test.sql` (25 tests); `pg_cron` enabled (on hosted: `create extension pg_cron with schema pg_catalog`, supabase.com/docs/guides/cron/install) | Every way an invitation goes away (the owner's delete, a workspace cascade) and expiry (within the hour). Atomic with a concurrent confirmation (M7). No secret key. Deletes by SQL, which Supabase's docs allow ("You may delete users directly or via the management console", supabase.com/docs/guides/auth/managing-user-data); Supabase Auth writes no audit-log entry for it |
| B. `auth.admin.deleteUser` (secret key) in the revoke action, after a lookup of the account | A second secret-key use (ADR 0005 widens), a definer lookup by email | Revoke only; nothing at expiry (the person would need "Forgot password", M3); a confirmation between the lookup and the delete would delete a just-confirmed account |

Only accounts nobody used are deleted: invited, never confirmed, never signed in, and without a password, checked in the delete itself. The password check came from `/code-review`: an invite to an address whose own sign-up isn't confirmed yet marks that account invited too (M9), and it holds the password the person chose. And only while no invitation for the address is open in any workspace. The hourly job also requires a Porchlet invitation for the address, so an invite sent from the Supabase dashboard is left alone. Each condition has a test and a planted case that fails it (M2.md section 10). Both functions are in `private` with no execute grant for the API roles.

## 6. Testing the hourly cap without breaking the other tests

The cap (20 per owner per hour, T7) is the only limit on invite emails (D2), and every E2E test acts as the one instance admin. `e2e/invite-cap.spec.ts` uses up the admin's hour, so it runs in its own Playwright project, `<browser>-cap`, which depends on `<browser>`: CI runs `--project=<browser> --project=<browser>-cap`. It sends through `create_invitation` (no email) across two workspaces until the database refuses, then shows the message on the page. Locally, run `scripts/e2e/make-admin.sh` again before each E2E run (a fresh admin, a fresh hour).

## Consequences

- New settings: `SITE_URL` (server only) and `SUPABASE_SECRET_KEY` now used by the app; `.env.example` documents both. `scripts/e2e/write-env.sh` writes both for the local stack only (it refuses a non-local API URL), into the git-ignored `.env.local` (mode 600).
- Hosted projects need the invite template and subject (the M5 wizard sets them, as for the confirmation and reset templates), `pg_cron`, and `SITE_URL` matching Supabase's `site_url`.
- Owners learn whether an address has an account (T16, accepted in M2.md).
- An address invited to several workspaces keeps its pending account until the last open invitation goes.
- The cleanup scans `auth.users` once per deleted invitation (M10): about 1 to 2 ms at 10,000 accounts.
