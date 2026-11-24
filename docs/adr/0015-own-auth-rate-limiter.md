# 0015. Porchlet counts auth attempts per visitor IP in Postgres

- Status: Proposed (2026-11-23); accepted when the M1 auth PR merges

## Context

Auth runs on the server (ADR 0014), so every call Supabase Auth sees comes from the server's IP. Supabase Auth limits by caller IP ("By default, Supabase Auth uses the IP address of the client for rate limiting", [rate-limits docs](https://supabase.com/docs/guides/auth/rate-limits)). On the hosted test project, through the Vercel preview, all visitors shared one login limit (measured 2026-11-23, M1.md):

- one script tripped it after 11 attempts;
- a phone on another network then got "Too many attempts" on its first try.

One person could block every login for about 5 minutes.

Options considered (sources and table in the M1 thread's comparison):

1. **Forward the visitor IP to Supabase** (`Sb-Forwarded-For`). Supabase honours it only on calls made with a secret key ("Publishable API keys and legacy anon/service_role API keys are not supported") and only after "IP Address Forwarding" is enabled. The login code would then carry a key that bypasses every RLS rule, which ADR 0005 confines to two setup routes.
2. **A Vercel firewall rule.** Hobby has one rate-limit rule per project, set by hand in the dashboard. It is Vercel only and can't run in CI.
3. **A captcha (Turnstile).** It needs a Cloudflare account, two keys and a CSP change, sends visitor data to a third party, and would block SiegeKit's scanner.
4. **Porchlet's own limiter in Postgres.**

## Decision

Option 4.

**The counter.**
- `public.rate_limit_hit(key, scope, ip, window, record)` counts attempts per scope and visitor IP in `private.rate_limit_hits`.
  - IPv4 counts per address. IPv6 counts per /64.
  - Rows older than an hour are deleted.
- It answers only callers holding `RATE_LIMIT_KEY`. The database stores the key's SHA-256 in `private.rate_limit_key`.
- That key can reach these counters and nothing else. A leak lets someone fill or empty counters, not read data.
- With no key, or a wrong one, the Server Actions fail closed ("Something went wrong").

**The limits** (per visitor IP, each over 10 minutes):

| Action | Limit |
|---|---|
| Failed logins, same email | 5 |
| Failed logins, any email | 20 |
| Sign-ups | 10 |
| Reset emails | 5 |
| Email-link verifications | 20 |
| Password changes | 10 |

- Only failed logins count, so people behind one office IP can still log in.
- No limit is per account alone, so an attacker can't lock a victim out of their account.

**The visitor IP** is the first `X-Forwarded-For` entry. Vercel overwrites that header: "we currently overwrite the X-Forwarded-For header and do not forward external IPs" ([Vercel docs](https://vercel.com/docs/edge-network/headers/request-headers)).

**Supabase's own limits stay on as a backstop** for attacks spread over many IPs. The M5 setup wizard raises them so normal traffic doesn't reach them; until then they stay at Supabase's defaults.

## Consequences

- The setup wizard (M5) generates `RATE_LIMIT_KEY`, stores its hash with the Management API, and sets the env var. Locally, `scripts/e2e/write-env.sh` does both.
- Four extra database round trips per failed login, and one per other auth action.
- The limits work in local E2E and CI, so SiegeKit's throttle checks (`login-throttle`, `login-spray`, `signup-limit`, `reset-limit`) have something to find locally.
- Gap: on a host that passes `X-Forwarded-For` through unchanged, a client can choose its own bucket. Only Supabase's backstop applies there. Self-host docs must say so.
- Gap: a large botnet can still use up Supabase's shared backstop. Turnstile after N failures is the follow-up if that happens.
