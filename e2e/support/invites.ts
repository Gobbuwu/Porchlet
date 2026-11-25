import { expect, type Page } from "@playwright/test";
import { confirmLink } from "./mail";

// Invites (M2 PR 3, ADR 0024).

export const INVITE_SUBJECT = /invited to a Porchlet workspace/;
// The SITE_URL that scripts/e2e/write-env.sh writes, which Playwright's baseURL also uses.
export const SITE = "http://127.0.0.1:3000";

/** Invites `email` from the workspace page the owner is on; returns the link the page shows. */
export async function inviteFromPage(page: Page, email: string, notice: RegExp): Promise<string> {
  await page.getByLabel("Client's email").fill(email);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByRole("status")).toHaveText(notice);
  const link = await page.getByLabel("Invite link").inputValue();
  expect(link).toMatch(new RegExp(`^${SITE.replaceAll(".", "\\.")}/invite\\?token=[0-9a-f]{64}$`));
  return link;
}

export const EMAILED = /^Invitation emailed\./;
export const HAS_ACCOUNT = /^This address already has an account/;

/** The /auth/confirm link in the newest invite email to `email`. */
export async function inviteEmailLink(email: string, after = 0): Promise<string> {
  const link = await confirmLink(email, INVITE_SUBJECT, after);
  // The email's link is on the site's own host (Supabase Auth's site_url), threat T9.
  expect(link.startsWith(`${SITE}/auth/confirm?`), link).toBe(true);
  return link;
}

export const openInvitations = (page: Page) => page.getByRole("list", { name: "Open invitations" }).getByRole("listitem");
export const memberItems = (page: Page) => page.getByRole("list", { name: "Members" }).getByRole("listitem");
