import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
import { PasswordField } from "@/components/fields";
import { safeNext } from "@/lib/auth/redirect";
import { logIn } from "../actions";

export const metadata: Metadata = { title: "Log in · Porchlet" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = safeNext(params.next);
  return (
    <main className="narrow">
      <h1>Log in</h1>
      {params.signed_out ? <p role="status" className="notice">You are signed out.</p> : null}
      <AuthForm action={logIn} submitLabel="Log in" withEmail>
        <input type="hidden" name="next" value={next} />
        <PasswordField label="Password" autoComplete="current-password" />
      </AuthForm>
      <p>
        <Link href="/forgot">Forgot your password?</Link>
      </p>
      <p>
        New here? <Link href="/signup">Create an account</Link>
      </p>
    </main>
  );
}
