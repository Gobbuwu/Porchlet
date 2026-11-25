import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { fillLogin, readSession, supabaseEnv } from "./users";

// The instance admin that scripts/e2e/make-admin.sh made for this stack (decision D4). Only the
// admin can create workspaces, so every workspace test logs in as it; it owns each test's
// workspaces, which have unique names, so tests can still run in parallel.
export function adminUser(): { email: string; password: string } {
  let text: string;
  try {
    text = readFileSync(".env.e2e-admin", "utf8");
  } catch {
    throw new Error("no .env.e2e-admin: run scripts/e2e/make-admin.sh against the local stack first");
  }
  const env = Object.fromEntries(
    text
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
  return { email: env.E2E_ADMIN_EMAIL, password: env.E2E_ADMIN_PASSWORD };
}

export async function logInAsAdmin(page: Page) {
  const admin = adminUser();
  await page.goto("/login");
  await fillLogin(page, admin.email, admin.password);
  await expect(page).toHaveURL(/\/w$/);
  return admin;
}

export const uniqueName = (tag: string) => `${tag} ${randomBytes(4).toString("hex")}`;

const WORKSPACE_URL = /\/w\/([0-9a-f-]{36})(\?.*)?$/;

/** Creates a workspace from /w as the signed-in admin; returns its id. */
export async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.goto("/w");
  await page.getByLabel("Workspace name").fill(name);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(WORKSPACE_URL);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  return page.url().match(WORKSPACE_URL)![1];
}

export async function createProject(page: Page, name: string) {
  await page.getByLabel("Project name").fill(name);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("status")).toHaveText("Project created.");
  await expect(projectItem(page, name)).toBeVisible();
}

export const projectItem = (page: Page, name: string) =>
  page.getByRole("list", { name: "Projects", exact: true }).getByRole("listitem", { name, exact: true });

export async function rpc(context: BrowserContext, fn: string, args: Record<string, unknown>) {
  const { url, key } = supabaseEnv();
  const { access_token } = await readSession(context);
  return fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${access_token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
}

// Makes the signed-in user of `client` a client of the workspace through the database's own
// invitation RPCs (PR 1), as the owner and then the invitee. The invite UI and email are PR 3's.
export async function joinAsClient(owner: BrowserContext, client: BrowserContext, workspaceId: string, email: string) {
  const invite = await rpc(owner, "create_invitation", { p_workspace_id: workspaceId, p_email: email });
  expect(invite.status, "create_invitation").toBe(200);
  const [{ token }] = (await invite.json()) as { token: string }[];
  const accept = await rpc(client, "accept_invitation", { p_token: token });
  expect(accept.status, "accept_invitation").toBe(200);
}
