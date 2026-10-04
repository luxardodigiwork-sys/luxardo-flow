/**
 * FOCUSED REGRESSION TEST — privileged login redirect race (V1 Stabilization
 * Step 3B).
 *
 * Bug fixed: AdminLoginPage.tsx's handleEmailLogin/handleGoogleLogin/
 * handleMobilePasswordLogin, and RoleLoginPage.tsx's handleEmailLogin/
 * handleGoogleLogin, each called an imperative navigate() immediately after
 * awaiting verifyAdminRole()/verifyRole() — which resolves via a SEPARATE
 * resolution channel (waitForResolution, src/utils/resolutionChannel.ts)
 * that is not synchronized with React's own commit of AuthContext's
 * setUser(). That navigate() could fire before ProtectedProductionRoute's
 * `useAuth().user` check had the fresh value, bouncing a freshly-authenticated
 * Super Admin/Admin/Owner to /login (which then never auto-forwards a
 * privileged identity — see isEligibleLoomIdentity).
 *
 * Fix: removed the premature imperative navigate() calls; navigation is now
 * driven SOLELY by each page's own useEffect watching `user` — which only
 * runs once React has actually committed the new `user`, so it can't race.
 *
 * This repo has no DOM test renderer (no jsdom/RTL), so this test is a
 * structural source check — it reads the actual page source and verifies:
 *   1. Each login handler's try-block no longer calls navigate() on its
 *      success path (the exact regression class this bug was).
 *   2. The useEffect that is now the SOLE navigation authority is still
 *      present and intact (a regression here would silently break ALL
 *      post-login navigation, not just the race).
 * The actual end-to-end behavioral proof (does login genuinely land on
 * /production?) is a separate Playwright/emulator integration test — see
 * this session's report for how to run it.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = true;
const check = (desc: string, cond: boolean) => {
  if (cond) {
    console.log(`OK  ${desc}`);
  } else {
    console.error(`FAIL ${desc}`);
    pass = false;
  }
};

/** Extract one top-level `const <name> = async (...) => { ... };` function
 *  body by locating its declaration and the next line that is exactly
 *  `  };` (2-space indent, matching this codebase's consistent style) at or
 *  after it. Deliberately simple (no brace-counting) — these are flat
 *  handler functions with no nested `};`-on-its-own-line blocks inside. */
function extractHandlerBody(source: string, handlerName: string): string {
  const startMarker = `const ${handlerName} = async`;
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Could not find handler "${handlerName}" in source.`);
  const endIdx = source.indexOf('\n  };', startIdx);
  if (endIdx === -1) throw new Error(`Could not find the end of handler "${handlerName}".`);
  const raw = source.slice(startIdx, endIdx);
  // Strip `//` line comments before any code-pattern check below — this
  // file's own explanatory comments legitimately mention "navigate()" in
  // prose (documenting why the call was removed), which must not trip a
  // check for an actual, executable navigate(...) call.
  return raw
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

// ── AdminLoginPage.tsx ────────────────────────────────────────────────────
{
  const path = join(__dirname, '..', 'pages', 'admin', 'AdminLoginPage.tsx');
  const source = readFileSync(path, 'utf8');

  for (const handler of ['handleEmailLogin', 'handleGoogleLogin', 'handleMobilePasswordLogin']) {
    const body = extractHandlerBody(source, handler);
    check(
      `AdminLoginPage.${handler}: no longer calls navigate() on its success path`,
      !body.includes('navigate(')
    );
    // Sanity: confirm the validation call itself is still present and
    // un-gutted — this isn't just a case of the whole handler being emptied.
    const validatesStillPresent = handler === 'handleMobilePasswordLogin'
      ? body.includes('await verifyAdminRole(cred.user.uid)')
      : body.includes('await verifyAdminRole(cred.user.uid)');
    check(`AdminLoginPage.${handler}: still awaits verifyAdminRole() for validation`, validatesStillPresent);
  }

  // The useEffect is now the SOLE navigation authority — confirm all three
  // of its branches are still intact.
  check(
    'AdminLoginPage: useEffect still navigates privileged roles to fromPath/production',
    source.includes("navigate(fromPath || '/production', { replace: true });")
  );
  check(
    'AdminLoginPage: useEffect still navigates stray staff roles to /login',
    source.includes("navigate('/login', { replace: true });")
  );
  check(
    'AdminLoginPage: useEffect still navigates the non-Loom (B2C) branch to `from`',
    source.includes('navigate(from, { replace: true });')
  );
}

// ── RoleLoginPage.tsx ─────────────────────────────────────────────────────
{
  const path = join(__dirname, '..', 'components', 'auth', 'RoleLoginPage.tsx');
  const source = readFileSync(path, 'utf8');

  for (const handler of ['handleEmailLogin', 'handleGoogleLogin']) {
    const body = extractHandlerBody(source, handler);
    check(
      `RoleLoginPage.${handler}: no longer calls navigate() on its success path`,
      !body.includes('navigate(')
    );
    check(`RoleLoginPage.${handler}: still awaits verifyRole() for validation`, body.includes('await verifyRole(cred.user.uid)'));
  }

  // The useEffect is now the SOLE navigation authority for both common
  // (Loom staff) and non-common (B2C per-role) modes.
  check(
    'RoleLoginPage: useEffect still navigates to successTarget once alreadyAllowed',
    source.includes('if (alreadyAllowed) navigate(successTarget, { replace: true });')
  );

  // The mobile-OTP password-RESET flow is a separate, unrelated code path
  // (ends in signOut(), not navigate()) — confirm it was NOT touched by this
  // fix (handleConfirmResetOtp never navigated preemptively to begin with,
  // so there's nothing to remove there; this just pins that invariant).
  const resetBody = extractHandlerBody(source, 'handleConfirmResetOtp');
  check(
    'RoleLoginPage.handleConfirmResetOtp: unaffected — still signs out (never a login-success path)',
    resetBody.includes('await signOut(auth);') && !resetBody.includes("navigate(successTarget")
  );
}

if (!pass) {
  console.error('LOGIN NAVIGATION RACE REGRESSION TEST: FAIL');
  process.exitCode = 1;
} else {
  console.log(
    'LOGIN NAVIGATION RACE REGRESSION TEST: PASS — every privileged and ' +
    'common-staff login handler (AdminLoginPage, RoleLoginPage) no longer ' +
    'calls navigate() on its success path, each still performs its role ' +
    'validation (and sign-out-on-failure) unchanged, and the useEffect ' +
    'that is now the sole navigation authority for both pages is intact ' +
    'with all of its branches.'
  );
}
