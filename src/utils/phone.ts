/**
 * E.164 phone validation — kept in exact sync with the server-side check
 * (functions/src/production.ts E164_RE) so the client can give immediate
 * feedback instead of round-tripping to find out the format was rejected.
 */
export const E164_RE = /^\+[1-9]\d{7,14}$/;

export function isValidE164(value: string): boolean {
  return E164_RE.test(value.trim());
}

/** Normalizes a raw phone-ish string (e.g. from react-phone-input-2, which
 * omits the leading "+") into the "+<digits>" form the E.164 check expects. */
export function toE164(value: string): string {
  const v = value.trim();
  return v.startsWith('+') ? v : `+${v}`;
}

/**
 * Masks a phone number down to only its last 4 digits, for the mobile-OTP
 * password-recovery confirmation screen ("Confirm this is your registered
 * mobile number: •••••••••••• 0699") — the UI must never render more of
 * the number than this, even though the full E.164 value necessarily still
 * exists in memory (Firebase's client-side phone-auth SDK requires the
 * exact number to send the SMS challenge — there is no way to trigger it
 * without the browser holding the real number). Returns null for anything
 * too short to safely mask (never partially reveals a short/malformed value).
 */
export function maskPhoneLast4(phoneNumber: string | null | undefined): string | null {
  if (!phoneNumber) return null;
  const digits = phoneNumber.replace(/\D/g, '');
  if (digits.length < 4) return null;
  const last4 = digits.slice(-4);
  return '•'.repeat(Math.max(8, digits.length - 4)) + ' ' + last4;
}
