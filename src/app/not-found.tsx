import Link from "next/link";

// Replaces the Next.js default 404, which uses inline styles that the CSP blocks.
export default function NotFound() {
  return (
    <main className="narrow">
      <h1>Page not found</h1>
      <p>
        <Link href="/">Go to the home page</Link>
      </p>
    </main>
  );
}
