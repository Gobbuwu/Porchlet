import Link from "next/link";

export default function Home() {
  return (
    <main className="narrow">
      <h1>Porchlet</h1>
      <p>A self-hosted client portal for freelancers.</p>
      <p>
        <Link href="/login">Log in</Link> or <Link href="/signup">create an account</Link>.
      </p>
    </main>
  );
}
