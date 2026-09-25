/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — MED-5 (rolePermissions.can() no longer bypasses
 * admin/super_admin for server-side "strict" single-role modules).
 *
 * Not wired into any test runner (the repo has none yet) — a standalone
 * script, mirroring the functions/src/__tests__ convention for a file that
 * needs one. can()/MATRIX are pure, dependency-free functions (no Firebase,
 * no emulator), so this runs directly via tsx with no setup.
 *
 * Run (from repo root):
 *   npx tsx src/__tests__/rolePermissions.med5.test.ts
 */
import { can, modulesFor } from "../utils/rolePermissions";

let pass = true;
const fail = (msg: string) => {
  console.error(`FAIL: ${msg}`);
  pass = false;
};
const check = (label: string, actual: boolean, expected: boolean) => {
  if (actual !== expected) {
    fail(`${label}: expected ${expected}, got ${actual}`);
  } else {
    console.log(`OK  ${label} -> ${actual}`);
  }
};

// ── The 7 modules whose server-side gate is a single non-elevated role ────
const STRICT_CASES: Array<{ mod: any; allowedRole: string }> = [
  { mod: "production.qc.perform", allowedRole: "guard" },
  { mod: "production.dispatch.assignTailor", allowedRole: "dispatch" },
  { mod: "production.dispatch.sendToStore", allowedRole: "dispatch" },
  { mod: "production.tailorRequests.raise", allowedRole: "dispatch" },
  { mod: "production.tailor.startComplete", allowedRole: "tailor" },
  { mod: "production.store.out", allowedRole: "store" },
  { mod: "production.store.out.issue", allowedRole: "store" },
];

for (const { mod, allowedRole } of STRICT_CASES) {
  check(`admin denied "${mod}" (matches server: no admin elevation)`, can("admin", mod), false);
  check(`super_admin denied "${mod}" (matches server: no admin elevation)`, can("super_admin", mod), false);
  check(`owner denied "${mod}" (not the allowed role)`, can("owner", mod), false);
  check(`"${allowedRole}" allowed "${mod}" (the actual server-allowed role)`, can(allowedRole, mod), true);
  check(`unrelated role "pm" denied "${mod}"`, can("pm", mod), false);
}

// ── Non-regression: admin/super_admin blanket access is UNCHANGED for
// every OTHER module, including production.tailorRequests.review (its
// server gate genuinely includes 'admin', so it must stay bypass-eligible) ──
const NON_STRICT_CASES: any[] = [
  "admin.settings",
  "production.designs.approve",
  "production.requests.approve",
  "production.labour.startStop",
  "production.pieces.reverse",
  "production.tailorRequests.review",
  "production.tailorRequests", // general view permission (dispatch/owner list) — admin still bypasses
];

for (const mod of NON_STRICT_CASES) {
  check(`admin still allowed "${mod}" (non-regression)`, can("admin", mod), true);
  check(`super_admin still allowed "${mod}" (non-regression)`, can("super_admin", mod), true);
}

// ── Unauthorized-role denial on NON-STRICT modules — this is the specific
// assertion that would catch a truthy-string-condition defect (e.g.
// `!STRICT_MODULES.has(mod) && ('admin')`, which is always true for any
// role on any non-strict module since the literal 'admin' is a truthy
// constant, not a comparison against `r`). Each case below pairs a role
// that is genuinely absent from that module's MATRIX list. ─────────────
const UNAUTHORIZED_ON_NON_STRICT: Array<{ mod: any; role: string }> = [
  { mod: "admin.settings", role: "customer" },              // ['super_admin','admin']
  { mod: "admin.settings", role: "dispatch" },
  { mod: "production.designs.approve", role: "dispatch" },  // ['super_admin','admin','owner']
  { mod: "production.designs.approve", role: "designer" },
  { mod: "production.labour.startStop", role: "guard" },    // ['super_admin','admin','owner','pm']
  { mod: "production.pieces.reverse", role: "pm" },         // ['super_admin','admin','owner']
  { mod: "production.requests.approve", role: "dispatch" }, // ['super_admin','admin','owner']
  { mod: "production.tailorRequests", role: "tailor" },     // ['dispatch','owner'] (+admin/super_admin bypass)
];
for (const { mod, role } of UNAUTHORIZED_ON_NON_STRICT) {
  check(`"${role}" denied "${mod}" (not in MATRIX list, non-strict module)`, can(role, mod), false);
}

// ── modulesFor() no longer lists strict modules for admin/super_admin ─────
const adminModules = modulesFor("admin");
for (const { mod } of STRICT_CASES) {
  check(`modulesFor("admin") no longer includes "${mod}"`, adminModules.includes(mod), false);
}
check(`modulesFor("admin") still includes "admin.settings" (non-regression)`, adminModules.includes("admin.settings" as any), true);

// ── No role / null / undefined always denied everywhere (unchanged) ───────
check(`can(null, ...) still denied`, can(null, "production.qc.perform"), false);
check(`can(undefined, ...) still denied`, can(undefined, "production.qc.perform"), false);
check(`can('', ...) still denied`, can("", "production.qc.perform"), false);

if (!pass) {
  console.error("MED-5 REGRESSION TEST: FAIL");
  process.exitCode = 1;
} else {
  console.log(
    "MED-5 REGRESSION TEST: PASS — admin/super_admin are now correctly " +
    "denied the 7 strict, server-exclusive modules, every other module's " +
    "existing admin/super_admin bypass is unchanged, and null/empty roles " +
    "remain denied everywhere."
  );
}
