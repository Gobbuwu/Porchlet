# 0017. Row level security on every private table, with no policies

- Status: Accepted (2026-11-24)

## Context

The `private` schema holds `instance`, `rate_limit_hits` and `rate_limit_key`. Two locks already keep the API roles (`anon`, `authenticated`) out: they have no usage on the schema and no grants on its tables, and PostgREST does not expose it (baseline tests 4, 5, 10, 11; rate-limit tests 1-4). RLS was off on all three, and the dashboard SQL editor warned about it when the M0 migration was run on `porchlet-test`.

[ADR 0004](0004-rls-is-the-only-gate.md) requires RLS on every table in `public`; it said nothing about `private`.

Measured on 2026-11-24, both on the local stack (Supabase CLI 3.2.0, Postgres 17) and on `porchlet-test`: all three tables and both `security definer` functions (`public.rate_limit_hit`, `private.handle_new_user`) are owned by `postgres`, and `postgres` has `BYPASSRLS`. `service_role` also has `BYPASSRLS`.

## Options

| Option | What it guards against | Cost |
|---|---|---|
| Leave RLS off | Nothing beyond the two locks | Editor warning stays |
| RLS on, no policies | A later grant or schema exposure by mistake: `anon` and `authenticated` still see and change no rows | One migration, eight pgTAP tests |
| RLS on and `FORCE` | Also restricts the table owner | Nothing more: the owner, `postgres`, bypasses RLS through `BYPASSRLS` anyway. If that attribute were ever lost, `FORCE` would block the definer functions (measured: with `NOBYPASSRLS` plus `FORCE` on `rate_limit_key`, the rate-limit test setup fails with "new row violates row-level security policy") |

## Decision

Enable RLS on every table in `private`, add no policies, and do not set `FORCE`. The baseline test's "RLS on" check now covers `public`, `graphql_public` and `private`, so a new private table without RLS fails CI.

## Consequences

- The definer functions keep working because `postgres` owns the tables and has `BYPASSRLS`; baseline tests 19 and 20 check both, and the rate-limit tests (as `anon`) and profiles tests exercise the functions with RLS on.
- A private table that some role other than `postgres` must read needs a policy, and baseline test 18 (no policy in `private`) must change with it, on purpose.
- `service_role` still reads these tables (it has `BYPASSRLS`). That key stays server-only ([ADR 0005](0005-secret-key-two-server-routes.md)).
