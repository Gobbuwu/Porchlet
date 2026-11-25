"use client";

import { useActionState, useLayoutEffect, useState, type ReactNode } from "react";
import type { FormState } from "@/lib/auth/types";
import { EmailField } from "./fields";

type Props = {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  /** From formStateFromParams(searchParams). */
  initialState?: FormState;
  submitLabel: string;
  /** Show the email field first, keeping what was typed after a failed attempt. */
  withEmail?: boolean;
  children?: ReactNode;
};

// A form posted to a Server Action. With JavaScript, the result shows without a full page load.
// Posted without it (or before React hydrated), the action redirects back with a message code and
// the page passes that message in as `initialState` (ADR 0018). Messages are announced to screen
// readers.
//
// Next.js keeps recently visited pages alive, hidden, in React's Activity and shows them again with
// their state (node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md), and
// useActionState reads `initialState` only once. So a page shown again would keep its last answer and
// ignore the message its new URL carries (measured: /reset kept "Your email is confirmed" after a
// login sent it there with a different message). The form therefore starts over each time its page
// is hidden, and whenever the page hands it a different initial message.
export function AuthForm(props: Props) {
  const [visit, setVisit] = useState(0);
  // Runs when Activity hides the page (and on unmount, where it does nothing).
  useLayoutEffect(() => () => setVisit((v) => v + 1), []);
  return <ActionForm key={`${visit}:${JSON.stringify(props.initialState ?? {})}`} {...props} />;
}

function ActionForm({
  action,
  initialState = {},
  submitLabel,
  withEmail = false,
  children,
}: Props) {
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
