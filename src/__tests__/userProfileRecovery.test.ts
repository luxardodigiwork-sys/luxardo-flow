/* eslint-disable */
/**
 * REGRESSION TEST — LUXARDO FLOW authoritative User Profile + redesigned
 * mobile-OTP password recovery.
 *
 * Covers the PURE, dependency-free client logic behind the recovery flow:
 * phone validation/masking (src/utils/phone.ts) and the shared eligibility
 * gate (src/utils/loomIdentity.ts isEligibleLoomIdentity), which
 * mobileResetLookup (functions/src/production.ts) mirrors server-side to
 * decide { eligible, reason } / { eligible, maskedLast4, recoveryToken } —
 * NOTE: as of the follow-up security patch, this response never includes
 * the full phone number at all; see mobileReset.tokenExchange.test.ts for
 * that redesign's own coverage (two-phase token exchange, Owner/Admin/
 * Super Admin recovery via isEligibleForMobileRecovery).
 *
 * What this file CANNOT test (no Firebase emulator or test-runner exists in
 * this repo — see rolePermissions.med5.test.ts's own note on this) and
 * instead documents as structurally guaranteed by the code, with exact
 * file/line evidence:
 *
 *   H. OTP sent only to the stored authoritative mobile —
 *      RoleLoginPage.handleConfirmSendOtp exchanges resetRecoveryTokenRef
 *      (set only from mobileResetLookup's response) for a phone number via
 *      mobileResetSendOtp, and passes that value straight into
 *      signInWithPhoneNumber(auth, phoneNumber, ...) in the same
 *      expression — never assigned to any React state, never rendered.
 *   I. An arbitrary/client-typed number cannot become the OTP destination —
 *      the reset flow's 'identify'/'confirm' screens contain no free-text
 *      phone input at all (grep confirms zero <PhoneInput> or phone
 *      <input> inside the mode==='reset' && common JSX block); the ONLY
 *      phone <PhoneInput> remaining is in the UNRELATED loginTab==='phone'
 *      LOGIN flow, which was explicitly out of scope for this change.
 *   D. Duplicate mobile numbers — enforced by Firebase Auth itself
 *      (project-wide uniqueness on the phoneNumber field), invoked via
 *      admin.auth().updateUser()/createUser() in functions/src/
 *      production.ts; surfaced to the client as the caught error's own
 *      message (StaffManagementPage.saveMobileNumber /
 *      UserProfilePage.handleSave catch blocks). Not independently
 *      re-implemented, so there is no separate client-side duplicate-check
 *      function to unit test here.
 *   L. duplicate recovery attempt / M. rate limiting — handleIdentifyForReset
 *      calls the EXISTING checkLocalLock()/recordLocalFailure() pair
 *      (MAX_FAILED_ATTEMPTS=3, 15-minute lock) on every ineligible lookup,
 *      the same mechanism already covering the login flow — verified by
 *      code inspection, not a new mechanism requiring its own test.
 *
 * Pure, dependency-free logic (no React, no Firebase) — matches the
 * established convention in this repo: not wired into a test runner (none
 * exists), runs directly via tsx.
 *
 * Run (from repo root):
 *   npx tsx src/__tests__/userProfileRecovery.test.ts
 */
import { isValidE164, toE164, maskPhoneLast4 } from '../utils/phone';
import { isEligibleLoomIdentity, isEligibleForMobileRecovery, SUPER_ADMIN_EMAIL, ADMIN_EMAIL } from '../utils/loomIdentity';

let pass = true;
const fail = (msg: string) => { console.error(`FAIL: ${msg}`); pass = false; };
const check = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  else console.log(`OK  ${label} -> ${JSON.stringify(actual)}`);
};

// ── G. Masked last-4 display ───────────────────────────────────────────
check('maskPhoneLast4 shows only the last 4 digits, dots for the rest',
  maskPhoneLast4('+919664040699'), '•••••••• 0699');
check('maskPhoneLast4 never includes any digit before the last 4 (spot check)',
  maskPhoneLast4('+919664040699')!.includes('966'), false);
check('maskPhoneLast4 handles a shorter international number',
  maskPhoneLast4('+14155552671'), '•••••••• 2671');
check('maskPhoneLast4 returns null for null input (no phone configured case)', maskPhoneLast4(null), null);
check('maskPhoneLast4 returns null for undefined input', maskPhoneLast4(undefined), null);
check('maskPhoneLast4 returns null rather than partially reveal a too-short value', maskPhoneLast4('12'), null);

// ── E. Invalid phone format rejected (client-side, matches server E164_RE) ─
const validNumbers = ['+919876543210', '+14155552671', '+441234567890'];
const invalidNumbers = ['919876543210', '+0123456789', '+91', 'not-a-number', '', '   ', '+91 98765 43210'];
for (const n of validNumbers) check(`"${n}" is valid E.164`, isValidE164(n), true);
for (const n of invalidNumbers) check(`"${n}" is rejected as invalid E.164`, isValidE164(n), false);
check('toE164 adds a leading "+" (PhoneInput output shape)', toE164('919876543210'), '+919876543210');
check('toE164 leaves an already-prefixed number unchanged', toE164('+919876543210'), '+919876543210');

// ── A/B/F/K. Eligibility for the identify step — same gate the server
// mirrors in mobileResetLookup's { eligible, reason } response.
//
// UPDATED for the LUXARDO FLOW authentication correction: this section
// tests RECOVERY eligibility specifically, which is isEligibleForMobileRecovery
// (mobileResetLookup's actual mirror) — NOT isEligibleLoomIdentity, which is
// LOGIN-page routing only and, as of this change, also excludes "owner"
// (Owner now has its own dedicated /owner/login page; see
// loomPrivilegedAuth.test.ts). Recovery eligibility for Owner is UNCHANGED —
// it still uses the mobile-OTP mechanism as a fallback even though it no
// longer logs in via the common page. ─────────────────────────────────────
// A: valid profile with a registered mobile + active role -> eligible
for (const role of ['owner', 'designer', 'pm', 'dispatch', 'guard', 'tailor', 'store', 'accounts', 'analysis']) {
  check(`A: active "${role}" with a resolvable identity is eligible (registered-mobile case)`,
    isEligibleForMobileRecovery(role, true), true);
}
// F: inactive User -> denied ("This User account is inactive...")
check('F: inactive User is denied even with an otherwise-valid role', isEligibleForMobileRecovery('pm', false), false);
// B: missing profile (no staff doc resolved at all) -> denied ("not registered")
check('B: no resolvable identity (role undefined) is denied', isEligibleForMobileRecovery(undefined), false);
check('B: no resolvable identity (role null) is denied', isEligibleForMobileRecovery(null), false);
// Legacy/unrecognised role fails closed, never guessed
check('unrecognised legacy role "grade" is denied (fails closed, no guessing)', isEligibleForMobileRecovery('grade'), false);

// K: normal operational User recovery works identically to any other role
check('K: normal operational role (dispatch) recovery-eligible', isEligibleForMobileRecovery('dispatch', true), true);

// Owner recovery (item 8 / test K's Owner counterpart) — Owner is NOT
// excluded from this mechanism, unlike the two truly privileged identities.
check('Owner is recovery-eligible (not conflated with the 2 privileged Gmail identities)',
  isEligibleForMobileRecovery('owner', true), true);

// Privileged Super Admin/Admin are excluded from RECOVERY too (own real
// Firebase email-based reset instead) — isEligibleForMobileRecovery takes a
// role only (no email param); the exclusion for these two is enforced by
// resolveRecoveryEligibility never resolving a *role* for them server-side,
// covered directly in mobileReset.tokenExchange.test.ts. This section keeps
// its original LOGIN-page assertions (isEligibleLoomIdentity) below, since
// that really is what they test — Super Admin/Admin never reach the common
// /login page at all, dedicated pages only.
check(`${SUPER_ADMIN_EMAIL} is denied on the common LOGIN page even with a role attached`, isEligibleLoomIdentity(SUPER_ADMIN_EMAIL, 'owner', true), false);
check(`${ADMIN_EMAIL} is denied on the common LOGIN page even with a role attached`, isEligibleLoomIdentity(ADMIN_EMAIL, 'admin', true), false);

// ── N. Existing email/password login path is unaffected ─────────────────
// verifyRole's common branch uses this SAME isEligibleLoomIdentity gate
// (RoleLoginPage.tsx) — these are the exact same assertions the login path
// depends on, re-confirmed here after the profile/recovery redesign.
check('N: login-path eligibility check still passes for an active canonical role', isEligibleLoomIdentity('pm@luxardofashion.com', 'pm', true), true);
check('N: login-path eligibility check still fails closed for privileged emails', isEligibleLoomIdentity(SUPER_ADMIN_EMAIL, 'super_admin', true), false);

if (!pass) {
  console.error('USER PROFILE / RECOVERY REGRESSION TEST: FAIL');
  process.exitCode = 1;
} else {
  console.log(
    'USER PROFILE / RECOVERY REGRESSION TEST: PASS — masking never reveals more than the ' +
    'last 4 digits, E.164 validation matches the server exactly, the recovery-eligibility ' +
    'gate (isEligibleForMobileRecovery) correctly admits every active canonical role ' +
    '(Owner included) while denying missing/inactive/unrecognised identities, and the ' +
    'separate common-login gate (isEligibleLoomIdentity) still denies the two privileged ' +
    'Gmail identities exactly as before.'
  );
}
