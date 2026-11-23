import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Porchlet's own per-visitor limits for the auth Server Actions (ADR 0015). Supabase Auth's
// limits are per caller IP, and here the caller is always this server, so they act only as a
// backstop shared by every visitor. These limits are per visitor IP, counted in Postgres by
// public.rate_limit_hit, which only accepts calls carrying RATE_LIMIT_KEY.

export type Rule = { scope: string; limit: number; windowSeconds: number };

const TEN_MINUTES = 600;

export const RULES = {
  // Failed logins, checked before and counted after the attempt. Per IP+email stops guessing one
  // account's password; per IP stops spraying many accounts. Nothing locks an account for
  // everyone, so an attacker can't lock a victim out.
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

export type LimitResult = "ok" | "limited" | "unavailable";

// Asks Postgres for each rule's count. With record, the attempt is counted first and the limit is
// "at most limit attempts"; without, it is a check that the bucket is still under the limit.
// Fails closed: a missing key, a refused key or an RPC error all answer "unavailable".
export async function checkLimits(
  supabase: SupabaseClient,
  ip: string,
  rules: readonly Rule[],
  record: boolean,
): Promise<LimitResult> {
  const key = process.env.RATE_LIMIT_KEY;
  if (!key) {
    console.error("rate limit unavailable: RATE_LIMIT_KEY is not set");
    return "unavailable";
  }
  const results = await Promise.all(
    rules.map(async (rule) => ({
      rule,
      ...(await supabase.rpc("rate_limit_hit", {
        p_key: key,
        p_scope: rule.scope,
        p_ip: ip,
        p_window_seconds: rule.windowSeconds,
        p_record: record,
      })),
    })),
  );
  let limited = false;
  for (const { rule, data, error } of results) {
    if (error || typeof data !== "number") {
      // Never log the key or the IP.
      console.error(`rate limit unavailable: ${error ? `code=${error.code}` : "key refused"}`);
      return "unavailable";
    }
    if (record ? data > rule.limit : data >= rule.limit) limited = true;
  }
  return limited ? "limited" : "ok";
}
