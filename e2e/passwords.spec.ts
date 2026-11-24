import { breachStatus, isCommonPassword, newPasswordProblem } from "../src/lib/auth/password-check";
import { mailCount } from "./support/mail";
import { expect, test } from "./support/test";
import { alertIn, newUser } from "./support/users";

// New passwords are checked against common and breached passwords (ADR 0019).

const COMMON_MESSAGE = "Choose a different password: this one is too common or has appeared in a data breach.";

test("sign-up with a common password is refused before an account is made", async ({ page }) => {
  const user = newUser("common");
  await page.goto("/signup");
  await page.getByLabel("Email").fill(user.email);
  // In the bundled list as "qwertyuiop"; the check ignores case.
  await page.getByLabel(/^Password/).fill("QwertyUIOP");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(alertIn(page)).toHaveText(COMMON_MESSAGE);
  expect(await mailCount(user.email), "no confirmation email, so no account").toBe(0);
});

// Porchlet leaves passwords under 10 characters to Supabase Auth, so both must count the same
// way: in characters (code points). Supabase does (measured with GoTrue v2.198.0); if an upgrade
// counted bytes, a short multi-byte password would be accepted without Porchlet's check.
// 5 emoji are 5 characters, 20 bytes and 10 UTF-16 units: the field's minlength counts UTF-16
// units, so the browser lets the form through and the server decides.
test("a password of 5 emoji (20 bytes) is refused as too short", async ({ page }) => {
  const user = newUser("short-multibyte");
  await page.goto("/signup");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel(/^Password/).fill("😀".repeat(5));
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(alertIn(page)).toHaveText("Choose a longer password: at least 10 characters.");
  expect(await mailCount(user.email), "no confirmation email, so no account").toBe(0);
});

// The breach lookup itself, with a stand-in for the Pwned Passwords API (no browser needed, so it
// runs once, in the chromium project). SHA-1("password1234") is E6B6A + FBD6D76BB5D2041542D7D2E3FAC5BB05593.
test.describe("breach lookup", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "plain Node code: one browser is enough");

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

  test("newPasswordProblem: list first, then the API; unavailable accepts; short is left to Supabase", async () => {
    // "not-in-the-list-1" is not in the bundled list; its SHA-1 is F7C93 + the suffix below.
    const other = "A02E31A059F04DE0F44292982624D4C5ADA";
    calls.length = 0;
    expect(await newPasswordProblem("password1234", api(""))).toBe("common-password");
    expect(calls, "a listed password needs no API call").toHaveLength(0);
    expect(await newPasswordProblem("not-in-the-list-1", api(`${other}:7`))).toBe("common-password");
    expect(calls[0].url).toBe("https://api.pwnedpasswords.com/range/F7C93");
    expect(await newPasswordProblem("not-in-the-list-1", api("", 500))).toBeNull();
    expect(await newPasswordProblem("not-in-the-list-1", api(`${other}:0`))).toBeNull();
    expect(await newPasswordProblem("short", api(`${SUFFIX}:7`))).toBeNull();
    // Length is counted in characters (code points), as Supabase Auth counts it (ADR 0019):
    // 9 two-byte characters are short and left to Supabase; 10 are checked.
    calls.length = 0;
    expect(await newPasswordProblem("é".repeat(9), api(""))).toBeNull();
    expect(calls, "9 characters (18 bytes) is short: no API call").toHaveLength(0);
    await newPasswordProblem("é".repeat(10), api(""));
    expect(calls, "10 characters is checked").toHaveLength(1);
    expect(isCommonPassword("BASKETBALL")).toBe(true);
  });
});
