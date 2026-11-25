import type { BrowserContext } from "@playwright/test";
import { confirmLink, mailCount, verifyLink } from "./support/mail";
import { expect, test } from "./support/test";
import {
  alertIn,
  expireSession,
  fillLogin,
  flaggedUser,
  newUser,
  openResetLink,
  readSession,
  signUp,
  signUpAndConfirm,
  supabaseEnv,
} from "./support/users";

// Changing the password asks for the current one, unless the session came from an emailed link
// (require_current_password in supabase/config.toml, ADR 0023). A session a reset link starts can't
// open the app until it saves a new password, and the forced-change flag (ADR 0021) follows only
// its own user.

const REQUIRED_AT_LOGIN =
  "The password you logged in with is too short, too common or has appeared in a data breach. Choose a new one to continue.";
const NEW_PASSWORD_REQUIRED = "Save a new password to continue, or log out.";

test("a password session must give its current password, also when calling Supabase Auth directly", async ({
  page,
}) => {
  const user = await signUpAndConfirm(page, "current-pw");
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login\?signed_out=1$/);
  await fillLogin(page, user.email, user.password);
  await expect(page).toHaveURL(/\/w$/);

  // Supabase Auth itself refuses the change without it, so a stolen session token can't skip the
  // form by calling the API with the public key.
  const { url, key } = supabaseEnv();
  const { access_token } = await readSession(page.context());
  const direct = await fetch(`${url}/auth/v1/user`, {
    method: "PUT",
    headers: { apikey: key, authorization: `Bearer ${access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ password: `${user.password}-direct` }),
  });
  expect(direct.status).toBe(400);
  expect(((await direct.json()) as { error_code?: string }).error_code).toBe("current_password_required");

  await page.goto("/reset");
  const save = page.getByRole("button", { name: "Save new password" });
  // Left empty (the browser's required check off, as a forged post would be).
  await page.locator("form", { has: save }).evaluate((f: HTMLFormElement) => (f.noValidate = true));
  await page.getByLabel(/^New password/).fill(`${user.password}-new`);
  await save.click();
  await expect(alertIn(page)).toHaveText("Enter your current password.");

  await page.getByLabel("Current password").fill("not-the-current-password");
  await page.getByLabel(/^New password/).fill(`${user.password}-new`);
  await save.click();
  await expect(alertIn(page)).toHaveText("Your current password is wrong.");

  await page.getByLabel("Current password").fill(user.password);
  await page.getByLabel(/^New password/).fill(`${user.password}-new`);
  await save.click();
  await expect(page).toHaveURL(/\/w\?password=changed$/);
  await page.getByRole("button", { name: "Log out" }).click();
  await fillLogin(page, user.email, `${user.password}-new`);
  await expect(page).toHaveURL(/\/w$/);
});

test("a session from an emailed link isn't asked for the current password", async ({ page }) => {
  const user = await signUpAndConfirm(page, "link-no-current");
  // The confirmation link's session.
  await page.goto("/reset");
  await expect(page.getByLabel(/^New password/)).toBeVisible();
  await expect(page.getByLabel("Current password")).toHaveCount(0);
  // A reset link's session.
  await page.context().clearCookies();
  await openResetLink(page, user.email);
  await expect(page.getByLabel(/^New password/)).toBeVisible();
  await expect(page.getByLabel("Current password")).toHaveCount(0);
});

test("a reset link's session can't open the app until it saves a new password", async ({ page, context }) => {
  // The reproduced case: a flagged user logs out (dropping the flag), then uses a reset link.
  const user = await flaggedUser(page, context, "reset-unfinished");
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login\?signed_out=1$/);
  await openResetLink(page, user.email);
  await page.goto("/w");
  await expect(page).toHaveURL(/\/reset\?error=new-password-required$/);
  await expect(alertIn(page)).toHaveText(NEW_PASSWORD_REQUIRED);
  await page.getByLabel(/^New password/).fill(`${newUser("x").password}-new`);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page).toHaveURL(/\/w\?password=changed$/);
  await page.goto("/w");
  await expect(page).toHaveURL(/\/w$/);
});

test("another account's link in a flagged browser isn't given that flag", async ({ page, context, browser }) => {
  // B signs up in another browser but confirms in this one, after A was flagged here.
  const b = newUser("flag-other-b");
  const other = await browser.newContext();
  await signUp(await other.newPage(), b.email, b.password);
  await other.close();
  await flaggedUser(page, context, "flag-other-a");
  await page.goto(await confirmLink(b.email, /Confirm your Porchlet account/));
  await page.getByRole("button", { name: "Confirm email" }).click();
  await expect(page).toHaveURL(/\/w$/);
  await page.goto("/w");
  await expect(page).toHaveURL(/\/w$/);

  // B's reset link here: B must save a new password, but isn't told it logged in with a bad one.
  await openResetLink(page, b.email);
  await page.goto("/w");
  await expect(page).toHaveURL(/\/reset\?error=new-password-required$/);
  await expect(alertIn(page)).toHaveText(NEW_PASSWORD_REQUIRED);
});

test("a flagged session that has ended is told to log in again, not that a reset link expired", async ({
  page,
  context,
}) => {
  await flaggedUser(page, context, "flag-ended");
  await expect(alertIn(page)).toHaveText(REQUIRED_AT_LOGIN);
  // End the session server-side while this page is open: the form's post still carries an access
  // token that hasn't expired.
  await endSessionServerSide(context);
  await page.getByLabel("Current password").fill("password1234");
  await page.getByLabel(/^New password/).fill(`${newUser("x").password}-new`);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(alertIn(page)).toHaveText("Your session has ended. Log in again.");
  // The browser is signed out too, so logging in again works at once (the still-valid access token
  // would otherwise send /login to /w and back to /reset).
  await page.goto("/login");
  await expect(page).toHaveURL(/\/login$/);
});

test("/reset for an ended password session says to log in again", async ({ page, context }) => {
  await flaggedUser(page, context, "flag-expired");
  await endSessionServerSide(context);
  // Once the access token expires too (as the idle limit would), the proxy can't refresh it.
  await expireSession(context);
  await page.goto("/reset?error=password-change-required");
  await expect(alertIn(page)).toHaveText("Your session has ended. Log in again.");
  await expect(page.getByRole("link", { name: "Log in again" })).toHaveAttribute("href", "/login");
  // Where the form's answer lands when posted without JavaScript.
  await page.goto("/reset?error=session-ended");
  await expect(alertIn(page)).toHaveText("Your session has ended. Log in again.");
});

test("a sign-in link of the same user in a flagged browser keeps the flag", async ({ page, context }) => {
  const user = await flaggedUser(page, context, "flag-same-user");
  // Supabase sends a sign-in link to anyone who asks its API; its token is the token hash that
  // /auth/confirm takes with type=email.
  const { url, key } = supabaseEnv();
  const before = await mailCount(user.email);
  const otp = await fetch(`${url}/auth/v1/otp`, {
    method: "POST",
    headers: { apikey: key, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, create_user: false }),
  });
  expect(otp.status).toBe(200);
  const token = new URL(await verifyLink(user.email, /Your sign-in link/, before)).searchParams.get("token");
  expect(token).toBeTruthy();
  await page.goto(`/auth/confirm?${new URLSearchParams({ token_hash: token!, type: "email" })}`);
  await page.getByRole("button", { name: "Confirm email" }).click();
  await expect(page).toHaveURL(/\/reset\?error=new-password-required$/);
  await page.goto("/w");
  await expect(page).toHaveURL(/\/reset\?error=new-password-required$/);
});

test("a form rendered for a link session, posted after a password login, asks for the current password", async ({
  page,
  context,
}) => {
  const user = await signUpAndConfirm(page, "stale-form");
  await context.clearCookies();
  await openResetLink(page, user.email);
  await expect(page.getByLabel("Current password")).toHaveCount(0);
  // In another tab of the same browser: log out, then log in with the password.
  const tab = await context.newPage();
  await tab.goto("/reset");
  await tab.getByRole("button", { name: "Log out" }).click();
  await expect(tab).toHaveURL(/\/login\?signed_out=1$/);
  await fillLogin(tab, user.email, user.password);
  await expect(tab).toHaveURL(/\/w$/);
  // The first tab's form has no field for it; the page reloads with one.
  await page.getByLabel(/^New password/).fill(`${user.password}-new`);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page).toHaveURL(/\/reset\?error=current-password-required$/);
  await expect(alertIn(page)).toHaveText("Enter your current password.");
  await page.getByLabel("Current password").fill(user.password);
  await page.getByLabel(/^New password/).fill(`${user.password}-new`);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page).toHaveURL(/\/w\?password=changed$/);
});

async function endSessionServerSide(context: BrowserContext) {
  const { url, key } = supabaseEnv();
  const { access_token } = await readSession(context);
  const logout = await fetch(`${url}/auth/v1/logout?scope=global`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${access_token}` },
  });
  expect(logout.status).toBe(204);
}
