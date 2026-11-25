import { confirmLink, mailCount } from "./support/mail";
import { expect, test } from "./support/test";
import { alertIn, chooseFirstPassword, confirmFromEmail, fillLogin, newUser, signUp, supabaseEnv } from "./support/users";

// A password stored before the address was proven never opens the confirmed account (ADR 0027).
// "Someone else" signs up straight against Supabase Auth with a password of their own, as anyone
// can with the publishable key; the address's owner then goes through Porchlet.

async function signUpDirectly(email: string, password: string) {
  const { url, key } = supabaseEnv();
  const res = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: key, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status, "direct sign-up").toBe(200);
}

// Tried straight against Supabase Auth (past the app's login and its limits).
async function passwordLogin(email: string, password: string) {
  const { url, key } = supabaseEnv();
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, code: ((await res.json()) as { error_code?: string }).error_code };
}

const NO_LOGIN = { status: 400, code: "invalid_credentials" };

test("someone else's sign-up: the owner confirms from the email they got, and only their own password works", async ({
  page,
}) => {
  const owner = newUser("prehijack-click");
  const otherPassword = `${owner.password}-other`;
  await signUpDirectly(owner.email, otherPassword);
  // Before the confirm, the other password gets the app's "confirm first" message.
  await page.goto("/login");
  await fillLogin(page, owner.email, otherPassword);
  await expect(alertIn(page)).toHaveText("Confirm your email first. The link is in the email we sent you.");
  await confirmFromEmail(page, owner.email);
  // Confirmed, password not chosen yet (or never, if the owner leaves now): the other password
  // already signs nobody in. Choosing one would replace it anyway, so this is the moment to check.
  expect(await passwordLogin(owner.email, otherPassword)).toEqual(NO_LOGIN);
  await chooseFirstPassword(page, owner.password);
  expect(await passwordLogin(owner.email, otherPassword)).toEqual(NO_LOGIN);
  expect((await passwordLogin(owner.email, owner.password)).status).toBe(200);
});

test("someone else's sign-up, then the owner signs up through Porchlet: only the owner's password works", async ({
  page,
}) => {
  // Supabase Auth refuses a second email to the address within max_frequency (60 s), so the
  // owner signs up after it, as a person would who signs up later (measured, ADR 0027).
  test.setTimeout(150_000);
  const owner = newUser("prehijack-again");
  const otherPassword = `${owner.password}-other`;
  await signUpDirectly(owner.email, otherPassword);
  await page.waitForTimeout(61_000);
  const before = await mailCount(owner.email);
  await signUp(page, owner.email);
  await confirmFromEmail(page, owner.email, before);
  expect(await passwordLogin(owner.email, otherPassword)).toEqual(NO_LOGIN);
  await chooseFirstPassword(page, owner.password);

  // Through the app too.
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login\?signed_out=1$/);
  await fillLogin(page, owner.email, otherPassword);
  await expect(alertIn(page)).toHaveText("Wrong email or password.");
  await fillLogin(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/w$/);
});

test("someone else's sign-up, then the owner uses Forgot password: the other password stops at the link", async ({
  page,
}) => {
  // Supabase Auth drops the password itself here (measured on GoTrue v2.198.0, ADR 0027); this
  // test keeps that true after a Supabase upgrade, and the trigger covers it as well.
  test.setTimeout(150_000);
  const owner = newUser("prehijack-reset");
  const otherPassword = `${owner.password}-other`;
  await signUpDirectly(owner.email, otherPassword);
  await page.waitForTimeout(61_000);
  const before = await mailCount(owner.email);
  await page.goto("/forgot");
  await page.getByLabel("Email").fill(owner.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "If an account uses that email, we sent it a link to choose a new password.",
  );
  await page.goto(await confirmLink(owner.email, /Reset your Porchlet password/, before));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/reset$/);
  // Pressed, not yet saved: the other password already signs nobody in.
  expect(await passwordLogin(owner.email, otherPassword)).toEqual(NO_LOGIN);
});

test("a password added to the sign-up form is ignored", async ({ page }) => {
  // Supabase Auth answers a right password for an unconfirmed account with email_not_confirmed
  // and a wrong one with invalid_credentials (measured on GoTrue v2.198.0), so a login attempt
  // shows whether a password was stored. First the control: a direct sign-up's own password.
  const control = newUser("signup-control");
  await signUpDirectly(control.email, control.password);
  expect(await passwordLogin(control.email, control.password)).toEqual({ status: 400, code: "email_not_confirmed" });

  // The form has no password field; one added by hand is posted with the form and must not be used.
  const owner = newUser("signup-extra-field");
  await page.goto("/signup");
  await page.getByLabel("Email").fill(owner.email);
  await page.locator("form", { has: page.getByRole("button", { name: "Create account" }) }).evaluate(
    (form: HTMLFormElement, password: string) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "password";
      input.value = password;
      form.append(input);
    },
    owner.password,
  );
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toHaveText("Check your email for a link to confirm your account.");
  expect(await passwordLogin(owner.email, owner.password)).toEqual(NO_LOGIN);
});
