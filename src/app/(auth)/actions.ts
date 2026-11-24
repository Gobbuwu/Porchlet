"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authErrorCode, GENERIC_ERROR, MESSAGES, type MessageCode, TOO_MANY_ATTEMPTS } from "@/lib/auth/messages";
import { newPasswordProblem } from "@/lib/auth/password-check";
import { checkLimits, clientIp, type Rule, RULES } from "@/lib/auth/rate-limit";
import { safeNext } from "@/lib/auth/redirect";
import type { FormState } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

// Auth runs here, on the server, so the session cookie can be HttpOnly (ADR 0014).
// Next.js checks that each Server Action POST comes from this site's Origin
// (node_modules/next/dist/docs/01-app/02-guides/data-security.md).

const field = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

type Outcome = { error?: MessageCode; notice?: MessageCode; email?: string };

// Answers a form post. When the hydrated page sent it (React's fetch, which carries Next.js's
// Next-Action header), the result goes back to useActionState. A native form post (sent before
// React hydrated, or with JavaScript off) is redirected to `page` with the message code in the
// URL instead (Post/Redirect/Get), and the page shows the message: Next.js 16.4 renders the
// response to such a post by resuming the prerendered shell, and React's resume() takes no form
// state, so useActionState would show nothing (measured; ADR 0018, Next.js issue #99756).
// The typed email is not put in the URL, so that path doesn't keep it.
async function answer(page: string, outcome: Outcome): Promise<FormState> {
  if ((await headers()).has("next-action")) {
    const state: FormState = {};
    if (outcome.error) state.error = MESSAGES[outcome.error];
    if (outcome.notice) state.notice = MESSAGES[outcome.notice];
    if (outcome.email !== undefined) state.email = outcome.email;
    return state;
  }
  const url = new URL(page, "http://porchlet.invalid");
  if (outcome.error) url.searchParams.set("error", outcome.error);
  if (outcome.notice) url.searchParams.set("notice", outcome.notice);
  redirect(url.pathname + url.search);
}

// Counts this attempt against Porchlet's per-visitor limits (ADR 0015). Returns a message code
// for the form when the visitor is over a limit or the limiter can't answer, else null.
async function limitError(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rules: readonly Rule[],
  record: boolean,
): Promise<MessageCode | null> {
  const result = await checkLimits(supabase, clientIp(await headers()), rules, record);
  if (result === "limited") return TOO_MANY_ATTEMPTS;
  if (result === "unavailable") return GENERIC_ERROR;
  return null;
}

function logAuthError(action: string, error: { status?: number; code?: string }) {
  // Status and code only: never the email or the password.
  console.warn(`auth ${action} failed: status=${error.status} code=${error.code}`);
}

export async function signUp(_state: FormState, formData: FormData): Promise<FormState> {
  const email = field(formData, "email").trim();
  const supabase = await createClient();
  const limited = await limitError(supabase, RULES.signUp, true);
  if (limited) return answer("/signup", { error: limited, email });
  const password = field(formData, "password");
  // Checked before Supabase sees the email, so the answer is the same for every address.
  const problem = await newPasswordProblem(password);
  if (problem) return answer("/signup", { error: problem, email });
  const { error } = await supabase.auth.signUp({ email, password });
  // Same answer whether or not the email already has an account. Supabase Auth itself answers
  // 422 user_already_exists for a confirmed address (measured, ADR 0014), so the page hides it.
  if (error && error.code !== "user_already_exists") {
    logAuthError("signup", error);
    return answer("/signup", { error: authErrorCode(error), email });
  }
  return answer("/signup", { notice: "signup-sent" });
}

export async function logIn(_state: FormState, formData: FormData): Promise<FormState> {
  const email = field(formData, "email").trim();
  const next = safeNext(field(formData, "next"));
  const page = `/login?${new URLSearchParams({ next })}`;
  const supabase = await createClient();
  // Only failures count, so people who share an IP (an office, a campus) can all still log in.
  const rules = RULES.loginFailures(email);
  const limited = await limitError(supabase, rules, false);
  if (limited) return answer(page, { error: limited, email });
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password: field(formData, "password"),
  });
  if (error) {
    logAuthError("login", error);
    if (error.status !== 429) {
      const after = await limitError(supabase, rules, true);
      if (after === GENERIC_ERROR) return answer(page, { error: after, email });
    }
    return answer(page, { error: authErrorCode(error), email });
  }
  redirect(next);
}

export async function requestReset(_state: FormState, formData: FormData): Promise<FormState> {
  const email = field(formData, "email").trim();
  const supabase = await createClient();
  const limited = await limitError(supabase, RULES.reset, true);
  if (limited) return answer("/forgot", { error: limited, email });
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) {
    logAuthError("reset-request", error);
    return answer("/forgot", { error: authErrorCode(error), email });
  }
  return answer("/forgot", { notice: "reset-sent", email });
}

export async function setNewPassword(_state: FormState, formData: FormData): Promise<FormState> {
  const supabase = await createClient();
  const limited = await limitError(supabase, RULES.newPassword, true);
  if (limited) return answer("/reset", { error: limited });
  const password = field(formData, "password");
  const problem = await newPasswordProblem(password);
  if (problem) return answer("/reset", { error: problem });
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    logAuthError("reset-update", error);
    if (error.status === 401 || error.code === "session_not_found" || error.code === "no_authorization") {
      return answer("/reset", { error: "reset-expired" });
    }
    // This page has no email field, so Supabase's validation_failed can't be about an email.
    const code = authErrorCode(error);
    return answer("/reset", { error: code === "invalid-email" ? GENERIC_ERROR : code });
  }
  // Supabase Auth ends the account's other sessions on a password change (ASVS 5.0.0 7.4.3;
  // LogoutAllExceptMe in its models/user.go). Their access tokens stay valid until they expire
  // (jwt_expiry, 1 hour) but can't be refreshed. E2E: "a password reset ends ... other sessions".
  redirect("/w?password=changed");
}

// Email links land on /auth/confirm, which shows a button that posts here. Verifying on POST
// rather than on GET means mail scanners that open links can't use up the one-time token.
export async function confirmEmailLink(_state: FormState, formData: FormData): Promise<FormState> {
  const type = field(formData, "type");
  const tokenHash = field(formData, "token_hash");
  // Back to the same link, so a visitor who was rate limited can press the button again.
  const page = `/auth/confirm?${new URLSearchParams({ token_hash: tokenHash, type })}`;
  if ((type !== "email" && type !== "recovery") || !tokenHash) {
    return answer(page, { error: "link-invalid" });
  }
  const supabase = await createClient();
  const limited = await limitError(supabase, RULES.verify, true);
  if (limited) return answer(page, { error: limited });
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) {
    logAuthError(`verify-${type}`, error);
    if (error.status === 429) return answer(page, { error: authErrorCode(error) });
    return answer(page, { error: "link-used" });
  }
  redirect(type === "recovery" ? "/reset" : "/w");
}

export async function logOut(): Promise<void> {
  const supabase = await createClient();
  // "local" ends this session (its refresh token is revoked on the server) and leaves the
  // user's other devices signed in.
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) logAuthError("logout", error);
  redirect("/login?signed_out=1");
}
