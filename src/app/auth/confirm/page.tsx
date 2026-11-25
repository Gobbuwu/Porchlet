import type { Metadata } from "next";
import { confirmEmailLink } from "@/app/(auth)/actions";
import { AuthForm } from "@/components/auth-form";
import { formStateFromParams } from "@/lib/auth/types";

export const metadata: Metadata = { title: "Confirm · Porchlet" };

// Links in the confirmation, reset and invite emails come here (supabase/templates). Opening the
// link changes nothing; the button posts the token, so a mail scanner that follows links can't use
// it up. An invite link also carries the Porchlet invite link in `invite` (ADR 0024).
export default async function ConfirmPage({ searchParams }: PageProps<"/auth/confirm">) {
  const params = await searchParams;
  const tokenHash = typeof params.token_hash === "string" ? params.token_hash : "";
  const type = params.type === "recovery" || params.type === "invite" ? params.type : "email";
  const invite = typeof params.invite === "string" ? params.invite : "";
  const heading = { recovery: "Reset your password", invite: "Join your Porchlet workspace", email: "Confirm your email" }[type];
  const label = { recovery: "Continue", invite: "Accept invitation", email: "Confirm email" }[type];
  return (
    <main className="narrow">
      <h1>{heading}</h1>
      <AuthForm action={confirmEmailLink} initialState={formStateFromParams(params)} submitLabel={label}>
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input type="hidden" name="type" value={type} />
        {type === "invite" ? <input type="hidden" name="invite" value={invite} /> : null}
      </AuthForm>
    </main>
  );
}
