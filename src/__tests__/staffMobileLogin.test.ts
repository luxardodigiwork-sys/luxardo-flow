/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — LUXARDO FLOW Mobile Number + Password login
 * eligibility, OPERATIONAL tier (V1 Auth Stabilization):
 * isStaffMobileLoginEligible (src/utils/loomIdentity.ts), the client-side
 * mirror of the identical server-side helper in functions/src/staffAuth.ts.
 * Covers ONLY the pure eligibility logic — the login method itself is
 * exercised end-to-end by
 * functions/src/__tests__/staffMobilePasswordLogin.emulator.test.ts.
 *
 * Accepts ONLY a staff/{uid} doc with an OPERATIONAL role (designer, pm,
 * dispatch, guard, tailor, store, accounts, analysis) AND active === true,
 * checked with STRICT equality — no coercion, mirroring
 * isPrivilegedMobileLoginEligible's exact security posture. Owner, Admin
 * and Super Admin are deliberately rejected here (they keep
 * isPrivilegedMobileLoginEligible and their own dedicated page) even when
 * active === true — the role gate is tier-exclusive in both directions.
 *
 * Pure, dependency-free logic (no React, no Firebase). Run (from repo root):
 *   npx tsx src/__tests__/staffMobileLogin.test.ts
 */
import { isStaffMobileLoginEligible } from "../utils/loomIdentity";

let pass = true;
const fail = (msg: string) => {
  console.error(`FAIL: ${msg}`);
  pass = false;
};
const check = (label: string, actual: boolean, expected: boolean) => {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
  else console.log(`OK  ${label} -> ${actual}`);
};

const OPERATIONAL = ["designer", "pm", "dispatch", "guard", "tailor", "store", "accounts", "analysis"];

// ── Valid: each operational role, active === true (strict) ───────────────
for (const role of OPERATIONAL) {
  check(`operational role "${role}" + true -> eligible`, isStaffMobileLoginEligible(role, true), true);
}
check("case-insensitive: 'PM' + true -> eligible", isStaffMobileLoginEligible("PM", true), true);
check("case-insensitive: 'Dispatch' + true -> eligible", isStaffMobileLoginEligible("Dispatch", true), true);

// ── Invalid: operational role with every non-strict-true active value ────
for (const role of OPERATIONAL) {
  check(`"${role}" + false -> rejected`, isStaffMobileLoginEligible(role, false), false);
  check(`"${role}" + undefined -> rejected`, isStaffMobileLoginEligible(role, undefined), false);
  check(`"${role}" + active omitted -> rejected`, isStaffMobileLoginEligible(role), false);
  check(`"${role}" + null -> rejected`, isStaffMobileLoginEligible(role, null), false);
  check(`"${role}" + "true" (string) -> rejected (no coercion)`, isStaffMobileLoginEligible(role, "true" as unknown), false);
  check(`"${role}" + 1 (number) -> rejected (no coercion)`, isStaffMobileLoginEligible(role, 1 as unknown), false);
}

// ── Invalid: privileged roles — rejected regardless of active, including
// active === true (tier gate is exclusive in both directions) ────────────
for (const role of ["owner", "admin", "super_admin"]) {
  check(`privileged role "${role}" + true -> NOT eligible here (uses isPrivilegedMobileLoginEligible instead)`, isStaffMobileLoginEligible(role, true), false);
}

// ── Invalid: missing / unknown role (even with active === true) ──────────
check("missing role (undefined) + true -> NOT eligible", isStaffMobileLoginEligible(undefined, true), false);
check("missing role (null) + true -> NOT eligible", isStaffMobileLoginEligible(null, true), false);
check("empty role string + true -> NOT eligible", isStaffMobileLoginEligible("", true), false);
check("unrecognised/legacy role \"grade\" + true -> NOT eligible", isStaffMobileLoginEligible("grade", true), false);

if (!pass) {
  console.error("LUXARDO FLOW STAFF MOBILE LOGIN ELIGIBILITY REGRESSION TEST: FAIL");
  process.exitCode = 1;
} else {
  console.log(
    "LUXARDO FLOW STAFF MOBILE LOGIN ELIGIBILITY REGRESSION TEST: PASS — every " +
    "operational role is eligible ONLY when active is the strict literal boolean true " +
    "(no coercion); Owner/Admin/Super Admin are correctly excluded from this tier " +
    "(they keep isPrivilegedMobileLoginEligible and /admin/login instead); and " +
    "missing/unknown roles are denied regardless of the active value."
  );
}
