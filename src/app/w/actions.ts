"use server";

import { redirect } from "next/navigation";
import { GENERIC_ERROR, type MessageCode } from "@/lib/auth/messages";
import type { FormState } from "@/lib/auth/types";
import { answer, field } from "@/lib/form-answer";
import { createClient } from "@/lib/supabase/server";
import { isUuid, nameProblem, workspacePage } from "@/lib/workspaces";

// Workspace and project writes (M2 PR 2), as Server Actions (decision D5). Each one runs as the
// signed-in user with the publishable key, so RLS and the RPCs decide what it may change (ADR 0004,
// ADR 0006); the checks here only pick the message. Next.js refuses a Server Action POST whose
// Origin is another site (measured in M1; e2e/workspaces.spec.ts replays one of these).
//
// Success redirects to the page with a notice, on both paths, so the page renders fresh data.
// A refusal answers the form that was posted (answer(), ADR 0018 and ADR 0025).

type Supabase = Awaited<ReturnType<typeof createClient>>;

// The signed-in user, or a redirect to log in. Server Actions can be posted without the proxy's
// page checks, so each one checks the session itself.
async function signedIn(page: string): Promise<{ supabase: Supabase; uid: string }> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const uid = data?.claims?.sub;
  if (!uid) redirect(`/login?${new URLSearchParams({ next: page })}`);
  return { supabase, uid };
}

// RLS refusals on insert and permission errors both come back as 42501; an RPC's own refusal
// does too (`not_allowed`). Anything else is unexpected: logged by code only, shown generically.
function dbErrorCode(action: string, error: { code?: string }): MessageCode {
  if (error.code === "42501") return "not-allowed";
  console.warn(`workspace ${action} failed: code=${error.code}`);
  return GENERIC_ERROR;
}

export async function createWorkspace(_state: FormState, formData: FormData): Promise<FormState> {
  const form = "create-workspace";
  const { supabase } = await signedIn("/w");
  const name = field(formData, "name").trim();
  if (nameProblem(name, 80)) return answer("/w", { error: "workspace-name-invalid" }, form);
  const { data, error } = await supabase.rpc("create_workspace", { p_name: name });
  if (error || typeof data !== "string") {
    return answer("/w", { error: error ? dbErrorCode("create", error) : GENERIC_ERROR }, form);
  }
  redirect(`${workspacePage(data)}?notice=workspace-created`);
}

export async function createProject(_state: FormState, formData: FormData): Promise<FormState> {
  const form = "create-project";
  const workspaceId = field(formData, "workspace_id");
  if (!isUuid(workspaceId)) return answer("/w", { error: "not-allowed" });
  const page = workspacePage(workspaceId);
  const { supabase } = await signedIn(page);
  const name = field(formData, "name").trim();
  if (nameProblem(name, 120)) return answer(page, { error: "project-name-invalid" }, form);
  const { error } = await supabase.from("projects").insert({ workspace_id: workspaceId, name });
  if (error) return answer(page, { error: dbErrorCode("project-create", error) }, form);
  redirect(`${page}?notice=project-created`);
}

// Updates one project of the workspace; no row back means RLS refused it (not an owner) or the
// project isn't in this workspace, which get the same answer.
async function updateProject(
  formData: FormData,
  form: (projectId: string) => string,
  change: (formData: FormData) => { values: { name?: string; status?: string }; notice: MessageCode } | MessageCode,
): Promise<FormState> {
  const workspaceId = field(formData, "workspace_id");
  const projectId = field(formData, "project_id");
  if (!isUuid(workspaceId) || !isUuid(projectId)) return answer("/w", { error: "not-allowed" });
  const page = workspacePage(workspaceId);
  const { supabase } = await signedIn(page);
  const wanted = change(formData);
  if (typeof wanted === "string") return answer(page, { error: wanted }, form(projectId));
  const { data, error } = await supabase
    .from("projects")
    .update(wanted.values)
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .select("id");
  if (error) return answer(page, { error: dbErrorCode("project-update", error) }, form(projectId));
  if (!data?.length) return answer(page, { error: "not-allowed" }, form(projectId));
  redirect(`${page}?notice=${wanted.notice}`);
}

export async function renameProject(_state: FormState, formData: FormData): Promise<FormState> {
  return updateProject(
    formData,
    (id) => `rename-${id}`,
    (fd) => {
      const name = field(fd, "name").trim();
      return nameProblem(name, 120) ? "project-name-invalid" : { values: { name }, notice: "project-renamed" };
    },
  );
}

export async function setProjectStatus(_state: FormState, formData: FormData): Promise<FormState> {
  return updateProject(
    formData,
    (id) => `status-${id}`,
    (fd) => {
      const status = field(fd, "status");
      if (status === "archived") return { values: { status }, notice: "project-archived" };
      if (status === "active") return { values: { status }, notice: "project-restored" };
      return GENERIC_ERROR;
    },
  );
}

// An owner removes another member. The delete policy lets owners remove anyone but themselves
// (so a workspace keeps its owner); clients can remove no one but themselves (leaveWorkspace).
export async function removeMember(_state: FormState, formData: FormData): Promise<FormState> {
  const workspaceId = field(formData, "workspace_id");
  const userId = field(formData, "user_id");
  if (!isUuid(workspaceId) || !isUuid(userId)) return answer("/w", { error: "not-allowed" });
  const page = workspacePage(workspaceId);
  const form = `member-${userId}`;
  const { supabase } = await signedIn(page);
  const { data, error } = await supabase
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .select("user_id");
  if (error) return answer(page, { error: dbErrorCode("member-remove", error) }, form);
  if (!data?.length) return answer(page, { error: "not-allowed" }, form);
  redirect(`${page}?notice=member-removed`);
}

// A client leaves. Owners can't (the delete policy), so their attempt gets "not allowed".
export async function leaveWorkspace(_state: FormState, formData: FormData): Promise<FormState> {
  const form = "leave";
  const workspaceId = field(formData, "workspace_id");
  if (!isUuid(workspaceId)) return answer("/w", { error: "not-allowed" });
  const page = workspacePage(workspaceId);
  const { supabase, uid } = await signedIn(page);
  const { data, error } = await supabase
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", uid)
    .select("user_id");
  if (error) return answer(page, { error: dbErrorCode("leave", error) }, form);
  if (!data?.length) return answer(page, { error: "not-allowed" }, form);
  redirect("/w?notice=left-workspace");
}
