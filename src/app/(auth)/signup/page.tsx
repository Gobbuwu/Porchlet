import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
import { PasswordField } from "@/components/fields";
import { formStateFromParams } from "@/lib/auth/types";
import { signUp } from "../actions";

export const metadata: Metadata = { title: "Create an account · Porchlet" };

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const initialState = formStateFromParams(await searchParams);
  return (
    <main className="narrow">
      <h1>Create an account</h1>
      <AuthForm action={signUp} initialState={initialState} submitLabel="Create account" withEmail>
        <PasswordField label="Password (at least 10 characters)" autoComplete="new-password" />
      </AuthForm>
      <p>
        Already have an account? <Link href="/login">Log in</Link>
      </p>
    </main>
  );
}
