import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
import { PasswordField } from "@/components/fields";
import { startedFromEmailedLink } from "@/lib/auth/session";
import { formStateFromParams } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { logOut, setNewPassword } from "../actions";

export const metadata: Metadata = { title: "Choose a new password · Porchlet" };

// Reached from the reset email (/auth/confirm verifies the link and signs the user in first), after
// a login with a common or breached password (ADR 0021), or by a signed-in user changing it.
export default async function ResetPage({ searchParams }: PageProps<"/reset">) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) {
    // The login check sends a flagged session here with this code; if that session has since ended,
    // the visitor never had a reset link, so the reset-link text would be wrong (ADR 0023).
    return (
      <main className="narrow">
        <h1>Choose a new password</h1>
        {params.error === "password-change-required" ? (
          <p role="alert" className="error">
            Your session has ended. <Link href="/login">Log in again</Link>.
          </p>
        ) : (
          <p role="alert" className="error">
            Your reset link has expired. <Link href="/forgot">Ask for a new one</Link>.
          </p>
        )}
      </main>
    );
  }
  // Supabase Auth asks for the current password unless the session came from an emailed link
  // (require_current_password, ADR 0023), so the field shows only when it will be checked.
  const askCurrent = !startedFromEmailedLink(data.claims.amr);
  return (
    <main className="narrow">
      <h1>Choose a new password</h1>
      <AuthForm action={setNewPassword} initialState={formStateFromParams(params)} submitLabel="Save new password">
        {askCurrent ? <PasswordField label="Current password" name="current_password" autoComplete="current-password" /> : null}
        <PasswordField label="New password (at least 10 characters)" autoComplete="new-password" />
      </AuthForm>
      {/* A session that must change its password (ADR 0021, ADR 0023) can't reach /w, so it logs out here. */}
      <form action={logOut}>
        <button type="submit">Log out</button>
      </form>
    </main>
  );
}
