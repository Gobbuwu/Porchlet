@AGENTS.md

# Porchlet: rules for Claude sessions

Porchlet is a self-hosted client portal (Next.js + Supabase). It also serves as a test target for
SiegeKit. The owner is Gobbu (`Gobbuwu`). Decisions live in `docs/adr`, milestone records in
`docs/milestones/Mx.md`, the 1.0 bar in `docs/definition-of-done-1.0.md`.

## Commands

Node 22 or later (`.nvmrc`), Docker for the local Supabase stack.

```sh
npm ci
npm run lint          # ESLint, warnings fail
npm run typecheck     # next typegen + tsc
npm run build
scripts/ci/check-client-bundle.sh .next/static   # no secret key in the browser bundle

# Database (pgTAP) on the local stack
npx supabase db start
npx supabase db lint --schema public,private --level warning --fail-on warning
npm run test:db 2>&1 | tee /tmp/pgtap.log
scripts/ci/db-count-check.sh /tmp/pgtap.log       # cross-checks the pgTAP and table counts
scripts/ci/db-race-check.sh                    # parallel invitation calls in two sessions

# E2E: full stack minus unused services (keeps Auth, REST and Mailpit)
npx supabase start -x realtime,storage-api,imgproxy,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
scripts/e2e/write-env.sh         # rewrites .env.local (URL, publishable key, RATE_LIMIT_KEY)
scripts/e2e/make-admin.sh        # fresh instance admin for the workspace tests (.env.e2e-admin)
scripts/ci/session-limit-check.sh  # session limits against the real Auth server
npm run build && npx playwright test --project=chromium
```

CI (`.github/workflows/ci.yml`) runs all of these plus Firefox and WebKit E2E, Node 22/24/26 builds,
DCO, gitleaks, npm audit, OSV-Scanner, CodeQL and Semgrep. 14 checks are required on `main`.

Cloud or sandbox tips:
- Image pulls blocked (ghcr/ECR): `export SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io`. On Docker
  Hub 429s, add `{"registry-mirrors":["https://mirror.gcr.io"]}` to `/etc/docker/daemon.json`.
- No Firefox/WebKit download: set `PW_CHROMIUM_PATH` to a preinstalled Chromium and let CI run the
  other two engines.
- No outbound internet: run `echo BREACHED_PASSWORD_CHECK=off >> .env.local` after each
  `write-env.sh` (it rewrites the file).
- Stop the app with `fuser -k 3000/tcp` (`pkill "next start"` misses `next-server`).

## Rules

- **Evidence.** Never guess. Back each key claim with a test, a measurement or a cited source;
  label the rest "unverified", and verify every unverified item in a PR before it merges.
- **Root causes.** Fix the cause and the whole class of failure, not one instance. Never re-run a
  flaky test to make it pass; find out why it fails. Don't weaken or skip a test or CI gate.
- **One PR per change**, CI green before merge, squash merge only. Run `/code-review` on the PR's
  diff and fix real findings before merging. Ask the owner before merging unless they said otherwise.
- **No force-pushes, no direct pushes to `main`.** The `main` ruleset enforces both.
- **DCO.** Every commit needs a sign-off matching its author exactly. Set the author repo-locally
  (`git config user.name "Dung Le"`, `git config user.email
  "347100038+Gobbuwu@users.noreply.github.com"`) and commit with
  `--trailer "Signed-off-by: Dung Le <347100038+Gobbuwu@users.noreply.github.com>"`.
  Don't use `-s`: it signs as the committer, which differs in cloud sessions.
- **Decisions** go in a new ADR in `docs/adr`; update the milestone's `docs/milestones/Mx.md`.
- **Dependencies** are pinned exactly; review each new one before adding it.
- **Secrets** never go in the repo, commits, logs or chat. Only `NEXT_PUBLIC_*` values may reach
  the browser; the Supabase secret key is server-only.
- **Security testing** runs only against the local stack or a throwaway Supabase project, never
  real users' data.
- **Weak spots in Porchlet** are reported privately (a GitHub security advisory), never in a
  public issue, PR or commit message.
- **SiegeKit** (`Gobbuwu/SiegeKit`) is read-only from here: report its bugs as issues labelled
  `from-porchlet`, and never push or open PRs there.
