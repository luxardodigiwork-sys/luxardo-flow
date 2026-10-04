/**
 * FOCUSED REGRESSION TEST — role-aware post-logout redirect
 * (src/utils/loomIdentity.ts's getPostLogoutRedirectPath).
 *
 * Bug fixed: ProductionLayout.tsx's handleLogout previously sent EVERY
 * Loom role to "/login" (the common staff page) on sign-out, including
 * Owner/Admin/Super Admin, who must land back on "/admin/login" — the
 * privileged page they actually sign in on. ChangePasswordPage.tsx's own
 * "Sign out" button had the same gap (no role-aware redirect at all).
 *
 * Both call sites now funnel through this ONE shared, pure function — no
 * duplicated role logic — so this test exercises the single source of
 * truth both ProductionLayout.tsx's handleLogout AND ChangePasswordPage.tsx's
 * handleSignOut now call. Neither component has its own redirect logic left
 * to diverge.
 *
 * Scenarios:
 *   1. super_admin logout (Loom host) -> /admin/login
 *   2. admin logout (Loom host) -> /admin/login
 *   3. owner logout (Loom host) -> /admin/login
 *   4. One representative normal staff role (pm) logout (Loom host) -> /login
 *   5. Every other canonical operational role (Loom host) -> /login
 *      (exhaustive, not just the one representative above)
 *   6. Non-Loom host: always /admin/login regardless of role — the
 *      pre-existing, unrelated B2C-branch behavior, confirmed UNCHANGED.
 *   7. Role normalization: case-insensitive, whitespace-trimmed, and
 *      missing/unknown role all fail safe to "/login" on a Loom host
 *      (never silently treated as privileged).
 */
import { getPostLogoutRedirectPath, isEligibleForPrivilegedLoginPage, OPERATIONAL_STAFF_ROLES } from '../utils/loomIdentity';

let pass = true;
const check = (desc: string, cond: boolean) => {
  if (cond) {
    console.log(`OK  ${desc}`);
  } else {
    console.error(`FAIL ${desc}`);
    pass = false;
  }
};

// ── 1-3. Privileged roles, Loom host -> /admin/login ──────────────────────
check('super_admin logout (Loom) -> /admin/login', getPostLogoutRedirectPath('super_admin', true) === '/admin/login');
check('admin logout (Loom) -> /admin/login', getPostLogoutRedirectPath('admin', true) === '/admin/login');
check('owner logout (Loom) -> /admin/login', getPostLogoutRedirectPath('owner', true) === '/admin/login');

// ── 4. One representative normal staff role (pm) -> /login ───────────────
check('pm logout (Loom) -> /login', getPostLogoutRedirectPath('pm', true) === '/login');

// ── 5. Every other canonical operational role -> /login (exhaustive) ─────
for (const role of OPERATIONAL_STAFF_ROLES) {
  check(`${role} logout (Loom) -> /login`, getPostLogoutRedirectPath(role, true) === '/login');
}

// ── 6. Non-Loom host: always /admin/login, regardless of role ────────────
// (the pre-existing B2C-branch behavior, confirmed UNCHANGED by this fix)
check('owner logout (non-Loom) -> /admin/login (unchanged)', getPostLogoutRedirectPath('owner', false) === '/admin/login');
check('pm logout (non-Loom) -> /admin/login (unchanged)', getPostLogoutRedirectPath('pm', false) === '/admin/login');
check('guard logout (non-Loom) -> /admin/login (unchanged)', getPostLogoutRedirectPath('guard', false) === '/admin/login');

// ── 7. Role normalization fails safe ──────────────────────────────────────
check('Role normalization: "SUPER_ADMIN" (uppercase) -> /admin/login', getPostLogoutRedirectPath('SUPER_ADMIN', true) === '/admin/login');
check('Role normalization: "  owner  " (whitespace) -> /admin/login', getPostLogoutRedirectPath('  owner  ', true) === '/admin/login');
check('Missing role (undefined) on Loom host fails safe -> /login (never privileged)', getPostLogoutRedirectPath(undefined, true) === '/login');
check('Missing role (null) on Loom host fails safe -> /login (never privileged)', getPostLogoutRedirectPath(null, true) === '/login');
check('Unrecognised role ("grade") on Loom host fails safe -> /login', getPostLogoutRedirectPath('grade', true) === '/login');
check('Empty role string on Loom host fails safe -> /login', getPostLogoutRedirectPath('', true) === '/login');

// ── Cross-check against the existing eligibility helper (no drift) ───────
// getPostLogoutRedirectPath must agree with isEligibleForPrivilegedLoginPage
// for every role on a Loom host — it is explicitly built on top of it, not a
// second independent implementation.
for (const role of [...OPERATIONAL_STAFF_ROLES, 'owner', 'admin', 'super_admin', 'unknown_role', '']) {
  const expectPrivileged = isEligibleForPrivilegedLoginPage(role);
  const redirect = getPostLogoutRedirectPath(role, true);
  check(
    `"${role}" redirect agrees with isEligibleForPrivilegedLoginPage (expected ${expectPrivileged ? '/admin/login' : '/login'})`,
    redirect === (expectPrivileged ? '/admin/login' : '/login')
  );
}

if (!pass) {
  console.error('POST-LOGOUT REDIRECT REGRESSION TEST: FAIL');
  process.exitCode = 1;
} else {
  console.log(
    'POST-LOGOUT REDIRECT REGRESSION TEST: PASS — super_admin/admin/owner ' +
    'logout correctly redirects to /admin/login, every operational staff ' +
    'role correctly redirects to /login, the non-Loom/B2C branch is ' +
    'unchanged, role normalization fails safe to the non-privileged page, ' +
    'and the decision never drifts from isEligibleForPrivilegedLoginPage ' +
    '(the same helper AdminLoginPage.tsx already relies on).'
  );
}
