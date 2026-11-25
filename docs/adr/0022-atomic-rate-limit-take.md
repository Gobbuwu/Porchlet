# 0022. The auth limiter checks and counts an attempt in one atomic step

- Status: Accepted (2026-11-25, M1). Amends [ADR 0015](0015-own-auth-rate-limiter.md): the limits and the key stay; how an attempt is counted changes.

## Context

ADR 0015's `public.rate_limit_hit` counted and checked in separate steps:

- **Logins** checked the two failure buckets without counting, called Supabase Auth, and counted a failure only after Supabase answered.
- **Sign-up, reset, email links and password changes** inserted a hit and then counted the bucket in the same transaction. Under Postgres's default isolation (read committed), a transaction doesn't see rows that parallel transactions haven't committed yet.

So posts sent at the same time from one IP all passed the check. Measured on the local stack (Supabase CLI 3.2.0, Postgres 17, `next start`, Chromium project), with the parallel tests in `e2e/rate-limit.spec.ts` before this change, 3 runs each:

| Test | Limit | Let through |
|---|---|---|
| 20 parallel wrong passwords, one account | 5 | 20, 20, 20 |
| 35 parallel failed logins, 35 emails | 20 | 24, 27, 35 |
| 15 parallel reset requests | 5 | 12, 13, 12 |

The same tests sent from the page itself (a browser holds about six connections per host) let through 9-10, 24 and 6.

## Options considered

1. **Lock per bucket and take a slot before the attempt (chosen).** One function checks every rule and records one hit per rule only when all have room, under a transaction-level advisory lock per bucket. A login takes its slot before Supabase checks the password and gives it back when the password proves right.
2. **Count every login, failed or not.** Atomic with the insert-then-count fix alone, but people behind one IP (an office, a campus) would use up the per-IP limit by logging in. ADR 0015 rejected that.
3. **Serializable isolation.** PostgREST runs each request at the role's default level; raising it for these calls means a per-role setting on `anon` and `authenticated` that changes every other query too, and parallel calls then fail with serialization errors, which the app would show as "Something went wrong" instead of "Too many attempts".
4. **A unique slot table** (insert slot 1..N, conflict means full). No lock, but a sliding window needs a slot per time bucket and the cleanup is more complex; not measured further because option 1 passes every test with less code.

## Decision

Option 1.

- `public.rate_limit_take(key, ip, scopes[], limits[], windows[])` returns the new hits' ids when every bucket had room, an empty array when any bucket is full (and then records nothing), or null for a wrong key or bad arguments.
  - It takes `pg_advisory_xact_lock` on each bucket in a fixed order, so two calls that share buckets can't deadlock. The lock is held until the request's transaction commits, so a parallel call waits and then counts the committed hits.
  - It refuses to run outside read committed: under repeatable read or serializable its count would use a snapshot taken before the wait. Measured: `rate_limit_take needs read committed, not repeatable read`. The app shows "Something went wrong" then (fails closed).
  - Hits older than an hour are deleted before any lock is taken, skipping rows another call is deleting, so the cleanup never waits while it holds a bucket lock.
- An IPv4 address written as IPv6 (`::ffff:a.b.c.d`, as a dual-stack socket reports it) is counted as that IPv4 address. `rate_limit_hit` applied the IPv6 /64 rule to it, which put every such visitor in one `::/64` bucket (found by the code review of this change; checked in psql: `network(set_masklen('::ffff:203.0.113.5', 64))` is `::/64`).
- `public.rate_limit_release(key, ids[])` gives hits back.
- `public.rate_limit_hit` is dropped, so no code path can count in two steps again.
- A login takes a slot in both failure buckets, then:
  - right password: the slot is given back;
  - Supabase answers 429 (it refused before checking the password): the slot is given back;
  - any other error, including a wrong password: the slot stays, as a failure.

Measured after the change, same setup: all 6 tests in `e2e/rate-limit.spec.ts` passed 5 times in a row (30 of 30), each parallel test letting through exactly the limit. Tests:

- `supabase/tests/database/020_rate_limit.test.sql`: taking up to the limit, all-or-nothing across rules, release, wrong key, bad arguments.
- `e2e/rate-limit.spec.ts`: the three parallel tests above, and "successful logins give their attempt back", which failed when the give-back was removed (5 of 8 right-password logins got through, then "Too many attempts").

## Consequences

- Behaviour change: an attempt over the limit is no longer recorded. Before, every refused sign-up, reset or link attempt added a hit, so a client that kept posting stayed blocked for as long as it kept going. Now the bucket refills as its oldest hit leaves the window, so a client gets at most `limit` attempts per window however hard it posts, and a flood can't grow the table.
- A login in progress holds its slot until Supabase answers. Six people logging in to one account from one IP at the same instant would see the sixth refused; 21 simultaneous logins from one IP would see the 21st refused. Each is refused only for the second or so the others are in flight.
- If the give-back fails after a right password, the login still succeeds and the attempt stays counted as a failure; the server logs `rate limit release failed`.
- Round trips per login: one before Supabase (was two) and one after a success (was none) or none after a failure (was two).
- Hosted rollout: [`supabase/migrations/20261125000000_rate_limit_take.sql`](../../supabase/migrations/20261125000000_rate_limit_take.sql) must reach `porchlet-test` before a deployment of this code runs against it. Deployments of older code call the dropped function and fail closed ("Something went wrong") until they are redeployed.
