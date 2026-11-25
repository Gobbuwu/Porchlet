import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { messageText } from "@/lib/auth/messages";
import { formStateFromParams } from "@/lib/auth/types";
import { inviteLink, isInviteToken, siteOrigin } from "@/lib/invites";
import { createClient } from "@/lib/supabase/server";
import { isUuid, workspacePage } from "@/lib/workspaces";
import {
  createProject,
  inviteClient,
  leaveWorkspace,
  removeMember,
  renameProject,
  revokeInvitation,
  setProjectStatus,
} from "../actions";

export const metadata: Metadata = { title: "Workspace · Porchlet" };

type Project = { id: string; name: string; status: "active" | "archived" };
type Member = { userId: string; role: "owner" | "client"; name: string; email?: string };
type Invitation = { id: string; email: string; expires_at: string };

// One workspace: its projects and members. Everything shown comes through RLS as the signed-in
// user (ADR 0004): a workspace they don't belong to looks the same as one that doesn't exist,
// a 404 (threat model T1). Owners see members' emails through list_workspace_members; clients see
// co-members' display names only (decision D3).
export default async function WorkspacePage({ params, searchParams }: PageProps<"/w/[wid]">) {
  const { wid } = await params;
  if (!isUuid(wid)) notFound();
  const page = workspacePage(wid);
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) redirect(`/login?${new URLSearchParams({ next: page })}`);
  const uid = auth.claims.sub;
  const query = await searchParams;

  const [workspace, membership, projects] = await Promise.all([
    supabase.from("workspaces").select("id, name").eq("id", wid).maybeSingle(),
    supabase.from("workspace_members").select("role").eq("workspace_id", wid).eq("user_id", uid).maybeSingle(),
    supabase.from("projects").select("id, name, status").eq("workspace_id", wid).order("created_at").order("id"),
  ]);
  const loadError = workspace.error ?? membership.error ?? projects.error;
  if (loadError) throw new Error(`workspace page failed: code=${loadError.code}`);
  if (!workspace.data || !membership.data) notFound();
  const owner = membership.data.role === "owner";
  const [members, invitations] = await Promise.all([
    loadMembers(supabase, wid, owner),
    owner ? loadInvitations(supabase, wid) : Promise.resolve([]),
  ]);
  // The link of an invitation just made (inviteClient's redirect), shown once to copy (ADR 0024).
  const origin = siteOrigin();
  const newLink = owner && origin && isInviteToken(query.invite) ? inviteLink(origin, query.invite) : null;
  const list = (projects.data ?? []) as Project[];
  const active = list.filter((p) => p.status === "active");
  const archived = list.filter((p) => p.status === "archived");
  const notice = messageText(query.notice);
  // The forms this page shows, by answer()'s key (ADR 0025). A message for any other form (one
  // that is gone, such as a member already removed, or one this user doesn't get) shows at the top.
  const formKeys = new Set(
    owner
      ? [
          "create-project",
          ...active.flatMap((p) => [`rename-${p.id}`, `status-${p.id}`]),
          ...archived.map((p) => `status-${p.id}`),
          ...(members ?? []).filter((m) => m.userId !== uid).map((m) => `member-${m.userId}`),
          "invite",
          ...(invitations ?? []).map((i) => `invitation-${i.id}`),
        ]
      : ["leave"],
  );
  const pageError =
    typeof query.form === "string" && formKeys.has(query.form) ? undefined : messageText(query.error);
  const hidden = <input type="hidden" name="workspace_id" value={wid} />;

  return (
    <main className="narrow">
      <p>
        <Link href="/w">All workspaces</Link>
      </p>
      <h1>{workspace.data.name}</h1>
      <p>You are {owner ? "an owner" : "a client"} of this workspace.</p>
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
      {newLink ? (
        <p>
          <label>
            Invite link
            <input readOnly value={newLink} className="wide" />
          </label>
        </p>
      ) : null}

      <section aria-labelledby="projects">
        <h2 id="projects">Projects</h2>
        {active.length === 0 ? <p>No projects yet.</p> : null}
        <ul aria-label="Projects" className="items">
          {active.map((p) => (
            <li key={p.id} aria-label={p.name}>
              <strong>{p.name}</strong>
              {owner ? (
                <>
                  <AuthForm
                    action={renameProject}
                    initialState={formStateFromParams(query, `rename-${p.id}`)}
                    submitLabel="Rename"
                  >
                    {hidden}
                    <input type="hidden" name="project_id" value={p.id} />
                    <label>
                      New name
                      <input name="name" required defaultValue={p.name} autoComplete="off" />
                    </label>
                  </AuthForm>
                  <AuthForm
                    action={setProjectStatus}
                    initialState={formStateFromParams(query, `status-${p.id}`)}
                    submitLabel="Archive"
                  >
                    {hidden}
                    <input type="hidden" name="project_id" value={p.id} />
                    <input type="hidden" name="status" value="archived" />
                  </AuthForm>
                </>
              ) : null}
            </li>
          ))}
        </ul>
        {archived.length > 0 ? (
          <>
            <h3>Archived</h3>
            <ul aria-label="Archived projects" className="items">
              {archived.map((p) => (
                <li key={p.id} aria-label={p.name}>
                  <strong>{p.name}</strong> (archived)
                  {owner ? (
                    <AuthForm
                      action={setProjectStatus}
                      initialState={formStateFromParams(query, `status-${p.id}`)}
                      submitLabel="Restore"
                    >
                      {hidden}
                      <input type="hidden" name="project_id" value={p.id} />
                      <input type="hidden" name="status" value="active" />
                    </AuthForm>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {owner ? (
          <>
            <h3>New project</h3>
            <AuthForm
              action={createProject}
              initialState={formStateFromParams(query, "create-project")}
              submitLabel="Create project"
            >
              {hidden}
              <label>
                Project name
                <input name="name" required autoComplete="off" />
              </label>
            </AuthForm>
          </>
        ) : null}
      </section>

      <section aria-labelledby="members">
        <h2 id="members">Members</h2>
        {members === null ? (
          <p role="alert" className="error">
            The member list could not be loaded. Reload the page to try again.
          </p>
        ) : (
          <ul aria-label="Members" className="items">
            {members.map((m) => (
              <li key={m.userId} aria-label={m.email ?? (m.name || "A member with no display name yet")}>
                {m.email ? (
                  <>
                    <strong>{m.email}</strong>
                    {m.name ? ` (${m.name})` : null}
                  </>
                ) : (
                  <strong>{m.name || "A member with no display name yet"}</strong>
                )}{" "}
                · {m.role}
                {m.userId === uid ? " · you" : null}
                {owner && m.userId !== uid ? (
                  <AuthForm
                    action={removeMember}
                    initialState={formStateFromParams(query, `member-${m.userId}`)}
                    submitLabel="Remove from workspace"
                  >
                    {hidden}
                    <input type="hidden" name="user_id" value={m.userId} />
                  </AuthForm>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {owner ? (
          <>
            <h3>Invite a client</h3>
            <p>
              A new address gets an email with a link to join. An address that already has an account gets no email:
              copy the link shown after you invite and send it yourself. Links work once and expire after 7 days.
            </p>
            <AuthForm action={inviteClient} initialState={formStateFromParams(query, "invite")} submitLabel="Send invitation">
              {hidden}
              <label>
                Client&apos;s email
                <input name="email" type="email" required maxLength={254} autoComplete="off" />
              </label>
            </AuthForm>
            <h3>Open invitations</h3>
            {invitations === null ? (
              <p role="alert" className="error">
                The invitations could not be loaded. Reload the page to try again.
              </p>
            ) : invitations.length === 0 ? (
              <p>No open invitations.</p>
            ) : (
              <ul aria-label="Open invitations" className="items">
                {invitations.map((i) => (
                  <li key={i.id} aria-label={i.email}>
                    <strong>{i.email}</strong>{" "}
                    {new Date(i.expires_at) > new Date() ? `· expires ${i.expires_at.slice(0, 10)}` : "· expired"}
                    <AuthForm
                      action={revokeInvitation}
                      initialState={formStateFromParams(query, `invitation-${i.id}`)}
                      submitLabel="Withdraw invitation"
                    >
                      {hidden}
                      <input type="hidden" name="invitation_id" value={i.id} />
                    </AuthForm>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <AuthForm action={leaveWorkspace} initialState={formStateFromParams(query, "leave")} submitLabel="Leave workspace">
            {hidden}
          </AuthForm>
        )}
      </section>
    </main>
  );
}

// An owner's invitations not yet accepted, expired ones included (they hold no pending slot, and
// withdrawing them tidies the list). Columns are named: token_hash isn't readable (PR 1).
// null when the query failed.
async function loadInvitations(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string,
): Promise<Invitation[] | null> {
  const { data, error } = await supabase
    .from("invitations")
    .select("id, email, expires_at")
    .eq("workspace_id", workspaceId)
    .is("accepted_at", null)
    .order("created_at")
    .order("id");
  if (error) {
    console.warn(`invitation list failed: code=${error.code}`);
    return null;
  }
  return data as Invitation[];
}

// Owners: every member with their email (list_workspace_members, owner-only). Clients: memberships
// and co-members' profiles through RLS, display names only. null when a query failed.
async function loadMembers(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string,
  owner: boolean,
): Promise<Member[] | null> {
  if (owner) {
    const { data, error } = await supabase.rpc("list_workspace_members", { p_workspace_id: workspaceId });
    if (error) {
      console.warn(`member list failed: code=${error.code}`);
      return null;
    }
    return (data as { user_id: string; role: Member["role"]; display_name: string; email: string }[]).map((m) => ({
      userId: m.user_id,
      role: m.role,
      name: m.display_name,
      email: m.email,
    }));
  }
  const rows = await supabase
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", workspaceId)
    .order("created_at")
    .order("user_id");
  if (rows.error) {
    console.warn(`member list failed: code=${rows.error.code}`);
    return null;
  }
  const ids = rows.data.map((m) => m.user_id as string);
  const profiles = await supabase.from("profiles").select("id, display_name").in("id", ids);
  if (profiles.error) {
    console.warn(`member profiles failed: code=${profiles.error.code}`);
    return null;
  }
  const names = new Map(profiles.data.map((p) => [p.id as string, (p.display_name as string | null) ?? ""]));
  return rows.data.map((m) => ({ userId: m.user_id as string, role: m.role as Member["role"], name: names.get(m.user_id) ?? "" }));
}
