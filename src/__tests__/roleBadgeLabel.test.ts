/**
 * FOCUSED REGRESSION TEST — persistent role-identity badge label mapping
 * (src/utils/rolePermissions.ts's roleBadgeLabel, V1 Stabilization Step 2).
 *
 * Verifies every one of the 11 canonical Flow roles maps to the exact,
 * deterministic, uppercase badge text ProductionLayout.tsx renders in the
 * desktop sidebar and the mobile header/drawer. roleBadgeLabel is
 * deliberately a SEPARATE function from the existing roleLabel() (used
 * elsewhere — ProductionHomePage, UserProfilePage, StaffManagementPage) —
 * this test also pins the two specific cases where they intentionally
 * diverge (pm, analysis), so neither accidentally regresses into matching
 * the other.
 */
import { roleBadgeLabel, roleLabel } from '../utils/rolePermissions';

let pass = true;
const check = (desc: string, cond: boolean) => {
  if (cond) {
    console.log(`OK  ${desc}`);
  } else {
    console.error(`FAIL ${desc}`);
    pass = false;
  }
};

const EXPECTED: Record<string, string> = {
  super_admin: 'SUPER ADMIN',
  admin: 'ADMIN',
  owner: 'OWNER',
  designer: 'DESIGNER',
  pm: 'PM',
  dispatch: 'DISPATCH',
  guard: 'GUARD',
  tailor: 'TAILOR',
  store: 'STORE',
  accounts: 'ACCOUNTS',
  analysis: 'ANALYSIS',
};

// ── 1. Every one of the 11 canonical roles has the exact expected label ──
for (const [role, expected] of Object.entries(EXPECTED)) {
  check(`roleBadgeLabel("${role}") === "${expected}"`, roleBadgeLabel(role) === expected);
}
check('All 11 canonical roles covered', Object.keys(EXPECTED).length === 11);

// ── 2. Deterministic: same input always produces the same output ────────
for (const role of Object.keys(EXPECTED)) {
  const a = roleBadgeLabel(role);
  const b = roleBadgeLabel(role);
  check(`roleBadgeLabel("${role}") is deterministic across repeated calls`, a === b);
}

// ── 3. Case-insensitive / whitespace-tolerant, same as roleLabel's pattern ─
check('roleBadgeLabel is case-insensitive ("OWNER" input)', roleBadgeLabel('OWNER') === 'OWNER');
check('roleBadgeLabel is case-insensitive ("Super_Admin" input)', roleBadgeLabel('Super_Admin') === 'SUPER ADMIN');

// ── 4. Fail-safe: unknown/missing role never renders blank or a guessed
//      privileged label ──────────────────────────────────────────────────
check('Unrecognised role ("grade") fails safe to "STAFF"', roleBadgeLabel('grade') === 'STAFF');
check('Missing role (undefined) fails safe to "STAFF"', roleBadgeLabel(undefined) === 'STAFF');
check('Missing role (null) fails safe to "STAFF"', roleBadgeLabel(null) === 'STAFF');
check('Empty role string fails safe to "STAFF"', roleBadgeLabel('') === 'STAFF');
check('"STAFF" is never mistaken for a privileged label', !['SUPER ADMIN', 'ADMIN', 'OWNER'].includes(roleBadgeLabel('grade')));

// ── 5. Pinned, intentional divergence from the existing roleLabel() ──────
// (longer, title-cased forms used elsewhere — unaffected by this feature)
check('roleBadgeLabel("pm") = "PM", NOT roleLabel\'s "Production Manager"', roleBadgeLabel('pm') === 'PM' && roleLabel('pm') === 'Production Manager');
check('roleBadgeLabel("analysis") = "ANALYSIS", NOT roleLabel\'s "Analytics"', roleBadgeLabel('analysis') === 'ANALYSIS' && roleLabel('analysis') === 'Analytics');
// Every other role's badge text is just the uppercase of roleLabel's form —
// confirms the divergence is ONLY the two documented exceptions above.
for (const role of ['super_admin', 'admin', 'owner', 'designer', 'dispatch', 'guard', 'tailor', 'store', 'accounts']) {
  check(
    `roleBadgeLabel("${role}") is exactly roleLabel("${role}").toUpperCase()`,
    roleBadgeLabel(role) === roleLabel(role).toUpperCase()
  );
}

if (!pass) {
  console.error('ROLE BADGE LABEL REGRESSION TEST: FAIL');
  process.exitCode = 1;
} else {
  console.log(
    'ROLE BADGE LABEL REGRESSION TEST: PASS — all 11 canonical roles map to ' +
    'deterministic, exact uppercase badge text; unknown/missing roles fail ' +
    'safe to a non-privileged "STAFF" tag; and the two intentional ' +
    'divergences from roleLabel() (pm, analysis) are pinned, with every ' +
    'other role staying the plain uppercase of roleLabel()\'s existing form.'
  );
}
