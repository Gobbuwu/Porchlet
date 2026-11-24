# 0012. CI pipeline: jobs, tools and lockdown

- Status: Proposed (PR 2, 2026-11-23); accepted when Gobbu merges PR 2

## Context

The design doc (section 7) asks for CI on every PR: DCO, lint and types, database tests, E2E on three browsers, secret scanning, dependency scanning, SAST and a count cross-check, with a locked-down pipeline (NIST SSDF PW.4.1, PW.4.4, PW.6.1, PW.7.2, PO.5.2). It left the tool choice open where there was a real choice. This ADR records what was picked and what was measured. All measurements are from GitHub-hosted `ubuntu-24.04` runners on PR 2 (runs linked from [M0.md](../milestones/M0.md)).

## Decisions

### Jobs

One workflow, `.github/workflows/ci.yml`, on `pull_request` to `main` and `push` to `main`. Every job is independent, so all of them report on every run and one failure never hides another.

| Check name | What it runs | Fails on |
|---|---|---|
| DCO sign-off | `scripts/ci/check-dco.sh` (after its self-test) | A non-merge commit without `Signed-off-by: <author>`; git's commit count differing from GitHub's |
| Lint and types | ESLint with `--max-warnings 0`, `next typegen && tsc --noEmit` | Any lint warning or type error |
| Build (Node 22), (Node 24), (Node 26) | `next build`, then `scripts/ci/check-client-bundle.sh` | Build error; `sb_secret_` in `.next/static`; no browser JS found |
| Database tests | `supabase db start`, `supabase db lint`, `supabase test db`, `scripts/ci/db-count-check.sh` | SQL function errors, any pgTAP failure, count mismatch, a table with no `-- Covers:` test |
| E2E (chromium), (firefox), (webkit) | Playwright against `next start` | Any failed test |
| Secret scan | gitleaks canary, then gitleaks on the full history, then a commit-count cross-check | Canary missed; any finding; scanned commits differing from git's count of non-merge commits that add lines |
| Dependency scan | `npm audit --audit-level=low`, OSV-Scanner with a package-count cross-check | Any advisory; OSV scanning a different number of packages than the lockfile holds |
| Registry signatures (own workflow, `signatures.yml`, **not required**) | `npm audit signatures` on every PR, on `main` and daily | A missing or bad registry signature or attestation. Not required because npm's CDN served stale or broken attestation data from some edges (M0.md); `npm ci` still checks every tarball against the lockfile's sha512 |
| SAST (CodeQL, javascript-typescript), (CodeQL, actions) | CodeQL `security-extended`, results uploaded to code scanning | The job fails only on errors; findings fail the separate **CodeQL** check that code scanning adds |
| SAST (Semgrep) | `semgrep scan --config p/default --config p/typescript --error` | Any finding |

Node versions: Vercel offers 26.x (default), 24.x and 22.x ([Vercel docs](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)); Netlify's build image defaults to 24 and reads `.nvmrc` ([Netlify docs](https://docs.netlify.com/build/configure-builds/available-software-at-build-time/)). The build runs on all three. Lint, types and database tests run on 22 because they don't depend on the Node runtime. E2E builds and serves the app inside the Playwright image, so it runs on that image's Node (26 for 1.65.1), Vercel's default; only one Node version, to keep CI time down (a gap in M0.md). See the 2026-11-23 update below.

### Tools where there was a choice

| Choice | Options measured | Result | Decision |
|---|---|---|---|
| SAST | CodeQL and Semgrep, both run on PR 2 | Clean run: CodeQL 61 s (JS/TS) + 43 s (Actions), Semgrep 31 s, in parallel. Round A plants: both found the `eval(location.hash)` and the workflow script injection. Only Semgrep found a real gap on the clean tree (`.npmrc` had no minimum release age; fixed). CodeQL traces data flow, so it flagged the `eval` because the input is the URL; Semgrep flags every `eval` (2 rules matched the same line). | **Keep both.** They run in parallel, cost no money on a public repo, and each found something the other doesn't check. A Semgrep false positive is triaged with a `nosemgrep` comment and a reason; a CodeQL one is dismissed in code scanning with a reason. |
| Dependency scan | `npm audit` and OSV-Scanner, both run on PR 2 | On lodash 4.17.20 both reported the same 4 advisories; OSV adds about 1 s. OSV reads OSV.dev, whose sources include the GitHub Advisory Database and also the OpenSSF Malicious Packages feed ([OSV data sources](https://google.github.io/osv.dev/data/), read 2026-11-24), and its log gives a package count we cross-check against the lockfile. | **Keep both** for now: the cost is about 2 s. Revisit if one ever finds something the other doesn't, or never does by M6. |
| Secret scan | gitleaks (in CI) plus GitHub secret scanning and push protection (repo settings, already on) | gitleaks runs on every PR and is the only one that runs a canary; GitHub's push protection blocks known provider formats before they land | **gitleaks + GitHub**, with a custom `supabase-secret-key` rule in `.gitleaks.toml` |
| Dependency updates | Dependabot or Renovate | Not measured: Dependabot security updates were already on, and Renovate needs a third-party app with write access to the repo | **Dependabot**, weekly, 7-day cooldown, npm and github-actions |
| DCO | Probot DCO app or a script | A script needs no app with repo access, and its self-test runs every time | **Script** |

### Lockdown

- `permissions: {}` at the top; each job asks for `contents: read`, and only the CodeQL jobs add `security-events: write`.
- Actions pinned by full commit SHA (checkout v7.0.1, setup-node v7.1.0, codeql-action v4.39.3), gitleaks 8.30.1 and OSV-Scanner 2.7.1 pinned by SHA-256 of the release file, Semgrep 1.185.0 pinned by image digest. Each was at least 7 days old when pinned (codeql-action v4.39.4 was 3 days old, so v4.39.3).
- `persist-credentials: false` on every checkout, no `npm` cache (no cache to poison), no secrets, no `pull_request_target`.
- The DCO exemption for Dependabot applies only when GitHub reports the PR author as `dependabot[bot]`, and only to commits with Dependabot's author email.

## Consequences

- The required checks for the `main` ruleset are the check names above, plus **CodeQL** (or the ruleset's code scanning rule). The steps are in M0.md.
- A full run took about 4.5 minutes of wall time in PR 2, with E2E the longest job because it installed browser system packages from the Ubuntu apt mirror. That mirror later made E2E take up to 15 minutes; the update below replaces the install with a pinned image.
- Not pinned: Semgrep's registry rule packs (`p/default`, `p/typescript`) change over time. Recorded as a gap in M0.md.
- Merge commits are skipped by the DCO script and by gitleaks (git shows no patch for them). With squash merges only, the PR's own commits are all checked.

## Update 2026-11-23: E2E runs in Playwright's pinned image

**Problem.** Each E2E job ran `npx playwright install --with-deps <browser>`. The browser download itself took about 2 s (log of [job 138013981302](https://github.com/Gobbuwu/porchlet/actions/runs/45266297122/job/138013981302): WebKit's 101 MiB arrived in under a second), but `--with-deps` installs about 190 system packages from the Ubuntu apt mirror, whose speed varies a lot. Over the 18 E2E jobs in runs 45214507704, 45262210744, 45262579914, 45262800279, 45266297122 and 45269559576, the install step took 19 s to 888 s (median 254 s), it took over 2 minutes in 11 of the 18, and every browser was hit (Chromium 349 s, Firefox 435 s, WebKit 888 s at worst). Because the `main` ruleset requires branches to be up to date, each merge restarts that wait for every open PR.

**Decision.** E2E runs Playwright in Microsoft's official image, `mcr.microsoft.com/playwright:v1.65.1-noble`, pinned by its multi-arch index digest `sha256:1507cbfc…f525579` (created 2026-11-13, 10 days old when pinned). The image already holds all three browsers and their libraries, so nothing comes from apt or Playwright's CDN at run time. `scripts/ci/in-playwright-image.sh` runs `npm run build` and `npx playwright test` in it with `docker run --network host` rather than as a job `container:`, because from M1 the job starts local Supabase with Docker on the runner, which a job container can't reach without the Docker socket. `npm ci` (and, from M1, `supabase start`) still run on the runner with Node 22. The script fails if the installed Playwright version differs from the image tag, so a Dependabot bump of `@playwright/test` fails E2E with a clear message until the image is bumped too. The job limit goes back to 15 minutes.

**Options considered.** (1) Job `container:` with the image: simplest, but can't reach the runner's Docker for Supabase in M1. (2) `actions/cache` of the apt packages and browsers: still runs apt to install the cached `.deb` files, adds a cache that a PR could poison (ADR 0012 has no caches for that reason), and isn't pinned. (3) `docker run` of the pinned image (chosen). Option 3 was measured; 1 and 2 were not.

**Measured.** Local, in a cloud container (Docker 29.9.3): the image pull took 32 s (1,013 MB compressed for amd64); `npm run build` in the image 6 s; Chromium, Firefox and WebKit all passed as uid 1001 (the runner's user), with WebKit and Firefox run locally for the first time, since their CDN is blocked there. A planted heading change failed WebKit with exit 1, and a mismatched image tag failed the version check. CI timings are in M0.md.

**Consequences.** E2E now pins its browsers by image digest (closing the "browsers from the CDN without a checksum" gap) and serves the app on the image's Node 26 instead of 22. Dependabot does not update this digest (same as Semgrep's); bump it by hand with `@playwright/test`, using a tag at least 7 days old. The image runs the app and the browsers as the runner's user, and with `--ipc host`, which [Playwright's Docker docs](https://github.com/microsoft/playwright/blob/v1.65.1/docs/src/docker.md) recommend for Chromium ("Without it, Chromium can run out of memory and crash").
