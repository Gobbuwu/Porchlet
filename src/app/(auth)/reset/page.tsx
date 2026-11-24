import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
import { PasswordField } from "@/components/fields";
import { formStateFromParams } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { setNewPassword } from "../actions";

export const metadata: Metadata = { title: "Choose a new password · Porchlet" };

// Reached from the reset email: /auth/confirm verifies the link and signs the user in first.
export default async function ResetPage({ searchParams }: PageProps<"/reset">) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) {
    return (
      <main className="narrow">
        <h1>Choose a new password</h1>
        <p role="alert" className="error">
          Your reset link has expired. <Link href="/forgot">Ask for a new one</Link>.
        </p>
      </main>
    );
  }
  return (
    <main className="narrow">
      <h1>Choose a new password</h1>
      <AuthForm action={setNewPassword} initialState={formStateFromParams(await searchParams)} submitLabel="Save new password">
        <PasswordField label="New password (at least 10 characters)" autoComplete="new-password" />
      </AuthForm>
    </main>
  );
}
