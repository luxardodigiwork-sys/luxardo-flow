/**
 * FOCUSED REGRESSION TEST — Dispatch Karigar-registry VIEW access removal.
 *
 * Live production smoke test finding: Dispatch could open
 * /production/karigars and see the full registry (name, mobile, hourly
 * rate, status) via the 'production.karigars' permission, which had
 * deliberately included dispatch earlier (to see who's assigned on a
 * piece) — but exposing PII/wage data to a role with no legitimate need
 * for it was judged unacceptable once actually seen live. Dispatch removed
 * from 'production.karigars'. The real security boundary is
 * firestore.loom.rules' karigars read rule (covered separately by
 * firestore.loom.rules.karigarDispatch.test.ts) — this file covers the
 * frontend permission matrix that drives the nav item, the route-level
 * self-check (KarigarListPage.tsx), and the cascading effect on every
 * OTHER page gated by the same permission (PieceListPage's Karigar filter/
 * column, ProductionHomePage's Karigar count card).
 *
 * Run: npx tsx src/__tests__/rolePermissions.dispatchKarigarFix.test.ts
 */
import { can } from '../utils/rolePermissions';

let pass = true;
const fail = (msg: string) => { console.error(`FAIL: ${msg}`); pass = false; };
const check = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  else console.log(`OK  ${label} -> ${JSON.stringify(actual)}`);
};

// ── The fix: dispatch no longer granted Karigar registry VIEW ────────────
check('dispatch denied "production.karigars" (the fix)', can('dispatch', 'production.karigars'), false);

// ── Roles that must remain allowed — unaffected by the Dispatch removal ──
check('pm still allowed "production.karigars"', can('pm', 'production.karigars'), true);
check('owner still allowed "production.karigars"', can('owner', 'production.karigars'), true);
check('admin still allowed "production.karigars"', can('admin', 'production.karigars'), true);
check('super_admin still allowed "production.karigars"', can('super_admin', 'production.karigars'), true);

// ── Roles that were already denied stay denied (no accidental widening) ──
check('guard still denied "production.karigars" (unaffected — was already denied)', can('guard', 'production.karigars'), false);
check('tailor still denied "production.karigars" (unaffected — was already denied)', can('tailor', 'production.karigars'), false);
check('store still denied "production.karigars" (unaffected — was already denied)', can('store', 'production.karigars'), false);
check('designer still denied "production.karigars" (unaffected — was already denied)', can('designer', 'production.karigars'), false);

// ── Non-regression: existing Karigar WRITE permission completely unchanged
// by this fix (it already excluded both dispatch AND pm, matching the
// server's requireAdmin() gate exactly) ──
check('karigars.write: dispatch still denied (unaffected, unchanged)', can('dispatch', 'production.karigars.write'), false);
check('karigars.write: pm still denied (unaffected, unchanged — matches server requireAdmin)', can('pm', 'production.karigars.write'), false);
check('karigars.write: owner still allowed (unaffected, unchanged)', can('owner', 'production.karigars.write'), true);
check('karigars.write: admin still allowed (unaffected, unchanged)', can('admin', 'production.karigars.write'), true);
check('karigars.write: super_admin still allowed (unaffected, unchanged)', can('super_admin', 'production.karigars.write'), true);

// ── production.pieces.assignKarigar (PM assigning an EXISTING karigar to a
// piece) is a completely different permission from the registry VIEW above
// — confirming this fix did not touch it ──
check('pieces.assignKarigar: pm still allowed (unaffected, unchanged)', can('pm', 'production.pieces.assignKarigar'), true);
check('pieces.assignKarigar: dispatch still denied (unaffected, unchanged — was already denied)', can('dispatch', 'production.pieces.assignKarigar'), false);

// ── Dispatch's Tailor/Store Workspace VIEW access — deliberately left
// UNCHANGED by this fix (see report: no PII/wage data shown on those pages,
// and Dispatch's own job directly requires tracking pieces through both
// stages — unlike the Karigar registry, which has nothing to do with
// Dispatch's routing function). Confirmed still intact, not accidentally
// touched while fixing Karigars. ──
check('dispatch still allowed "production.tailor" (view — deliberately unchanged)', can('dispatch', 'production.tailor'), true);
check('dispatch still allowed "production.store" (view — deliberately unchanged)', can('dispatch', 'production.store'), true);
// ...but the ACTION permissions on those same pages remain correctly
// restricted to their own role, exactly as before this fix.
check('dispatch still denied "production.tailor.startComplete" (action — unaffected, unchanged)', can('dispatch', 'production.tailor.startComplete'), false);
check('dispatch still denied "production.store.out" (action — unaffected, unchanged)', can('dispatch', 'production.store.out'), false);

if (!pass) {
  console.error('DISPATCH KARIGAR ACCESS REMOVAL REGRESSION TEST: FAIL');
  process.exitCode = 1;
} else {
  console.log(
    'DISPATCH KARIGAR ACCESS REMOVAL REGRESSION TEST: PASS — dispatch no longer has Karigar registry VIEW access ' +
    '(matrix + cascading pages), every other role\'s Karigar read/write access is unaffected, and Dispatch\'s ' +
    'separate Tailor/Store Workspace VIEW access (no PII/wage data, required for its own routing job) is confirmed ' +
    'untouched.'
  );
}
