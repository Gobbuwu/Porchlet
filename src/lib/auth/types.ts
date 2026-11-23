// What a form's Server Action returns: an error to show, or a notice (for example "check your
// email"), plus the email typed, so the form can keep it after React resets the form.
export type FormState = { error?: string; notice?: string; email?: string };
