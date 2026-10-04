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
 * The 8 OPERATIONAL roles that sign in via the common LUXARDO FLOW staff
 * page ("/login") — i.e. CANONICAL_STAFF_ROLES minus "owner" and "admin".
 * "owner", "admin" and the (non-canonical) "super_admin" identity instead
 * share the ONE privileged page ("/admin/login") — see
 * PRIVILEGED_LOGIN_ROLES / isEligibleForPrivilegedLoginPage below.
 */
export const OPERATIONAL_STAFF_ROLES = [
  "designer",
  "pm",
  "dispatch",
  "guard",
  "tailor",
  "store",
  "accounts",
  "analysis",
] as const;

export type OperationalStaffRole = (typeof OPERATIONAL_STAFF_ROLES)[number];

export function isOperationalStaffRole(role: unknown): boolean {
  const r = String(role ?? "").toLowerCase().trim();
  return (OPERATIONAL_STAFF_ROLES as readonly string[]).includes(r);
}

/**
 * The 3 roles that share the ONE privileged login page ("/admin/login"):
 * Super Admin, Admin, Owner. Exactly complementary to OPERATIONAL_STAFF_ROLES
 * within {CANONICAL_STAFF_ROLES ∪ "super_admin"}.
 */
export const PRIVILEGED_LOGIN_ROLES = ["super_admin", "admin", "owner"] as const;

export function isEligibleForPrivilegedLoginPage(role: unknown): boolean {
  const r = String(role ?? "").toLowerCase().trim();
  return (PRIVILEGED_LOGIN_ROLES as readonly string[]).includes(r);
}

/**
 * Single source of truth for "which login page does a signed-out User land
 * on" — used by every post-logout redirect (ProductionLayout.tsx's
 * handleLogout, ChangePasswordPage.tsx's sign-out) so the decision is never
 * duplicated inline. Mirrors isEligibleForPrivilegedLoginPage exactly: Owner/
 * Admin/Super Admin -> the privileged page, every other canonical role -> the
 * common staff page. Non-Loom (B2C) hosts always return "/admin/login",
 * matching that branch's pre-existing, unrelated behavior — left untouched.
 */
export function getPostLogoutRedirectPath(role: unknown, loomHost: boolean): string {
  if (!loomHost) return "/admin/login";
  return isEligibleForPrivilegedLoginPage(role) ? "/admin/login" : "/login";
}

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
 * Shared fail-closed eligibility check for the LUXARDO FLOW COMMON login page
 * ("/login") ONLY (not the mobile-OTP password-reset flow — see
 * isEligibleForMobileRecovery below, which deliberately stays broader, and
 * not the privileged page — see isEligibleForPrivilegedLoginPage above).
 *
 * An identity may use the common page when it is an ACTIVE OPERATIONAL staff
 * role (one of the 8 in OPERATIONAL_STAFF_ROLES) — Super Admin, Admin and
 * Owner are excluded here regardless of email: they all share the ONE
 * privileged page ("/admin/login") instead. `active` may be omitted when the
 * caller has already filtered for it.
 */
export function isEligibleLoomIdentity(
  email: unknown,
  role: unknown,
  active?: unknown,
): boolean {
  if (isPrivilegedEmail(email)) return false;
  if (active === false) return false;
  return isOperationalStaffRole(role);
}

/**
 * True when a privileged Gmail identity (Super Admin or Admin, as resolved
 * by privilegedRoleForEmail) may ACTUALLY resolve to that role — i.e. the
 * email alone is never sufficient; there must also be a matching, active
 * staff/{uid} doc. Super Admin's doc may still carry the pre-migration
 * "owner" role (see scripts/loom-seed-privileged-staff.cjs) — accepted for
 * that identity only. Admin requires its own exact role; it is never
 * accepted merely because the doc is some other admin-tier role. Used by
 * AuthContext.tsx (client identity resolution) so a privileged email with no
 * doc, a deactivated doc, or a mismatched role fails closed to null — the
 * same as any other unrecognised account, never trusted by email alone.
 */
export function isEligiblePrivilegedStaffDoc(
  privRole: "super_admin" | "admin",
  docRole: unknown,
  active: unknown,
): boolean {
  if (active === false) return false;
  // "super_admin" is deliberately not in CANONICAL_STAFF_ROLES (it's never
  // assignable via staffCreate/staffUpdate), so it needs its own check
  // alongside normalizeStaffRole for the ordinary canonical values.
  const r = String(docRole ?? "").toLowerCase().trim();
  const canonical = normalizeStaffRole(r);
  const effective = canonical ?? (r === "super_admin" ? "super_admin" : null);
  if (!effective) return false;
  const acceptedDocRoles = privRole === "super_admin" ? ["super_admin", "owner"] : ["admin"];
  return acceptedDocRoles.includes(effective);
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

/**
 * True when a resolved staff/{uid} role/active pair is eligible for the
 * privileged Mobile Number + Password login method (Owner/Admin/Super Admin
 * ONLY, and active) — the client-side mirror of the identical server-side
 * helper in functions/src/staffAuth.ts (isPrivilegedMobileLoginEligible),
 * kept in sync the same way every other eligibility pair in this file is.
 * Does not change which page a role signs in on (isEligibleForPrivilegedLoginPage
 * above is unrelated and unaffected) — only whether this specific login
 * METHOD accepts the resolved identity.
 *
 * STRICT active check (locked requirement): ONLY the literal boolean
 * `true` is accepted. false, undefined, null, a missing field, "true"
 * (string), and 1 (number) are ALL rejected — no coercion. Intentionally
 * stricter than the `!== false` convention used by every other eligibility
 * helper in this file (isEligibleLoomIdentity, isEligiblePrivilegedStaffDoc,
 * isEligibleForMobileRecovery) — this method's locked spec requires a
 * positive, exact match, not merely "not explicitly deactivated".
 */
export function isPrivilegedMobileLoginEligible(role: unknown, active?: unknown): boolean {
  if (active !== true) return false;
  const r = String(role ?? "").toLowerCase().trim();
  return r === "owner" || r === "admin" || r === "super_admin";
}
