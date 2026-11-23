import type { Metadata } from "next";
import { confirmEmailLink } from "@/app/(auth)/actions";
import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = { title: "Confirm · Porchlet" };

// Links in the confirmation and reset emails come here (supabase/templates). Opening the link
// changes nothing; the button posts the token, so a mail scanner that follows links can't use
// it up.
export default async function ConfirmPage({ searchParams }: PageProps<"/auth/confirm">) {
  const params = await searchParams;
  const tokenHash = typeof params.token_hash === "string" ? params.token_hash : "";
  const type = params.type === "recovery" ? "recovery" : "email";
  const recovery = type === "recovery";
  return (
    <main className="narrow">
      <h1>{recovery ? "Reset your password" : "Confirm your email"}</h1>
      <AuthForm action={confirmEmailLink} submitLabel={recovery ? "Continue" : "Confirm email"}>
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input type="hidden" name="type" value={type} />
      </AuthForm>
    </main>
  );
}
