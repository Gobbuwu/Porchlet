import { randomBytes } from "node:crypto";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { confirmLink } from "./mail";

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

export async function signUp(page: Page, email: string, password: string) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toHaveText("Check your email for a link to confirm your account.");
}

// Signs up through the UI and follows the confirmation email, ending signed in on /w.
export async function signUpAndConfirm(page: Page, tag: string) {
  const user = newUser(tag);
  await signUp(page, user.email, user.password);
  await page.goto(await confirmLink(user.email, /Confirm your Porchlet account/));
  await page.getByRole("button", { name: "Confirm email" }).click();
  await expect(page).toHaveURL(/\/w$/);
  return user;
}

// Our error messages. Next.js also renders an empty role="alert" route announcer outside <main>.
export const alertIn = (page: Page) => page.locator('main [role="alert"]');

// Session cookie names from src/lib/supabase/config.ts.
export const isAuthCookie = (name: string) => /^(__Host-)?porchlet-auth/.test(name);

type Session = { refresh_token: string; expires_at: number };

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
