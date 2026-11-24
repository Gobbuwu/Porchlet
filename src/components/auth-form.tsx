"use client";

import { useActionState, type ReactNode } from "react";
import type { FormState } from "@/lib/auth/types";
import { EmailField } from "./fields";

// A form posted to a Server Action. It works without JavaScript too; with it, the result shows
// without a full page load. Messages are announced to screen readers.
export function AuthForm({
  action,
  submitLabel,
  withEmail = false,
  children,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
  /** Show the email field first, keeping what was typed after a failed attempt. */
  withEmail?: boolean;
  children?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, {});
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
