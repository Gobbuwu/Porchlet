import type { Page } from "@playwright/test";
import { alertIn, signUpAndConfirm } from "./support/users";
import { expect, test, waitForHydration } from "./support/test";
import {
  adminUser,
  createProject,
  createWorkspace,
  joinAsClient,
  logInAsAdmin,
  projectItem,
  uniqueName,
} from "./support/workspaces";

// M2 PR 2: workspaces and projects (docs/milestones/M2.md, threat model T1, T11, T13, T14).

// A workspace the visitor isn't in looks like one that doesn't exist (T1). With Cache Components
// the page's request-time notFound() runs after the shell is sent, so the status stays 200 and
// Next.js marks the page noindex instead (ADR 0025; Next.js docs, loading.md "Status codes").
async function expectNotFound(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
  await expect(page.locator('meta[name="robots"][content="noindex"]')).toHaveCount(1);
}

test("the admin creates a workspace and manages its projects", async ({ page }) => {
  await logInAsAdmin(page);
  const name = uniqueName("Studio");
  const wid = await createWorkspace(page, name);
  await expect(page.getByRole("status")).toHaveText("Workspace created.");
  await expect(page.getByText("You are an owner of this workspace.")).toBeVisible();

  await createProject(page, "Website");
  const website = projectItem(page, "Website");
  await website.getByLabel("New name").fill("Website redesign");
  await website.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("status")).toHaveText("Project renamed.");
  const renamed = projectItem(page, "Website redesign");
  await renamed.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("status")).toHaveText("Project archived.");
  await expect(renamed).toHaveCount(0);
  const archived = page.getByRole("list", { name: "Archived projects" }).getByRole("listitem", { name: "Website redesign" });
  await archived.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("status")).toHaveText("Project restored.");
  await expect(projectItem(page, "Website redesign")).toBeVisible();

  // A name of spaces only passes the browser's `required` but not the server's check, and the
  // message shows on the form that was posted.
  await page.getByLabel("Project name").fill("   ");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(alertIn(page)).toHaveText("Enter a project name of 1 to 120 characters.");
  await expect(alertIn(page)).toHaveCount(1);

  // The admin is the only member, listed with their email.
  const members = page.getByRole("list", { name: "Members" }).getByRole("listitem");
  await expect(members).toHaveCount(1);
  await expect(members.first()).toContainText(adminUser().email);
  await expect(page.getByRole("button", { name: "Leave workspace" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove from workspace" })).toHaveCount(0);

  await page.goto("/w");
  await expect(page.getByRole("link", { name })).toHaveAttribute("href", `/w/${wid}`);
});

test("an outsider sees no workspace and gets the not-found page for one they aren't in", async ({ browser, page }) => {
  const admin = await browser.newContext();
  const adminPage = await admin.newPage();
  await logInAsAdmin(adminPage);
  const wid = await createWorkspace(adminPage, uniqueName("Private"));
  await createProject(adminPage, "Secret plans");

  await signUpAndConfirm(page, "outsider");
  await expect(page.getByText("You are not in any workspace yet.")).toBeVisible();
  // Only the admin may create workspaces (ADR 0025).
  await expect(page.getByRole("button", { name: "Create workspace" })).toHaveCount(0);
  await expectNotFound(page, `/w/${wid}`);
  await expect(page.getByText("Secret plans")).toHaveCount(0);
  // A malformed id gets the same page, not an error.
  await expectNotFound(page, "/w/not-a-uuid");
  await admin.close();
});

test("a client sees projects read-only and co-members without emails, then leaves", async ({ browser, page, context }) => {
  const admin = await browser.newContext();
  const adminPage = await admin.newPage();
  await logInAsAdmin(adminPage);
  const name = uniqueName("Shared");
  const wid = await createWorkspace(adminPage, name);
  await createProject(adminPage, "Logo");

  const client = await signUpAndConfirm(page, "client");
  await joinAsClient(admin, context, wid, client.email);
  await page.goto("/w");
  await expect(page.getByRole("listitem").filter({ hasText: name })).toContainText("(client)");
  await page.getByRole("link", { name }).click();
  await expect(page.getByText("You are a client of this workspace.")).toBeVisible();
  await expect(projectItem(page, "Logo")).toBeVisible();
  for (const button of ["Rename", "Archive", "Create project", "Remove from workspace"]) {
    await expect(page.getByRole("button", { name: button })).toHaveCount(0);
  }
  // Clients see display names only (decision D3): neither the owner's email nor their own.
  const members = page.getByRole("list", { name: "Members" });
  await expect(members.getByRole("listitem")).toHaveCount(2);
  await expect(members).not.toContainText("@");

  await page.getByRole("button", { name: "Leave workspace" }).click();
  await expect(page).toHaveURL(/\/w\?notice=left-workspace$/);
  await expect(page.getByRole("status")).toHaveText("You left the workspace.");
  await expect(page.getByText("You are not in any workspace yet.")).toBeVisible();
  await expectNotFound(page, `/w/${wid}`);
  await admin.close();
});

test("an owner removes a client, whose next page load is refused", async ({ browser, page, context }) => {
  const admin = await browser.newContext();
  const adminPage = await admin.newPage();
  await logInAsAdmin(adminPage);
  const wid = await createWorkspace(adminPage, uniqueName("Removal"));
  const client = await signUpAndConfirm(page, "removed");
  await joinAsClient(admin, context, wid, client.email);
  await page.goto(`/w/${wid}`);
  await expect(page.getByText("You are a client of this workspace.")).toBeVisible();

  await adminPage.reload();
  const row = adminPage.getByRole("list", { name: "Members" }).getByRole("listitem", { name: client.email });
  await expect(row).toContainText("client");
  await row.getByRole("button", { name: "Remove from workspace" }).click();
  await expect(adminPage.getByRole("status")).toHaveText("Member removed.");
  await expect(row).toHaveCount(0);

  // Threat model T11: RLS checks membership on every query, so access ends at once.
  await expectNotFound(page, `/w/${wid}`);
  await admin.close();
});

test("a replayed create-project action is refused from another origin and for a client", async ({
  browser,
  page,
  context,
}) => {
  const admin = await browser.newContext();
  const adminPage = await admin.newPage();
  await logInAsAdmin(adminPage);
  const wid = await createWorkspace(adminPage, uniqueName("Replay"));
  await waitForHydration(adminPage); // the replay needs React's request, with its Next-Action header
  const post = adminPage.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === `/w/${wid}`);
  await createProject(adminPage, "Original");
  const real = await post;
  const headers = await real.allHeaders();
  const replay = (request: typeof adminPage.request, origin: string) =>
    request.post(real.url(), {
      headers: {
        "content-type": headers["content-type"],
        "next-action": headers["next-action"],
        accept: headers["accept"] ?? "text/x-component",
        origin,
      },
      data: real.postDataBuffer() ?? undefined,
      maxRedirects: 0,
    });
  const own = new URL(real.url()).origin;

  // Threat model T14: Next.js refuses a Server Action from a foreign Origin.
  const foreign = await replay(adminPage.request, "https://evil.example");
  expect(foreign.status(), "foreign-origin replay").toBe(500); // Next.js: "Invalid Server Actions request"

  // A client of the workspace posting the owner's action from our own origin: RLS refuses it.
  const client = await signUpAndConfirm(page, "replayer");
  await joinAsClient(admin, context, wid, client.email);
  const asClient = await replay(page.request, own);
  expect(asClient.status()).toBe(200);
  expect(await asClient.text()).toContain("You can't do that in this workspace.");

  // Control: the owner's own replay from our origin works, so the refusals above are the checks.
  const asOwner = await replay(adminPage.request, own);
  expect(asOwner.status(), "own-origin replay by the owner").toBeLessThan(400);
  await adminPage.reload();
  await expect(projectItem(adminPage, "Original")).toHaveCount(2);
  await admin.close();
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("workspace forms show their messages after a native post", async ({ page }) => {
    // ADR 0018: a native post is redirected back with the message code; ADR 0025: the page shows
    // it on the form that was posted only.
    await logInAsAdmin(page);
    await createWorkspace(page, uniqueName("No JS"));
    await createProject(page, "Plain");
    await page.getByLabel("Project name").fill("   ");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page).toHaveURL(/error=project-name-invalid&form=create-project$/);
    await expect(alertIn(page)).toHaveText("Enter a project name of 1 to 120 characters.");
    await expect(alertIn(page)).toHaveCount(1);
    const plain = projectItem(page, "Plain");
    await plain.getByLabel("New name").fill(" ");
    await plain.getByRole("button", { name: "Rename" }).click();
    await expect(plain.getByRole("alert")).toHaveText("Enter a project name of 1 to 120 characters.");
    await expect(alertIn(page)).toHaveCount(1);
  });

  test("a refusal for a form that is gone shows at the top of the page", async ({ browser, page, context }) => {
    const admin = await browser.newContext({ javaScriptEnabled: false });
    const stale = await admin.newPage();
    await logInAsAdmin(stale);
    const wid = await createWorkspace(stale, uniqueName("Stale"));
    const client = await signUpAndConfirm(page, "stale");
    await joinAsClient(admin, context, wid, client.email);
    await stale.reload();
    // Removed from a second tab first, so the first tab's Remove button is for a member who is gone.
    const other = await admin.newPage();
    await other.goto(`/w/${wid}`);
    await other.getByRole("listitem", { name: client.email }).getByRole("button", { name: "Remove from workspace" }).click();
    await expect(other.getByRole("status")).toHaveText("Member removed.");
    await stale.getByRole("listitem", { name: client.email }).getByRole("button", { name: "Remove from workspace" }).click();
    await expect(stale).toHaveURL(/error=not-allowed&form=member-/);
    await expect(alertIn(stale)).toHaveText("You can't do that in this workspace.");
    await admin.close();
  });
});
