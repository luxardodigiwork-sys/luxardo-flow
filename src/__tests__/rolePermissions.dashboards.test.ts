/**
 * FOCUSED REGRESSION TEST — Final Role Dashboards & Reporting phase.
 * Covers the two new rolePermissions.ts modules added for this phase:
 *   - production.storeOverview (read-only Store Overview, cross-role)
 *   - production.labour.cost (dashboard-level AGGREGATE labour cost card)
 *
 * The labour.cost assertions below are deliberately the exact 11-role
 * visibility matrix for ProductionHomePage.tsx's single "Labour" KPI card
 * (super_admin/admin/owner/pm visible; dispatch/guard/tailor/store/designer/
 * accounts/analysis hidden) — a source-level guard (below) additionally
 * asserts that card exists EXACTLY ONCE in the dashboard and is gated by
 * showLabourCostCard, so a second, unconditional copy can never silently
 * reappear and leak aggregate labour cost to a role that shouldn't see it.
 *
 * Run: npx tsx src/__tests__/rolePermissions.dashboards.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { can } from '../utils/rolePermissions';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ── Source-level guard: ProductionHomePage.tsx's dashboard "Labour" KPI
// card must exist EXACTLY ONCE, and that one occurrence must be gated by
// showLabourCostCard — catches a second, unconditional copy of the card
// (the exact regression class this test was added to prevent) even
// without a browser. ──
{
  const dashboardSrc = fs.readFileSync(
    path.join(__dirname, '..', 'pages', 'production', 'ProductionHomePage.tsx'),
    'utf8',
  );
  const labourCardIndex = dashboardSrc.indexOf('label="Labour"');
  const secondOccurrence = labourCardIndex >= 0 ? dashboardSrc.indexOf('label="Labour"', labourCardIndex + 1) : -1;
  check('ProductionHomePage: exactly one label="Labour" KPI card exists', labourCardIndex >= 0 && secondOccurrence === -1, true);

  // The nearest preceding code must be the showLabourCostCard gate — if a
  // second, unconditional card were ever added back (or the gate removed
  // from this one), this immediately preceding window would no longer
  // contain it.
  const precedingWindow = labourCardIndex >= 0 ? dashboardSrc.slice(Math.max(0, labourCardIndex - 150), labourCardIndex) : '';
  check('ProductionHomePage: that card is immediately gated by showLabourCostCard', precedingWindow.includes('showLabourCostCard'), true);
}

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
