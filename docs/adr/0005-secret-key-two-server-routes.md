# 0005. Secret key used in two server routes only

- Status: Accepted (2026-11-23, from the design doc)

## Context

The Supabase secret key bypasses RLS. If it leaks into browser code, or is used to read user data, ADR 0004's model fails.

## Decision

`SUPABASE_SECRET_KEY` is used only in `/api/setup/*` (bucket and admin account setup) and `/api/invite` (sending the invite email). It is never prefixed `NEXT_PUBLIC_` and never used to read user data.

## Consequences

- CI fails the build if `sb_secret_` appears in `.next/static` (CI PR in M0).
- Code review rejects any new import of the secret key outside those two routes; a lint rule or CI grep enforces it (M2).
- `.env.example` documents the variable without a value.
