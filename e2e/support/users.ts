import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { confirmLink, mailCount, verifyLink } from "./mail";

// A fresh address and password per test, so tests can run in parallel and in any order.
export function newUser(tag: string) {
  const id = randomBytes(6).toString("hex");
  return { email: `${tag}-${id}@example.test`, password: `pw-${randomBytes(12).toString("base64url")}` };
}

export async function fillLogin(page: Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}

// Sign-up asks only for the email; the password is chosen after the confirm link (ADR 0027).
export async function signUp(page: Page, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toHaveText("Check your email for a link to confirm your account.");
}

// Presses the button on the newest confirmation email's link, ending on the page where the new
// account chooses its password (ADR 0027). `before` is how many emails the address had before the
// sign-up.
export async function confirmFromEmail(page: Page, email: string, before = 0) {
  await page.goto(await confirmLink(email, /Confirm your Porchlet account/, before));
  await page.getByRole("button", { name: "Confirm email" }).click();
  await expect(page).toHaveURL(/\/reset\?notice=email-confirmed$/);
  await expect(page.getByRole("status")).toHaveText("Your email is confirmed. Choose a password to continue.");
  // An emailed link's session sets the password without a current one (ADR 0023).
  await expect(page.getByLabel("Current password")).toHaveCount(0);
}

// On that page, chooses the password, ending signed in on /w.
export async function chooseFirstPassword(page: Page, password: string) {
  await page.getByLabel(/^New password/).fill(password);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page).toHaveURL(/\/w\?password=changed$/);
}

export async function confirmAndChoosePassword(page: Page, email: string, password: string, before = 0) {
  await confirmFromEmail(page, email, before);
  await chooseFirstPassword(page, password);
}

// Signs up through the UI, follows the confirmation email and chooses the password, ending signed
// in on /w.
export async function signUpAndConfirm(page: Page, tag: string) {
  const user = newUser(tag);
  await signUp(page, user.email);
  await confirmAndChoosePassword(page, user.email, user.password);
  return user;
}

// Our error messages. Next.js also renders an empty role="alert" route announcer outside <main>.
export const alertIn = (page: Page) => page.locator('main [role="alert"]');

// Session cookie names from src/lib/supabase/config.ts.
export const isAuthCookie = (name: string) => /^(__Host-)?porchlet-auth/.test(name);

type Session = { access_token: string; refresh_token: string; expires_at: number };

// @supabase/ssr stores the session as "base64-" + base64url(JSON), split into .0, .1, ... when
// large. Plain-HTTP runs use the bare cookie name.
async function sessionCookies(context: BrowserContext) {
  const cookies = (await context.cookies()).filter((c) => /^porchlet-auth(\.\d+)?$/.test(c.name));
  return cookies.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSession(context: BrowserContext): Promise<Session> {
  const raw = (await sessionCookies(context)).map((c) => c.value).join("");
  expect(raw.startsWith("base64-"), "session cookie format").toBe(true);
  return JSON.parse(Buffer.from(raw.slice(7), "base64url").toString("utf8")) as Session;
}

// Marks the stored access token as expired, so the next request makes the server refresh it
// with the refresh token, as it would after jwt_expiry (1 hour).
export async function expireSession(context: BrowserContext): Promise<Session> {
  const cookies = await sessionCookies(context);
  expect(cookies.length, "session cookies").toBeGreaterThan(0);
  const session = await readSession(context);
  session.expires_at = Math.floor(Date.now() / 1000) - 60;
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  await context.clearCookies();
  await context.addCookies([{ ...cookies[0], name: "porchlet-auth", value }]);
  return session;
}

// The app's Supabase settings, from the .env.local that scripts/e2e/write-env.sh writes.
export function supabaseEnv(): { url: string; key: string } {
  const env = Object.fromEntries(
    readFileSync(".env.local", "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, key: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY };
}

// Sets the signed-in user's password by calling Supabase Auth directly, skipping the app's check.
// The session must come from an emailed link: Supabase Auth asks a password session for the
// current password (require_current_password, ADR 0023). "password1234" is in the bundled list,
// so the login check needs no Pwned Passwords call.
export async function setPasswordDirectly(context: BrowserContext, password: string) {
  const { url, key } = supabaseEnv();
  const { access_token } = await readSession(context);
  const response = await fetch(`${url}/auth/v1/user`, {
    method: "PUT",
    headers: { apikey: key, authorization: `Bearer ${access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  expect(response.status, "Supabase Auth takes the password directly").toBe(200);
}

// Asks for a reset email in this browser and opens its link, ending on /reset with a new session.
export async function openResetLink(page: Page, email: string) {
  await page.goto("/forgot");
  await page.getByLabel("Email").fill(email);
  const before = await mailCount(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toBeVisible();
  await page.goto(await confirmLink(email, /Reset your Porchlet password/, before));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/reset$/);
}

// A user whose password was set outside the app to a listed one, then logged in with it: the
// login check flags the session and sends it to /reset (ADR 0021).
export async function flaggedUser(page: Page, context: BrowserContext, tag: string) {
  const user = await signUpAndConfirm(page, tag);
  await setPasswordDirectly(context, "password1234");
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login\?signed_out=1$/);
  await fillLogin(page, user.email, "password1234");
  await expect(page).toHaveURL(/\/reset\?error=password-change-required$/);
  return { ...user, password: "password1234" };
}

// Asks Supabase Auth's API for a sign-in link (it sends one to anyone who asks; the app offers
// none) and opens it through /auth/confirm, whose type=email takes the link's token hash.
export async function openSignInLink(page: Page, email: string) {
  const { url, key } = supabaseEnv();
  const before = await mailCount(email);
  const otp = await fetch(`${url}/auth/v1/otp`, {
    method: "POST",
    headers: { apikey: key, "content-type": "application/json" },
    body: JSON.stringify({ email, create_user: false }),
  });
  expect(otp.status).toBe(200);
  const token = new URL(await verifyLink(email, /Your sign-in link/, before)).searchParams.get("token");
  expect(token).toBeTruthy();
  await page.goto(`/auth/confirm?${new URLSearchParams({ token_hash: token!, type: "email" })}`);
  await page.getByRole("button", { name: "Confirm email" }).click();
}
