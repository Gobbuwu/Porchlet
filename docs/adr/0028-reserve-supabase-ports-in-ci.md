# 0028. CI reserves the local Supabase ports before starting the stack

- Status: Accepted (2026-11-26, after PR 34's Database tests failure; full project check 1 follow-up).

## Context

PR 34's first CI run (45738229808) failed in Database tests before any test ran: Docker couldn't bind `0.0.0.0:54322` (`address already in use`). Every host port in `supabase/config.toml` that a CI job uses (54320 shadow db, 54321 API, 54322 db, 54323 Studio, 54324 Mailpit, 54327 analytics, 54329 pooler) is inside Linux's default ephemeral range, 32768 to 60999 (`/proc/sys/net/ipv4/ip_local_port_range` on the runner image and locally). The kernel may give any outgoing connection one of those ports, and then the bind fails. Which connection held 54322 on the runner is unknown.

Measured in a separate network namespace with the ephemeral range narrowed to 54320-54330 (2026-11-26, cloud container, Linux 6.18, Python 3.13 client sockets): ten outgoing connections took 54320-54330 including 54322, 54327 and 54329. After `scripts/ci/reserve-supabase-ports.sh` they took only 54325, 54326, 54328 and 54330, and the next one failed with `EADDRNOTAVAIL`, so the kernel never handed out a reserved port.

## Decision

| Option | Cost | Coverage |
|---|---|---|
| **Reserve the ports with `net.ipv4.ip_local_reserved_ports` as each Supabase job's first step (chosen)** | One step per job (well under a second locally); needs sudo, which GitHub's runners have | Every configured port inside the range, read from `config.toml`, so a port added later is covered. A socket opened before the step still holds its port; the script lists any |
| Move the Supabase ports below 32768 | Changes the ports every local setup, script and doc uses (54322 is hard-coded in three scripts and the docs) | Same, for the job and for local setups. Not measured |
| Shrink `ip_local_port_range` to end below 54320 | One step, but changes the runner's whole outgoing port pool | Same as reserving. Not measured |

Not all options measured: only the chosen one was run.

## Consequences

- `scripts/ci/reserve-supabase-ports.sh` runs right after checkout in `Database tests` and the three `E2E` jobs, before `npm ci` and image pulls open connections. It reads the kernel's list back and fails if a port is missing.
- Local stacks aren't changed; a clash there shows the same Docker error and the same script fixes it on Linux.
