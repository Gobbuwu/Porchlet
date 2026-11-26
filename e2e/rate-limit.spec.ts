import { alertIn, fillLogin, newUser, signUp, signUpAndConfirm } from "./support/users";
import type { Page } from "@playwright/test";
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

test("the limit follows the address the host added, not entries the browser sent", async ({ page }) => {
  // Netlify, and reverse proxies like nginx's $proxy_add_x_forwarded_for, keep the browser's
  // X-Forwarded-For entries and append the address they saw (ADR 0028). Changing the earlier
  // entries on every try must not give a fresh bucket.
  const user = await signUpAndConfirm(page, "limit-chain");
  await page.context().clearCookies();
  const seen = randomIp();
  for (let i = 0; i < 5; i++) {
    await page.setExtraHTTPHeaders({ "x-forwarded-for": `${randomIp()}, ${seen}` });
    await page.goto("/login");
    await fillLogin(page, user.email, "not-the-password");
    await expect(alertIn(page)).toHaveText(WRONG);
  }
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `${randomIp()}, ${randomIp()}, ${seen}` });
  await page.goto("/login");
  await fillLogin(page, user.email, user.password);
  await expect(alertIn(page)).toHaveText(TOO_MANY);
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
    await signUp(page, user.email);
  }
  const user = newUser("limit-signup");
  await page.goto("/signup");
  await page.getByLabel("Email").fill(user.email);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(alertIn(page)).toHaveText(TOO_MANY);
});

// Posts the page's form as a native form post (no Next-Action header), once per entry of
// `posts`, and tallies what each post was answered with: the message code (ADR 0018: it comes back
// in the URL), or the path it ended on. With `parallel`, all posts are sent at once, which is how a
// client would get past a limiter whose check and count are separate steps. Sent from Node rather
// than the page, because a browser holds only about six connections per host and would queue them.
async function burst(page: Page, path: string, posts: Record<string, string>[], parallel = true) {
  // A signed-out visitor: a signed-in one is sent from the login page to the app.
  await page.context().clearCookies();
  await page.goto(path);
  const form = await page.evaluate(() => [...new FormData(document.querySelector("main form") as HTMLFormElement)]);
  const send = async (fields: Record<string, string>) => {
    const multipart = new FormData();
    for (const [name, value] of form) multipart.set(name, fields[name] ?? (value as string));
    const res = await page.request.post(path, { multipart });
    const url = new URL(res.url());
    return url.searchParams.get("error") ?? url.searchParams.get("notice") ?? `${url.pathname} ${res.status()}`;
  };
  const codes: string[] = [];
  if (parallel) codes.push(...(await Promise.all(posts.map(send))));
  else
    for (const fields of posts) {
      // Signed out before each post, so a login that worked doesn't turn the next post into a visit
      // by a signed-in user.
      await page.context().clearCookies();
      codes.push(await send(fields));
    }
  const tally: Record<string, number> = {};
  for (const code of codes) tally[code] = (tally[code] ?? 0) + 1;
  return tally;
}

test("parallel wrong passwords for one account stop at the per-account limit", async ({ page }) => {
  const user = await signUpAndConfirm(page, "limit-burst");
  const posts = Array.from({ length: 20 }, () => ({ email: user.email, password: "not-the-password" }));
  const tally = await burst(page, "/login", posts);
  expect(tally, JSON.stringify(tally)).toEqual({ "wrong-credentials": 5, "too-many-attempts": 15 });
});

test("parallel failed logins for many emails stop at the per-IP limit", async ({ page }) => {
  const posts = Array.from({ length: 35 }, () => ({ email: newUser("limit-burst-spray").email, password: "x-wrong" }));
  const tally = await burst(page, "/login", posts);
  expect(tally, JSON.stringify(tally)).toEqual({ "wrong-credentials": 20, "too-many-attempts": 15 });
});

test("parallel reset requests stop at the limit", async ({ page }) => {
  const posts = Array.from({ length: 15 }, () => ({ email: newUser("limit-burst-reset").email }));
  const tally = await burst(page, "/forgot", posts);
  expect(tally, JSON.stringify(tally)).toEqual({ "reset-sent": 5, "too-many-attempts": 10 });
});

test("successful logins give their attempt back, so they never use up the limit", async ({ page }) => {
  const user = await signUpAndConfirm(page, "limit-success");
  const right = Array.from({ length: 8 }, () => ({ email: user.email, password: user.password }));
  expect(await burst(page, "/login", right, false)).toEqual({ "/w 200": 8 });
  const wrong = Array.from({ length: 6 }, () => ({ email: user.email, password: "not-the-password" }));
  expect(await burst(page, "/login", wrong, false)).toEqual({ "wrong-credentials": 5, "too-many-attempts": 1 });
});
