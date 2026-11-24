# 0018. Native form posts get their message through a redirect

- Status: Accepted (2026-11-24)

## Context

The auth forms (log in, sign up, reset request, new password, email link) post to Server Actions and show the result with React's `useActionState`. A form is sent as a native HTML form post, not through React, when the page has not hydrated yet (a slow device or connection, or a quick click) or when JavaScript is off.

Found while landing the Dependabot PRs: a native post ran its action, but the page that came back showed no message, on the server render and after it hydrated. A Firefox E2E failure on PR 4 (`password reset by email`, [job](https://github.com/Gobbuwu/porchlet/actions/runs/45296124667/job/138116841874)) was put down to it. Correction (2026-11-24): that test also types the same email twice, which in Playwright's headless Firefox can lose the submit click (M1.md, "Firefox: clicks lost to saved form history"), so either cause fits (unverified). [ADR 0014](0014-server-side-auth.md) and M1.md already listed "without JavaScript, form errors don't show" as a gap; it is the same bug.

Root cause, measured on 2026-11-24 with Next.js 16.4.6, React 19.3.1, `next start` and local Supabase:

- With Cache Components, the build saves a resume state ("postponed") for every page, even our empty shells (`.next/server/app/forgot.meta`).
- For a Server Action request, Next.js loads that state (`build/templates/app-page-runtime.js`: "If this is a dynamic RSC request or a server action request, we should use the postponed data from the static render") and renders the HTML with React's `resume()`.
- React's `resume()` creates its request with no form state (`resumeRequest` in `react-dom-server.node.production.js` passes `null`), so `useActionState` can't pick up the action's result. Next.js only passes `formState` to the full-render path.
- A logging wrapper around Next.js's Fizz calls showed the native post rendered through `resume` with options `onError,onAllReady,nonce` (no `formState`), and the returned HTML had no `<!--F!-->` form-state marker. Hydration matches on that marker, so the client ignores the state too, although it is in the page's flight data.

Upstream: [Next.js issue #99756](https://github.com/vercel/next.js/issues/99756) (open) reports the same class of bug. [PR #100740](https://github.com/vercel/next.js/pull/100740) was merged to canary on 2026-10-26 to fix it. The latest stable release is 16.4.6 (npm, 2026-11-09). On `16.5.0-canary.62` (2026-11-23) our pages still showed no message after a post with JavaScript off (measured), so waiting for an upgrade does not fix it for us today.

## Options

| Option | Covers | Cost |
|---|---|---|
| Wait for a Next.js release | Nothing today: still broken on 16.5.0-canary.62 (measured) | None now; the flake and the user-facing bug stay |
| Wait for hydration in E2E tests only | Nothing for users; hides the bug in CI | Small; rejected by the project rules (fix the class, not the test) |
| Hand `useActionState` a client function that calls the action (the workaround in #99756) | Pages with JavaScript; before hydration unverified | Removes the no-JS path completely (the issue says so: "It costs the form its no-JavaScript path"); not measured further |
| Patch Next.js in `node_modules` to pass form state on resume | All paths, if it works | Not measured; a patch to re-check on every Next.js bump |
| **Post/Redirect/Get for native posts (chosen)** | Every auth form, before hydration and with JavaScript off | 124 lines added and 44 removed in 9 files under `src`; one extra GET for a native post. Measured below |

## Decision

Each auth action ends with `answer(page, outcome)` (`src/app/(auth)/actions.ts`):

- **Sent by React** (the request has Next.js's `Next-Action` header, which Next.js itself uses to tell a fetch action from a form post, `server/lib/server-action-request-meta.js`): return the state to `useActionState`, as before.
- **Native post** (no header): redirect to the form's page with the message code in the URL, `?error=<code>` or `?notice=<code>`. Login keeps `?next=`; the email link keeps its `token_hash` and `type`, so a rate-limited visitor can press the button again.

Each page reads the codes with `formStateFromParams` (`src/lib/auth/types.ts`) and passes them to `AuthForm` as `initialState`. Only codes in `MESSAGES` (`src/lib/auth/messages.ts`) are shown, as their fixed text; anything else in the URL is ignored (`Object.hasOwn`, so `__proto__` or `constructor` show nothing). No text from the URL reaches the page.

The typed email is not put in the URL (it would land in history and server logs), so after a native post the email field is empty. With JavaScript it is kept, as before.

## Consequences

- Messages show on every auth form before hydration and with JavaScript off. This closes the M1 gap. E2E: `e2e/form-messages.spec.ts` (6 tests; all 6 fail on the code before this change, measured).
- E2E tests that check the React path itself (the typed email is kept; replaying React's request with its `Next-Action` header) now wait for hydration first (`waitForHydration` in `e2e/support/test.ts`). Every other test passes either way, so a quick click no longer flakes them.
- A message stays in the URL, so reloading the page shows it again. It is one of our fixed texts, so a crafted link can show only a message the app could show anyway.
- When a Next.js release renders native posts with their form state (re-test with the JavaScript-off tests), `answer()` can return the state on both paths and the URL codes can go. Until then, a new form must use `answer()` and read `formStateFromParams`, or its messages won't show without JavaScript.
