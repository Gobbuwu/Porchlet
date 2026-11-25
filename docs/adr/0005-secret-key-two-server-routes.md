# 0005. Secret key used in two server routes only

- Status: Accepted (2026-11-23, from the design doc). Updated 2026-11-25 by [ADR 0024](0024-invite-delivery.md): the invite email is sent from a Server Action, not `/api/invite`, and the CI check below exists.

## Context

The Supabase secret key bypasses RLS. If it leaks into browser code, or is used to read user data, ADR 0004's model fails.

## Decision

`SUPABASE_SECRET_KEY` is used only in `/api/setup/*` (bucket and admin account setup, M5) and for sending the invite email. It is never prefixed `NEXT_PUBLIC_` and never used to read user data.

As built in M2 (ADR 0024): the invite email is sent by `sendInviteEmail` in `src/lib/supabase/admin.ts`, the only module that reads the key, called only by the `inviteClient` Server Action in `src/app/w/actions.ts` after `create_invitation` succeeded as the signed-in owner. The module starts with `import "server-only"`. M5 adds the setup routes to the allowed list.

## Consequences

- CI fails the build if `sb_secret_` appears in `.next/static` (CI PR in M0).
- Code review rejects any new use of the secret key outside those places; `scripts/ci/check-secret-key-use.sh` (CI, since M2) fails on the key's name, `sb_secret_`, `service_role` or `.auth.admin` in `src/` outside `admin.ts`, on an import of `admin.ts` from anywhere but the invite action, and on `admin.ts` without `server-only`.
- `.env.example` documents the variable without a value.
