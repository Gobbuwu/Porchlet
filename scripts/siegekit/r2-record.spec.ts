// SiegeKit R2 recorder (docs/siegekit-schedule.md): makes accounts A, B and C on the LOCAL stack and
// records a HAR as A of every change the workspace page offers an owner. Run by r2-run.sh:
//   R2_OUT=<dir> npx playwright test -c scripts/siegekit/playwright.config.ts
// Writes: a.har (A's recording), session-b.txt and session-c.txt ("Cookie: ..." lines for
// SIEGEKIT_SESSION_B/C), accounts.json (emails and ids, no passwords). Local stack only.
// A = the instance admin from .env.e2e-admin, owner of workspace X.
// B = a client of X (shares X with A: tests the client-vs-owner boundary).
// C = an outsider: a confirmed account in no workspace.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test, waitForHydration } from "../../e2e/support/test";
import { signUpAndConfirm, newUser, isAuthCookie } from "../../e2e/support/users";
import { createProject, createWorkspace, logInAsAdmin, projectItem, uniqueName } from "../../e2e/support/workspaces";
import { HAS_ACCOUNT, EMAILED, inviteFromPage, openInvitations, memberItems } from "../../e2e/support/invites";

// No default: a fixed path in the shared temp directory could be made in advance by another local
// user (CodeQL js/insecure-temporary-file). r2-run.sh passes a directory only its user can read.
const OUT = process.env.R2_OUT ?? "";
const SITE = "http://127.0.0.1:3000";

async function cookieHeader(context: BrowserContext) {
  const cookies = (await context.cookies(SITE)).filter((c) => isAuthCookie(c.name));
  expect(cookies.length, "session cookie").toBeGreaterThan(0);
  return "Cookie: " + cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function joinWithLink(page: Page, link: string) {
  await page.goto(link);
  await waitForHydration(page);
  await page.getByRole("button", { name: "Join workspace" }).click();
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}/);
}

async function submit(page: Page, scope: ReturnType<Page["locator"]> | Page, button: string) {
  await waitForHydration(page);
  await scope.getByRole("button", { name: button }).click();
}

test("record R2 HAR as A", async ({ browser, page: bPage, context: bContext }) => {
  test.setTimeout(180_000);
  if (!OUT) throw new Error("set R2_OUT to an output directory (scripts/siegekit/r2-run.sh does)");
  mkdirSync(OUT, { recursive: true, mode: 0o700 });

  // B and C sign up through the UI (not recorded).
  const b = await signUpAndConfirm(bPage, "r2-b");
  const cContext = await browser.newContext({ baseURL: SITE });
  const cPage = await cContext.newPage();
  const c = await signUpAndConfirm(cPage, "r2-c");
  // D: another existing account, invited then removed by A.
  const dContext = await browser.newContext({ baseURL: SITE });
  const dPage = await dContext.newPage();
  const d = await signUpAndConfirm(dPage, "r2-d");
  // E: an address with no account: invited (email path), then withdrawn.
  const e = newUser("r2-e");

  // A logs in outside the recording, so the HAR holds no password.
  const loginContext = await browser.newContext({ baseURL: SITE });
  const loginPage = await loginContext.newPage();
  const admin = await logInAsAdmin(loginPage);
  const state = await loginContext.storageState();
  await loginContext.close();

  const har = join(OUT, "a.har");
  const aContext = await browser.newContext({
    baseURL: SITE,
    storageState: state,
    recordHar: { path: har, mode: "full", content: "embed", urlFilter: /^http:\/\/127\.0\.0\.1:3000\/(?!_next\/static\/)/ },
  });
  const a = await aContext.newPage();

  // Workspace X with two projects.
  await a.goto("/w");
  await waitForHydration(a);
  const xName = uniqueName("R2 X");
  const x = await createWorkspace(a, xName);
  await waitForHydration(a);
  await createProject(a, "R2 project one");
  await waitForHydration(a);
  await createProject(a, "R2 project two");

  // Rename, archive, restore project one.
  await waitForHydration(a);
  const one = projectItem(a, "R2 project one");
  await one.getByLabel("New name").fill("R2 project one renamed");
  await submit(a, one, "Rename");
  await expect(a.getByRole("status")).toHaveText("Project renamed.");
  await submit(a, projectItem(a, "R2 project one renamed"), "Archive");
  await expect(a.getByRole("status")).toHaveText(/archived/i);
  await submit(a, a.getByRole("list", { name: "Archived projects" }).getByRole("listitem", { name: "R2 project one renamed" }), "Restore");
  await expect(a.getByRole("status")).toHaveText(/restored/i);

  // Invites: B and D have accounts (link to copy), E gets an email.
  // Each invite starts from a fresh page, so the previous notice can't satisfy the next check.
  const invite = async (email: string, notice: RegExp) => {
    await a.goto(`/w/${x}`);
    await waitForHydration(a);
    return inviteFromPage(a, email, notice);
  };
  const bLink = await invite(b.email, HAS_ACCOUNT);
  const dLink = await invite(d.email, HAS_ACCOUNT);
  expect(dLink).not.toBe(bLink);
  await invite(e.email, EMAILED);

  await joinWithLink(bPage, bLink);
  await joinWithLink(dPage, dLink);

  // A reloads, withdraws E's invitation and removes D.
  await a.goto(`/w/${x}`);
  await submit(a, openInvitations(a).filter({ hasText: e.email }), "Withdraw invitation");
  await expect(a.getByRole("status")).toHaveText(/withdrawn/i);
  await submit(a, memberItems(a).filter({ hasText: d.email }), "Remove from workspace");
  await expect(a.getByRole("status")).toHaveText(/removed/i);

  // Read pages again as A.
  await a.goto("/w");
  await a.goto(`/w/${x}`);
  await expect(memberItems(a).filter({ hasText: b.email })).toHaveCount(1);
  await aContext.close(); // writes the HAR; A is not logged out, so its session stays valid.

  writeFileSync(join(OUT, "session-b.txt"), (await cookieHeader(bContext)) + "\n", { mode: 0o600 });
  writeFileSync(join(OUT, "session-c.txt"), (await cookieHeader(cContext)) + "\n", { mode: 0o600 });
  writeFileSync(
    join(OUT, "accounts.json"),
    JSON.stringify({ a: admin.email, b: b.email, c: c.email, d: d.email, e: e.email, workspaceX: x }, null, 2) + "\n",
  );
});
