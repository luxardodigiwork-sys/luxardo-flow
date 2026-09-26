/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — LUXARDO FLOW Mobile Number + Password login
 * eligibility (P0-2): isPrivilegedMobileLoginEligible (src/utils/
 * loomIdentity.ts), the client-side mirror of the identical server-side
 * helper in functions/src/staffAuth.ts. Covers ONLY the pure eligibility
 * logic — the login method itself is exercised end-to-end by
 * functions/src/__tests__/privilegedMobilePasswordLogin.emulator.test.ts.
 *
 * Accepts ONLY a staff/{uid} doc with role owner/admin/super_admin AND
 * active === true, checked with STRICT equality — no coercion. false,
 * undefined, null, a missing field, "true" (string), and 1 (number) are ALL
 * rejected. This is a P0-2 authorization-bug fix: an earlier version of
 * this helper used `active !== false` (treating a missing/null field as
 * eligible), which a locked-spec audit flagged as a blocking mismatch —
 * this file's cases below specifically pin down the corrected, strict
 * behavior so that regression can never silently reintroduce it.
 *
 * Never touched: isEligibleLoomIdentity, isEligiblePrivilegedStaffDoc,
 * isEligibleForMobileRecovery, isEligibleForPrivilegedLoginPage — this is a
 * new, additive helper alongside them, not a replacement for any of them
 * (those all deliberately keep their own, looser `!== false` convention).
 *
 * Pure, dependency-free logic (no React, no Firebase) — matches the
 * established convention in this repo. Not wired into a test runner (none
 * exists), runs directly via tsx.
 *
 * Run (from repo root):
 *   npx tsx src/__tests__/privilegedMobileLogin.test.ts
 */
import { isPrivilegedMobileLoginEligible } from "../utils/loomIdentity";

let pass = true;
const fail = (msg: string) => {
  console.error(`FAIL: ${msg}`);
  pass = false;
};
const check = (label: string, actual: boolean, expected: boolean) => {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
  else console.log(`OK  ${label} -> ${actual}`);
};

// ── Valid: each privileged role, active === true (strict) ────────────────
check("owner + true -> eligible", isPrivilegedMobileLoginEligible("owner", true), true);
check("admin + true -> eligible", isPrivilegedMobileLoginEligible("admin", true), true);
check("super_admin + true -> eligible", isPrivilegedMobileLoginEligible("super_admin", true), true);
check("case-insensitive: 'OWNER' + true -> eligible", isPrivilegedMobileLoginEligible("OWNER", true), true);
check("case-insensitive: 'Super_Admin' + true -> eligible", isPrivilegedMobileLoginEligible("Super_Admin", true), true);

// ── Invalid: owner with every non-strict-true active value ───────────────
// (the exact P0-2 authorization-bug regression set — each of these MUST be
// rejected; before the fix, undefined/null/omitted were incorrectly
// accepted)
check("owner + false -> rejected", isPrivilegedMobileLoginEligible("owner", false), false);
check("owner + undefined -> rejected", isPrivilegedMobileLoginEligible("owner", undefined), false);
check("owner + active omitted entirely -> rejected", isPrivilegedMobileLoginEligible("owner"), false);
check("owner + null -> rejected", isPrivilegedMobileLoginEligible("owner", null), false);
check('owner + "true" (string) -> rejected (no coercion)', isPrivilegedMobileLoginEligible("owner", "true" as unknown), false);
check("owner + 1 (number) -> rejected (no coercion)", isPrivilegedMobileLoginEligible("owner", 1 as unknown), false);

// ── Invalid: admin / super_admin, same non-strict-true active values ─────
check("admin + false -> rejected", isPrivilegedMobileLoginEligible("admin", false), false);
check("admin + undefined -> rejected", isPrivilegedMobileLoginEligible("admin", undefined), false);
check("admin + null -> rejected", isPrivilegedMobileLoginEligible("admin", null), false);
check("super_admin + false -> rejected", isPrivilegedMobileLoginEligible("super_admin", false), false);
check("super_admin + undefined -> rejected", isPrivilegedMobileLoginEligible("super_admin", undefined), false);
check("super_admin + null -> rejected", isPrivilegedMobileLoginEligible("super_admin", null), false);

// ── Invalid: operational roles — rejected regardless of active, including
// active === true (role gate must still apply even when active is valid) ──
for (const role of ["designer", "pm", "dispatch", "guard", "tailor", "store", "accounts", "analysis"]) {
  check(`operational role "${role}" + true -> NOT eligible`, isPrivilegedMobileLoginEligible(role, true), false);
  check(`operational role "${role}" + active omitted -> NOT eligible`, isPrivilegedMobileLoginEligible(role), false);
}

// ── Invalid: missing / unknown role (even with active === true) ──────────
check("missing role (undefined) + true -> NOT eligible", isPrivilegedMobileLoginEligible(undefined, true), false);
check("missing role (null) + true -> NOT eligible", isPrivilegedMobileLoginEligible(null, true), false);
check("empty role string + true -> NOT eligible", isPrivilegedMobileLoginEligible("", true), false);
check("unrecognised/legacy role \"grade\" + true -> NOT eligible", isPrivilegedMobileLoginEligible("grade", true), false);

if (!pass) {
  console.error("LUXARDO FLOW PRIVILEGED MOBILE LOGIN ELIGIBILITY REGRESSION TEST: FAIL");
  process.exitCode = 1;
} else {
  console.log(
    "LUXARDO FLOW PRIVILEGED MOBILE LOGIN ELIGIBILITY REGRESSION TEST: PASS — Owner, " +
    "Admin and Super Admin are eligible ONLY when active is the strict literal boolean " +
    "true; false, undefined, null, a missing field, the string \"true\", and the number 1 " +
    "are all correctly rejected with no coercion; every operational role and missing/" +
    "unknown role is denied regardless of the active value."
  );
}
