import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { MESSAGES, type MessageCode } from "@/lib/auth/messages";
import type { FormState } from "@/lib/auth/types";

// A text field of a posted form; "" when it is missing or is a file.
export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export type Outcome = { error?: MessageCode; notice?: MessageCode; email?: string };

// Answers a form post from a Server Action. When the hydrated page sent it (React's fetch, which
// carries Next.js's Next-Action header), the result goes back to useActionState. A native form post
// (sent before React hydrated, or with JavaScript off) is redirected to `page` with the message
// code in the URL instead (Post/Redirect/Get), and the page shows the message: Next.js 16.4 renders
// the response to such a post by resuming the prerendered shell, and React's resume() takes no form
// state, so useActionState would show nothing (measured; ADR 0018, Next.js issue #99756).
// The typed email is not put in the URL, so that path doesn't keep it.
//
// `form` names which of a page's forms the message is for, when it has several (the workspace
// page); the page shows a redirected message only on the form whose key matches (ADR 0025).
export async function answer(page: string, outcome: Outcome, form?: string): Promise<FormState> {
  if ((await headers()).has("next-action")) {
    const state: FormState = {};
    if (outcome.error) state.error = MESSAGES[outcome.error];
    if (outcome.notice) state.notice = MESSAGES[outcome.notice];
    if (outcome.email !== undefined) state.email = outcome.email;
    return state;
  }
  const url = new URL(page, "http://porchlet.invalid");
  if (outcome.error) url.searchParams.set("error", outcome.error);
  if (outcome.notice) url.searchParams.set("notice", outcome.notice);
  if (form) url.searchParams.set("form", form);
  redirect(url.pathname + url.search);
}
