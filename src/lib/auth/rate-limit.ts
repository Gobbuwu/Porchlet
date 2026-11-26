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
  // locks an account for everyone, so an attacker can't lock a victim out (as long as the visitor
  // IP is right, see clientIp: with too few trusted hops, visitors share one IP).
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

// Netlify's site ID: a UUID that Netlify sets for its functions at runtime and that can't be
// overridden ("only the following variables are available to serverless functions during runtime:
// URL, SITE_NAME, SITE_ID"; "You can't set or override these values manually",
// docs.netlify.com/build/functions/environment-variables). Requiring the UUID form and SITE_NAME
// keeps an unrelated SITE_ID (say "main") on another host from being taken for Netlify.
type Env = Readonly<Record<string, string | undefined>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function onNetlify(env: Env = process.env): boolean {
  return UUID.test(env.SITE_ID ?? "") && !!env.SITE_NAME;
}

// How many hosts in front of the app append their own entry to X-Forwarded-For (ADR 0029), or null
// when TRUSTED_PROXY_HOPS is set but isn't a whole number from 1 to 10 (the limits then refuse every
// attempt: a guessed count could share or open them). Vercel replaces the header with the one
// address it saw ("we currently overwrite the X-Forwarded-For header", vercel.com/docs/
// edge-network/headers/request-headers): 1. Netlify's CDN appends the visitor's address, then the
// edge function that runs src/proxy.ts appends its own before calling the app (measured,
// ADR 0029): 2.
export function trustedHops(env: Env = process.env): number | null {
  const setting = env.TRUSTED_PROXY_HOPS;
  if (setting !== undefined && setting !== "") {
    if (!/^[0-9]{1,2}$/.test(setting)) return null;
    const hops = Number(setting);
    return hops >= 1 && hops <= 10 ? hops : null;
  }
  return onNetlify(env) ? 2 : 1;
}

// The visitor's IP: the X-Forwarded-For entry the first trusted host added, counted from the end.
// Entries before it are whatever the browser sent. With fewer entries than hops, the first one is
// the closest to the visitor that exists. With no host in front (a bare `next start`), every entry
// is the browser's, so a client can pick its own bucket there (ADR 0015, gaps); Supabase's limit
// still applies. Null when TRUSTED_PROXY_HOPS is invalid.
export function clientIp(headers: Headers, env: Env = process.env): string | null {
  const hops = trustedHops(env);
  if (hops === null) return null;
  const entries = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const entry = entries[Math.max(0, entries.length - hops)];
  return entry?.slice(0, 64) || "unknown";
}

// "ok" carries the ids of the hits taken, so a login can give them back (releaseLimits).
export type LimitResult = { status: "ok"; hits: number[] } | { status: "limited" } | { status: "unavailable" };

// Takes one attempt from every rule's bucket in one atomic step (public.rate_limit_take, ADR 0022):
// either every bucket had room and the attempt is counted in all of them, or nothing is counted and
// the answer is "limited". Fails closed: an invalid TRUSTED_PROXY_HOPS, a missing key, a refused key
// or an RPC error all answer "unavailable".
export async function takeLimits(supabase: SupabaseClient, ip: string | null, rules: readonly Rule[]): Promise<LimitResult> {
  if (ip === null) {
    console.error("rate limit unavailable: TRUSTED_PROXY_HOPS must be a whole number from 1 to 10");
    return { status: "unavailable" };
  }
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
