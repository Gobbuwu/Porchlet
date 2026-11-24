import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Porchlet's own per-visitor limits for the auth Server Actions (ADR 0015). Supabase Auth's
// limits are per caller IP, and here the caller is always this server, so they act only as a
// backstop shared by every visitor. These limits are per visitor IP, counted in Postgres by
// public.rate_limit_take (ADR 0022), which only accepts calls carrying RATE_LIMIT_KEY.

export type Rule = { scope: string; limit: number; windowSeconds: number };

const TEN_MINUTES = 600;

export const RULES = {
  // Failed logins. Each attempt takes a slot before the password is checked and gives it back
  // when the password proves right (ADR 0022), so parallel guesses can't all pass one check. Per
  // IP+email stops guessing one account's password; per IP stops spraying many accounts. Nothing
  // locks an account for everyone, so an attacker can't lock a victim out.
  loginFailures: (email: string): Rule[] => [
    { scope: `login-fail:${emailKey(email)}`, limit: 5, windowSeconds: TEN_MINUTES },
    { scope: "login-fail", limit: 20, windowSeconds: TEN_MINUTES },
  ],
  // Every attempt counts, since each one can send an email or change state.
  signUp: [{ scope: "signup", limit: 10, windowSeconds: TEN_MINUTES }],
  reset: [{ scope: "reset", limit: 5, windowSeconds: TEN_MINUTES }],
  verify: [{ scope: "verify", limit: 20, windowSeconds: TEN_MINUTES }],
  newPassword: [{ scope: "new-password", limit: 10, windowSeconds: TEN_MINUTES }],
} as const;

// A hash, so the counters never hold an email address. Case-folded like Supabase Auth's lookup.
function emailKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
}

// The visitor's IP. Vercel replaces any X-Forwarded-For the browser sent with the address it saw
// ("we currently overwrite the X-Forwarded-For header", vercel.com/docs/edge-network/headers/
// request-headers), so the first entry can be trusted there. On a host that passes the header
// through, a client can pick its own bucket (ADR 0015, gaps); Supabase's limit still applies.
export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) || "unknown";
}

// "ok" carries the ids of the hits taken, so a login can give them back (releaseLimits).
export type LimitResult = { status: "ok"; hits: number[] } | { status: "limited" } | { status: "unavailable" };

// Takes one attempt from every rule's bucket in one atomic step (public.rate_limit_take, ADR 0022):
// either every bucket had room and the attempt is counted in all of them, or nothing is counted and
// the answer is "limited". Fails closed: a missing key, a refused key or an RPC error all answer
// "unavailable".
export async function takeLimits(supabase: SupabaseClient, ip: string, rules: readonly Rule[]): Promise<LimitResult> {
  const key = process.env.RATE_LIMIT_KEY;
  if (!key) {
    console.error("rate limit unavailable: RATE_LIMIT_KEY is not set");
    return { status: "unavailable" };
  }
  const { data, error } = await supabase.rpc("rate_limit_take", {
    p_key: key,
    p_ip: ip,
    p_scopes: rules.map((r) => r.scope),
    p_limits: rules.map((r) => r.limit),
    p_windows: rules.map((r) => r.windowSeconds),
  });
  if (error || !Array.isArray(data) || !data.every((id) => typeof id === "number")) {
    // Never log the key or the IP.
    console.error(`rate limit unavailable: ${error ? `code=${error.code || "none (network?)"}` : "key refused"}`);
    return { status: "unavailable" };
  }
  return data.length ? { status: "ok", hits: data } : { status: "limited" };
}

// Gives back hits that takeLimits took. A failure only leaves the attempt counted, so it is logged
// and not passed on.
export async function releaseLimits(supabase: SupabaseClient, hits: readonly number[]): Promise<void> {
  const { data, error } = await supabase.rpc("rate_limit_release", {
    p_key: process.env.RATE_LIMIT_KEY ?? "",
    p_ids: hits,
  });
  if (error || typeof data !== "number") {
    console.error(`rate limit release failed: ${error ? `code=${error.code || "none (network?)"}` : "key refused"}`);
  }
}
