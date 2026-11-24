import { createHash } from "node:crypto";
import { COMMON_PASSWORDS } from "./common-passwords";

// Checks a new password (sign-up, reset) before it reaches Supabase Auth (ADR 0019). Supabase's
// own leaked-password check is a paid-plan feature, so Porchlet does it here, in two layers:
// 1. A bundled list of common passwords (ASVS 5.0.0 6.2.4). Always on, works offline.
// 2. Have I Been Pwned's Pwned Passwords range API (ASVS 5.0.0 6.2.12), unless
//    BREACHED_PASSWORD_CHECK=off. Only the first 5 hex characters of the password's SHA-1 leave
//    the server (k-anonymity), and padding hides how many suffixes matched. If the API can't be
//    reached in time, the password is accepted and a warning is logged: layer 1 still applied.

const COMMON = new Set(COMMON_PASSWORDS);

export const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";
const HIBP_TIMEOUT_MS = 2000;
// supabase/config.toml minimum_password_length, in characters (code points), as Supabase Auth
// counts it (ADR 0021). Shorter passwords are left to Supabase Auth, which refuses them with
// weak_password, so the user is told the length rule rather than this one.
const MIN_LENGTH = 10;
// Supabase Auth's maximum, in UTF-8 bytes (bcrypt's limit). Supabase refuses longer passwords with
// validation_failed, the code it also uses for a bad email, so Porchlet checks this itself to give
// the right message (ADR 0021). The field's maxlength doesn't count bytes, so it can't.
const MAX_BYTES = 72;

export type BreachResult = "breached" | "not-found" | "unavailable";
type Fetch = typeof fetch;

export function isCommonPassword(password: string): boolean {
  return COMMON.has(password.toLowerCase());
}

export async function breachStatus(password: string, fetchImpl: Fetch = fetch): Promise<BreachResult> {
  const hash = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const response = await fetchImpl(HIBP_RANGE_URL + prefix, {
      headers: { "Add-Padding": "true", "User-Agent": "Porchlet" },
      cache: "no-store",
      signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
    });
    if (!response.ok) return "unavailable";
    for (const line of (await response.text()).split(/\r?\n/)) {
      const [lineSuffix, count] = line.split(":");
      // Padding lines have a count of 0 (haveibeenpwned.com/API/v3).
      if (lineSuffix?.trim().toUpperCase() === suffix) return Number(count) > 0 ? "breached" : "not-found";
    }
    return "not-found";
  } catch {
    return "unavailable";
  }
}

function breachCheckEnabled(): boolean {
  return process.env.BREACHED_PASSWORD_CHECK !== "off";
}

/**
 * Whether a password that just signed in must be changed before the app can be used (ADR 0021):
 * shorter than the minimum (set under an older or looser Supabase setting), or common or breached.
 */
export async function loginNeedsPasswordChange(password: string, fetchImpl: Fetch = fetch): Promise<boolean> {
  if ([...password].length < MIN_LENGTH) return true;
  return (await newPasswordProblem(password, fetchImpl)) === "common-password";
}

/** Why the password can't be used, or null when it can. */
export async function newPasswordProblem(
  password: string,
  fetchImpl: Fetch = fetch,
): Promise<"common-password" | "password-too-long" | null> {
  if (Buffer.byteLength(password, "utf8") > MAX_BYTES) return "password-too-long";
  if ([...password].length < MIN_LENGTH) return null;
  if (isCommonPassword(password)) return "common-password";
  if (!breachCheckEnabled()) return null;
  const status = await breachStatus(password, fetchImpl);
  if (status === "unavailable") console.warn("breached-password check unavailable; only the bundled list applied");
  return status === "breached" ? "common-password" : null;
}
