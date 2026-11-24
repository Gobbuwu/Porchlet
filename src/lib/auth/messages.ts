// Turns Supabase Auth errors into messages for people. Raw server messages are never shown.
// Error codes: https://supabase.com/docs/guides/auth/debugging/error-codes

export const TOO_MANY_ATTEMPTS = "Too many attempts, try again later.";
export const GENERIC_ERROR = "Something went wrong. Try again.";

type AuthErrorLike = { status?: number; code?: string };

export function authErrorMessage(error: AuthErrorLike): string {
  // Every Supabase Auth rate limit answers HTTP 429 (over_request_rate_limit,
  // over_email_send_rate_limit, over_sms_send_rate_limit).
  if (error.status === 429 || error.code?.startsWith("over_")) return TOO_MANY_ATTEMPTS;
  switch (error.code) {
    case "invalid_credentials":
      return "Wrong email or password.";
    case "email_not_confirmed":
      return "Confirm your email first. The link is in the email we sent you.";
    case "weak_password":
      return "Choose a longer password: at least 10 characters.";
    case "same_password":
      return "Choose a password that is different from your current one.";
    case "email_address_invalid":
    case "validation_failed":
      return "Enter a valid email address.";
    case "otp_expired":
      return "This link has expired or was already used. Ask for a new one.";
    case "signup_disabled":
      return "Sign-up is turned off on this site.";
    default:
      return GENERIC_ERROR;
  }
}
