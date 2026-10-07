/**
 * TEMPORARY, ONE-TIME legacy data recovery for PIECE-0001 ONLY.
 *
 * PIECE-0001 predates the commit that made Guard QC PASS hand off directly
 * to DISPATCH_READY (see guardQc.ts) — it is a legacy record resting at the
 * now-unreachable QC_PASS stage with no routine forward move. This module
 * exists only to gate a temporary Piece Detail UI control that recovers
 * that one specific piece via the existing, already-tested
 * recordPieceMovement(QC_PASS -> DISPATCH_READY, action: LEGACY_RECOVERY)
 * path (functions/src/pieces.ts, PIECE_MANAGERS-only). No new backend
 * logic, no new state machine — this is a UX gate only, matching this
 * file's own established pattern of frontend guards backed by a server
 * that re-checks everything (pieceLifecycle.ts).
 *
 * DELETE this file and its import/usage in PieceDetailPage.tsx once
 * PIECE-0001 has been recovered to DISPATCH_READY.
 */
export const LEGACY_RECOVERY_PIECE_ID = 'PIECE-0001';
export const LEGACY_RECOVERY_SOURCE_STAGE = 'QC_PASS';
export const LEGACY_RECOVERY_TARGET_STAGE = 'DISPATCH_READY';
export const LEGACY_RECOVERY_ACTION = 'LEGACY_RECOVERY';

const LEGACY_RECOVERY_ROLES = ['super_admin', 'admin', 'owner', 'pm'];

/**
 * True only when ALL of: the role is super_admin/admin/owner/pm, the piece
 * is literally PIECE-0001 (no other piece may ever use this control), and
 * the piece is still sitting at the legacy QC_PASS stage (so the control
 * disappears the instant the recovery succeeds — the piece's own stage,
 * re-read from Firestore, is what prevents a repeat, not extra state).
 */
export function canRunLegacyRecovery(
  role: string | undefined | null,
  pieceId: string | undefined | null,
  stage: string | undefined | null,
): boolean {
  if (!role) return false;
  if (pieceId !== LEGACY_RECOVERY_PIECE_ID) return false;
  if (stage !== LEGACY_RECOVERY_SOURCE_STAGE) return false;
  return LEGACY_RECOVERY_ROLES.includes(String(role).toLowerCase());
}
