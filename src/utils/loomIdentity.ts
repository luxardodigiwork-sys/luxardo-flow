/**
 * LUXARDO LOOM — shared identity / host helpers.
 *
 * Kept deliberately tiny and dependency-free so it can be imported from the
 * AuthContext, the login pages and the production route guard without pulling
 * in the wider app graph.
 *
 * The canonical staff-role list MUST stay in sync with the server source of
 * truth in functions/src/staffAuth.ts (CANONICAL_STAFF_ROLES) and the
 * StaffRole union in src/types/production.ts.
 */

export const CANONICAL_STAFF_ROLES = [
  "owner",
  "admin",
  "designer",
  "pm",
  "dispatch",
  "guard",
  "tailor",
  "store",
  "accounts",
  "analysis",
] as const;

export type CanonicalStaffRole = (typeof CANONICAL_STAFF_ROLES)[number];

/**
 * Canonical form of a role string, or null when it is not a recognised
 * canonical staff role. Legacy / typo roles (e.g. "grade") return null and
 * therefore fail closed — they are repaired only by the server-side
 * staffBackfillCustomerDocs job, never guessed at in the client.
 */
export function normalizeStaffRole(role: unknown): CanonicalStaffRole | null {
  const r = String(role ?? "").toLowerCase().trim();
  return (CANONICAL_STAFF_ROLES as readonly string[]).includes(r)
    ? (r as CanonicalStaffRole)
    : null;
}

export function isCanonicalStaffRole(role: unknown): boolean {
  return normalizeStaffRole(role) !== null;
}

/**
 * True when this bundle IS the Loom build (`vite build --mode loom`). The
 * dist-loom/ output is deployed exclusively to the luxardo-flow project
 * (firebase.loom.json), so "loom build" always means "run the Loom app".
 * Checked in addition to the hostname so a `--mode loom` build is correct
 * even when served from localhost / a preview channel.
 */
export const IS_LOOM_BUILD: boolean =
  typeof import.meta !== "undefined" &&
  (import.meta as ImportMeta).env?.MODE === "loom";

/**
 * True when the app is the Loom production system — either the Loom build,
 * or served from the dedicated Loom project host
 * (luxardo-flow.web.app / luxardo-flow.firebaseapp.com). On the Loom app the
 * production system is the ONLY thing mounted; the B2C storefront is never
 * reachable. Mirrors the check in src/App.tsx (kept as a local const there so
 * the B2C entry file stays free of cross-imports).
 */
export function isLoomHost(): boolean {
  if (IS_LOOM_BUILD) return true;
  return (
    typeof window !== "undefined" &&
    /(^|\.)luxardo-flow\.(web\.app|firebaseapp\.com)$/.test(window.location.hostname)
  );
}

/**
 * The two PRIVILEGED LUXARDO FLOW identities. Both are backed by REAL Gmail
 * mailboxes, so both keep Google Sign-In, email/password login and genuine
 * Firebase password reset. They are recognised by their Firebase Auth
 * identifier (not by a Firestore role string), so they resolve with zero
 * dependency on staff/{uid} / customers/{uid} and stay off the common staff
 * login page. Keep these in sync with:
 *   - src/context/AuthContext.tsx
 *   - scripts/loom-reset-staff-passwords.cjs   (EXCLUDE list — never get USER123456)
 *
 * NOTE: verified against the live luxardo-flow Firebase Auth accounts.
 */
export const SUPER_ADMIN_EMAIL = "luxardodigiwork@gmail.com";
export const ADMIN_EMAIL = "abhijeetra799@gmail.com";

/** Back-compat alias. */
export const MASTER_ADMIN_EMAIL = SUPER_ADMIN_EMAIL;

function emailEquals(email: unknown, target: string): boolean {
  return (
    typeof email === "string" &&
    email.trim().toLowerCase() === target.toLowerCase()
  );
}

/** True when the email is the Super Admin identifier (case-insensitive). */
export function isSuperAdminEmail(email: unknown): boolean {
  return emailEquals(email, SUPER_ADMIN_EMAIL);
}

/** True when the email is the Admin identifier (case-insensitive). */
export function isAdminEmail(email: unknown): boolean {
  return emailEquals(email, ADMIN_EMAIL);
}

/** True for either privileged Gmail identity (Super Admin or Admin). */
export function isPrivilegedEmail(email: unknown): boolean {
  return isSuperAdminEmail(email) || isAdminEmail(email);
}

/**
 * The app role for a privileged email, or null. Super Admin → "super_admin",
 * Admin → "admin". Used by AuthContext to resolve identity without a Firestore
 * read, and by the privileged login page to authorise entry.
 */
export function privilegedRoleForEmail(email: unknown): "super_admin" | "admin" | null {
  if (isSuperAdminEmail(email)) return "super_admin";
  if (isAdminEmail(email)) return "admin";
  return null;
}

/**
 * True for any identity allowed into the production system: a canonical staff
 * role, or the elevated "super_admin" identity (which is deliberately NOT in
 * CANONICAL_STAFF_ROLES because it is never assignable to a staff/{uid} doc).
 */
export function isStaffRoleOrSuperAdmin(role: unknown): boolean {
  return role === "super_admin" || isCanonicalStaffRole(role);
}

/**
 * Shared fail-closed eligibility check for the LUXARDO FLOW common login page
 * AND the mobile-OTP password-reset flow: an identity is only usable there
 * when it is an ACTIVE canonical staff/{uid} role (Owner included — Owner is
 * not excluded from this, per the User/Owner/Staff model) and NOT one of the
 * two privileged Gmail identities (those use the dedicated /admin/login page
 * and its own real Firebase password reset, never this mechanism).
 * `active` may be omitted when the caller has already filtered for it.
 */
export function isEligibleLoomIdentity(
  email: unknown,
  role: unknown,
  active?: unknown,
): boolean {
  if (isPrivilegedEmail(email)) return false;
  if (active === false) return false;
  return isCanonicalStaffRole(role);
}

/**
 * Eligibility for mobile-OTP PASSWORD RECOVERY specifically — deliberately
 * NOT the same gate as isEligibleLoomIdentity() (used by LOGIN routing
 * above). Recovering a password is independent of which page a User
 * ultimately signs in on: Owner, Admin and Super Admin must all be able to
 * use this mechanism (not silently excluded by role/email terminology),
 * while Admin/Super Admin still sign in exclusively via the dedicated
 * /admin/login page (AdminLoginPage.tsx, unchanged, its own real
 * Gmail-based email reset untouched) — this function only decides "may a
 * password be reset via mobile OTP", never "which page may sign in".
 * Accepts the literal "super_admin" role value too (mirrors
 * isStaffRoleOrSuperAdmin() below) since some staff/{uid} docs carry it and
 * it's deliberately excluded from CANONICAL_STAFF_ROLES for unrelated
 * (assignability) reasons — a naming technicality, not a genuine
 * ineligibility. Server mirror: functions/src/production.ts
 * isRecognisedRecoveryRole().
 */
export function isEligibleForMobileRecovery(role: unknown, active?: unknown): boolean {
  if (active === false) return false;
  const r = String(role ?? "").toLowerCase().trim();
  return r === "super_admin" || isCanonicalStaffRole(r);
}
