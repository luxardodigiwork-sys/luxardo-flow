// Expected role × route matrix — built ONLY from repository evidence.
// Every claim below cites the exact source file/lines it came from. Where
// the repository does not explicitly establish a permission or a route-level
// gate, this file records UNKNOWN rather than guessing — per the task's
// explicit "do not invent permissions" requirement.
//
// Sources read for this matrix (read-only, as of authoring this framework):
//   - src/utils/rolePermissions.ts   (MATRIX, STRICT_MODULES, can())
//   - src/utils/loomIdentity.ts      (CANONICAL_STAFF_ROLES, isStaffRoleOrSuperAdmin)
//   - src/components/production/ProtectedProductionRoute.tsx  (the ONLY
//     route-level guard applied to every /production/* route)
//   - src/pages/production/StaffManagementPage.tsx  (redirects via
//     <Navigate> when denied — a REDIRECTED-class page-level gate)
//   - src/pages/production/DispatchWorkspacePage.tsx,
//     GuardQcWorkspacePage.tsx, PieceListPage.tsx, StoreWorkspacePage.tsx,
//     TailorWorkspacePage.tsx, TailorRequestReviewPage.tsx (each renders an
//     in-page "You do not have permission..." block instead of navigating
//     away when denied — a DENIED-class page-level gate, same net effect as
//     a redirect but staying on the requested URL; an initial audit pass
//     missed these six and treated them as ungated, which produced a false
//     DENIED-vs-ALLOWED mismatch for pm @ /production/dispatch — corrected
//     below in ROUTE_LEVEL_GATES)
//   - grep for `can(` and `<Navigate` across src/pages/production/*.tsx
//     (confirms these seven pages are the only ones with a page-level
//     access gate; every other can() call there only toggles individual
//     buttons/controls, not page-level access)

export const ROLES = [
  'super_admin', 'admin', 'owner',
  'designer', 'pm', 'dispatch', 'guard', 'tailor', 'store', 'accounts', 'analysis',
];

// KEY FINDING (source-backed): ProtectedProductionRoute
// (src/components/production/ProtectedProductionRoute.tsx:29-59) is the ONLY
// gate applied to the /production/* route tree itself. It allows through any
// identity for which isStaffRoleOrSuperAdmin(user.staffRole) is true — i.e.
// ANY of the 11 roles above, once resolved via AuthContext — and otherwise
// redirects to /login. It does NOT check which specific role it is; per its
// own comment, "per-page role checks are done inside each page using can()
// ... and every write is re-checked server-side."
//
// So, with SEVEN exceptions (production/staff, plus the six pages listed
// above), the source does not establish that any of these 19 routes
// redirects/denies a specific role at the ROUTE level. What differs per role
// on most OTHER pages is which in-page CONTROLS (create/write/approve/
// assign/etc. buttons) render — a UI-level difference, not a page-access
// difference. Per the task's own instruction ("UI visibility alone must not
// be treated as proof of authorization" / "Do not infer authorization from
// sidebar visibility alone"), this file does NOT translate a plain
// button-level can() check into a route-level ALLOWED/DENIED claim — those
// stay recorded separately as "moduleHints" for context, explicitly labeled
// as control-visibility, not access control. The seven exceptions are
// different in kind: each is a can() check that gates rendering of the
// ENTIRE page (an early `if (!canX) return <denied UI or Navigate>`, before
// any other content), which IS a page-access decision, not a control
// visibility one — so those seven are promoted into ROUTE_LEVEL_GATES below.
export const STATIC_ROUTES = [
  { path: '/production', label: 'Production Dashboard (index)', pageFile: 'src/pages/production/ProductionHomePage.tsx' },
  { path: '/production/staff', label: 'Staff Management', pageFile: 'src/pages/production/StaffManagementPage.tsx' },
  { path: '/production/profile', label: 'Profile (own)', pageFile: 'src/pages/production/UserProfilePage.tsx' },
  { path: '/production/karigars', label: 'Karigars list', pageFile: 'src/pages/production/KarigarListPage.tsx' },
  { path: '/production/karigars/new', label: 'Karigar create form', pageFile: 'src/pages/production/KarigarCreatePage.tsx' },
  { path: '/production/designs', label: 'Catalogue Designs list', pageFile: 'src/pages/production/DesignListPage.tsx' },
  { path: '/production/designs/new', label: 'Catalogue Design create form', pageFile: 'src/pages/production/DesignCreatePage.tsx' },
  { path: '/production/sample-designs', label: 'Sample Designs list', pageFile: 'src/pages/production/SampleDesignListPage.tsx' },
  { path: '/production/sample-designs/new', label: 'Sample Design create form', pageFile: 'src/pages/production/SampleDesignCreatePage.tsx' },
  { path: '/production/sample-pieces', label: 'Sample Pieces list', pageFile: 'src/pages/production/SamplePieceListPage.tsx' },
  { path: '/production/sample-pieces/new', label: 'Sample Piece create form', pageFile: 'src/pages/production/SamplePieceCreatePage.tsx' },
  { path: '/production/requests', label: 'Production Requests / Work Orders list', pageFile: 'src/pages/production/ProductionRequestListPage.tsx' },
  { path: '/production/requests/new', label: 'Production Request create form', pageFile: 'src/pages/production/ProductionRequestCreatePage.tsx' },
  { path: '/production/pieces', label: 'Production Pieces list', pageFile: 'src/pages/production/PieceListPage.tsx' },
  { path: '/production/qc', label: 'Guard QC workspace', pageFile: 'src/pages/production/GuardQcWorkspacePage.tsx' },
  { path: '/production/dispatch', label: 'Dispatch workspace', pageFile: 'src/pages/production/DispatchWorkspacePage.tsx' },
  { path: '/production/tailor', label: 'Tailor workspace', pageFile: 'src/pages/production/TailorWorkspacePage.tsx' },
  { path: '/production/store', label: 'Store / Store-Out workspace', pageFile: 'src/pages/production/StoreWorkspacePage.tsx' },
  { path: '/production/tailor-requests', label: 'Tailor Requests review', pageFile: 'src/pages/production/TailorRequestReviewPage.tsx' },
];

// Seven route-level exceptions found in source. Each is an early, whole-page
// `if (!can(...)) return <...>` BEFORE any other content renders — a
// page-access decision, not a button-visibility one. `deniedResult` records
// which shape the denial takes: StaffManagementPage does a client-side
// <Navigate> (the audit script observes this as REDIRECTED, since the final
// URL differs from the requested one); the other six instead render an
// in-page "You do not have permission..." block and stay on the requested
// URL (the audit script observes this as DENIED, via its DENIAL_UI_TEXT
// marker check). allowedRoles is derived from MATRIX[module] plus can()'s
// blanket super_admin/admin bypass — EXCEPT where the module (or, for
// /production/dispatch, every one of the OR'd modules) is in STRICT_MODULES,
// which disables that bypass; each entry below states which case applies.
export const ROUTE_LEVEL_GATES = {
  '/production/staff': {
    module: 'production.staff',
    allowedRoles: ['super_admin', 'admin', 'owner'], // MATRIX['production.staff'] + can()'s bypass, same result
    deniedResult: 'REDIRECTED',
    deniedBehavior: 'Client-side <Navigate to="/production" replace /> — no error UI, just silently returns to the dashboard.',
    source: 'src/pages/production/StaffManagementPage.tsx:26,75; src/utils/rolePermissions.ts:166,199-205',
  },
  '/production/dispatch': {
    module: "production.dispatch.assignTailor OR production.dispatch.sendToStore OR production.tailorRequests.raise",
    // All three are STRICT_MODULES (src/utils/rolePermissions.ts:184-192),
    // each mapped to MATRIX = ['dispatch'] only (lines 147,148,152) — no
    // admin/super_admin bypass applies to any of them. The page renders if
    // ANY of the three is true, so the union is still just ['dispatch'].
    allowedRoles: ['dispatch'],
    deniedResult: 'DENIED',
    deniedBehavior: 'In-page block, same URL: "You do not have permission to access the Dispatch workspace."',
    source: 'src/pages/production/DispatchWorkspacePage.tsx:20-22,114-120; src/utils/rolePermissions.ts:147,148,152,184-192',
  },
  '/production/qc': {
    module: 'production.qc',
    // Not in STRICT_MODULES (only production.qc.perform is) — bypass applies, though
    // super_admin/admin are already listed explicitly in MATRIX['production.qc'].
    allowedRoles: ['super_admin', 'admin', 'owner', 'pm', 'dispatch', 'guard'],
    deniedResult: 'DENIED',
    deniedBehavior: 'In-page block, same URL: "You do not have permission to access the Guard QC workspace."',
    source: 'src/pages/production/GuardQcWorkspacePage.tsx:33,69-75; src/utils/rolePermissions.ts:142',
  },
  '/production/pieces': {
    module: 'production.pieces',
    allowedRoles: ['super_admin', 'admin', 'owner', 'pm', 'dispatch', 'guard', 'tailor', 'store'],
    deniedResult: 'DENIED',
    deniedBehavior: 'In-page block, same URL: "You do not have permission to view production pieces."',
    source: 'src/pages/production/PieceListPage.tsx:57,107-113; src/utils/rolePermissions.ts:133',
  },
  '/production/store': {
    module: 'production.store',
    allowedRoles: ['super_admin', 'admin', 'owner', 'designer', 'pm', 'dispatch', 'store'],
    deniedResult: 'DENIED',
    deniedBehavior: 'In-page block, same URL: "You do not have permission to access the Store workspace."',
    source: 'src/pages/production/StoreWorkspacePage.tsx:19,99-105; src/utils/rolePermissions.ts:159',
  },
  '/production/tailor': {
    module: 'production.tailor',
    allowedRoles: ['super_admin', 'admin', 'owner', 'pm', 'dispatch', 'tailor'],
    deniedResult: 'DENIED',
    deniedBehavior: 'In-page block, same URL: "You do not have permission to access the Tailor workspace."',
    source: 'src/pages/production/TailorWorkspacePage.tsx:17,88-94; src/utils/rolePermissions.ts:154',
  },
  '/production/tailor-requests': {
    module: 'production.tailorRequests.review',
    // Deliberately NOT in STRICT_MODULES (rolePermissions.ts:180-182 comment:
    // its server gate genuinely includes 'admin') — bypass applies, adding
    // super_admin/admin on top of MATRIX's literal ['owner'].
    allowedRoles: ['super_admin', 'admin', 'owner'],
    deniedResult: 'DENIED',
    deniedBehavior: 'In-page block, same URL: "You do not have permission to review Tailor requests."',
    source: 'src/pages/production/TailorRequestReviewPage.tsx:18,72-78; src/utils/rolePermissions.ts:151,153,180-182',
  },
};

// In-page CONTROL visibility hints (NOT route access). Recorded for context
// only — per the task's own instruction, this framework must not treat a
// visible/hidden control as proof of authorization. Real enforcement for
// every one of these actions is also re-checked server-side (Cloud
// Functions / firestore.loom.rules), which this client-only framework does
// not inspect. Note: for the six routes that also appear in
// ROUTE_LEVEL_GATES above, the FIRST module listed here is the one that
// gates the whole page (already asserted as ALLOWED/DENIED there); any
// additional modules listed for that route remain plain control-visibility
// hints on top of that page-access gate.
export const MODULE_HINTS_BY_ROUTE = {
  '/production': ['production.staff', 'admin.dashboard', 'production.designs', 'production.sampleDesigns', 'production.samplePieces', 'production.pieces', 'production.requests', 'production.karigars'],
  '/production/designs': ['production.designs.write'],
  '/production/designs/new': [], // no can() call found — UNKNOWN whether any role sees an access-denied state here
  '/production/sample-designs': ['production.sampleDesigns.write'],
  '/production/sample-designs/new': [], // no can() call found in SampleDesignDetailPage's list counterpart's create page
  '/production/sample-pieces': ['production.samplePieces.write'],
  '/production/sample-pieces/new': [],
  '/production/requests': ['production.requests'],
  '/production/requests/new': [], // ProductionRequestCreatePage.tsx: no can() call found by grep
  '/production/pieces': ['production.pieces', 'production.karigars'],
  '/production/qc': ['production.qc.perform', 'production.karigars'],
  '/production/dispatch': ['production.dispatch.assignTailor', 'production.dispatch.sendToStore', 'production.tailorRequests.raise'],
  '/production/tailor': ['production.tailor.startComplete'],
  '/production/store': ['production.store.out', 'production.store.out.issue'],
  '/production/tailor-requests': ['production.tailorRequests.review'],
  '/production/karigars': [], // KarigarListPage.tsx: no can() call found by grep
  '/production/karigars/new': [], // KarigarCreatePage.tsx: no can() call found by grep
  '/production/profile': ['production.staff'], // isAdminViewer flag only — viewing OWN profile has no can() gate found
};

/**
 * Returns the expected outcome for a role visiting a route, based ONLY on
 * source evidence above. Never invents a DENIED verdict without a citation.
 */
export function expectedOutcome(role, routePath) {
  const r = String(role || '').toLowerCase();
  if (!ROLES.includes(r)) {
    return { expected: 'UNKNOWN', reason: `"${role}" is not one of the 11 roles established in src/utils/loomIdentity.ts / rolePermissions.ts.` };
  }

  const gate = ROUTE_LEVEL_GATES[routePath];
  if (gate) {
    const allowed = gate.allowedRoles.includes(r);
    return {
      expected: allowed ? 'ALLOWED' : gate.deniedResult,
      reason: allowed
        ? `${r} passes this page's in-page permission gate (module: ${gate.module}; allowed roles: ${gate.allowedRoles.join(', ')}). Source: ${gate.source}`
        : `${r} is not in this page's allowed roles (module: ${gate.module}; allowed roles: ${gate.allowedRoles.join(', ')}). Expected: ${gate.deniedBehavior} Source: ${gate.source}`,
    };
  }

  // No route-level gate found for this route in source — ProtectedProductionRoute
  // admits any of the 11 roles without a per-role check (see file header).
  return {
    expected: 'ALLOWED',
    reason:
      'No page-level role redirect was found in source for this route (only ProtectedProductionRoute\'s ' +
      'generic "is this any valid staff/super_admin identity" check applies). Expected: the page itself ' +
      'loads for every one of the 11 roles. Which in-page CONTROLS render differs per role — see ' +
      'MODULE_HINTS_BY_ROUTE for the relevant can() modules — but that is a control-visibility fact, not an ' +
      'access-control verdict, and is not asserted as ALLOWED/DENIED here.',
  };
}
