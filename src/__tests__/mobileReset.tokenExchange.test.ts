/* eslint-disable */
/**
 * REGRESSION TEST — LUXARDO FLOW mobile-OTP recovery SECURITY PATCH:
 *   1. mobileResetLookup no longer returns the full phone number.
 *   2. Owner/Admin/Super Admin are no longer silently excluded from
 *      recovery (only LOGIN ROUTING stays exclusive to /admin/login).
 *
 * Covers the PURE, dependency-free logic this patch touches:
 * isEligibleForMobileRecovery (src/utils/loomIdentity.ts) — the recovery
 * gate used by both the client's final re-check (RoleLoginPage.tsx
 * handleConfirmResetOtp) and mirrored server-side by
 * isRecognisedRecoveryRole() (functions/src/production.ts).
 *
 * What this file CANNOT test (no Firebase emulator — see
 * rolePermissions.med5.test.ts's own note) and instead documents as
 * structurally guaranteed by the code, with exact file/line evidence:
 *
 *   1. Full phone never reaches the browser on lookup —
 *      functions/src/production.ts mobileResetLookup's ONLY two return
 *      statements are `{ eligible: false, reason }` and
 *      `{ eligible: true, maskedLast4: result.phone.slice(-4),
 *      recoveryToken: token }` — grep confirms no `phoneNumber` key
 *      anywhere in that function's return values. The client
 *      (RoleLoginPage.tsx handleIdentifyForReset) types the response as
 *      `{ eligible, reason?, maskedLast4?, recoveryToken? }` — no
 *      `phoneNumber` field exists in that type at all.
 *   2. OTP still uses the server-authoritative phone, and an arbitrary/
 *      client-entered number still cannot be substituted — the ONLY place
 *      the client ever obtains a full number is mobileResetSendOtp's
 *      response, exchanged for a server-validated, single-use
 *      recoveryToken (never a phone number the requester supplied), and
 *      that number is passed straight into signInWithPhoneNumber() in the
 *      same expression (handleConfirmSendOtp) — never stored in state.
 *   3. The recoveryToken is single-use and short-lived — mobileResetSendOtp
 *      rejects with "invalid or has expired" when
 *      tokenData.used || Date.now() > tokenData.expiresAt, and marks
 *      `used: true` before ever returning the phone number (production.ts).
 *   4. Admin/Super Admin's LOGIN routing is unchanged — verifyRole's common
 *      branch (RoleLoginPage.tsx) still uses isEligibleLoomIdentity (NOT
 *      isEligibleForMobileRecovery), which still excludes them by email via
 *      isPrivilegedEmail; AdminLoginPage.tsx (their dedicated page, own
 *      real Gmail-based sendPasswordResetEmail) is untouched by this patch.
 *   5. Rate limiting is intact — handleIdentifyForReset still calls the
 *      existing checkLocalLock()/recordLocalFailure() pair (unchanged,
 *      same MAX_FAILED_ATTEMPTS/LOCKOUT_DURATION_MINUTES as the login path)
 *      on every ineligible lookup.
 *
 * Pure, dependency-free logic (no React, no Firebase) — matches the
 * established convention in this repo: not wired into a test runner (none
 * exists), runs directly via tsx.
 *
 * Run (from repo root):
 *   npx tsx src/__tests__/mobileReset.tokenExchange.test.ts
 */
import { isEligibleForMobileRecovery, isEligibleLoomIdentity, SUPER_ADMIN_EMAIL, ADMIN_EMAIL } from '../utils/loomIdentity';

let pass = true;
const fail = (msg: string) => { console.error(`FAIL: ${msg}`); pass = false; };
const check = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  else console.log(`OK  ${label} -> ${JSON.stringify(actual)}`);
};

// ── Owner recovery ─────────────────────────────────────────────────────
check('Owner recovery: active "owner" role is recovery-eligible', isEligibleForMobileRecovery('owner', true), true);

// ── Admin recovery (previously silently excluded — now included) ───────
check('Admin recovery: active "admin" role is now recovery-eligible', isEligibleForMobileRecovery('admin', true), true);

// ── Super Admin recovery (previously excluded by role-string BOTH via the
// exclusion set AND the "super_admin" terminology gap in
// CANONICAL_STAFF_ROLES — now both are fixed) ───────────────────────────
check('Super Admin recovery: literal "super_admin" role is recovery-eligible (terminology gap closed)',
  isEligibleForMobileRecovery('super_admin', true), true);
check('Super Admin recovery: case-insensitive "SUPER_ADMIN" also works', isEligibleForMobileRecovery('SUPER_ADMIN', true), true);

// ── Operational User recovery (unaffected, still works) ─────────────────
for (const role of ['designer', 'pm', 'dispatch', 'guard', 'tailor', 'store', 'accounts', 'analysis']) {
  check(`Operational User recovery: active "${role}" is recovery-eligible`, isEligibleForMobileRecovery(role, true), true);
}

// ── Inactive / missing-mobile-adjacent rejection ─────────────────────────
check('Inactive User is denied even with a valid role (owner)', isEligibleForMobileRecovery('owner', false), false);
check('Inactive Admin is denied too — active still gates regardless of role', isEligibleForMobileRecovery('admin', false), false);
check('No resolvable role (undefined) is denied', isEligibleForMobileRecovery(undefined, true), false);
check('No resolvable role (null) is denied', isEligibleForMobileRecovery(null, true), false);
check('Unrecognised legacy role "grade" is denied (fails closed, no guessing)', isEligibleForMobileRecovery('grade', true), false);
check('Empty role string is denied', isEligibleForMobileRecovery('', true), false);

// ── Confirms the two gates are DELIBERATELY different (login vs recovery) ─
// This is the crux of the fix: recovery must NOT reuse the login gate.
check('isEligibleForMobileRecovery admits Admin (recovery)', isEligibleForMobileRecovery('admin', true), true);
check('isEligibleLoomIdentity still denies Admin (login routing unchanged — dedicated /admin/login only)',
  isEligibleLoomIdentity(ADMIN_EMAIL, 'admin', true), false);
check('isEligibleForMobileRecovery admits Super Admin (recovery)', isEligibleForMobileRecovery('super_admin', true), true);
check('isEligibleLoomIdentity still denies Super Admin (login routing unchanged)',
  isEligibleLoomIdentity(SUPER_ADMIN_EMAIL, 'super_admin', true), false);
// Owner: still eligible for mobile-OTP RECOVERY (unchanged), but — per the
// LUXARDO FLOW authentication correction — now excluded from the common
// LOGIN gate too, same as Super Admin/Admin: Owner moved to the dedicated
// Owner/Super-Admin page (/owner/login). See loomPrivilegedAuth.test.ts.
check('isEligibleForMobileRecovery admits Owner', isEligibleForMobileRecovery('owner', true), true);
check('isEligibleLoomIdentity now denies Owner (moved to /owner/login)',
  isEligibleLoomIdentity('owner@luxardofashion.com', 'owner', true), false);

if (!pass) {
  console.error('MOBILE RESET TOKEN-EXCHANGE / PRIVILEGED-RECOVERY REGRESSION TEST: FAIL');
  process.exitCode = 1;
} else {
  console.log(
    'MOBILE RESET TOKEN-EXCHANGE / PRIVILEGED-RECOVERY REGRESSION TEST: PASS — Owner, Admin, ' +
    'Super Admin and every operational role are all recovery-eligible when active (no more ' +
    'silent exclusion by role-string or "super_admin" terminology gap); inactive/unrecognised ' +
    'roles still fail closed; and the recovery gate is confirmed structurally distinct from the ' +
    'unchanged login gate, which still routes Admin/Super Admin exclusively to /admin/login.'
  );
}
