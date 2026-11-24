import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
import { requestReset } from "../actions";

export const metadata: Metadata = { title: "Reset your password · Porchlet" };

export default function ForgotPage() {
  return (
    <main className="narrow">
      <h1>Reset your password</h1>
      <p>Enter your email and we will send you a link to choose a new password.</p>
      <AuthForm action={requestReset} submitLabel="Send reset link" withEmail>
      </AuthForm>
      <p>
        <Link href="/login">Back to log in</Link>
      </p>
    </main>
  );
}
