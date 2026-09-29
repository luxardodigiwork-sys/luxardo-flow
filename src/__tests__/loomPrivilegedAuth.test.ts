/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — LUXARDO FLOW authentication correction.
 *
 * Covers the pure, dependency-free eligibility logic behind the
 * Owner/Super-Admin/Admin login consolidation and the "must resolve through
 * staff/{uid}, not merely a known email" requirement. NOTE: an earlier
 * iteration of this change gave Owner/Super-Admin their own page separate
 * from Admin; the FINAL requirement instead puts all three on the ONE
 * privileged page (/admin/login) — see privilegedLoginConsolidation.test.ts
 * for that page-partition coverage. Nothing below is affected by which URL
 * the privileged group lands on:
 *
 *   - isEligibleLoomIdentity(): the COMMON staff page ("/login") excludes
 *     role "owner" (and "admin" — see privilegedLoginConsolidation.test.ts)
 *     — Owner/Admin/Super Admin all share the one privileged page instead.
 *   - isEligiblePrivilegedStaffDoc(): used by AuthContext.tsx for BOTH
 *     Google Sign-In and email/password (the resolution path is identical
 *     either way, so this one set of checks covers "role verification after
 *     Google login" for Admin and Super Admin).
 *   - isEligibleForMobileRecovery(): UNCHANGED (non-regression) — Owner,
 *     Admin and Super Admin all keep mobile-OTP recovery as a fallback even
 *     though they no longer LOG IN via the common page.
 *
 * Not wired into any test runner (the repo has none yet) — a standalone
 * script, mirroring src/__tests__/rolePermissions.med5.test.ts. All three
 * functions are pure (no Firebase, no emulator), so this runs directly via
 * tsx with no setup.
 *
 * Run (from repo root):
 *   npx tsx src/__tests__/loomPrivilegedAuth.test.ts
 */
import {
  isEligibleLoomIdentity,
  isEligiblePrivilegedStaffDoc,
  isEligibleForMobileRecovery,
} from "../utils/loomIdentity";

let pass = true;
const fail = (msg: string) => {
  console.error(`FAIL: ${msg}`);
  pass = false;
};
const check = (label: string, actual: boolean, expected: boolean) => {
  if (actual !== expected) {
    fail(`${label}: expected ${expected}, got ${actual}`);
  } else {
    console.log(`OK  ${label} -> ${actual}`);
  }
};

const SUPER_ADMIN_EMAIL = "luxardodigiwork@gmail.com";
const ADMIN_EMAIL = "abhijeetra799@gmail.com";

// ── isEligibleLoomIdentity(): common-page ("/login") eligibility ──────────
check(
  '"owner" is NOW excluded from the common page (moved to /owner/login)',
  isEligibleLoomIdentity("owner@luxardofashion.com", "owner", true),
  false,
);
check(
  "Super Admin email is excluded from the common page (unchanged)",
  isEligibleLoomIdentity(SUPER_ADMIN_EMAIL, "owner", true),
  false,
);
check(
  "Admin email is excluded from the common page (unchanged)",
  isEligibleLoomIdentity(ADMIN_EMAIL, "admin", true),
  false,
);
check(
  "an ordinary operational role (pm) is still allowed on the common page (non-regression)",
  isEligibleLoomIdentity("pm@luxardofashion.com", "pm", true),
  true,
);
for (const role of ["designer", "dispatch", "guard", "tailor", "store", "accounts", "analysis"]) {
  check(
    `operational role "${role}" still allowed on the common page (non-regression)`,
    isEligibleLoomIdentity(`${role}@luxardofashion.com`, role, true),
    true,
  );
}
check(
  "a deactivated staff account is still denied (non-regression)",
  isEligibleLoomIdentity("pm@luxardofashion.com", "pm", false),
  false,
);
check(
  "an unrecognised/legacy role is still denied (non-regression)",
  isEligibleLoomIdentity("someone@luxardofashion.com", "grade", true),
  false,
);

// ── isEligiblePrivilegedStaffDoc(): Owner/Super-Admin & Admin pages ───────
// Covers Google Sign-In and email/password identically — AuthContext calls
// this exact function regardless of which sign-in method was used.
check(
  "Super Admin email + doc role 'super_admin' + active -> eligible",
  isEligiblePrivilegedStaffDoc("super_admin", "super_admin", true),
  true,
);
check(
  "Super Admin email + doc role 'owner' (pre-migration state) + active -> eligible",
  isEligiblePrivilegedStaffDoc("super_admin", "owner", true),
  true,
);
check(
  "Super Admin email + doc role 'admin' -> NOT eligible (wrong tier)",
  isEligiblePrivilegedStaffDoc("super_admin", "admin", true),
  false,
);
check(
  "Admin email + doc role 'admin' + active -> eligible",
  isEligiblePrivilegedStaffDoc("admin", "admin", true),
  true,
);
check(
  "Admin email + doc role 'owner' -> NOT eligible (own exact role only)",
  isEligiblePrivilegedStaffDoc("admin", "owner", true),
  false,
);
check(
  "Admin email + doc role 'super_admin' -> NOT eligible (own exact role only, unaffected by the other identity's elevation)",
  isEligiblePrivilegedStaffDoc("admin", "super_admin", true),
  false,
);
check(
  "Super Admin email + a matching doc that is DEACTIVATED -> NOT eligible (fails closed, email alone is never enough)",
  isEligiblePrivilegedStaffDoc("super_admin", "super_admin", false),
  false,
);
check(
  "Admin email + NO staff doc at all (role undefined) -> NOT eligible (fails closed)",
  isEligiblePrivilegedStaffDoc("admin", undefined, undefined),
  false,
);
check(
  "Admin email + an unrelated operational role on the doc -> NOT eligible",
  isEligiblePrivilegedStaffDoc("admin", "pm", true),
  false,
);

// ── isEligibleForMobileRecovery(): UNCHANGED — non-regression ────────────
for (const role of ["owner", "admin", "super_admin", "pm", "designer", "guard"]) {
  check(
    `mobile-OTP recovery still eligible for role "${role}" (unchanged — recovery is independent of login routing)`,
    isEligibleForMobileRecovery(role, true),
    true,
  );
}
check(
  "mobile-OTP recovery still denied for a deactivated account (non-regression)",
  isEligibleForMobileRecovery("pm", false),
  false,
);
check(
  "mobile-OTP recovery still denied for an unrecognised role (non-regression)",
  isEligibleForMobileRecovery("grade", true),
  false,
);

if (!pass) {
  console.error("LUXARDO FLOW AUTH-CORRECTION REGRESSION TEST: FAIL");
  process.exitCode = 1;
} else {
  console.log(
    "LUXARDO FLOW AUTH-CORRECTION REGRESSION TEST: PASS — Owner is correctly " +
    "excluded from the common login page, Google Sign-In / email login for " +
    "Owner-Super-Admin and Admin now genuinely require a matching active " +
    "staff/{uid} doc (never email alone), and mobile-OTP recovery eligibility " +
    "is unchanged for every role."
  );
}
