import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { logOut } from "@/app/(auth)/actions";
import { AuthForm } from "@/components/auth-form";
import { messageText } from "@/lib/auth/messages";
import { formStateFromParams } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { workspacePage } from "@/lib/workspaces";
import { createWorkspace } from "./actions";

export const metadata: Metadata = { title: "Workspaces · Porchlet" };

export default async function WorkspacesPage({ searchParams }: PageProps<"/w">) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  // The proxy already sends signed-out visitors to /login; this is the second check.
  if (!data?.claims?.sub) redirect("/login?next=/w");
  const uid = data.claims.sub;
  const email = typeof data.claims.email === "string" ? data.claims.email : "";
  const params = await searchParams;

  // RLS returns only the workspaces this user belongs to (ADR 0004), and only their own
  // memberships are asked for here.
  const [workspaces, memberships, admin] = await Promise.all([
    supabase.from("workspaces").select("id, name").order("name").order("id"),
    supabase.from("workspace_members").select("workspace_id, role").eq("user_id", uid),
    supabase.rpc("is_instance_admin"),
  ]);
  const loadError = workspaces.error ?? memberships.error;
  if (loadError) console.warn(`workspaces list failed: code=${loadError.code}`);
  // Without an answer the create form is left out; the list doesn't depend on it.
  if (admin.error) console.warn(`admin check failed: code=${admin.error.code}`);
  const isAdmin = admin.data === true;
  const list = workspaces.data ?? [];
  const roles = new Map((memberships.data ?? []).map((m) => [m.workspace_id, m.role]));
  const notice = messageText(params.notice);
  // A message for a form this page doesn't show (ADR 0025) shows at the top instead.
  const pageError = isAdmin && params.form === "create-workspace" ? undefined : messageText(params.error);

  return (
    <main className="narrow">
      <h1>Workspaces</h1>
      {params.password === "changed" ? (
        <p role="status" className="notice">
          Your password has been changed.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="notice">
          {notice}
        </p>
      ) : null}
      {pageError ? (
        <p role="alert" className="error">
          {pageError}
        </p>
      ) : null}
      <p>
        Signed in as <strong>{email}</strong>.
      </p>
      {loadError ? (
        <p role="alert" className="error">
          Your workspaces could not be loaded. Reload the page to try again.
        </p>
      ) : list.length === 0 ? (
        <p>You are not in any workspace yet.</p>
      ) : (
        <ul aria-label="Your workspaces">
          {list.map((w) => (
            <li key={w.id}>
              <Link href={workspacePage(w.id)}>{w.name}</Link> ({roles.get(w.id) === "owner" ? "owner" : "client"})
            </li>
          ))}
        </ul>
      )}
      {isAdmin ? (
        <section aria-labelledby="new-workspace">
          <h2 id="new-workspace">New workspace</h2>
          <AuthForm
            action={createWorkspace}
            initialState={formStateFromParams(params, "create-workspace")}
            submitLabel="Create workspace"
          >
            <label>
              Workspace name
              <input name="name" required autoComplete="off" />
            </label>
          </AuthForm>
        </section>
      ) : null}
      <form action={logOut}>
        <button type="submit">Log out</button>
      </form>
    </main>
  );
}
