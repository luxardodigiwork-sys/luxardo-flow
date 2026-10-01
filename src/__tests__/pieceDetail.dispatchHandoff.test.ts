/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — no PM/Admin/Owner/Dispatch routine handoff UI
 * remains after the locked business rule change (Guard QC PASS itself
 * transitions the piece straight to DISPATCH_READY; see guardQc.ts).
 *
 * Supersedes this file's earlier version, which tested the now-removed
 * dedicated "Move to Dispatch Ready" panel and its canShowMoveToDispatchReady()
 * predicate (both deleted from pieceLifecycle.ts / PieceDetailPage.tsx).
 *
 * NEXT_STAGES lives in the pure, dependency-free
 * src/pages/production/pieceLifecycle.ts module (no React, no Firebase —
 * PieceDetailPage.tsx imports from it too), same testing approach as
 * rolePermissions.piecesMove.test.ts. Absence of the removed UI/handler code
 * itself is verified separately via source removal + a build-bundle grep
 * (not expressible as a pure-function assertion), documented in the task's
 * final report.
 *
 * Run (from repo root):
 *   npx tsx src/__tests__/pieceDetail.dispatchHandoff.test.ts
 */
import { can } from "../utils/rolePermissions";
import { NEXT_STAGES } from "../pages/production/pieceLifecycle";

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

// ── No generic/dedicated forward move out of QC_PASS for ANY role: the
// Stage Movement panel's own transition table must have zero entries, since
// a piece should never normally rest at QC_PASS after this change, and no
// PM/Admin/Owner/Dispatch routine action should ever be offered for it ──────
check('NEXT_STAGES.QC_PASS has no forward moves (no routine handoff UI)', NEXT_STAGES.QC_PASS.length === 0, true);

// ── Non-regression: QC_PENDING's existing dedicated-action-only gate is
// unaffected by this change (Guard QC panel remains the only path there) ───
check('NEXT_STAGES.QC_PENDING still has no generic forward moves (unaffected)', NEXT_STAGES.QC_PENDING.length === 0, true);

// ── Non-regression: DISPATCH_READY's own Dispatch-eligible forward moves
// (TAILOR_ASSIGNED / STORE) are completely unaffected by this change —
// pieces reaching DISPATCH_READY via the new automatic PASS path flow into
// Dispatch's EXISTING workspace/actions exactly the same as before ─────────
check(
  'NEXT_STAGES.DISPATCH_READY still offers TAILOR_ASSIGNED/STORE (unaffected)',
  NEXT_STAGES.DISPATCH_READY.length === 2 &&
    NEXT_STAGES.DISPATCH_READY.includes("TAILOR_ASSIGNED") &&
    NEXT_STAGES.DISPATCH_READY.includes("STORE"),
  true
);

// ── No generic movement permission was added for Guard or Dispatch as part
// of this change — 'production.pieces.move' stays PM/Admin/Owner/Super Admin
// only, exactly as the prior RBAC fix (commit 3620cd4) left it ─────────────
check('guard still denied "production.pieces.move" (unaffected by this change)', can("guard", "production.pieces.move" as any), false);
check('dispatch still denied "production.pieces.move" (unaffected by this change)', can("dispatch", "production.pieces.move" as any), false);
check('pm still allowed "production.pieces.move" (unaffected)', can("pm", "production.pieces.move" as any), true);

// ── Guard's actual QC-performing permission is completely unaffected ───────
check('guard still allowed "production.qc.perform" (unaffected)', can("guard", "production.qc.perform" as any), true);
check('dispatch still denied "production.qc.perform" (unaffected — Guard-only verdict)', can("dispatch", "production.qc.perform" as any), false);
check('pm still denied "production.qc.perform" (unaffected — Guard-only verdict)', can("pm", "production.qc.perform" as any), false);

// ── Dispatch's own existing assignment/routing permissions are untouched ───
check('dispatch still allowed "production.dispatch.assignTailor" (unaffected)', can("dispatch", "production.dispatch.assignTailor" as any), true);
check('dispatch still allowed "production.dispatch.sendToStore" (unaffected)', can("dispatch", "production.dispatch.sendToStore" as any), true);

if (!pass) {
  console.error("NO ROUTINE DISPATCH HANDOFF UI REGRESSION TEST: FAIL");
  process.exitCode = 1;
} else {
  console.log(
    "NO ROUTINE DISPATCH HANDOFF UI REGRESSION TEST: PASS — QC_PASS has no " +
    "generic or dedicated forward move for any role (Guard PASS itself now " +
    "reaches DISPATCH_READY server-side), QC_PENDING and DISPATCH_READY's " +
    "own transitions are unaffected, and no generic movement or QC-perform " +
    "permission was added for Guard or Dispatch as a side effect."
  );
}
