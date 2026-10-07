/**
 * FOCUSED REGRESSION TEST — Final Role Dashboards & Reporting phase.
 * Covers the two new rolePermissions.ts modules added for this phase:
 *   - production.storeOverview (read-only Store Overview, cross-role)
 *   - production.labour.cost (dashboard-level AGGREGATE labour cost card)
 *
 * Run: npx tsx src/__tests__/rolePermissions.dashboards.test.ts
 */
import { can } from '../utils/rolePermissions';

let pass = true;
const fail = (msg: string) => { console.error(`FAIL: ${msg}`); pass = false; };
const check = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  else console.log(`OK  ${label} -> ${JSON.stringify(actual)}`);
};

// ── production.storeOverview — exactly the 9 roles named in the spec ──
const STORE_OVERVIEW_ALLOWED = ['super_admin', 'admin', 'owner', 'guard', 'pm', 'designer', 'dispatch', 'analysis', 'store'];
const STORE_OVERVIEW_DENIED = ['accounts', 'tailor', 'customer'];

for (const r of STORE_OVERVIEW_ALLOWED) {
  check(`storeOverview: "${r}" allowed`, can(r, 'production.storeOverview'), true);
}
for (const r of STORE_OVERVIEW_DENIED) {
  check(`storeOverview: "${r}" denied`, can(r, 'production.storeOverview'), false);
}

// ── production.labour.cost — super_admin/admin/owner/pm ONLY; never the
// operational roles that must not see aggregate labour cost on the dashboard ──
const LABOUR_COST_ALLOWED = ['super_admin', 'admin', 'owner', 'pm'];
const LABOUR_COST_DENIED = ['dispatch', 'guard', 'tailor', 'store', 'designer', 'accounts', 'analysis'];

for (const r of LABOUR_COST_ALLOWED) {
  check(`labour.cost: "${r}" allowed`, can(r, 'production.labour.cost'), true);
}
for (const r of LABOUR_COST_DENIED) {
  check(`labour.cost: "${r}" denied`, can(r, 'production.labour.cost'), false);
}

// ── Non-regression: production.store.out / production.karigars.write /
// production.pieces.assignKarigar unchanged by this phase ──
check('store.out: dispatch still denied (unaffected)', can('dispatch', 'production.store.out'), false);
check('store.out: store still allowed (unaffected)', can('store', 'production.store.out'), true);
check('karigars.write: dispatch still denied (unaffected)', can('dispatch', 'production.karigars.write'), false);
check('karigars.write: pm still denied (matches server requireAdmin, unaffected)', can('pm', 'production.karigars.write'), false);
check('karigars: dispatch still allowed VIEW (unaffected — different from the dashboard-only restriction)', can('dispatch', 'production.karigars'), true);

// ── Reports stays locked to EXACTLY the matrix's literal role list
// (super_admin, owner) — now a STRICT_MODULE so can()'s blanket admin bypass
// can never show admin a Reports page the new server-side callables
// (REPORTS_ROLES = ["super_admin","owner"]) would reject. ──
check('reports: super_admin allowed', can('super_admin', 'production.reports'), true);
check('reports: owner allowed', can('owner', 'production.reports'), true);
check('reports: admin denied (matrix omits admin; STRICT_MODULES prevents the blanket bypass from overriding that)', can('admin', 'production.reports'), false);
check('reports: pm denied', can('pm', 'production.reports'), false);
check('reports: dispatch denied', can('dispatch', 'production.reports'), false);

if (!pass) {
  console.error('ROLE PERMISSIONS DASHBOARDS REGRESSION TEST: FAIL');
  process.exitCode = 1;
} else {
  console.log(
    'ROLE PERMISSIONS DASHBOARDS REGRESSION TEST: PASS — production.storeOverview is exactly the 9 specified roles, ' +
    'production.labour.cost excludes every operational role from the dashboard labour-cost card while keeping ' +
    'super_admin/admin/owner/pm, and no pre-existing permission (store.out, karigars, karigars.write, reports) regressed.'
  );
}
