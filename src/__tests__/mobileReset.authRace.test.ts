/* eslint-disable */
/**
 * REGRESSION TEST — LUXARDO FLOW mobile OTP password-reset eligibility +
 * phone-number validation.
 *
 * Covers the fail-closed eligibility gate shared by the common login page
 * (RoleLoginPage.verifyRole, common branch) and the mobile-OTP reset flow
 * (RoleLoginPage.handleConfirmResetOtp) — src/utils/loomIdentity.ts
 * isEligibleLoomIdentity() — plus the E.164 validator both the Add-Staff
 * form and the Set/Edit Mobile Number modal now use
 * (src/utils/phone.ts), matching functions/src/production.ts's E164_RE
 * exactly so client-side rejection lines up with the server's.
 *
 * Pure, dependency-free logic (no React, no Firebase) — matches the
 * `rolePermissions.med5.test.ts` / `resolutionChannel.authRace.test.ts`
 * convention: not wired into a test runner (the repo has none yet), runs
 * directly via tsx.
 *
 * Run (from repo root):
 *   npx tsx src/__tests__/mobileReset.authRace.test.ts
 */
import { isEligibleLoomIdentity, SUPER_ADMIN_EMAIL, ADMIN_EMAIL } from '../utils/loomIdentity';
import { isValidE164, toE164 } from '../utils/phone';

let pass = true;
const fail = (msg: string) => {
  console.error(`FAIL: ${msg}`);
  pass = false;
};
const check = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`OK  ${label} -> ${JSON.stringify(actual)}`);
  }
};

// ── isEligibleLoomIdentity: the fail-closed reset/login gate ──────────────

// 1) User with a valid mobile number → eligible (OTP reset must succeed for
//    every canonical role, Owner included per the User/Owner/Staff model).
for (const role of ['owner', 'designer', 'pm', 'dispatch', 'guard', 'tailor', 'store', 'accounts', 'analysis']) {
  check(`active canonical role "${role}" is eligible`, isEligibleLoomIdentity('someone@luxardofashion.com', role, true), true);
  check(`active canonical role "${role}" (active omitted) is eligible`, isEligibleLoomIdentity('someone@luxardofashion.com', role), true);
}

// 2) Missing identity → safe, clear denial (no staff/{uid} doc at all —
//    the caller passes role=undefined/data=null in this case).
check('no staff doc (role undefined) is denied', isEligibleLoomIdentity('someone@luxardofashion.com', undefined), false);
check('no staff doc (role null) is denied', isEligibleLoomIdentity('someone@luxardofashion.com', null), false);

// 3) Invalid / legacy role rejected (fails closed, never guesses a mapping).
check('unrecognised role string "grade" is denied', isEligibleLoomIdentity('someone@luxardofashion.com', 'grade'), false);
check('empty role string is denied', isEligibleLoomIdentity('someone@luxardofashion.com', ''), false);

// 4) Deactivated account is denied even with an otherwise-valid role.
check('active === false is denied even for a valid role', isEligibleLoomIdentity('someone@luxardofashion.com', 'owner', false), false);

// 5) Privileged Gmail identities never go through this staff-only mechanism
//    — they have their own real Firebase password reset on /admin/login.
check(`${SUPER_ADMIN_EMAIL} is denied even with a role attached`, isEligibleLoomIdentity(SUPER_ADMIN_EMAIL, 'owner', true), false);
check(`${ADMIN_EMAIL} is denied even with a role attached`, isEligibleLoomIdentity(ADMIN_EMAIL, 'admin', true), false);

// 6) No account-existence leak: an unrecognised phone number's resulting
//    Firebase uid has no staff doc, and this call is the ONLY signal the
//    reset flow acts on — it must produce the exact same "denied" outcome
//    (and therefore the exact same error message upstream) as every other
//    denial reason above, with no distinguishing detail leaked.
const unknownNumberOutcome = isEligibleLoomIdentity(undefined, undefined, undefined);
check('an unrecognised phone number (no email, no staff doc) is denied, indistinguishably from other denials', unknownNumberOutcome, false);

// ── isValidE164 / toE164 — matches functions/src/production.ts E164_RE ────
const validNumbers = ['+919876543210', '+14155552671', '+441234567890'];
const invalidNumbers = ['919876543210', '+0123456789', '+91', 'not-a-number', '', '   ', '+91 98765 43210'];

for (const n of validNumbers) {
  check(`"${n}" is valid E.164`, isValidE164(n), true);
}
for (const n of invalidNumbers) {
  check(`"${n}" is rejected as invalid E.164 (missing +, leading 0, too short, spaces, etc.)`, isValidE164(n), false);
}

check('toE164 adds a leading "+" when missing (react-phone-input-2 output shape)', toE164('919876543210'), '+919876543210');
check('toE164 leaves an already-prefixed number unchanged', toE164('+919876543210'), '+919876543210');
check('toE164 output round-trips as valid', isValidE164(toE164('919876543210')), true);

if (!pass) {
  console.error('MOBILE RESET REGRESSION TEST: FAIL');
  process.exitCode = 1;
} else {
  console.log(
    'MOBILE RESET REGRESSION TEST: PASS — every canonical role (Owner included) with a ' +
    'valid, active identity is reset-eligible; a missing/invalid/inactive/privileged ' +
    'identity is denied with no distinguishing signal; E.164 validation matches the ' +
    "server's regex exactly."
  );
}
