# 0028. CI reserves the local Supabase ports before starting the stack

- Status: Accepted (2026-11-26, after PR 34's Database tests failure; full project check 1 follow-up).

## Context

PR 34's first CI run (45738229808) failed in Database tests before any test ran: Docker couldn't bind `0.0.0.0:54322` (`address already in use`). Every host port configured in `supabase/config.toml` except the edge runtime's inspector (54320 shadow db, 54321 API, 54322 db, 54323 Studio, 54324 Mailpit, 54327 analytics, 54329 pooler; the CI jobs bind a subset, since E2E leaves out Studio, analytics and the pooler and Database tests runs only the database) is inside Linux's default ephemeral range, 32768 to 60999 (`/proc/sys/net/ipv4/ip_local_port_range` locally; the runner's value is read from PR 36's CI log, see M2.md section 15). The kernel may give any outgoing connection one of those ports, and then the bind fails. Which connection held 54322 on the runner is unknown.

Measured in a separate network namespace with the ephemeral range narrowed to 54320-54330 (2026-11-26, cloud container, Linux 6.18, Python 3.13 client sockets): with a listener holding 54327, ten outgoing connections took the other ten ports, 54320-54326 and 54328-54330, including 54322 and 54329. After `scripts/ci/reserve-supabase-ports.sh` four connections took 54325, 54326, 54328 and 54330 and the fifth failed with `EADDRNOTAVAIL`, so the kernel never handed out a reserved port.

## Decision

| Option | Cost | Coverage |
|---|---|---|
| **Reserve the ports with `net.ipv4.ip_local_reserved_ports` as each Supabase job's first step (chosen)** | One step per job (well under a second locally); needs sudo, which GitHub's runners have | Every configured port inside the range, read from `config.toml`, so a port added later is covered. A socket opened before the step still holds its port; the script lists any |
| Move the Supabase ports below 32768 | Changes the ports every local setup, script and doc uses (54322 is hard-coded in three scripts and the docs) | Same, for the job and for local setups. Not measured |
| Shrink `ip_local_port_range` to end below 54320 | One step, but changes the runner's whole outgoing port pool | Same as reserving. Not measured |

Not all options measured: only the chosen one was run.

## Consequences

- `scripts/ci/reserve-supabase-ports.sh` runs right after checkout in `Database tests` and the three `E2E` jobs, before `npm ci` and image pulls open connections (checkout and the runner agent connect earlier). It reads the kernel's list back and fails if a port is missing.
- Local stacks aren't changed. On Linux the same script (with sudo) prevents the clash; it doesn't run on macOS.
