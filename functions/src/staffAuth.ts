import { HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

const db = admin.firestore();

/* ─────────────────────────── STAFF ROLES ──────────────────────────────
 * Canonical Loom production staff roles. This is the single server-side
 * source of truth — keep it in sync with:
 *   - src/utils/loomIdentity.ts        (frontend mirror)
 *   - src/types/production.ts          (StaffRole union)
 *   - firestore.loom.rules             (isStaffInRoles allow-lists)
 * ("super_admin" is an elevated identity accepted by admin checks but is
 *  never assignable via staffCreate/staffUpdate.)
 * ─────────────────────────────────────────────────────────────────────── */
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

/* ────────────────────────── DEPARTMENTS ────────────────────────────────
 * Purely descriptive/organisational — a controlled list for the User
 * Profile "department" field. Department is INTENTIONALLY never consulted
 * by any authorization check (can()/hasAnyRole()/isAdmin()/requireStaff()):
 * changing a User's department must never grant or imply a permission.
 * Role remains the ONLY concept authorization decisions are based on. Keep
 * in sync with src/constants/businessConfig.ts (frontend mirror).
 * ─────────────────────────────────────────────────────────────────────── */
export const CANONICAL_DEPARTMENTS = [
  "Management",
  "Design",
  "Production",
  "Planning",
  "Dispatch",
  "Quality Control",
  "Tailoring",
  "Store",
  "Accounts",
  "Analysis",
] as const;
export type CanonicalDepartment = (typeof CANONICAL_DEPARTMENTS)[number];

/**
 * Known legacy / typo role strings that map to a canonical role.
 * Applied ONLY by the sanctioned staffBackfillCustomerDocs repair job
 * (and only when explicitly opted in). It is deliberately NOT applied at
 * request time — a live authorization decision must never silently accept
 * a guessed role. Unrecognised roles fail closed.
 */
export const LEGACY_STAFF_ROLE_MAP: Record<string, CanonicalStaffRole> = {
  grade: "guard",
};

/**
 * Return the canonical form of a role string, or null when it is not a
 * recognised canonical role. Does NOT apply LEGACY_STAFF_ROLE_MAP.
 */
export function normalizeStaffRole(role: unknown): CanonicalStaffRole | null {
  const r = String(role || "").toLowerCase().trim();
  return (CANONICAL_STAFF_ROLES as readonly string[]).includes(r)
    ? (r as CanonicalStaffRole)
    : null;
}

export function isCanonicalStaffRole(role: unknown): boolean {
  return normalizeStaffRole(role) !== null;
}

export interface StaffIdentity {
  uid: string;
  role: string;
  name: string;
}

/**
 * Resolve the acting staff identity for a signed-in user (Phase 2).
 *
 * Checks staff/{uid} first (the Loom production identity doc — role =
 * owner | admin | designer | pm | dispatch | guard | tailor | store).
 * Falls back to customers/{uid} for admin / super_admin / owner accounts
 * that do not have a staff doc (e.g. the master admin).
 */
export async function requireStaff(uid: string): Promise<StaffIdentity> {
  const staffSnap = await db.doc(`staff/${uid}`).get();
  if (staffSnap.exists) {
    const d = staffSnap.data();
    // Fail closed: a deactivated staff member must not retain access via
    // this path, mirroring the active !== false check requireAdmin()
    // already applies to its own staff/{uid} branch.
    if (d?.active !== false) {
      return {
        uid,
        role: String(d?.role || ""),
        name: String(d?.displayName || ""),
      };
    }
  }
  const custSnap = await db.doc(`customers/${uid}`).get();
  if (custSnap.exists) {
    const d = custSnap.data();
    const role = String(d?.role || "").toLowerCase();
    if (["admin", "super_admin", "owner"].includes(role)) {
      const name = d?.firstName
        ? `${d.firstName} ${d.lastName || ""}`.trim()
        : String(d?.name || "");
      return { uid, role, name };
    }
  }
  throw new HttpsError("permission-denied", "Production staff access required.");
}

/**
 * True when the actor identity satisfies one of the given roles.
 *
 * `super_admin` is a privileged SUPERSET of `admin` for production
 * authorization: any allow-list that grants `admin` also grants
 * `super_admin`. This is the only elevation — `super_admin` never gains an
 * operation that `admin` would not, and lists that exclude `admin`
 * (e.g. the guard-only QC list) still exclude `super_admin`. Role semantics
 * for owner/pm/guard/designer/dispatch/tailor/store are unchanged.
 *
 * This never relaxes authentication: the caller must already hold a valid
 * staff identity resolved by requireStaff() (which itself fails closed when
 * no staff/{uid} identity exists).
 */
export function hasAnyRole(identity: StaffIdentity, roles: string[]): boolean {
  const r = (identity.role || "").toLowerCase();
  if (roles.includes(r)) return true;
  if (r === "super_admin" && roles.includes("admin")) return true;
  return false;
}

/**
 * True when a resolved staff/{uid} role/active pair is eligible for the
 * privileged Mobile Number + Password login method (Owner/Admin/Super Admin
 * ONLY, and active). Mirrors the same privileged tier already accepted by
 * ADMIN_STAFF_ROLES in functions/src/production.ts requireAdmin() and by
 * isEligiblePrivilegedStaffDoc in src/utils/loomIdentity.ts (client mirror
 * below) — kept as its own pure, dependency-free helper so it can be
 * unit-tested without a Firestore/Auth call. Never grants anything a
 * non-mobile privileged login method wouldn't already grant.
 *
 * STRICT active check (locked requirement): ONLY the literal boolean
 * `true` is accepted. false, undefined, null, a missing field, "true"
 * (string), and 1 (number) are ALL rejected — no coercion. This is
 * intentionally stricter than the `!== false` convention used elsewhere in
 * this codebase (requireAdmin, requireStaff, isEligiblePrivilegedStaffDoc,
 * isEligibleForMobileRecovery, isEligibleLoomIdentity) — this specific
 * method's locked spec requires a positive, exact match, not merely "not
 * explicitly deactivated".
 */
export function isPrivilegedMobileLoginEligible(role: unknown, active: unknown): boolean {
  if (active !== true) return false;
  const r = String(role ?? "").toLowerCase().trim();
  return r === "owner" || r === "admin" || r === "super_admin";
}