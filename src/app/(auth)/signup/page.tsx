import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
import { formStateFromParams } from "@/lib/auth/types";
import { signUp } from "../actions";

export const metadata: Metadata = { title: "Create an account · Porchlet" };

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const initialState = formStateFromParams(await searchParams);
  return (
    <main className="narrow">
      <h1>Create an account</h1>
      {/* Only the email: the password is chosen after the confirm link proves the address (ADR 0027). */}
      <AuthForm action={signUp} initialState={initialState} submitLabel="Create account" withEmail />
      <p>We&apos;ll email you a link. After you confirm your email, you choose your password.</p>
      <p>
        Already have an account? <Link href="/login">Log in</Link>
      </p>
    </main>
  );
}
