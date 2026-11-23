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
| Dependency scan | `npm audit --audit-level=low`, `npm audit signatures`, OSV-Scanner with a package-count cross-check | Any advisory; a bad signature; OSV scanning a different number of packages than the lockfile holds |
| SAST (CodeQL, javascript-typescript), (CodeQL, actions) | CodeQL `security-extended`, results uploaded to code scanning | The job fails only on errors; findings fail the separate **CodeQL** check that code scanning adds |
| SAST (Semgrep) | `semgrep scan --config p/default --config p/typescript --error` | Any finding |

Node versions: Vercel offers 26.x (default), 24.x and 22.x ([Vercel docs](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)); Netlify's build image defaults to 24 and reads `.nvmrc` ([Netlify docs](https://docs.netlify.com/build/configure-builds/available-software-at-build-time/)). The build runs on all three. Lint, types and database tests run on 22 because they don't depend on the Node runtime. E2E runs on 22 only to keep CI time down; that is a gap in M0.md.

### Tools where there was a choice

| Choice | Options measured | Result | Decision |
|---|---|---|---|
| SAST | CodeQL and Semgrep, both run on PR 2 | Clean run: CodeQL 61 s (JS/TS) + 43 s (Actions), Semgrep 31 s, in parallel. Round A plants: both found the `eval(location.hash)` and the workflow script injection. Only Semgrep found a real gap on the clean tree (`.npmrc` had no minimum release age; fixed). CodeQL traces data flow, so it flagged the `eval` because the input is the URL; Semgrep flags every `eval` (2 rules matched the same line). | **Keep both.** They run in parallel, cost no money on a public repo, and each found something the other doesn't check. A Semgrep false positive is triaged with a `nosemgrep` comment and a reason; a CodeQL one is dismissed in code scanning with a reason. |
| Dependency scan | `npm audit` and OSV-Scanner, both run on PR 2 | On lodash 4.17.20 both reported the same 4 advisories; OSV adds about 1 s. OSV reads OSV.dev, which aggregates more sources than the GitHub Advisory Database (from memory, **unverified**), and its log gives a package count we cross-check against the lockfile. | **Keep both** for now: the cost is about 2 s. Revisit if one ever finds something the other doesn't, or never does by M6. |
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
- A full run takes about 4.5 minutes of wall time; WebKit E2E is the longest job (about 4.5 minutes, mostly installing the browser). E2E jobs have a 30-minute limit because that install pulls system packages from the Ubuntu apt mirror, which once took over 15 minutes.
- Not pinned: Semgrep's registry rule packs (`p/default`, `p/typescript`) change over time, and Playwright downloads browsers from Microsoft's CDN without a checksum we control. Recorded as gaps in M0.md.
- Merge commits are skipped by the DCO script and by gitleaks (git shows no patch for them). With squash merges only, the PR's own commits are all checked.
