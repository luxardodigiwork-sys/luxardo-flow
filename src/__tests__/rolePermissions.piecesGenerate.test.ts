/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — production.pieces.generate RBAC fix.
 *
 * Verifies:
 *  1. production.pieces.generate is allowed ONLY for super_admin/admin/owner/pm
 *  2. production.pieces.generate is denied for dispatch/guard/tailor/store/designer/accounts/analysis
 *  3. production.pieces (VIEW) still grants access to dispatch (and the other widened roles)
 *  4. production.pieces (VIEW) remains granted to super_admin/admin/owner/pm
 *
 * Run (from repo root):
 *   npx tsx src/__tests__/rolePermissions.piecesGenerate.test.ts
 */
import { can } from "../utils/rolePermissions";

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

// ── 1. production.pieces.generate: allowed ONLY for super_admin/admin/owner/pm ──
const GENERATE_ALLOWED: string[] = ["super_admin", "admin", "owner", "pm"];
for (const role of GENERATE_ALLOWED) {
  check(
    `"${role}" ALLOWED production.pieces.generate`,
    can(role as any, "production.pieces.generate" as any),
    true,
  );
}

// ── 2. production.pieces.generate: denied for all other roles ──
const GENERATE_DENIED: string[] = [
  "dispatch",
  "guard",
  "tailor",
  "store",
  "designer",
  "accounts",
  "analysis",
];
for (const role of GENERATE_DENIED) {
  check(
    `"${role}" DENIED production.pieces.generate`,
    can(role as any, "production.pieces.generate" as any),
    false,
  );
}

// ── 3. production.pieces (VIEW): dispatch still has access ──
check(
  `"dispatch" ALLOWED production.pieces (VIEW — non-regression)`,
  can("dispatch" as any, "production.pieces" as any),
  true,
);

// ── 4. production.pieces (VIEW): all widened roles have access ──
const VIEW_ALLOWED: string[] = [
  "super_admin",
  "admin",
  "owner",
  "pm",
  "dispatch",
  "guard",
  "tailor",
  "store",
];
for (const role of VIEW_ALLOWED) {
  check(
    `"${role}" ALLOWED production.pieces (VIEW)`,
    can(role as any, "production.pieces" as any),
    true,
  );
}

// ── 5. production.pieces (VIEW): roles NOT in the list are still denied ──
const VIEW_DENIED: string[] = ["designer", "accounts", "analysis"];
for (const role of VIEW_DENIED) {
  check(
    `"${role}" DENIED production.pieces (VIEW)`,
    can(role as any, "production.pieces" as any),
    false,
  );
}

if (!pass) {
  console.error("\nproduction.pieces.generate REGRESSION TEST: FAIL");
  process.exitCode = 1;
} else {
  console.log(
    "\nproduction.pieces.generate REGRESSION TEST: PASS — " +
      "generate is restricted to super_admin/admin/owner/pm, " +
      "VIEW (production.pieces) correctly includes dispatch/guard/tailor/store, " +
      "and designer/accounts/analysis remain denied on both.",
  );
}
