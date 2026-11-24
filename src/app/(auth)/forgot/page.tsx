import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
import { formStateFromParams } from "@/lib/auth/types";
import { requestReset } from "../actions";

export const metadata: Metadata = { title: "Reset your password · Porchlet" };

export default async function ForgotPage({ searchParams }: PageProps<"/forgot">) {
  const initialState = formStateFromParams(await searchParams);
  return (
    <main className="narrow">
      <h1>Reset your password</h1>
      <p>Enter your email and we will send you a link to choose a new password.</p>
      <AuthForm action={requestReset} initialState={initialState} submitLabel="Send reset link" withEmail />
      <p>
        <Link href="/login">Back to log in</Link>
      </p>
    </main>
  );
}
