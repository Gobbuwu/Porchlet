// Every message the app's forms show (auth, and from M2 the workspace pages), by code. Raw server
// and database messages are never shown.
// The codes also travel in the URL after a form posted without JavaScript (ADR 0018), so a
// page only ever shows one of these fixed texts, never text taken from the URL.
// Error codes: https://supabase.com/docs/guides/auth/debugging/error-codes

export const MESSAGES = {
  "too-many-attempts": "Too many attempts, try again later.",
  "something-went-wrong": "Something went wrong. Try again.",
  "wrong-credentials": "Wrong email or password.",
  "email-not-confirmed": "Confirm your email first. The link is in the email we sent you.",
  "weak-password": "Choose a longer password: at least 10 characters.",
  "common-password": "Choose a different password: this one is too common or has appeared in a data breach.",
  "password-too-long":
    "Choose a shorter password: at most 72 bytes, which is 72 plain letters or digits, or fewer with accents, other alphabets or emoji.",
  "password-change-required":
    "The password you logged in with is too short, too common or has appeared in a data breach. Choose a new one to continue.",
  "new-password-required": "Save a new password to continue, or log out.",
  "same-password": "Choose a password that is different from your current one.",
  "current-password-required": "Enter your current password.",
  "current-password-wrong": "Your current password is wrong.",
  "invalid-email": "Enter a valid email address.",
  "link-used": "This link has expired or was already used. Ask for a new one.",
  "link-invalid": "This link is not valid. Ask for a new one.",
  "reset-expired": "Your reset link has expired. Ask for a new one.",
  "session-ended": "Your session has ended. Log in again.",
  "signup-disabled": "Sign-up is turned off on this site.",
  "signup-sent": "Check your email for a link to confirm your account.",
  "reset-sent": "If an account uses that email, we sent it a link to choose a new password.",
  // Workspaces and projects (M2).
  "not-allowed": "You can't do that in this workspace.",
  "workspace-name-invalid": "Enter a workspace name of 1 to 80 characters.",
  "project-name-invalid": "Enter a project name of 1 to 120 characters.",
  "workspace-created": "Workspace created.",
  "project-created": "Project created.",
  "project-renamed": "Project renamed.",
  "project-archived": "Project archived.",
  "project-restored": "Project restored.",
  "member-removed": "Member removed.",
  "left-workspace": "You left the workspace.",
  // Invites (M2 PR 3, ADR 0024).
  "invite-sent": "Invitation emailed. You can also copy the link below and send it yourself.",
  "invite-has-account":
    "This address already has an account, so no email was sent. Copy the link below and send it to them.",
  "invite-email-failed": "The invitation was made, but the email could not be sent. Copy the link below and send it yourself.",
  "invite-check-failed": "The invitation email went out, but the invited account could not be checked, so the invitation was withdrawn. Try again.",
  "invite-revoked": "Invitation withdrawn.",
  "invite-pending": "This address already has an open invitation. Withdraw it first to send a new one.",
  "invite-workspace-limit": "This workspace has 20 open invitations. Withdraw some before inviting more.",
  "invite-hourly-limit": "You have sent 20 invitations in the last hour. Try again later.",
  "already-member": "This person is already a member of the workspace.",
  "invite-invalid": "This invite link is not valid, or the invitation was withdrawn. Ask for a new one.",
  "invite-used": "This invitation was already used.",
  "invite-expired": "This invitation has expired. Ask for a new one.",
  "invite-wrong-account":
    "This invitation is for a different email address. Log out, then log in with the address it was sent to.",
  "invite-joined": "You joined the workspace. Choose a password to finish setting up your account.",
  "invite-not-joined":
    "Your account is ready, but the invitation could not be used just now. Choose a password, then open the invite link again.",
  "invite-email-link-used":
    "The sign-in part of this email's link has expired or was already used; the invitation may still be open. Log in with the invited address to join. No password yet? Use \"Forgot your password?\" with that address first, then open the email's link again.",
  "joined-workspace": "You joined the workspace.",
} as const;

export type MessageCode = keyof typeof MESSAGES;

export const TOO_MANY_ATTEMPTS: MessageCode = "too-many-attempts";
export const GENERIC_ERROR: MessageCode = "something-went-wrong";

/** The code's text, or undefined for anything that is not one of our codes. */
export function messageText(code: unknown): string | undefined {
  return typeof code === "string" && Object.hasOwn(MESSAGES, code) ? MESSAGES[code as MessageCode] : undefined;
}

type AuthErrorLike = { status?: number; code?: string };

export function authErrorCode(error: AuthErrorLike): MessageCode {
  // Every Supabase Auth rate limit answers HTTP 429 (over_request_rate_limit,
  // over_email_send_rate_limit, over_sms_send_rate_limit).
  if (error.status === 429 || error.code?.startsWith("over_")) return TOO_MANY_ATTEMPTS;
  switch (error.code) {
    case "invalid_credentials":
      return "wrong-credentials";
    case "email_not_confirmed":
      return "email-not-confirmed";
    case "weak_password":
      return "weak-password";
    case "same_password":
      return "same-password";
    // With require_current_password on (ADR 0023).
    case "current_password_required":
      return "current-password-required";
    case "current_password_invalid":
      return "current-password-wrong";
    case "email_address_invalid":
    case "validation_failed":
      return "invalid-email";
    case "otp_expired":
      return "link-used";
    case "signup_disabled":
      return "signup-disabled";
    default:
      return GENERIC_ERROR;
  }
}
