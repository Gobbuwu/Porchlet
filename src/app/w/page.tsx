import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { logOut } from "@/app/(auth)/actions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Workspaces · Porchlet" };

export default async function WorkspacesPage({ searchParams }: PageProps<"/w">) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  // The proxy already sends signed-out visitors to /login; this is the second check.
  if (!data?.claims?.sub) redirect("/login?next=/w");
  const email = typeof data.claims.email === "string" ? data.claims.email : "";
  const params = await searchParams;
  return (
    <main className="narrow">
      <h1>Workspaces</h1>
      {params.password === "changed" ? (
        <p role="status" className="notice">
          Your password has been changed.
        </p>
      ) : null}
      <p>
        Signed in as <strong>{email}</strong>.
      </p>
      <p>You are not in any workspace yet.</p>
      <form action={logOut}>
        <button type="submit">Log out</button>
      </form>
    </main>
  );
}
