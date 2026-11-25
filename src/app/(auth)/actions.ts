"use server";

import { isAuthSessionMissingError } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { authErrorCode, GENERIC_ERROR, type MessageCode, TOO_MANY_ATTEMPTS } from "@/lib/auth/messages";
import { loginNeedsPasswordChange, newPasswordProblem } from "@/lib/auth/password-check";
import { clientIp, releaseLimits, type Rule, RULES, takeLimits } from "@/lib/auth/rate-limit";
import { safeNext } from "@/lib/auth/redirect";
import { startedFromEmailedLink } from "@/lib/auth/session";
import type { FormState } from "@/lib/auth/types";
import { answer, field } from "@/lib/form-answer";
import { inviteErrorCode, tokenFromInviteLink } from "@/lib/invites";
import { isHttps } from "@/lib/http";
import { hardenCookie, passwordChangeCookieName } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";

// Auth runs here, on the server, so the session cookie can be HttpOnly (ADR 0014).
// Next.js checks that each Server Action POST comes from this site's Origin
// (node_modules/next/dist/docs/01-app/02-guides/data-security.md).

// Counts this attempt against Porchlet's per-visitor limits (ADR 0015, 0022). Returns a message
// code for the form when the visitor is over a limit or the limiter can't answer; otherwise the
// ids of the hits taken, which a login gives back when the password proves right.
async function takeAttempt(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rules: readonly Rule[],
): Promise<{ error: MessageCode } | { hits: number[] }> {
  const result = await takeLimits(supabase, clientIp(await headers()), rules);
  if (result.status === "limited") return { error: TOO_MANY_ATTEMPTS };
  if (result.status === "unavailable") return { error: GENERIC_ERROR };
  return { hits: result.hits };
}

// Sets or clears the cookie that sends this browser's app pages to /reset (ADR 0021). It holds the
// flagged session's id, and the proxy acts on it only while that session is the signed-in one, so
// it can't follow a later sign-in. It lives as long as the session cookies (@supabase/ssr's 400
// days), so closing the browser doesn't drop it, and is cleared with the same attributes, which a
// __Host- cookie needs.
const FLAG_MAX_AGE = 400 * 24 * 60 * 60;

async function requirePasswordChange(sessionId: string | null) {
  const secure = isHttps(await headers());
  (await cookies()).set(passwordChangeCookieName(secure), sessionId ?? "", {
    ...hardenCookie({}, secure),
    maxAge: sessionId ? FLAG_MAX_AGE : 0,
  });
}

// The session id (the session_id claim) of an access token Supabase Auth just issued to this
// server. Not a verification: the token came straight from Supabase over the server's own call.
function sessionIdOf(accessToken: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof claims.session_id === "string" && claims.session_id ? claims.session_id : null;
  } catch {
    return null;
  }
}

// Ends this browser's session and its password-change flag. "local" leaves the user's other
// devices signed in. auth-js removes the session cookies before it asks Supabase to revoke the
// refresh token, so the browser is signed out even when that call fails (measured with Supabase
// Auth stopped: a 500 after about a minute, and no session cookie left; ADR 0021).
async function endSession(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) logAuthError("logout", error);
  await requirePasswordChange(null);
}

// Flags the session that `accessToken` belongs to. Without a session id the flag couldn't be
// matched, so it fails closed: the session is ended and false returned.
async function flagSession(supabase: Awaited<ReturnType<typeof createClient>>, accessToken: string | undefined) {
  const sessionId = sessionIdOf(accessToken ?? "");
  if (!sessionId) {
    await endSession(supabase);
    return false;
  }
  await requirePasswordChange(sessionId);
  return true;
}

function logAuthError(action: string, error: { status?: number; code?: string }) {
  // Status and code only: never the email or the password.
  console.warn(`auth ${action} failed: status=${error.status} code=${error.code}`);
}

export async function signUp(_state: FormState, formData: FormData): Promise<FormState> {
  const email = field(formData, "email").trim();
  const supabase = await createClient();
  const taken = await takeAttempt(supabase, RULES.signUp);
  if ("error" in taken) return answer("/signup", { error: taken.error, email });
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
  // Only failures count, so people who share an IP (an office, a campus) can all still log in. The
  // attempt takes its slot first and gives it back on success (ADR 0022): counting only after
  // Supabase answered let parallel guesses all pass the check.
  const taken = await takeAttempt(supabase, RULES.loginFailures(email));
  if ("error" in taken) return answer(page, { error: taken.error, email });
  const password = field(formData, "password");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    logAuthError("login", error);
    // A 429 means Supabase refused before checking the password, so it wasn't a guess.
    if (error.status === 429) await releaseLimits(supabase, taken.hits);
    return answer(page, { error: authErrorCode(error), email });
  }
  await releaseLimits(supabase, taken.hits);
  // The new-password check runs again at every login (ADR 0021), only after the password proved
  // right. It catches passwords set by calling Supabase Auth directly, set before ADR 0019, or
  // breached since. A flagged session can't use the app until the password is changed.
  if (await loginNeedsPasswordChange(password)) {
    if (!(await flagSession(supabase, data.session?.access_token))) return answer(page, { error: GENERIC_ERROR, email });
    redirect("/reset?error=password-change-required");
  }
  await requirePasswordChange(null);
  redirect(next);
}

export async function requestReset(_state: FormState, formData: FormData): Promise<FormState> {
  const email = field(formData, "email").trim();
  const supabase = await createClient();
  const taken = await takeAttempt(supabase, RULES.reset);
  if ("error" in taken) return answer("/forgot", { error: taken.error, email });
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) {
    logAuthError("reset-request", error);
    return answer("/forgot", { error: authErrorCode(error), email });
  }
  return answer("/forgot", { notice: "reset-sent", email });
}

export async function setNewPassword(_state: FormState, formData: FormData): Promise<FormState> {
  const supabase = await createClient();
  const taken = await takeAttempt(supabase, RULES.newPassword);
  if ("error" in taken) return answer("/reset", { error: taken.error });
  const password = field(formData, "password");
  const problem = await newPasswordProblem(password);
  if (problem) return answer("/reset", { error: problem });
  // Supabase Auth asks a password session for its current password (require_current_password,
  // ADR 0023); it decides from the session, so a post without the field gets
  // current_password_required. Read from the live session rather than the form, which may have been
  // rendered for an earlier one; with no session, the form's field says which kind it was.
  const claims = (await supabase.auth.getClaims()).data?.claims;
  const passwordSession = claims ? !startedFromEmailedLink(claims.amr) : formData.has("current_password");
  const { error } = await supabase.auth.updateUser(
    passwordSession ? { password, current_password: field(formData, "current_password") } : { password },
  );
  if (error) {
    logAuthError("reset-update", error);
    // auth-js answers AuthSessionMissingError (400, no code) when Supabase Auth no longer knows the
    // session, for example after it was ended server-side while its access token was still valid
    // (measured, ADR 0023). That token would keep the visitor "signed in" here until it expires, so
    // the session is ended locally too, and logging in again works at once.
    if (
      isAuthSessionMissingError(error) ||
      error.status === 401 ||
      error.code === "session_not_found" ||
      error.code === "no_authorization"
    ) {
      await endSession(supabase);
      return answer("/reset", { error: passwordSession ? "session-ended" : "reset-expired" });
    }
    const code = authErrorCode(error);
    // A form rendered for an emailed-link session has no current-password field; reload the page
    // so this session gets one.
    if (code === "current-password-required" && !formData.has("current_password")) {
      redirect("/reset?error=current-password-required");
    }
    // This page has no email field, so Supabase's validation_failed can't be about an email.
    return answer("/reset", { error: code === "invalid-email" ? GENERIC_ERROR : code });
  }
  // Supabase Auth ends the account's other sessions on a password change (ASVS 5.0.0 7.4.3;
  // LogoutAllExceptMe in its models/user.go). Their access tokens stay valid until they expire
  // (jwt_expiry, 1 hour) but can't be refreshed. E2E: "a password reset ends ... other sessions".
  await requirePasswordChange(null);
  redirect("/w?password=changed");
}

// Email links land on /auth/confirm, which shows a button that posts here. Verifying on POST
// rather than on GET means mail scanners that open links can't use up the one-time token.
export async function confirmEmailLink(_state: FormState, formData: FormData): Promise<FormState> {
  const type = field(formData, "type");
  const tokenHash = field(formData, "token_hash");
  const inviteParam = field(formData, "invite");
  // Back to the same link, so a visitor who was rate limited can press the button again.
  const page = `/auth/confirm?${new URLSearchParams({ token_hash: tokenHash, type, ...(type === "invite" ? { invite: inviteParam } : {}) })}`;
  if ((type !== "email" && type !== "recovery" && type !== "invite") || !tokenHash) {
    return answer(page, { error: "link-invalid" });
  }
  // An invite email's link (ADR 0024): only the token is taken from the Porchlet link inside it.
  const inviteToken = type === "invite" ? tokenFromInviteLink(inviteParam) : null;
  if (type === "invite" && !inviteToken) return answer(page, { error: "link-invalid" });
  const supabase = await createClient();
  const taken = await takeAttempt(supabase, RULES.verify);
  if ("error" in taken) return answer(page, { error: taken.error });
  // An emailed link starts a new session; if this browser's current session is flagged by the login
  // check, the new one is flagged too, so a link is no way around the change (ADR 0021). As in the
  // proxy, the flag counts only while it holds the current session's id, and it is carried only to
  // a session of the same user: another account's link in this browser has nothing to change.
  const flag = (await cookies()).get(passwordChangeCookieName(isHttps(await headers())))?.value;
  const claims = flag ? (await supabase.auth.getClaims()).data?.claims : undefined;
  const flaggedUser = !!flag && flag === claims?.session_id ? claims.sub : undefined;
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) {
    logAuthError(`verify-${type}`, error);
    if (error.status === 429) return answer(page, { error: authErrorCode(error) });
    // The sign-in part of an invite link stops working once the address has been confirmed some
    // other way, for example by the person's own sign-up (measured, M2.md D2 and T8). The
    // invitation itself may still be open, so the person can join from a session of that address.
    // Sent straight to the right page: a page's own redirect while it renders a Server Action's
    // redirect target shows the new page but leaves the old URL (measured, E2E).
    if (inviteToken) {
      const invitePage = `/invite?${new URLSearchParams({ token: inviteToken })}`;
      const signedIn = !!(await supabase.auth.getClaims()).data?.claims?.sub;
      redirect(
        signedIn
          ? `${invitePage}&error=invite-email-link-used`
          : `/login?${new URLSearchParams({ next: invitePage, error: "invite-email-link-used" })}`,
      );
    }
    return answer(page, { error: "link-used" });
  }
  if (inviteToken) {
    // The invited person's account is new and has no password they know, so this session must
    // choose one before it can use the app, as a reset link's must (ADR 0023). It joins first, in
    // this POST, so nothing depends on carrying the token through the password page.
    const { error: acceptError } = await supabase.rpc("accept_invitation", { p_token: inviteToken });
    if (acceptError && !inviteErrorCode(acceptError)) console.warn(`invite accept failed: code=${acceptError.code}`);
    if (!(await flagSession(supabase, data.session?.access_token))) return answer(page, { error: "link-used" });
    redirect(acceptError ? "/reset?error=invite-not-joined" : "/reset?notice=invite-joined");
  }
  // A reset link's session exists to set a new password, and Supabase Auth lets it do so without
  // the current one, so it can't open the app until it has (ADR 0023): otherwise the link would
  // be a way into the app that leaves the old password in place.
  const mustChange = type === "recovery" || (!!flaggedUser && flaggedUser === data.user?.id);
  // If the new session can't be flagged it has been ended, and the link is used up.
  if (mustChange && !(await flagSession(supabase, data.session?.access_token))) {
    return answer(page, { error: "link-used" });
  }
  if (type === "recovery") redirect("/reset");
  // A redirect from a Server Action renders its target in the same response, without the proxy
  // (measured: a flagged session's sign-in link showed /w), so a flagged session is sent to /reset
  // here rather than left to the proxy.
  redirect(mustChange ? "/reset?error=new-password-required" : "/w");
}

export async function logOut(): Promise<void> {
  await endSession(await createClient());
  redirect("/login?signed_out=1");
}
