# SiegeKit test-run schedule

Testing [SiegeKit](https://github.com/Gobbuwu/SiegeKit) is Porchlet's main purpose. This page says when each SiegeKit run is best: which Porchlet milestone unlocks which check, where the run goes, and what must be true first. It mirrors the schedule in the design doc (section 8) and is updated after each run.

Written 2026-11-23 against SiegeKit `main` 4e6f35e (pre-release, no tags) and Porchlet `main` f152474 plus open PRs 8 and 10. Check names and limits are from SiegeKit's `siegekit scan --help` text (`cmd/siegekit/scan.go`) and `docs/coverage.md` at that commit.

## Earliest next run: R1, as soon as PR 8 (headers) and PR 10 (auth and limiter) are merged

That run is the first one that tests something new in Porchlet. Nothing in Porchlet has changed for the M0 checks since R0, so re-running them earlier would find nothing new.

## How "local" and "hosted" work for SiegeKit

- SiegeKit's active checks (`login-throttle`, `login-spray`, `signup-limit`, `reset-limit`, `code-limit`, `rate-limit`, `access-control-write`, `storage-write`) run **only against a local target**, meaning the app's own URL on this machine, until SiegeKit's M2.10 decides deployed mode (open in SiegeKit's `docs/m2-plan.md`).
- So a **hosted** run means: Porchlet runs on `127.0.0.1` (`next build && next start`), pointed at the hosted `porchlet-test` project. SiegeKit's target is still local. A **local** run points the same app at `supabase start`.
- Checks that run on every target (`served-secrets`, `public-maps`, `access-control`, `nuclei`, `ffuf`, ZAP passive) can also run against a Vercel preview.
- Every run uses a throwaway project only: the local stack or `porchlet-test`, never real users' data.

## Schedule

| Run | When | Where | SiegeKit checks | Preconditions | Status |
|---|---|---|---|---|---|
| R0 | End of M0 | Repo only | `gitleaks`, `gitleaks-history`, `dotenv-gitignore`, `weak-passwords`, `backend-rules`, `trivy` | None | **Done 2026-11-23** on 376cd91. No Porchlet code change needed. SiegeKit issues SK-1 to SK-9 found and to be reported back. |
| (R0h) | M1, before the limiter | Hosted `porchlet-test`, Porchlet's own scripts, not SiegeKit | none | none | **Done 2026-11-23.** Through the app, every visitor shares one Supabase login limit, because Supabase sees only the server's IP. The limit tripped at attempt 11, and another device was then refused on its first try. This led to Porchlet's own limiter (PR 10, ADR 0015). |
| **R1** | **M1, right after PRs 8 and 10 merge** | Local: `supabase start` (with its Mailpit at `http://127.0.0.1:54324`) and `next start` | `login-throttle`, `login-spray`, `signup-limit`, `reset-limit` (with `--mail-catcher`), `served-secrets`, `public-maps`, ZAP, `nuclei`, `ffuf`, and the R0 set again | A local test account. A dry run first: Porchlet's forms are Next.js Server Actions, and SiegeKit has no header flag, so its form POST must carry the page's `$ACTION_ID_…` field (read from the built page). Whether Next.js accepts that as a URL-encoded form is **unverified**. If it doesn't, try `--har` for sign-up and reset, and report it to SiegeKit. | Next |
| R1h | M1, after R1 passes | Hosted: app on `127.0.0.1`, pointed at `porchlet-test` | `login-throttle`, `login-spray` | PR 10's limiter migration applied to `porchlet-test` and its key set. Gobbu's OK for the hosted run. Sign-up and reset are skipped here: SiegeKit counts emails only in a local Mailpit, so a hosted run can't count them. | Waiting on R1 |
| R1p | M1, any time after merge | Vercel preview | `served-secrets`, `public-maps`, `nuclei`, `ffuf`, ZAP passive | Run from Gobbu's computer, because cloud sessions can't reach `*.vercel.app`. Previews may sit behind Vercel's login (**unverified** for this project); if so, use the production URL or a bypass token. | Waiting on merge |
| R2 | M2, before full project check 1 | Local | `access-control` (`--har` as owner A; `SIEGEKIT_SESSION_B` a client in another workspace; `SIEGEKIT_SESSION_C` an outsider), `access-control-write` (`--replay-writes`), `rate-limit` on `/api/invite`, R0 set | Three test accounts and a recording of every change the UI offers. On plain-HTTP local runs the session cookie is `porchlet-auth`, not `__Host-porchlet-auth`. Whether SiegeKit keeps the `Next-Action` header when it replays recorded Server Action writes is **unverified**. | Waiting on M2 |
| R2b | M2 | Local, then hosted | `backend-live` | **Blocked as Porchlet is built now.** `backend-live` reads the Supabase public key from the app's browser scripts (`internal/backend/backend.go:375`). Porchlet talks to Supabase only from the server (ADR 0014), and in PR 10 no client component uses Supabase, so the scripts should hold no key (from reading the code; a build check is **unverified**). Either SiegeKit gains a way to pass the key, or this run is replaced by pgTAP plus a manual check. | Report to SiegeKit before M2 |
| R3 | M3, after the bucket and storage policies merge | Local, then hosted `porchlet-test` test bucket (app on `127.0.0.1`, `--storage-url https://<ref>.supabase.co`) | `storage-write`, plus the manual HTML or SVG upload test | `storage-write` is merged in SiegeKit `main` (ADR 0058), opt-in, and a person must type the host and `write test files` in a terminal. It has the same key-in-scripts need as R2b. No storage triggers on `porchlet-test`. | Waiting on M3 |
| R4 | M4, after TOTP merges | Local | `code-limit` on the TOTP verify page | SiegeKit reports **low** when a code page allows more than 100 wrong codes a day (NIST SP 800-63B-4). Set Porchlet's TOTP limit to fit, or record why not. | Waiting on M4 |
| R5 | M5, after the wizard locks | Local and preview, fresh throwaway project | `access-control` (outsider and no login on `/setup`), `ffuf` | A fresh project set up only through the wizard. | Waiting on M5 |
| R6 | M6, release candidate | The deploy made by following the guide | Full run | Hosted email needs custom SMTP for `signup-limit` and `reset-limit`. Deployed mode for the active checks depends on SiegeKit M2.10; anything still local-only is listed as "not tested on deployed". | Waiting on M6 |

## Every run

- Use SiegeKit's latest `main` and record its commit, the platform and the container engine.
- Re-run the R0 checks.
- Plant known-bad cases in a scratch copy, so a clean result can be trusted (as in R0).
- Re-check SK-1 to SK-9 once SiegeKit fixes them, and report new mistakes back to SiegeKit.
- Write the result into `docs/milestones/Mx.md` and update the Status column here.

## Sources

- R0 report and raw output: project files `porchlet-m0/siegekit-m0.md` and `porchlet-m0/siegekit-m0-raw/`.
- Hosted login limit: project file `porchlet/m1-login-limit-options.md`; Supabase reads a forwarded IP only from calls made with a secret key (https://supabase.com/docs/guides/auth/rate-limits).
- SiegeKit at 4e6f35e: `docs/coverage.md` rows for each check, ADR 0058 (storage-write), `docs/m2-plan.md` item 10 (M2.10, open).
