import { type Page } from "@playwright/test";
import { expect, test, waitForHydration } from "./support/test";
import { alertIn, fillLogin, newUser, signUp, signUpAndConfirm } from "./support/users";

// A form sent before React hydrates the page (a slow device, a quick click) or with JavaScript
// off is a native form post. Its message comes back through a redirect to the form's page
// (ADR 0018). Before that, no message showed at all: Next.js resumes the prerendered shell for
// such a post and React drops the form state (Next.js issue #99756).

const RESET_SENT = "If an account uses that email, we sent it a link to choose a new password.";
const WRONG = "Wrong email or password.";

// Loads `path` with the page's scripts blocked, so the form is still a plain HTML form when it
// is sent. Scripts load normally once the form has been posted.
async function gotoUnhydrated(page: Page, path: string) {
  let block = true;
  page.on("request", (r) => {
    if (r.method() === "POST") block = false;
  });
  await page.route("**/_next/static/chunks/**", (route) => (block ? route.abort() : route.continue()));
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

test.describe("sent before the page hydrates", () => {
  test("a reset request shows its notice", async ({ page }) => {
    await gotoUnhydrated(page, "/forgot");
    await page.getByLabel("Email").fill(newUser("prehydrate").email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("status")).toHaveText(RESET_SENT);
    await expect(page).toHaveURL(/\/forgot\?notice=reset-sent$/);
  });

  test("a failed login shows its error, then the hydrated page sends through React", async ({ page }) => {
    const email = newUser("prehydrate").email;
    await gotoUnhydrated(page, "/login");
    await fillLogin(page, email, "not-the-password");
    await expect(alertIn(page)).toHaveText(WRONG);
    await expect(page).toHaveURL(/\/login\?next=%2Fw&error=wrong-credentials$/);
    // The native post doesn't keep the typed email (it is never put in the URL).
    await expect(page.getByLabel("Email")).toHaveValue("");

    // The page it lands on hydrates; the next try goes through useActionState, which keeps it.
    await waitForHydration(page);
    await fillLogin(page, email, "not-the-password");
    await expect(alertIn(page)).toHaveText(WRONG);
    await expect(page.getByLabel("Email")).toHaveValue(email);
  });
});

test.describe("with JavaScript turned off", () => {
  test.use({ javaScriptEnabled: false });

  test("log in shows its error and keeps where to go next", async ({ page }) => {
    await page.goto(`/login?next=${encodeURIComponent("/w?from=next")}`);
    await fillLogin(page, newUser("nojs").email, "not-the-password");
    await expect(alertIn(page)).toHaveText(WRONG);
    await expect(page).toHaveURL(/\/login\?next=%2Fw%3Ffrom%3Dnext&error=wrong-credentials$/);
  });

  test("sign-up, confirm, new password, reset request and a bad link all show their messages", async ({
    page,
  }) => {
    // Sign-up notice (checked inside signUp) and the email confirmation, all without JavaScript.
    const user = await signUpAndConfirm(page, "nojs-flow");
    await expect(page).toHaveURL(/\/w$/);

    // /reset is open to a signed-in user. Its errors come back to it.
    await page.goto("/reset");
    await page.getByLabel(/^New password/).fill(user.password);
    await page.getByRole("button", { name: "Save new password" }).click();
    await expect(alertIn(page)).toHaveText("Choose a password that is different from your current one.");
    await expect(page).toHaveURL(/\/reset\?error=same-password$/);
    await page.getByLabel(/^New password/).fill(`${user.password}-new`);
    await page.getByRole("button", { name: "Save new password" }).click();
    await expect(page.getByRole("status")).toHaveText("Your password has been changed.");

    await page.getByRole("button", { name: "Log out" }).click();
    await page.goto("/forgot");
    await page.getByLabel("Email").fill(user.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("status")).toHaveText(RESET_SENT);

    // A link whose token is not real: the error comes back to the same link.
    await page.goto("/auth/confirm?token_hash=not-a-real-token&type=recovery");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(alertIn(page)).toHaveText("This link has expired or was already used. Ask for a new one.");
    await expect(page).toHaveURL(/\/auth\/confirm\?token_hash=not-a-real-token&type=recovery&error=link-used$/);
  });

  test("sign-up's notice shows", async ({ page }) => {
    const user = newUser("nojs-signup");
    await signUp(page, user.email, user.password);
    await expect(page).toHaveURL(/\/signup\?notice=signup-sent$/);
  });
});

test("a page shows only Porchlet's own messages from the URL", async ({ page }) => {
  for (const code of ["<b>hi</b>", "Wrong email or password.", "__proto__", "constructor", "toString"]) {
    await page.goto(`/login?error=${encodeURIComponent(code)}&notice=${encodeURIComponent(code)}`);
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
    await expect(alertIn(page), code).toHaveCount(0);
    await expect(page.locator("main form [role=status]"), code).toHaveCount(0);
  }
  await page.goto("/forgot?error=too-many-attempts");
  await expect(alertIn(page)).toHaveText("Too many attempts, try again later.");
});
