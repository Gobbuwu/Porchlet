import {
  breachStatus,
  isCommonPassword,
  loginNeedsPasswordChange,
  newPasswordProblem,
} from "../src/lib/auth/password-check";
import type { Page } from "@playwright/test";
import { confirmLink } from "./support/mail";
import { expect, test } from "./support/test";
import {
  alertIn,
  fillLogin,
  flaggedUser,
  newUser,
  openResetLink,
  openSignInLink,
  setPasswordDirectly,
  signUp,
  signUpAndConfirm,
  supabaseEnv,
} from "./support/users";

// New passwords are checked against common and breached passwords (ADR 0019).

const COMMON_MESSAGE = "Choose a different password: this one is too common or has appeared in a data breach.";

// A new account just after its confirm link, on the page where it chooses its first password
// (sign-up asks only for the email, ADR 0027).
async function newAccountChoosingPassword(page: Page, tag: string) {
  const user = newUser(tag);
  await signUp(page, user.email);
  await page.goto(await confirmLink(user.email, /Confirm your Porchlet account/));
  await page.getByRole("button", { name: "Confirm email" }).click();
  await expect(page).toHaveURL(/\/reset\?notice=email-confirmed$/);
  // The browser's length check is turned off, so the server decides.
  const save = page.getByRole("button", { name: "Save new password" });
  await page.locator("form", { has: save }).evaluate((f: HTMLFormElement) => (f.noValidate = true));
  return user;
}

// Whether `password` signs `email` in, tried straight against Supabase Auth (past the app's checks).
async function passwordWorks(email: string, password: string) {
  const { url, key } = supabaseEnv();
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return res.status === 200;
}

test("a new account's first password can't be a common one", async ({ page }) => {
  const user = await newAccountChoosingPassword(page, "common");
  // In the bundled list as "qwertyuiop"; the check ignores case.
  await page.getByLabel(/^New password/).fill("QwertyUIOP");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(alertIn(page)).toHaveText(COMMON_MESSAGE);
  expect(await passwordWorks(user.email, "QwertyUIOP"), "the refused password was not set").toBe(false);
});

// The minimum counts characters (code points), in Porchlet and in Supabase Auth (measured with
// GoTrue v2.198.0); counting bytes would let a short multi-byte password through (ADR 0021).
// 5 emoji are 5 characters, 20 bytes and 10 UTF-16 units. Browsers count the field's minlength
// differently, so the browser check is turned off and the server decides.
test("a password of 5 emoji (20 bytes) is refused as too short", async ({ page }) => {
  const user = await newAccountChoosingPassword(page, "short-multibyte");
  await page.getByLabel(/^New password/).fill("😀".repeat(5));
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(alertIn(page)).toHaveText("Choose a longer password: at least 10 characters.");
  expect(await passwordWorks(user.email, "😀".repeat(5)), "the refused password was not set").toBe(false);
});

// Supabase's maximum is 72 bytes, and it refuses longer passwords with the code it uses for a bad
// email, so Porchlet checks the length itself (ADR 0021). 19 emoji are 76 bytes but only 38 UTF-16
// units, under the field's maxlength of 72; the browser check is off anyway, as above.
test("a password over 72 bytes is refused as too long, not as a bad email", async ({ page }) => {
  const user = await newAccountChoosingPassword(page, "long-multibyte");
  await page.getByLabel(/^New password/).fill("😀".repeat(19));
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(alertIn(page)).toHaveText(
    "Choose a shorter password: at most 72 bytes, which is 72 plain letters or digits, or fewer with accents, other alphabets or emoji.",
  );
  expect(await passwordWorks(user.email, "😀".repeat(19)), "the refused password was not set").toBe(false);
});

// The check runs again at every login (ADR 0021). A password set by calling Supabase Auth
// directly skips the sign-up and reset checks; the next login catches it and the session can't use
// the app until the password is changed.
test("a login with a common password set outside the app must change it first", async ({ page, context }) => {
  const user = await signUpAndConfirm(page, "weak-login");
  await setPasswordDirectly(context, "password1234");
  await page.getByRole("button", { name: "Log out" }).click();

  const REQUIRED =
    "The password you logged in with is too short, too common or has appeared in a data breach. Choose a new one to continue.";
  await fillLogin(page, user.email, "password1234");
  await expect(page).toHaveURL(/\/reset\?error=password-change-required$/);
  await expect(alertIn(page)).toHaveText(REQUIRED);
  // Every app page sends the flagged session back here.
  await page.goto("/w");
  await expect(page).toHaveURL(/\/reset\?error=password-change-required$/);
  // The flag outlives a browser restart (a session-only cookie would not), belongs to this session
  // only, and the page offers a way out.
  const flag = (await context.cookies()).find((c) => c.name === "porchlet-password-change");
  expect(flag?.expires, "flag cookie is persistent").toBeGreaterThan(Date.now() / 1000 + 86_400);
  expect(flag?.httpOnly).toBe(true);
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  // The session logged in with a password, so Supabase Auth asks for it again (ADR 0023).
  await page.getByLabel("Current password").fill("password1234");
  // The new password is checked as usual.
  await page.getByLabel(/^New password/).fill("password12345");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(alertIn(page)).toHaveText(COMMON_MESSAGE);

  const strong = `${user.password}-new`;
  await page.getByLabel("Current password").fill("password1234");
  await page.getByLabel(/^New password/).fill(strong);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page).toHaveURL(/\/w\?password=changed$/);
  await page.goto("/w");
  await expect(page).toHaveURL(/\/w$/);
  await page.getByRole("button", { name: "Log out" }).click();
  await fillLogin(page, user.email, strong);
  await expect(page).toHaveURL(/\/w$/);
  expect((await context.cookies()).map((c) => c.name)).not.toContain("porchlet-password-change");
});

test("a leftover flag cookie from another session doesn't hold up a different sign-in", async ({ page, context }) => {
  const user = await signUpAndConfirm(page, "stale-flag");
  const [session] = (await context.cookies()).filter((c) => /^porchlet-auth/.test(c.name));
  // As if a flagged session had ended without logging out, leaving its cookie behind.
  await context.addCookies([{ ...session, name: "porchlet-password-change", value: "a-session-that-ended" }]);
  await page.goto("/w");
  await expect(page).toHaveURL(/\/w$/);
  // Nor is its reason carried to the same user's sign-in link: the current session isn't the flagged
  // one. The link's session must still choose a password, as every emailed link's does (ADR 0027).
  await openSignInLink(page, user.email);
  await expect(page).toHaveURL(/\/reset\?notice=email-confirmed$/);
});

test("a reset link doesn't get a flagged session past the change", async ({ page, context }) => {
  const user = await flaggedUser(page, context, "flag-reset-link");
  // A reset link in the same browser starts a new session, which must also save a new password.
  await openResetLink(page, user.email);
  await page.goto("/w");
  await expect(page).toHaveURL(/\/reset\?error=new-password-required$/);
});

test("a flagged session can log out from /reset", async ({ page, context }) => {
  await flaggedUser(page, context, "flag-logout");
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login\?signed_out=1$/);
  expect((await context.cookies()).map((c) => c.name)).not.toContain("porchlet-password-change");
});

// The breach lookup itself, with a stand-in for the Pwned Passwords API (no browser needed, so it
// runs once, in the chromium project). SHA-1("password1234") is E6B6A + FBD6D76BB5D2041542D7D2E3FAC5BB05593.
test.describe("breach lookup", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "plain Node code: one browser is enough");

  // newPasswordProblem reads BREACHED_PASSWORD_CHECK; these tests need the lookup on, even when
  // the runner's environment turns it off (as .env.example allows for hosts without internet).
  const saved = process.env.BREACHED_PASSWORD_CHECK;
  test.beforeEach(() => {
    delete process.env.BREACHED_PASSWORD_CHECK;
  });
  test.afterEach(() => {
    if (saved === undefined) delete process.env.BREACHED_PASSWORD_CHECK;
    else process.env.BREACHED_PASSWORD_CHECK = saved;
  });

  const SUFFIX = "FBD6D76BB5D2041542D7D2E3FAC5BB05593";
  const calls: { url: string; init?: RequestInit }[] = [];
  const api =
    (body: string, status = 200): typeof fetch =>
    async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(body, { status });
    };

  test("sends only the 5-character prefix, with padding asked for", async () => {
    calls.length = 0;
    await breachStatus("password1234", api(""));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.pwnedpasswords.com/range/E6B6A");
    expect(new Headers(calls[0].init?.headers).get("add-padding")).toBe("true");
  });

  test("a listed suffix with a count is breached, in either case", async () => {
    expect(await breachStatus("password1234", api(`0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${SUFFIX}:42`))).toBe("breached");
    expect(await breachStatus("password1234", api(`${SUFFIX.toLowerCase()}:3`))).toBe("breached");
  });

  test("a padding entry (count 0) or no entry is not breached", async () => {
    expect(await breachStatus("password1234", api(`${SUFFIX}:0\r\n0018A45C4D1DEF81644B54AB7F969B88D65:1`))).toBe("not-found");
    expect(await breachStatus("password1234", api("0018A45C4D1DEF81644B54AB7F969B88D65:1"))).toBe("not-found");
  });

  test("an error answer, a network failure or a timeout is unavailable", async () => {
    expect(await breachStatus("password1234", api("", 503))).toBe("unavailable");
    expect(await breachStatus("password1234", async () => Promise.reject(new TypeError("fetch failed")))).toBe(
      "unavailable",
    );
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    expect(await breachStatus("password1234", hang)).toBe("unavailable");
  });

  test("newPasswordProblem: length, then the list, then the API; unavailable accepts", async () => {
    // "not-in-the-list-1" is not in the bundled list; its SHA-1 is F7C93 + the suffix below.
    const other = "A02E31A059F04DE0F44292982624D4C5ADA";
    calls.length = 0;
    expect(await newPasswordProblem("password1234", api(""))).toBe("common-password");
    expect(calls, "a listed password needs no API call").toHaveLength(0);
    expect(await newPasswordProblem("not-in-the-list-1", api(`${other}:7`))).toBe("common-password");
    expect(calls[0].url).toBe("https://api.pwnedpasswords.com/range/F7C93");
    expect(await newPasswordProblem("not-in-the-list-1", api("", 500))).toBeNull();
    expect(await newPasswordProblem("not-in-the-list-1", api(`${other}:0`))).toBeNull();
    expect(await newPasswordProblem("short", api(`${SUFFIX}:7`))).toBe("weak-password");
    // Length is counted in characters (code points), as Supabase Auth counts it (ADR 0021):
    // 9 two-byte characters are too short, with no lookup; 10 are checked.
    calls.length = 0;
    expect(await newPasswordProblem("é".repeat(9), api(""))).toBe("weak-password");
    expect(calls, "9 characters (18 bytes) is short: no API call").toHaveLength(0);
    await newPasswordProblem("é".repeat(10), api(""));
    expect(calls, "10 characters is checked").toHaveLength(1);
    // Over 72 bytes (Supabase's maximum) is refused before any lookup; 72 bytes is checked.
    calls.length = 0;
    expect(await newPasswordProblem("x".repeat(73), api(""))).toBe("password-too-long");
    expect(await newPasswordProblem("😀".repeat(19), api(""))).toBe("password-too-long");
    expect(calls, "too long: no API call").toHaveLength(0);
    expect(await newPasswordProblem("😀".repeat(18), api(""))).toBeNull();
    expect(calls, "72 bytes is checked").toHaveLength(1);
    expect(isCommonPassword("BASKETBALL")).toBe(true);
    // At login (ADR 0021): a password under the minimum also needs a change, with no lookup.
    calls.length = 0;
    expect(await loginNeedsPasswordChange("short1234", api(""))).toBe(true);
    expect(calls, "a short password needs no API call").toHaveLength(0);
    expect(await loginNeedsPasswordChange("password1234", api(""))).toBe(true);
    expect(await loginNeedsPasswordChange("not-in-the-list-1", api(""))).toBe(false);
  });
});
