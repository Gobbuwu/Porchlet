import { expect, test, waitForHydration } from "./support/test";
import { confirmLink, mailCount } from "./support/mail";
import {
  alertIn,
  expireSession,
  fillLogin,
  isAuthCookie,
  newUser,
  readSession,
  signUp,
  signUpAndConfirm,
  supabaseEnv,
} from "./support/users";

// The M1 auth loop against the local Supabase stack and its mail catcher (design doc section 8).

test("sign-up needs the emailed confirmation, then login and logout work", async ({ page, context }) => {
  const user = newUser("signup");
  // The form asks only for the email (ADR 0027).
  await page.goto("/signup");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await signUp(page, user.email);

  // Not confirmed yet, and the account has no password anyone knows: login is refused.
  await page.goto("/login");
  await fillLogin(page, user.email, user.password);
  await expect(alertIn(page)).toHaveText("Wrong email or password.");

  // Opening the link alone changes nothing (mail scanners open links); the button confirms.
  const link = await confirmLink(user.email, /Confirm your Porchlet account/);
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Confirm your email" })).toBeVisible();
  await page.goto("/w");
  await expect(page).toHaveURL(/\/login\?next=%2Fw$/);
  await page.goto(link);
  await page.getByRole("button", { name: "Confirm email" }).click();
  // Confirmed, and signed in, but the app stays closed until a password is chosen (ADR 0027).
  await expect(page).toHaveURL(/\/reset\?notice=email-confirmed$/);
  await page.goto("/w");
  await expect(page).toHaveURL(/\/reset\?error=new-password-required$/);
  await page.getByLabel(/^New password/).fill(user.password);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page).toHaveURL(/\/w\?password=changed$/);
  await expect(page.getByText(`Signed in as ${user.email}.`)).toBeVisible();

  // Sign-up through Supabase Auth created the user's profile (PR 9's trigger), and the user's
  // own token reads exactly that row through the API.
  const { url, key } = supabaseEnv();
  const { access_token: token, user: authUser } = (await readSession(context)) as unknown as {
    access_token: string;
    user: { id: string };
  };
  const profiles = await fetch(`${url}/rest/v1/profiles?select=id,display_name`, {
    headers: { apikey: key, authorization: `Bearer ${token}` },
  });
  expect(profiles.status).toBe(200);
  expect(await profiles.json()).toEqual([{ id: authUser.id, display_name: "" }]);

  // Session cookies are out of reach of page scripts (ADR 0014).
  const authCookies = (await context.cookies()).filter((c) => isAuthCookie(c.name));
  expect(authCookies.length).toBeGreaterThan(0);
  for (const c of authCookies) {
    expect(c.httpOnly, `${c.name} HttpOnly`).toBe(true);
    expect(c.sameSite, `${c.name} SameSite`).toBe("Lax");
  }
  expect(await page.evaluate(() => document.cookie)).not.toContain("porchlet-auth");

  // Signed in, /login and /signup lead back to the app.
  await page.goto("/login");
  await expect(page).toHaveURL(/\/w$/);

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login\?signed_out=1$/);
  await expect(page.getByRole("status")).toHaveText("You are signed out.");
  expect((await context.cookies()).filter((c) => isAuthCookie(c.name))).toEqual([]);
  await page.goto("/w");
  await expect(page).toHaveURL(/\/login\?next=%2Fw$/);

  // Back in, and returned to the page that asked for login.
  await fillLogin(page, user.email, user.password);
  await expect(page).toHaveURL(/\/w$/);

  // The used link can't be replayed.
  await context.clearCookies();
  await page.goto(link);
  await page.getByRole("button", { name: "Confirm email" }).click();
  await expect(alertIn(page)).toHaveText(
    "This link has expired or was already used. Ask for a new one.",
  );
});

test("signing up again with a used email looks the same and sends no email", async ({ page }) => {
  const user = await signUpAndConfirm(page, "dupe");
  await page.context().clearCookies();
  const before = await mailCount(user.email);
  await signUp(page, user.email);
  // Give a stray email time to arrive before counting.
  await page.waitForTimeout(2_000);
  expect(await mailCount(user.email)).toBe(before);
});

test("a wrong password gets one generic message", async ({ page }) => {
  const user = await signUpAndConfirm(page, "wrongpw");
  await page.context().clearCookies();
  await page.goto("/login");
  await fillLogin(page, user.email, `${user.password}x`);
  await expect(alertIn(page)).toHaveText("Wrong email or password.");
  await fillLogin(page, newUser("nobody").email, user.password);
  await expect(alertIn(page)).toHaveText("Wrong email or password.");
});

test("password reset by email", async ({ page, context }) => {
  const user = await signUpAndConfirm(page, "reset");
  await context.clearCookies();

  const before = await mailCount(user.email);
  await page.goto("/forgot");
  await page.getByLabel("Email").fill(user.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "If an account uses that email, we sent it a link to choose a new password.",
  );

  const link = await confirmLink(user.email, /Reset your Porchlet password/, before);
  await page.goto(link);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/reset$/);

  // Too short for the server's minimum (supabase/config.toml), even with the browser check off.
  const save = page.getByRole("button", { name: "Save new password" });
  await page.locator("form", { has: save }).evaluate((f: HTMLFormElement) => (f.noValidate = true));
  await page.getByLabel(/^New password/).fill("short");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(alertIn(page)).toHaveText("Choose a longer password: at least 10 characters.");

  // A common password is refused too (ADR 0019), and the reset session survives it.
  await page.getByLabel(/^New password/).fill("basketball");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(alertIn(page)).toHaveText(
    "Choose a different password: this one is too common or has appeared in a data breach.",
  );

  // Over Supabase's 72-byte maximum: the length message, not an email one (ADR 0021).
  await page.getByLabel(/^New password/).fill("😀".repeat(19));
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(alertIn(page)).toHaveText(
    "Choose a shorter password: at most 72 bytes, which is 72 plain letters or digits, or fewer with accents, other alphabets or emoji.",
  );

  const newPassword = `${user.password}-new`;
  await page.getByLabel(/^New password/).fill(newPassword);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page).toHaveURL(/\/w\?password=changed$/);
  await expect(page.getByRole("status")).toHaveText("Your password has been changed.");

  await page.getByRole("button", { name: "Log out" }).click();
  await fillLogin(page, user.email, user.password);
  await expect(alertIn(page)).toHaveText("Wrong email or password.");
  await fillLogin(page, user.email, newPassword);
  await expect(page).toHaveURL(/\/w$/);
});

test("a reset request for an unknown email looks the same as for a real one", async ({ page }) => {
  await page.goto("/forgot");
  await page.getByLabel("Email").fill(newUser("unknown").email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "If an account uses that email, we sent it a link to choose a new password.",
  );
});

test("/reset without a reset session says the link expired", async ({ page }) => {
  await page.goto("/reset");
  await expect(alertIn(page)).toHaveText("Your reset link has expired. Ask for a new one.");
});

test("after login, ?next= only goes to paths on this site", async ({ page, context }) => {
  const user = await signUpAndConfirm(page, "next");
  for (const next of ["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)"]) {
    await context.clearCookies();
    await page.goto(`/login?next=${encodeURIComponent(next)}`);
    await fillLogin(page, user.email, user.password);
    await expect(page, `next=${next}`).toHaveURL("/w");
  }
  await context.clearCookies();
  await page.goto(`/login?next=${encodeURIComponent("/w?from=next")}`);
  await fillLogin(page, user.email, user.password);
  await expect(page).toHaveURL("/w?from=next");
});

test("a login POST from another site's origin is refused", async ({ page, request }) => {
  const user = await signUpAndConfirm(page, "origin");
  await page.context().clearCookies();
  await page.goto("/login");
  await waitForHydration(page); // the replay below needs React's request, with its Next-Action header
  const post = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/login");
  await fillLogin(page, user.email, user.password);
  const real = await post;
  await expect(page).toHaveURL(/\/w$/);

  // Replay the same Server Action call with a foreign Origin (design doc threat model row 17).
  const headers = await real.allHeaders();
  const replay = (origin: string) =>
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
  const foreign = await replay("https://evil.example");
  expect(foreign.status(), "foreign-origin replay").toBe(500); // Next.js: "Invalid Server Actions request"
  expect(foreign.headers()["set-cookie"] ?? "").not.toContain("porchlet-auth");
  // Control: the same replay from our own origin signs in, so the refusal above is the Origin check.
  const own = await replay(new URL(real.url()).origin);
  expect(own.headers()["set-cookie"] ?? "", "own-origin replay sets the session").toContain("porchlet-auth");
});

test("the proxy refreshes an expired session and keeps the cookie HttpOnly", async ({ page, context }) => {
  await signUpAndConfirm(page, "refresh");
  const old = await expireSession(context);
  await page.goto("/w");
  await expect(page.getByText(/^Signed in as /)).toBeVisible();
  expect((await readSession(context)).refresh_token, "refresh token rotated").not.toBe(old.refresh_token);
  for (const c of (await context.cookies()).filter((c) => isAuthCookie(c.name))) {
    expect(c.httpOnly, `${c.name} HttpOnly after refresh`).toBe(true);
  }
});

test("a password reset ends the account's other sessions", async ({ page, browser }) => {
  const user = await signUpAndConfirm(page, "others");
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto("/login");
  await fillLogin(otherPage, user.email, user.password);
  await expect(otherPage).toHaveURL(/\/w$/);

  await page.context().clearCookies();
  await page.goto("/forgot");
  const before = await mailCount(user.email);
  await page.getByLabel("Email").fill(user.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toBeVisible();
  await page.goto(await confirmLink(user.email, /Reset your Porchlet password/, before));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel(/^New password/).fill(`${user.password}-new`);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page).toHaveURL(/\/w\?password=changed$/);

  // The other browser's refresh token was revoked: once its access token is due for refresh,
  // it is signed out.
  await expireSession(other);
  await otherPage.goto("/w");
  await expect(otherPage).toHaveURL(/\/login\?next=%2Fw$/);
  // The browser that reset the password stays signed in.
  await expireSession(page.context());
  await page.goto("/w");
  await expect(page).toHaveURL(/\/w$/);
  await other.close();
});

test("over HTTPS the session cookie is __Host- prefixed, Secure and HttpOnly", async ({ page, request }) => {
  const user = await signUpAndConfirm(page, "https");
  await page.context().clearCookies();
  await page.goto("/login");
  await waitForHydration(page); // the replay below needs React's request, with its Next-Action header
  const post = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/login");
  await fillLogin(page, user.email, user.password);
  const real = await post;
  const headers = await real.allHeaders();
  // Replay the login as a host that ends TLS in front of the app would forward it.
  const res = await request.post(real.url(), {
    headers: {
      "content-type": headers["content-type"],
      "next-action": headers["next-action"],
      accept: headers["accept"] ?? "text/x-component",
      origin: new URL(real.url()).origin,
      "x-forwarded-proto": "https",
    },
    data: real.postDataBuffer() ?? undefined,
    maxRedirects: 0,
  });
  const setCookies = res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);
  const session = setCookies.filter((v) => /^__Host-porchlet-auth(\.\d+)?=/.test(v));
  expect(session.length, `session cookies in ${JSON.stringify(setCookies)}`).toBeGreaterThan(0);
  expect(setCookies.filter((v) => /^porchlet-auth/.test(v)), "no unprefixed session cookie").toEqual([]);
  for (const v of session) {
    const attrs = v.split(";").map((a) => a.trim().toLowerCase());
    expect(attrs, v).toContain("secure");
    expect(attrs, v).toContain("httponly");
    expect(attrs, v).toContain("path=/");
    expect(attrs, v).toContain("samesite=lax");
    expect(attrs.some((a) => a.startsWith("domain=")), `${v}: no Domain`).toBe(false);
  }
});

test("with X-Forwarded-Proto `http, https` the proxy and the login agree on the session cookie", async ({
  page,
  request,
}) => {
  // Next.js gives the proxy an https:// URL when the header contains "https" anywhere (ADR 0028), so
  // the Server Action must read the header the same way, or the proxy looks for a cookie the login
  // never set and sends the signed-in person back to /login (the Netlify bug, from the other side).
  const proto = "http, https";
  const user = await signUpAndConfirm(page, "https-chain");
  await page.context().clearCookies();
  await page.goto("/login");
  await waitForHydration(page);
  const post = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/login");
  await fillLogin(page, user.email, user.password);
  const real = await post;
  const headers = await real.allHeaders();
  const res = await request.post(real.url(), {
    headers: {
      "content-type": headers["content-type"],
      "next-action": headers["next-action"],
      accept: headers["accept"] ?? "text/x-component",
      origin: new URL(real.url()).origin,
      "x-forwarded-proto": proto,
    },
    data: real.postDataBuffer() ?? undefined,
    maxRedirects: 0,
  });
  const session = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie" && /^__Host-porchlet-auth(\.\d+)?=/.test(h.value))
    .map((h) => h.value.split(";")[0]);
  expect(session.length, "the login set __Host- session cookies").toBeGreaterThan(0);

  const w = await request.get("/w", {
    headers: { cookie: session.join("; "), "x-forwarded-proto": proto },
    maxRedirects: 0,
  });
  expect(w.status(), `/w answered ${w.status()} ${w.headers()["location"] ?? ""}`).toBe(200);
});

test("Supabase Auth's 429 shows the friendly rate-limit message", async ({ page, context }) => {
  // supabase/config.toml sets max_frequency = "60s": a second reset email to the same user
  // within 60 s gets HTTP 429 over_email_send_rate_limit from Supabase Auth.
  const user = await signUpAndConfirm(page, "ratelimit");
  await context.clearCookies();
  await page.goto("/forgot");
  await waitForHydration(page); // only React's path keeps the typed email (ADR 0018)
  await page.getByLabel("Email").fill(user.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "If an account uses that email, we sent it a link to choose a new password.",
  );
  // The form keeps the email after the action, so the same request can be sent again.
  await expect(page.getByLabel("Email")).toHaveValue(user.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(alertIn(page)).toHaveText("Too many attempts, try again later.");
});

// Messages without JavaScript are checked in form-messages.spec.ts.
test("login and logout work with JavaScript turned off", async ({ page, browser }) => {
  const user = await signUpAndConfirm(page, "nojs");
  const context = await browser.newContext({ javaScriptEnabled: false });
  const noJs = await context.newPage();
  await noJs.goto("/login");
  await fillLogin(noJs, user.email, user.password);
  await expect(noJs).toHaveURL(/\/w$/);
  await noJs.getByRole("button", { name: "Log out" }).click();
  await expect(noJs).toHaveURL(/\/login\?signed_out=1$/);
  await context.close();
});
