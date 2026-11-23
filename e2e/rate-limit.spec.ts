import { alertIn, fillLogin, newUser, signUp, signUpAndConfirm } from "./support/users";
import { expect, randomIp, test } from "./support/test";

// Porchlet's own per-visitor limits (ADR 0015). Local Supabase Auth has no per-IP limits
// (M1.md), so every 429 here comes from Porchlet's limiter.

const WRONG = "Wrong email or password.";
const TOO_MANY = "Too many attempts, try again later.";

test("five wrong passwords block that account from that IP only", async ({ page, browser }) => {
  const user = await signUpAndConfirm(page, "limit-account");
  await page.context().clearCookies();

  for (let i = 0; i < 5; i++) {
    await page.goto("/login");
    await fillLogin(page, user.email, "not-the-password");
    await expect(alertIn(page)).toHaveText(WRONG);
  }
  // The sixth try is refused even with the right password.
  await page.goto("/login");
  await fillLogin(page, user.email, user.password);
  await expect(alertIn(page)).toHaveText(TOO_MANY);

  // The same account from another IP still logs in: no account lockout an attacker could use.
  const other = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": randomIp() } });
  const otherPage = await other.newPage();
  await otherPage.goto("/login");
  await fillLogin(otherPage, user.email, user.password);
  await expect(otherPage).toHaveURL(/\/w$/);
  await other.close();
});

test("twenty failed logins block that IP, and other visitors are unaffected", async ({ page, browser }) => {
  test.slow();
  for (let i = 0; i < 20; i++) {
    await page.goto("/login");
    await fillLogin(page, newUser("limit-spray").email, "not-the-password");
    await expect(alertIn(page)).toHaveText(WRONG);
  }
  await page.goto("/login");
  await fillLogin(page, newUser("limit-spray").email, "not-the-password");
  await expect(alertIn(page)).toHaveText(TOO_MANY);

  // The shared-limit bug this fixes: another visitor still gets a normal answer.
  const other = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": randomIp() } });
  const otherPage = await other.newPage();
  await otherPage.goto("/login");
  await fillLogin(otherPage, newUser("limit-other").email, "not-the-password");
  await expect(alertIn(otherPage)).toHaveText(WRONG);
  await other.close();
});

test("sign-up is limited per IP", async ({ page }) => {
  for (let i = 0; i < 10; i++) {
    const user = newUser("limit-signup");
    await signUp(page, user.email, user.password);
  }
  const user = newUser("limit-signup");
  await page.goto("/signup");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel(/^Password/).fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(alertIn(page)).toHaveText(TOO_MANY);
});
