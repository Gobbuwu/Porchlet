import { messageText } from "./messages";

// What a form's Server Action returns: an error to show, or a notice (for example "check your
// email"), plus the email typed, so the form can keep it after React resets the form.
export type FormState = { error?: string; notice?: string; email?: string };

// The state a form starts with: the message a form posted without JavaScript was redirected back
// with (ADR 0018). Only our own message codes are read; anything else in the URL is ignored.
export function formStateFromParams(params: Record<string, string | string[] | undefined>): FormState {
  const state: FormState = {};
  const error = messageText(params.error);
  const notice = messageText(params.notice);
  if (error) state.error = error;
  if (notice) state.notice = notice;
  return state;
}
