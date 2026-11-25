// Facts about the signed-in session, read from its verified JWT claims.

// The sign-in methods after which Supabase Auth lets a session change the password without the
// current one, even with require_current_password on (ADR 0023): Session.IsRecovery() in
// supabase/auth v2.198.0 internal/models/sessions.go, with AuthenticationMethod.IsRecovery() in
// internal/models/factor.go (otp, magiclink, recovery). Measured on GoTrue v2.198.0: a reset link
// and a sign-up confirmation link both give amr [{"method":"otp"}]; a password login gives
// "password", and a token refresh keeps the session's amr.
const EMAILED_LINK_METHODS = new Set(["otp", "magiclink", "recovery"]);

/** True when the session was started from an emailed link (reset or confirmation). */
export function startedFromEmailedLink(amr: unknown): boolean {
  if (!Array.isArray(amr)) return false;
  // The amr claim is either RFC 8176 strings or Supabase's { method, timestamp } entries.
  return amr.some((entry) => {
    const method = typeof entry === "string" ? entry : (entry as { method?: unknown } | null)?.method;
    return typeof method === "string" && EMAILED_LINK_METHODS.has(method);
  });
}
