import type { Page } from "@playwright/test";
import {
  EMAILED,
  HAS_ACCOUNT,
  inviteEmailLink,
  inviteFromPage,
  memberItems,
  openInvitations,
  shownInviteLink,
  SITE,
} from "./support/invites";
import { mailCount } from "./support/mail";
import { expect, test, waitForHydration } from "./support/test";
import {
  alertIn,
  confirmAndChoosePassword,
  fillLogin,
  newUser,
  readSession,
  signUp,
  signUpAndConfirm,
  supabaseEnv,
} from "./support/users";
import { createWorkspace, joinAsClient, logInAsAdmin, uniqueName } from "./support/workspaces";

// M2 PR 3: invites (docs/milestones/M2.md, threat model T5, T6, T8, T9, T14; ADR 0024).
// The hourly cap is in invite-cap.spec.ts, which runs after these (playwright.config.ts).
// Each test drives two or three browsers through email links, so they get more than 30 s.
test.describe.configure({ timeout: 90_000 });

async function ownerWorkspace(page: Page, tag: string) {
  await logInAsAdmin(page);
  const name = uniqueName(tag);
  const wid = await createWorkspace(page, name);
  return { wid, name };
}

async function choosePassword(page: Page, password: string) {
  await page.getByLabel(/^New password/).fill(password);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page).toHaveURL(/\/w\?password=changed$/);
}

test("a new address gets an email, joins, and chooses a password", async ({ browser, page }) => {
  const { wid, name } = await ownerWorkspace(page, "Invite new");
  const client = newUser("invited");
  const link = await inviteFromPage(page, client.email, EMAILED);
  await expect(openInvitations(page)).toHaveCount(1);
  await expect(openInvitations(page)).toContainText([client.email]);

  const ctx = await browser.newContext();
  const invitee = await ctx.newPage();
  // Opening the email's link and the copied link only shows pages; nothing is accepted (T6).
  const emailLink = await inviteEmailLink(client.email);
  await invitee.goto(emailLink);
  await expect(invitee.getByRole("heading", { level: 1 })).toHaveText("Join your Porchlet workspace");
  await page.reload();
  await expect(memberItems(page)).toHaveCount(1);
  await expect(openInvitations(page)).toHaveCount(1);

  await invitee.getByRole("button", { name: "Accept invitation" }).click();
  await expect(invitee).toHaveURL(/\/reset\?notice=invite-joined$/);
  await expect(invitee.getByRole("status")).toHaveText(/^You joined the workspace\./);
  // The new session can't use the app before it has a password (as with a reset link, ADR 0023).
  await invitee.goto("/w");
  await expect(invitee).toHaveURL(/\/reset\?error=new-password-required$/);
  await choosePassword(invitee, client.password);
  await invitee.getByRole("link", { name }).click();
  await expect(invitee.getByText("You are a client of this workspace.")).toBeVisible();

  // The password works, and the owner sees the client and no open invitation.
  await invitee.goto("/w");
  await invitee.getByRole("button", { name: "Log out" }).click();
  await expect(invitee).toHaveURL(/\/login\?signed_out=1$/);
  await fillLogin(invitee, client.email, client.password);
  await expect(invitee).toHaveURL(/\/w$/);
  await page.reload();
  await expect(memberItems(page)).toHaveCount(2);
  await expect(memberItems(page).filter({ hasText: client.email })).toContainText("client");
  await expect(openInvitations(page)).toHaveCount(0);

  // The copied link is used up too (one invitation, one use).
  await invitee.goto(link);
  await invitee.getByRole("button", { name: "Join workspace" }).click();
  await expect(alertIn(invitee)).toHaveText("This invitation was already used.");
  await ctx.close();
  expect(wid).toBeTruthy();
});

test("an existing account gets a link to copy; only that account can use it, once", async ({ browser, page }) => {
  const { wid, name } = await ownerWorkspace(page, "Invite existing");
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const b = await signUpAndConfirm(pageB, "existing");
  const mailsBefore = await mailCount(b.email);
  const link = await inviteFromPage(page, b.email, HAS_ACCOUNT);
  expect(await mailCount(b.email), "no invite email to an existing account").toBe(mailsBefore);

  // Another signed-in account can't use B's link (T5), and learns nothing about the workspace.
  const ctxC = await browser.newContext();
  const pageC = await ctxC.newPage();
  await signUpAndConfirm(pageC, "wrongaccount");
  await pageC.goto(link);
  await expect(pageC.getByText(name)).toHaveCount(0);
  await pageC.getByRole("button", { name: "Join workspace" }).click();
  await expect(alertIn(pageC)).toHaveText(/^This invitation is for a different email address\./);
  await pageC.goto("/w");
  await expect(pageC.getByText(name)).toHaveCount(0);

  // B opens it signed out: log in first, then back to the invite.
  await pageB.getByRole("button", { name: "Log out" }).click();
  await expect(pageB).toHaveURL(/\/login\?signed_out=1$/);
  await pageB.goto(link);
  await expect(pageB).toHaveURL(/\/login\?next=/);
  await fillLogin(pageB, b.email, b.password);
  await expect(pageB).toHaveURL(/\/invite\?token=[0-9a-f]{64}$/);
  await expect(pageB.getByText(`You are logged in as ${b.email}`)).toBeVisible();
  await pageB.getByRole("button", { name: "Join workspace" }).click();
  await expect(pageB).toHaveURL(`${SITE}/w/${wid}?notice=joined-workspace`);
  await expect(pageB.getByRole("status")).toHaveText("You joined the workspace.");

  // Used: a second press, by B or by anyone, is refused.
  await pageB.goto(link);
  await pageB.getByRole("button", { name: "Join workspace" }).click();
  await expect(alertIn(pageB)).toHaveText("This invitation was already used.");
  await ctxB.close();
  await ctxC.close();
});

test("someone's earlier sign-up with the address is replaced, so its password never gets in", async ({ browser, page }) => {
  await ownerWorkspace(page, "Invite pre-signup");
  const client = newUser("presignup");
  const otherPassword = `${client.password}-other`;
  // Anyone who knows the address signs up with it first (straight to Supabase Auth, which gives
  // the account's id) and doesn't confirm.
  const { url, key } = supabaseEnv();
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: key, "content-type": "application/json" },
    body: JSON.stringify({ email: client.email, password: otherPassword }),
  });
  expect(signup.status).toBe(200);
  const otherId = ((await signup.json()) as { id?: string }).id;
  expect(otherId).toMatch(/^[0-9a-f-]{36}$/);

  await inviteFromPage(page, client.email, EMAILED);
  const ctx = await browser.newContext();
  const invitee = await ctx.newPage();
  await invitee.goto(await inviteEmailLink(client.email));
  await invitee.getByRole("button", { name: "Accept invitation" }).click();
  await expect(invitee).toHaveURL(/\/reset\?notice=invite-joined$/);
  // The invite deleted that sign-up before its email, so the invited person is a new account.
  const token = (await readSession(ctx)).access_token;
  const sub = (JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: string }).sub;
  expect(sub).toMatch(/^[0-9a-f-]{36}$/);
  expect(sub).not.toBe(otherId);

  // The earlier sign-up's password, tried straight against Supabase Auth (past the app's login),
  // signs nobody in (ADR 0024 section 7).
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "content-type": "application/json" },
    body: JSON.stringify({ email: client.email, password: otherPassword }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error_code).toBe("invalid_credentials");
  await ctx.close();
});

test("an invitation accepted after the owner's page loaded can't be withdrawn", async ({ browser, page }) => {
  const { wid } = await ownerWorkspace(page, "Invite accepted");
  const ctx = await browser.newContext();
  const pageB = await ctx.newPage();
  const b = await signUpAndConfirm(pageB, "acceptfirst");
  const link = await inviteFromPage(page, b.email, HAS_ACCOUNT);
  await expect(openInvitations(page)).toHaveCount(1);
  // B joins while the owner's page still lists the invitation as open.
  await pageB.goto(link);
  await pageB.getByRole("button", { name: "Join workspace" }).click();
  await expect(pageB).toHaveURL(`${SITE}/w/${wid}?notice=joined-workspace`);

  await openInvitations(page).getByRole("button", { name: "Withdraw invitation" }).click();
  await expect(alertIn(page)).toHaveText("This invitation was already accepted, so it can't be withdrawn.");
  await page.goto(`/w/${wid}`);
  await expect(memberItems(page).filter({ hasText: b.email })).toContainText("client");
  await expect(openInvitations(page)).toHaveCount(0);
  await ctx.close();
});

test("withdrawing an invitation deletes the unused account, so the address can sign up", async ({ browser, page }) => {
  await ownerWorkspace(page, "Invite revoke");
  const e = newUser("withdrawn");
  await inviteFromPage(page, e.email, EMAILED);
  const emailLink = await inviteEmailLink(e.email);
  await openInvitations(page).getByRole("button", { name: "Withdraw invitation" }).click();
  await expect(page.getByRole("status")).toHaveText("Invitation withdrawn.");
  await expect(openInvitations(page)).toHaveCount(0);

  // The email's link no longer signs anyone in, and the invitation is gone.
  const ctx = await browser.newContext();
  const pageE = await ctx.newPage();
  await pageE.goto(emailLink);
  await pageE.getByRole("button", { name: "Accept invitation" }).click();
  await expect(pageE).toHaveURL(/\/login\?next=%2Finvite%3Ftoken%3D[0-9a-f]{64}&error=invite-email-link-used$/);
  await expect(alertIn(pageE)).toHaveText(/^The sign-in part of this email's link has expired or was already used;/);

  // With the invited account deleted, the address signs up normally and keeps the password it
  // chooses (T8).
  const before = await mailCount(e.email);
  await signUp(pageE, e.email);
  await confirmAndChoosePassword(pageE, e.email, e.password, before);
  await pageE.getByRole("button", { name: "Log out" }).click();
  await expect(pageE).toHaveURL(/\/login\?signed_out=1$/);
  await fillLogin(pageE, e.email, e.password);
  await expect(pageE).toHaveURL(/\/w$/);
  await ctx.close();
});

test("a pending invite, then the person's own sign-up: the email still gets them in", async ({ browser, page }) => {
  // Supabase Auth refuses a second email to the address within max_frequency (60 s), so the
  // sign-up waits it out, as a person would who signs up later (measured, M2.md D2).
  test.setTimeout(150_000);
  const { name } = await ownerWorkspace(page, "Invite then signup");
  const f = newUser("selfsignup");
  await inviteFromPage(page, f.email, EMAILED);
  const emailLink = await inviteEmailLink(f.email);
  await page.waitForTimeout(61_000);

  const ctx = await browser.newContext();
  const pageF = await ctx.newPage();
  const before = await mailCount(f.email);
  await signUp(pageF, f.email);
  await confirmAndChoosePassword(pageF, f.email, f.password, before);

  // The confirmation used up the invite email's sign-in part; the invitation is still open, and
  // this session is the invited address's, so the page offers to join.
  await pageF.goto(emailLink);
  await pageF.getByRole("button", { name: "Accept invitation" }).click();
  await expect(pageF).toHaveURL(/\/invite\?token=[0-9a-f]{64}&error=invite-email-link-used$/);
  await expect(alertIn(pageF)).toHaveText(/^The sign-in part of this email's link has expired or was already used;/);
  await pageF.getByRole("button", { name: "Join workspace" }).click();
  await expect(pageF.getByRole("heading", { level: 1 })).toHaveText(name);
  await ctx.close();
});

// T9: the links come from SITE_URL, never from the request's headers. The owner reaches the app
// as localhost:3000 while SITE_URL is 127.0.0.1:3000, so a link built from the Host or
// X-Forwarded-Host header would start with http://localhost:3000 and fail the link checks. Each
// such planted case fails this test (M2.md section 13).
test("invite links stay on the site's URL when the app is reached by another host name", async ({ browser }) => {
  const other = "http://localhost:3000";
  expect(new URL(other).host).not.toBe(new URL(SITE).host);
  const ctx = await browser.newContext({ baseURL: other });
  const page = await ctx.newPage();
  await ownerWorkspace(page, "Invite other host");
  const client = newUser("otherhost");
  const link = await inviteFromPage(page, client.email, EMAILED);
  expect(new URL(page.url()).origin).toBe(other);
  // The render that follows the action sees Next.js's own host name in Host (measured); a fresh
  // load sees the browser's, so the page's link is checked again.
  await page.reload();
  expect(await shownInviteLink(page)).toBe(link);
  expect(new URL(await inviteEmailLink(client.email)).searchParams.get("invite")).toBe(link);
  await ctx.close();
});

test("a replayed invite action is refused from another origin and for a client", async ({ page, context, browser }) => {
  const { wid } = await ownerWorkspace(page, "Invite replay");
  await waitForHydration(page);
  const post = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === `/w/${wid}`);
  const invited = newUser("replayed").email;
  await inviteFromPage(page, invited, EMAILED);
  await inviteEmailLink(invited);
  const real = await post;
  const headers = await real.allHeaders();
  const replay = (request: typeof page.request, origin: string) =>
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
  // T14: Next.js refuses a Server Action from a foreign Origin.
  const foreign = await replay(page.request, "https://evil.example");
  expect(foreign.status(), "foreign-origin replay").toBe(500); // Next.js: "Invalid Server Actions request"

  // A client of the workspace posting the owner's invite (for a fresh address) from our own
  // origin: create_invitation refuses it, and no email goes out (the secret key is used only
  // after the owner check).
  const clientCtx = await browser.newContext();
  const clientPage = await clientCtx.newPage();
  const client = await signUpAndConfirm(clientPage, "replayclient");
  await joinAsClient(context, clientCtx, wid, client.email);
  const target = newUser("replaytarget").email;
  const body = (real.postData() ?? "").replace(invited, target);
  expect(body).toContain(target);
  const asClient = await clientPage.request.post(real.url(), {
    headers: {
      "content-type": headers["content-type"],
      "next-action": headers["next-action"],
      accept: headers["accept"] ?? "text/x-component",
      origin: new URL(real.url()).origin,
    },
    data: body,
    maxRedirects: 0,
  });
  expect(asClient.status()).toBe(200);
  expect(await asClient.text()).toContain("You can't do that in this workspace.");
  await page.waitForTimeout(1_000);
  expect(await mailCount(target), "no invite email for a client's replay").toBe(0);
  await page.reload();
  await expect(openInvitations(page)).toHaveCount(1);
  await clientCtx.close();
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the invite form shows the link and its refusals after a native post", async ({ page }) => {
    await ownerWorkspace(page, "Invite nojs");
    const email = newUser("nojs").email;
    await inviteFromPage(page, email, EMAILED);
    await page.getByLabel("Client's email").fill(email);
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect(alertIn(page)).toHaveText(/^This address already has an open invitation\./);
    await expect(alertIn(page)).toHaveCount(1);
  });
});

test("the invite link shows only from this browser's own invite, not from a crafted URL", async ({ browser, page }) => {
  const { wid } = await ownerWorkspace(page, "Invite crafted");
  await inviteFromPage(page, newUser("own").email, EMAILED);
  // Another browser of the same owner: no invite of its own, so a URL can't make it show a link.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await logInAsAdmin(otherPage);
  await otherPage.goto(`/w/${wid}?notice=invite-sent&invite=${"a".repeat(64)}`);
  await expect(otherPage.getByRole("status")).toHaveText(EMAILED);
  await expect(otherPage.getByLabel("Invite link")).toHaveCount(0);
  await other.close();
});
