# 0025. Workspace pages: who sees "Create workspace", how their forms answer, and what a stranger sees

- Status: Accepted (2026-11-25, M2 PR 2). Builds on [ADR 0018](0018-native-form-posts-redirect-with-message.md) (native posts) and decision D5 in [M2.md](../milestones/M2.md) (Server Actions).

## Context

M2 PR 2 adds `/w` (the user's workspaces, and "Create workspace" for the instance admin) and `/w/[wid]` (projects, members, and the owner's and client's actions). Four questions came up that PR 1 and the plan didn't settle. Measured on the local stack (Supabase CLI 3.2.0, PostgreSQL 17.12, GoTrue v2.198.0, Next.js 16.4.6 `next start`, Chromium 1243 from Playwright 1.65.1, Linux cloud container).

## 1. How the page knows who the admin is

`private.instance.admin_user_id` is closed to the API roles (M0, ADR 0017), so the page can't read it.

| Option | Cost | Who sees the form |
|---|---|---|
| A. Show "Create workspace" to everyone; `create_workspace` refuses non-admins | None | Every client sees a form that always fails ("You can't do that") |
| **B. `public.is_instance_admin()`: a definer function that answers only about the caller (chosen)** | Migration `20261125020000_is_instance_admin.sql` (19 lines), `060_instance_admin.test.sql` (8 tests), one line in 040 test 12; one PostgREST call per `/w` load, 1.6 to 1.9 ms locally after the first (6 calls; the first took 16 ms), run in parallel with the page's two other queries | The admin only |
| C. An `ADMIN_EMAIL` env var in the app | An env var per deployment | The admin, but the env var and `private.instance` can disagree; M5's wizard would have to set both. Not built |

B: the function takes no arguments and names no one, so it tells a user nothing about anyone else; `create_workspace` still makes its own check, so the answer gates no data. `anon` can't execute it (baseline test 3, 060 tests 2 and 8; through PostgREST `anon` gets `42501`). Planted cases: `select true` fails 060 tests 3, 5 and 6 and the E2E outsider test; an `anon` grant fails baseline test 3 and 060 tests 2 and 8; `security invoker` fails 060 test 1 and stops the file (7 of 8 not run).

## 2. Messages on a page with many forms

ADR 0018's `answer()` redirects a native post back with `?error=<code>`. `/w/[wid]` has one form per project action and per member, so every form would show that message.

Chosen: `answer(page, outcome, form)` also puts `form=<key>` in the URL (`create-project`, `rename-<project id>`, `status-<project id>`, `member-<user id>`, `leave`, `create-workspace`), and `formStateFromParams(params, key)` gives the message only to the form with that key. A message with no key (the action's ids didn't parse) shows once at the top of the page. `answer()` moved from the auth actions to `src/lib/form-answer.ts` so both action files use one copy. Planted case: ignoring the key fails all six workspace E2E tests (the notice and errors show twice).

## 3. Success answers with a redirect on both paths

A Server Action that returns state doesn't re-render the page's Server Components, so the new project wouldn't appear. Options: `refresh()` from `next/cache` plus a returned notice (React path only; the native path still needs ADR 0018's redirect), or `redirect(page + "?notice=<code>")` on both paths.

Chosen: the redirect, one code path for both. Next.js renders the redirect target fresh in the same response. Planted case: returning the notice instead fails five of the six workspace E2E tests. Refusals still go back to the posted form through `answer()`.

## 4. A workspace the visitor isn't in

Threat model T1: such a workspace must look the same as one that doesn't exist. The page calls `notFound()` when RLS returns no workspace row or no membership, and for a malformed id.

With Cache Components, the response starts with the prerendered shell, so a request-time `notFound()` can't set the status: the page shows the not-found UI with status **200** and `<meta name="robots" content="noindex">` (measured; Next.js docs `03-file-conventions/loading.md`, "Status codes": "A request-time check inside the page runs after the shell is sent ... so the status remains `200`"). The docs' way to a real 404 is a check in the proxy.

| Option | Cost | Result |
|---|---|---|
| **A. Accept status 200 with the not-found page (chosen)** | None | Same page and status for "not a member" and "doesn't exist", so neither leaks; crawlers get `noindex` |
| B. Look the workspace up in the proxy and answer 404 | One more PostgREST call on every `/w/...` request, in addition to the page's own; cost not measured (**unverified**) | A real 404 status |

A, because the status is not what protects the data (RLS is, ADR 0004), and the two cases already answer identically. Tested: `expectNotFound` in `e2e/workspaces.spec.ts` checks the status, the heading, the `noindex` tag, and that the workspace's project name is absent. If SiegeKit's `access-control` reads a 200 here as access, that is a finding to report to SiegeKit (R2).

## Also

- The E2E admin: `scripts/e2e/make-admin.sh` creates a confirmed account through Supabase Auth's admin API with the local stack's secret key (used for that one call, never written; the script refuses a non-local API URL), runs `scripts/dev/make-admin.sql` on it, and writes its email and a random password to `.env.e2e-admin` (git-ignored). PR 3's planned CI grep for secret-key use (ADR 0005) must allow this file, as it must `scripts/ci/session-limit-check.sh`.
- Clients get members' display names through `workspace_members` and `profiles` under RLS; owners get emails through `list_workspace_members` (decision D3).
- No workspace rename UI: the policy exists (PR 1) but rename isn't in PR 2's scope.

## Consequences

- `/w` costs one more database call per load (measured above).
- New forms on multi-form pages must pass a form key to `answer()` and `formStateFromParams()`, or their native-post messages show on every form.
- `/w/[wid]` answers 200 for strangers; any check that looks for a 404 there must look for the not-found page instead.
