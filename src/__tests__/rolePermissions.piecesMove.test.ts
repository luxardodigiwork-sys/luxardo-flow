/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — 'production.pieces.move' RBAC mismatch fix.
 *
 * The backend callable recordPieceMovement (functions/src/pieces.ts,
 * PIECE_MANAGERS = ["admin", "owner", "pm"]) has only ever authorized
 * Admin, Owner and PM. The frontend MATRIX entry for 'production.pieces.move'
 * also granted 'dispatch' and 'guard', so PieceDetailPage's generic "Stage
 * Movement" panel (gated on this permission) showed those two roles an
 * action the server always rejects with
 * `permission-denied: "PM/Admin/Owner access required."` — e.g. Guard
 * attempting QC_PASS -> DISPATCH_READY via that panel. 'production.pieces.move'
 * is not a STRICT_MODULE, so admin/super_admin reach it via can()'s blanket
 * bypass rather than needing to be listed — mirrored below.
 *
 * Not wired into any test runner (the repo has none yet) — a standalone
 * script, mirroring the rolePermissions.med5.test.ts / pmViewAccess
 * .qcTailorStore.test.ts convention. can()/MATRIX are pure, dependency-free
 * functions (no Firebase, no emulator), so this runs directly via tsx.
 *
 * Run (from repo root):
 *   npx tsx src/__tests__/rolePermissions.piecesMove.test.ts
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

// ── The fix: dispatch/guard no longer granted the generic move panel ──────
check('guard denied "production.pieces.move" (fix — matches server PIECE_MANAGERS)', can("guard", "production.pieces.move" as any), false);
check('dispatch denied "production.pieces.move" (fix — matches server PIECE_MANAGERS)', can("dispatch", "production.pieces.move" as any), false);

// ── Roles that must remain allowed (PIECE_MANAGERS + the admin bypass) ────
check('pm still allowed "production.pieces.move"', can("pm", "production.pieces.move" as any), true);
check('admin still allowed "production.pieces.move"', can("admin", "production.pieces.move" as any), true);
check('owner still allowed "production.pieces.move"', can("owner", "production.pieces.move" as any), true);
check('super_admin still allowed "production.pieces.move"', can("super_admin", "production.pieces.move" as any), true);

// ── Non-regression: the roles' OWN dedicated action permissions are
// completely unaffected by tightening the generic move panel ──────────────
check('guard still allowed "production.qc.perform" (unaffected)', can("guard", "production.qc.perform" as any), true);
check('dispatch still allowed "production.dispatch.assignTailor" (unaffected)', can("dispatch", "production.dispatch.assignTailor" as any), true);
check('guard still allowed "production.pieces" (view permission, unaffected)', can("guard", "production.pieces" as any), true);
check('dispatch still allowed "production.pieces" (view permission, unaffected)', can("dispatch", "production.pieces" as any), true);

if (!pass) {
  console.error("PRODUCTION.PIECES.MOVE RBAC FIX REGRESSION TEST: FAIL");
  process.exitCode = 1;
} else {
  console.log(
    "PRODUCTION.PIECES.MOVE RBAC FIX REGRESSION TEST: PASS — guard and " +
    "dispatch no longer see the generic Stage Movement panel permission, " +
    "matching the server's PIECE_MANAGERS gate exactly, while PM/Admin/Owner" +
    "/Super Admin and every unrelated permission (qc.perform, " +
    "dispatch.assignTailor, the piece-view permission) are unaffected."
  );
}
