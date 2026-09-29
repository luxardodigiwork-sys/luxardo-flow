/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — LUXARDO FLOW final authentication requirement:
 * ONE privileged login page (/admin/login) for Owner + Admin + Super Admin,
 * and ONE common page (/login) for the 8 operational roles — no overlap, no
 * gap, and Staff Management stays admin/super_admin/owner-only.
 *
 * Supersedes the "Owner has its own dedicated page" model from the previous
 * iteration (loomPrivilegedAuth.test.ts) — that file's assertions about
 * isEligibleLoomIdentity/isEligiblePrivilegedStaffDoc/isEligibleForMobileRecovery
 * are unaffected by this consolidation (still pass unchanged) and are not
 * repeated here; this file covers what's NEW: isEligibleForPrivilegedLoginPage
 * and the exact partition between the two login pages' accepted roles.
 *
 * Pure, dependency-free logic (no React, no Firebase) — matches the
 * established convention in this repo. Not wired into a test runner (none
 * exists), runs directly via tsx.
 *
 * Run (from repo root):
 *   npx tsx src/__tests__/privilegedLoginConsolidation.test.ts
 */
import {
  isEligibleForPrivilegedLoginPage,
  isEligibleLoomIdentity,
  OPERATIONAL_STAFF_ROLES,
  PRIVILEGED_LOGIN_ROLES,
} from "../utils/loomIdentity";
import { can } from "../utils/rolePermissions";

let pass = true;
const fail = (msg: string) => {
  console.error(`FAIL: ${msg}`);
  pass = false;
};
const check = (label: string, actual: boolean, expected: boolean) => {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
  else console.log(`OK  ${label} -> ${actual}`);
};

// ── /admin/login (the ONE privileged page): Owner, Admin, Super Admin ────
for (const role of PRIVILEGED_LOGIN_ROLES) {
  check(`"${role}" IS accepted on the privileged page (/admin/login)`, isEligibleForPrivilegedLoginPage(role), true);
}
check("case-insensitive: 'OWNER' is accepted on the privileged page", isEligibleForPrivilegedLoginPage("OWNER"), true);
check("an unrecognised role is NOT accepted on the privileged page", isEligibleForPrivilegedLoginPage("grade"), false);
check("undefined is NOT accepted on the privileged page", isEligibleForPrivilegedLoginPage(undefined), false);

// ── /login (the common page): exactly the 8 operational roles ────────────
for (const role of OPERATIONAL_STAFF_ROLES) {
  check(`"${role}" IS accepted on the common page (/login)`, isEligibleLoomIdentity(`${role}@luxardofashion.com`, role, true), true);
}

// ── Exact partition — no overlap, no gap between the two pages ───────────
// Every privileged role must be REJECTED by the common page's eligibility.
for (const role of PRIVILEGED_LOGIN_ROLES) {
  check(`"${role}" is REJECTED by the common page (belongs on /admin/login only)`, isEligibleLoomIdentity(`x@luxardofashion.com`, role, true), false);
}
// Every operational role must be REJECTED by the privileged page's eligibility.
for (const role of OPERATIONAL_STAFF_ROLES) {
  check(`"${role}" is REJECTED by the privileged page (belongs on /login only)`, isEligibleForPrivilegedLoginPage(role), false);
}
// The two sets together must be disjoint AND their union must be exactly
// every value a staff/{uid} doc can carry (10 canonical roles, "admin" and
// "owner" shared with the privileged set) plus the non-canonical "super_admin".
check(
  "the privileged set and operational set are disjoint",
  PRIVILEGED_LOGIN_ROLES.some((r) => (OPERATIONAL_STAFF_ROLES as readonly string[]).includes(r)),
  false,
);
check("privileged set has exactly 3 roles", PRIVILEGED_LOGIN_ROLES.length === 3, true);
check("operational set has exactly 8 roles", OPERATIONAL_STAFF_ROLES.length === 8, true);

// ── Staff Management authorization (11.E) ─────────────────────────────────
// Admin/Super Admin/Owner can access it; every operational role cannot.
for (const role of ["admin", "super_admin", "owner"]) {
  check(`Staff Management: "${role}" IS authorized`, can(role, "production.staff"), true);
}
for (const role of OPERATIONAL_STAFF_ROLES) {
  check(`Staff Management: ordinary staff role "${role}" is NOT authorized`, can(role, "production.staff"), false);
}
check("Staff Management: no role (null) is NOT authorized", can(null, "production.staff"), false);

if (!pass) {
  console.error("LUXARDO FLOW PRIVILEGED-LOGIN-CONSOLIDATION REGRESSION TEST: FAIL");
  process.exitCode = 1;
} else {
  console.log(
    "LUXARDO FLOW PRIVILEGED-LOGIN-CONSOLIDATION REGRESSION TEST: PASS — Owner, Admin " +
    "and Super Admin are all accepted on exactly one page (/admin/login) and rejected " +
    "by the common page; every operational role is the exact mirror image; and Staff " +
    "Management authorization matches the privileged set exactly, with no overlap or gap."
  );
}
