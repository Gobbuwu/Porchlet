import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { formStateFromParams } from "@/lib/auth/types";
import { isInviteToken } from "@/lib/invites";
import { createClient } from "@/lib/supabase/server";
import { acceptInvite } from "./actions";

export const metadata: Metadata = { title: "Join a workspace · Porchlet" };

// The invite link an owner copies, and where an invite email's link ends up when its sign-in part
// is already used (ADR 0024). Opening it changes nothing; the button accepts (threat T6). The page
// shows nothing about the workspace: the visitor isn't a member yet, so RLS shows them nothing.
export default async function InvitePage({ searchParams }: PageProps<"/invite">) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  // The proxy already sends signed-out visitors to /login with this page as `next`.
  if (!data?.claims?.sub) redirect(`/login?${new URLSearchParams({ next: `/invite?${new URLSearchParams({ token })}` })}`);
  const email = typeof data.claims.email === "string" ? data.claims.email : "";
  return (
    <main className="narrow">
      <h1>Join a workspace</h1>
      {isInviteToken(token) ? (
        <>
          <p>
            You were invited to a Porchlet workspace. You are logged in as <strong>{email}</strong>; the invitation
            must be for this address.
          </p>
          <AuthForm action={acceptInvite} initialState={formStateFromParams(params)} submitLabel="Join workspace">
            <input type="hidden" name="token" value={token} />
          </AuthForm>
        </>
      ) : (
        <p role="alert" className="error">
          This invite link is not valid. Ask for a new one.
        </p>
      )}
    </main>
  );
}
