"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authErrorMessage, GENERIC_ERROR, TOO_MANY_ATTEMPTS } from "@/lib/auth/messages";
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

// Counts this attempt against Porchlet's per-visitor limits (ADR 0015). Returns a message for the
// form when the visitor is over a limit or the limiter can't answer, else null.
async function limitError(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rules: readonly Rule[],
  record: boolean,
): Promise<string | null> {
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
  if (limited) return { error: limited, email };
  const { error } = await supabase.auth.signUp({
    email,
    password: field(formData, "password"),
  });
  // Same answer whether or not the email already has an account. Supabase Auth itself answers
  // 422 user_already_exists for a confirmed address (measured, ADR 0014), so the page hides it.
  if (error && error.code !== "user_already_exists") {
    logAuthError("signup", error);
    return { error: authErrorMessage(error), email };
  }
  return { notice: "Check your email for a link to confirm your account." };
}

export async function logIn(_state: FormState, formData: FormData): Promise<FormState> {
  const email = field(formData, "email").trim();
  const supabase = await createClient();
  // Only failures count, so people who share an IP (an office, a campus) can all still log in.
  const rules = RULES.loginFailures(email);
  const limited = await limitError(supabase, rules, false);
  if (limited) return { error: limited, email };
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password: field(formData, "password"),
  });
  if (error) {
    logAuthError("login", error);
    if (error.status !== 429) {
      const after = await limitError(supabase, rules, true);
      if (after === GENERIC_ERROR) return { error: after, email };
    }
    return { error: authErrorMessage(error), email };
  }
  redirect(safeNext(field(formData, "next")));
}

export async function requestReset(_state: FormState, formData: FormData): Promise<FormState> {
  const email = field(formData, "email").trim();
  const supabase = await createClient();
  const limited = await limitError(supabase, RULES.reset, true);
  if (limited) return { error: limited, email };
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) {
    logAuthError("reset-request", error);
    return { error: authErrorMessage(error), email };
  }
  return { notice: "If an account uses that email, we sent it a link to choose a new password.", email };
}

export async function setNewPassword(_state: FormState, formData: FormData): Promise<FormState> {
  const supabase = await createClient();
  const limited = await limitError(supabase, RULES.newPassword, true);
  if (limited) return { error: limited };
  const { error } = await supabase.auth.updateUser({ password: field(formData, "password") });
  if (error) {
    logAuthError("reset-update", error);
    if (error.status === 401 || error.code === "session_not_found" || error.code === "no_authorization") {
      return { error: "Your reset link has expired. Ask for a new one." };
    }
    return { error: authErrorMessage(error) };
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
  if ((type !== "email" && type !== "recovery") || !tokenHash) {
    return { error: "This link is not valid. Ask for a new one." };
  }
  const supabase = await createClient();
  const limited = await limitError(supabase, RULES.verify, true);
  if (limited) return { error: limited };
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) {
    logAuthError(`verify-${type}`, error);
    if (error.status === 429) return { error: authErrorMessage(error) };
    return { error: "This link has expired or was already used. Ask for a new one." };
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
