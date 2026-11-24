"use client";

import { useActionState, type ReactNode } from "react";
import type { FormState } from "@/lib/auth/types";
import { EmailField } from "./fields";

// A form posted to a Server Action. With JavaScript, the result shows without a full page load.
// Posted without it (or before React hydrated), the action redirects back with a message code and
// the page passes that message in as `initialState` (ADR 0018). Messages are announced to screen
// readers.
export function AuthForm({
  action,
  initialState = {},
  submitLabel,
  withEmail = false,
  children,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  /** From formStateFromParams(searchParams). */
  initialState?: FormState;
  submitLabel: string;
  /** Show the email field first, keeping what was typed after a failed attempt. */
  withEmail?: boolean;
  children?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  return (
    <form action={formAction} className="stack">
      {withEmail ? <EmailField defaultValue={state.email} /> : null}
      {children}
      {state.error ? (
        <p role="alert" className="error">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="notice">
          {state.notice}
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {submitLabel}
      </button>
    </form>
  );
}
