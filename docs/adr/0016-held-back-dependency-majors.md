# 0016. Hold back @types/node and TypeScript majors; take ESLint 10

- Status: Accepted (2026-11-24)

## Context

Dependabot's first npm run opened four PRs (#3 to #6). Each was tested on its own branch on 2026-11-24 (Node 22.23.5, npm 10.9.9), plus full CI.

| PR | Update | What was measured | Result |
|---|---|---|---|
| #6 | supabase CLI 3.1.0 → 3.2.0 | Lockfile diff only touches the CLI and its platform packages; full CI | Merged |
| #4 | ESLint 9.39.5 → 10.15.0 | Planted files hitting every enabled rule of eslint-plugin-react, -jsx-a11y and -import, linted with ESLint 9 and 10 | Same 27 findings from 23 rules, same lines; same 86 enabled rules. Taken (below) |
| #5 | TypeScript 5.9.3 → 7.0.2 | `npm run lint`, `npm run typecheck`, `npm run build` | Lint crashes: "Error: typescript-eslint does not support TS 7.0." Held back |
| #3 | @types/node 22.20.5 → 26.6.6 | A call to `http.setGlobalProxyFromEnv()` (`@since v25.4.0`) | Type-checks with 26, fails with 22 (TS2339); on Node 22.23.5 the function is `undefined`. Held back |

**ESLint 10.** eslint-plugin-import 2.32.0, eslint-plugin-react 7.37.5 and eslint-plugin-jsx-a11y 6.10.2 (all used by eslint-config-next 16.4.6, all their latest releases) declare peer ESLint up to `^9`, so `npm ci` prints a peer warning. The planted-file comparison shows every rule they enable here still reports under ESLint 10. ESLint 9.39.5 is marked deprecated on npm ("This version is no longer supported"), so staying on 9 also has a cost.

**TypeScript 7.** TypeScript 7.0.2 ships no JavaScript compiler API (its package exports only `version.cjs` and `unstable/*`). typescript-eslint, which eslint-config-next uses (8.73.0 in the lockfile; 8.74.0, the latest, is the same), declares `typescript: ">=4.8.4 <6.1.0"` and throws on load. `tsc --noEmit` and `next build` pass on 7.0.2, so the only blocker is lint.

**@types/node.** `engines.node` is `>=22` and CI builds on Node 22, 24 and 26. Types newer than the lowest supported Node let code use APIs that crash on Node 22, and type checking can't catch it.

## Decision

- Take ESLint 10 (#4).
- Hold TypeScript at versions below 6.1.0 with a Dependabot `ignore` rule, so Dependabot can still offer 6.0.x (6.0.3, 2026-04-16, is inside typescript-eslint's range). Close #5.
- Hold `@types/node` majors with a Dependabot `ignore` rule, and raise it only with `engines.node`. Minor and patch updates of 22.x still come. Close #3.

## Consequences

- Revisit TypeScript when typescript-eslint supports 7 (watch its peer range), and remove the rule then.
- If a plugin breaks on ESLint 10 later, lint fails loudly in CI (`--max-warnings 0`, and a crash exits non-zero), (a crash exits with code 2: measured with TypeScript 7), so there is no silent loss.
- The peer warning from `npm ci` stays until those three plugins declare ESLint 10.
