import type { MessageCode } from "@/lib/auth/messages";

// Invite links and tokens (M2 PR 3, ADR 0024).

// create_invitation hands out 32 random bytes as 64 lower-case hex characters; accept_invitation
// takes nothing else.
const TOKEN = /^[0-9a-f]{64}$/;

export function isInviteToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

/**
 * The site's own origin, from the SITE_URL setting, never from the request's Host header (threat
 * T9). null when it is missing or isn't a bare http(s) origin, so invites fail closed.
 */
export function siteOrigin(): string | null {
  const value = process.env.SITE_URL;
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  return url.origin;
}

// The invitation just made, for its owner's page to show once to copy (ADR 0024 section 4): set
// by inviteClient, HttpOnly, five minutes, "<workspace id>.<token>". In a cookie rather than the
// URL, so the token reaches no request log or browser history, and a crafted URL can't make the
// page show some other workspace's link as this one's.
const NEW_INVITE_COOKIE = "porchlet-new-invite";
export const NEW_INVITE_MAX_AGE = 5 * 60;

export function newInviteCookieName(secure: boolean): string {
  return secure ? `__Host-${NEW_INVITE_COOKIE}` : NEW_INVITE_COOKIE;
}

/** The token in the new-invite cookie when it is for `workspaceId`, else null. */
export function newInviteToken(cookie: string | undefined, workspaceId: string): string | null {
  if (!cookie) return null;
  const dot = cookie.indexOf(".");
  const token = cookie.slice(dot + 1);
  return dot > 0 && cookie.slice(0, dot) === workspaceId && isInviteToken(token) ? token : null;
}

/** The link an invited person opens: /invite with the token. */
export function inviteLink(origin: string, token: string): string {
  return `${origin}/invite?${new URLSearchParams({ token })}`;
}

/**
 * The token inside the invite link that the invite email carries (its `invite` parameter, the
 * redirectTo Supabase Auth checked). Only the token is used, never the link's host or path, so
 * the email can't send anyone elsewhere.
 */
export function tokenFromInviteLink(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link, "http://porchlet.invalid");
  } catch {
    return null;
  }
  const token = url.searchParams.get("token");
  return url.pathname === "/invite" && isInviteToken(token) ? token : null;
}

// accept_invitation and create_invitation answer P0001 with one of these keys (PR 1 migration).
const DB_KEYS: Record<string, MessageCode> = {
  invalid_email: "invalid-email",
  already_member: "already-member",
  invitation_pending: "invite-pending",
  workspace_invitation_limit: "invite-workspace-limit",
  hourly_invitation_limit: "invite-hourly-limit",
  invitation_invalid: "invite-invalid",
  invitation_used: "invite-used",
  invitation_expired: "invite-expired",
  invitation_wrong_account: "invite-wrong-account",
  email_not_confirmed: "email-not-confirmed",
};

/** The message for an invitation RPC's error, or undefined when it isn't one of their keys. */
export function inviteErrorCode(error: { code?: string; message?: string }): MessageCode | undefined {
  if (error.code === "42501") return "not-allowed";
  if (error.code !== "P0001" || !error.message) return undefined;
  return Object.hasOwn(DB_KEYS, error.message) ? DB_KEYS[error.message] : undefined;
}
