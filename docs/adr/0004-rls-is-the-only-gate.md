# 0004. The browser talks to Supabase directly; RLS is the only gate

- Status: Accepted (2026-11-23, from the design doc)

## Context

A server API in front of Supabase would duplicate access rules and hide the database's real defences from SiegeKit.

## Decision

All user traffic goes from the app to Supabase with the publishable key and the user's own session. Row Level Security policies on tables and storage policies on `storage.objects` decide what each user can read and write. The Next.js server never reads user data with elevated keys (see [0005](0005-secret-key-two-server-routes.md)).

## Consequences

- Every table in `public` has RLS on and is shipped in migrations; CI fails if any table has RLS off (CI PR in M0).
- `anon` gets no table grants, and Supabase's default grants on new tables and functions are revoked with `alter default privileges`. Whether those defaults exist on current Supabase is unverified and is checked by pgTAP grant tests in M0.
- Inserts that must not trust the client (role, file size, uploader) go through `security definer` functions (ADR 0006, M2).
- Next.js middleware/proxy checks are for user experience only; the database enforces the same rules.
