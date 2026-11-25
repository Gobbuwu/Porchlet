"use server";

import { redirect } from "next/navigation";
import { GENERIC_ERROR } from "@/lib/auth/messages";
import type { FormState } from "@/lib/auth/types";
import { answer, field } from "@/lib/form-answer";
import { inviteErrorCode, isInviteToken } from "@/lib/invites";
import { createClient } from "@/lib/supabase/server";
import { workspacePage } from "@/lib/workspaces";

// A signed-in person accepts an invitation with the token from the link (ADR 0024). Opening the
// link only shows the page; this POST accepts, so a mail scanner or a prefetch can't (threat T6).
// accept_invitation checks that the token is current and is for this account's confirmed address.
export async function acceptInvite(_state: FormState, formData: FormData): Promise<FormState> {
  const token = field(formData, "token");
  if (!isInviteToken(token)) return answer("/invite", { error: "invite-invalid" });
  const page = `/invite?${new URLSearchParams({ token })}`;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) redirect(`/login?${new URLSearchParams({ next: page })}`);
  const { data, error } = await supabase.rpc("accept_invitation", { p_token: token });
  if (error || typeof data !== "string") {
    const code = error ? inviteErrorCode(error) : undefined;
    if (error && !code) console.warn(`invite accept failed: code=${error.code}`);
    return answer(page, { error: code ?? GENERIC_ERROR });
  }
  redirect(`${workspacePage(data)}?notice=joined-workspace`);
}
