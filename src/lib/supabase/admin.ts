import "server-only";
import { createClient } from "@supabase/supabase-js";

// The only place Porchlet's app code uses the Supabase secret key (ADR 0005, ADR 0024; CI checks
// that nothing else reads it: scripts/ci/check-secret-key-use.sh). It sends invite emails and
// nothing more: it reads no user data, and every check on who may invite runs before, as the
// signed-in owner (create_invitation).

export type InviteEmailResult = "sent" | "has-account" | "failed";

/**
 * Asks Supabase Auth to email an invitation to an address with no account yet. `link` is the
 * Porchlet invite link; the email template puts it in its own link's `invite` parameter.
 * Supabase Auth answers 422 email_exists for an address that already has an account (measured,
 * M2.md D2): the owner sends the link themselves then.
 */
export async function sendInviteEmail(email: string, link: string): Promise<InviteEmailResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    console.warn("invite email not sent: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY is not set");
    return "failed";
  }
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: link });
  if (!error) return "sent";
  if (error.code === "email_exists") return "has-account";
  // Status and code only: never the address.
  console.warn(`invite email failed: status=${error.status} code=${error.code}`);
  return "failed";
}
