// Every message the auth forms show, by code. Raw server messages are never shown.
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
