/**
 * FOCUSED REGRESSION TEST — Loom Guide Tour (src/constants/guideTourSteps.ts,
 * src/utils/guideTour.ts).
 *
 * This is a pure-logic test (no DOM/jsdom, matching this repo's existing
 * src/__tests__/*.test.ts style — run via `npx tsx`). The actual
 * react-joyride rendering is NOT exercised here (no DOM test runner in this
 * repo); it's covered instead by the Loom Vite build + the 11-role navcheck
 * run (both performed alongside this test, see the session's report).
 *
 * What IS fully verifiable without a DOM, and is the most important safety
 * property of this feature, is checked here:
 *
 *   1. All 11 canonical roles have a GUIDE_TOUR_CONFIG entry with non-empty
 *      welcome/outro copy.
 *   2. RBAC SAFETY (the critical one): for every (role, navPath) pair that
 *      appears in GUIDE_TOUR_CONFIG, rolePermissions.ts's can() actually
 *      grants that role the permission module ProductionLayout.tsx gates
 *      that nav item behind. If this test fails, the static config
 *      references a link some role cannot actually see — i.e. exactly the
 *      "no tour step may expose an unauthorized control" failure mode.
 *      (Note: even if this static map ever drifted out of sync with
 *      ProductionLayout.tsx, runtime safety is still independently
 *      guaranteed by buildGuideTourSteps's visibleNavPaths filter, which
 *      uses ProductionLayout's own live, rendered nav list — scenario 3
 *      below tests that filter directly.)
 *   3. buildGuideTourSteps correctly drops a step whose navPath is not in
 *      the live visibleNavPaths list, AND a step whose DOM target doesn't
 *      exist — proving the defensive double-filter actually works.
 */
import { GUIDE_TOUR_CONFIG, GUIDE_TOUR_ROLES, type GuideTourRole } from '../constants/guideTourSteps';
import { buildGuideTourSteps, getTourStorageKey, hasTourBeenSeen, markTourSeen, type TourStorageLike } from '../utils/guideTour';
import { can } from '../utils/rolePermissions';

let pass = true;
const check = (desc: string, cond: boolean) => {
  if (cond) {
    console.log(`OK  ${desc}`);
  } else {
    console.error(`FAIL ${desc}`);
    pass = false;
  }
};

// ── 1. All 11 canonical roles present, with non-empty copy ───────────────
const CANONICAL_ROLES = [
  'owner', 'admin', 'super_admin', 'designer', 'pm',
  'dispatch', 'guard', 'tailor', 'store', 'accounts', 'analysis',
];
check('GUIDE_TOUR_ROLES has exactly 11 entries', GUIDE_TOUR_ROLES.length === 11);
check('GUIDE_TOUR_ROLES matches the canonical 11-role list exactly',
  CANONICAL_ROLES.every(r => (GUIDE_TOUR_ROLES as readonly string[]).includes(r)) &&
  GUIDE_TOUR_ROLES.every(r => CANONICAL_ROLES.includes(r)));

for (const role of GUIDE_TOUR_ROLES) {
  const cfg = GUIDE_TOUR_CONFIG[role];
  check(`${role}: has a config entry`, !!cfg);
  check(`${role}: welcomeTitle is non-empty`, !!cfg?.welcomeTitle?.trim());
  check(`${role}: welcomeBody is non-empty`, !!cfg?.welcomeBody?.trim());
  check(`${role}: outroBody is non-empty`, !!cfg?.outroBody?.trim());
  check(`${role}: steps is an array`, Array.isArray(cfg?.steps));
}

// ── 2. RBAC safety: every (role, navPath) step is actually can()-granted ──
// Mirrors ProductionLayout.tsx's item.show conditions exactly. Keep this in
// sync with that file — this test's whole purpose is to catch drift.
const NAV_PATH_CHECK: Record<string, (role: GuideTourRole) => boolean> = {
  '/production/staff': (r) => can(r, 'production.staff'),
  '/production/karigars': (r) => can(r, 'production.karigars'),
  '/production/designs': (r) => can(r, 'production.designs'),
  '/production/sample-designs': (r) => can(r, 'production.sampleDesigns'),
  '/production/sample-pieces': (r) => can(r, 'production.samplePieces'),
  '/production/requests': (r) => can(r, 'production.requests'),
  '/production/pieces': (r) => can(r, 'production.pieces'),
  '/production/qc': (r) => can(r, 'production.qc'),
  '/production/dispatch': (r) => can(r, 'production.dispatch.assignTailor'),
  '/production/tailor': (r) => can(r, 'production.tailor'),
  '/production/store': (r) => can(r, 'production.store') && can(r, 'production.pieces'),
  '/production/tailor-requests': (r) => can(r, 'production.tailorRequests.review'),
};

for (const role of GUIDE_TOUR_ROLES) {
  const cfg = GUIDE_TOUR_CONFIG[role];
  for (const step of cfg.steps) {
    const checker = NAV_PATH_CHECK[step.navPath];
    check(`${role}: step navPath "${step.navPath}" is a known, checkable nav path`, !!checker);
    if (checker) {
      check(`${role}: can() actually grants "${step.navPath}" (no unauthorized tour step)`, checker(role));
    }
    check(`${role}: step "${step.navPath}" has non-empty content`, !!step.content?.trim());
  }
}

// ── 3. buildGuideTourSteps defensive double-filter ────────────────────────
{
  const sampleConfig = {
    steps: [
      { navPath: '/production/pieces', content: 'A' },
      { navPath: '/production/qc', content: 'B' },
      { navPath: '/production/store', content: 'C' },
    ],
  };

  // 3a. A navPath missing from visibleNavPaths (simulating permission drift
  //     or a role that doesn't actually have this item) is dropped.
  const onlyPiecesVisible = buildGuideTourSteps(sampleConfig, ['/production/pieces'], () => true);
  check('buildGuideTourSteps: drops a step not in visibleNavPaths',
    onlyPiecesVisible.length === 1 && onlyPiecesVisible[0].navPath === '/production/pieces');

  // 3b. A navPath that IS visible but whose DOM element doesn't exist
  //     (hasElement returns false) is also dropped.
  const allVisibleButQcMissingFromDom = buildGuideTourSteps(
    sampleConfig,
    ['/production/pieces', '/production/qc', '/production/store'],
    (navPath) => navPath !== '/production/qc'
  );
  check('buildGuideTourSteps: drops a step whose DOM target does not exist',
    allVisibleButQcMissingFromDom.length === 2 &&
    allVisibleButQcMissingFromDom.every(s => s.navPath !== '/production/qc'));

  // 3c. Order and content are preserved for surviving steps.
  const allPass = buildGuideTourSteps(
    sampleConfig,
    ['/production/pieces', '/production/qc', '/production/store'],
    () => true
  );
  check('buildGuideTourSteps: preserves order and content when nothing is filtered',
    allPass.length === 3 &&
    allPass[0].navPath === '/production/pieces' && allPass[0].content === 'A' &&
    allPass[1].navPath === '/production/qc' && allPass[1].content === 'B' &&
    allPass[2].navPath === '/production/store' && allPass[2].content === 'C');

  // 3d. Nothing visible -> empty result, not a crash.
  const nothingVisible = buildGuideTourSteps(sampleConfig, [], () => true);
  check('buildGuideTourSteps: returns an empty array when nothing is visible', nothingVisible.length === 0);
}

// ── 4. Storage helpers (fake storage, no real localStorage needed) ───────
{
  class FakeStorage implements TourStorageLike {
    private map = new Map<string, string>();
    getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
    setItem(key: string, value: string) { this.map.set(key, value); }
  }
  const storage = new FakeStorage();
  check('hasTourBeenSeen: false before anything is marked', hasTourBeenSeen('owner', storage) === false);
  markTourSeen('owner', storage);
  check('hasTourBeenSeen: true after marking', hasTourBeenSeen('owner', storage) === true);
  check('hasTourBeenSeen: unaffected for a different role', hasTourBeenSeen('guard', storage) === false);
  check('getTourStorageKey: role-scoped and versioned', getTourStorageKey('owner') !== getTourStorageKey('guard') && getTourStorageKey('owner').includes('owner'));

  // A storage whose getItem/setItem throw (private-mode Safari style) must
  // never crash the caller — both helpers fail closed to "not seen".
  class ThrowingStorage implements TourStorageLike {
    getItem(): string { throw new Error('blocked'); }
    setItem(): void { throw new Error('blocked'); }
  }
  const throwing = new ThrowingStorage();
  check('hasTourBeenSeen: fails closed (false) when storage throws', hasTourBeenSeen('owner', throwing) === false);
  let markThrew = false;
  try { markTourSeen('owner', throwing); } catch { markThrew = true; }
  check('markTourSeen: never throws even when storage throws', markThrew === false);
}

if (!pass) {
  console.error('GUIDE TOUR CONFIG REGRESSION TEST: FAIL');
  process.exitCode = 1;
} else {
  console.log(
    'GUIDE TOUR CONFIG REGRESSION TEST: PASS — all 11 canonical roles have a ' +
    'complete config, every configured tour step is actually can()-granted ' +
    'for its role (no unauthorized link exposure), the defensive ' +
    'visible+DOM-exists double-filter correctly drops unsafe/missing steps ' +
    'while preserving order for the rest, and the storage helpers fail ' +
    'closed when storage is unavailable.'
  );
}
