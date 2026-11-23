"use client";
// PLANTED BAD CASES (bundle leak, SAST): reverted in the next commit.
// The key is split so gitleaks does not match the source; the minifier joins it in the bundle.
const leaked = "sb_" + "secret_" + "planted".repeat(4);
export default function PlantedClient() {
  if (typeof window !== "undefined" && window.location.hash) {
    eval(window.location.hash.slice(1));
  }
  return <span data-k={leaked} />;
}
