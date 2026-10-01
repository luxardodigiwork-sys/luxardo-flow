/**
 * Pure, dependency-free piece-lifecycle constants shared by PieceDetailPage
 * and its tests. No React, no Firebase — same "pure" convention as
 * src/utils/rolePermissions.ts, so this can be unit-tested directly via tsx
 * without pulling in import.meta.env / Vite-only globals.
 */

/**
 * Legal forward stage transitions for the finalized Loom pipeline.
 * Linear production flow + rework loop + tailor branch. REJECTED is terminal.
 * The trusted backend callable (recordPieceMovement) is the authority on
 * validity; this map drives which forward moves the UI exposes.
 */
export const NEXT_STAGES: Record<string, string[]> = {
  OPEN: ['IN_WORK'],
  IN_WORK: ['QC_PENDING'],
  // QC_PENDING has no generic forward moves — verdicts (PASS/REWORK/COMPLETE_REJECT)
  // go exclusively through guardQcPerform (see the "Guard QC" panel below), matching
  // the backend's NEXT_STAGES in functions/src/pieces.ts.
  QC_PENDING: [],
  REWORK: ['IN_WORK'],
  // LOCKED BUSINESS RULE: a Guard PASS verdict now persists the piece
  // directly at DISPATCH_READY (guardQcPerform never leaves a piece resting
  // at QC_PASS). There is deliberately NO generic or dedicated UI move out
  // of QC_PASS for PM/Admin/Owner/Dispatch — keep this empty. (The backend's
  // own NEXT_STAGES.QC_PASS still technically allows a PIECE_MANAGERS-only
  // recordPieceMovement call, kept only as a non-routine recovery path for
  // any piece already at legacy QC_PASS from before this rule — never
  // surface that as a routine button here.)
  QC_PASS: [],
  DISPATCH_READY: ['TAILOR_ASSIGNED', 'STORE'],
  TAILOR_ASSIGNED: ['STITCHING'],
  STITCHING: ['STITCH_COMPLETE'],
  STITCH_COMPLETE: ['STORE'],
  STORE: ['STORE_OUT'],
  STORE_OUT: [],
  REJECTED: [],
};
