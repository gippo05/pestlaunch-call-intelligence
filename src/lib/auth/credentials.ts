export type LoginValidation =
  | { ok: true; credentials: { email: string; password: string } }
  | { ok: false; message: string };

const INVALID_CREDENTIALS = "Enter a valid email and password.";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateLoginCredentials(emailInput: string, passwordInput: string): LoginValidation {
  const email = emailInput.trim();

  if (
    email.length === 0 ||
    email.length > 254 ||
    !EMAIL_PATTERN.test(email) ||
    passwordInput.trim().length === 0 ||
    passwordInput.length > 1024
  ) {
    return { ok: false, message: INVALID_CREDENTIALS };
  }

  return { ok: true, credentials: { email, password: passwordInput } };
}
