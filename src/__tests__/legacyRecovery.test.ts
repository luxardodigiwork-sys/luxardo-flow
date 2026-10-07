/**
 * TEMPORARY REGRESSION TEST — covers src/pages/production/legacyRecovery.ts,
 * the one-time PIECE-0001 QC_PASS -> DISPATCH_READY recovery gate.
 *
 * DELETE this file (and legacyRecovery.ts, and the recovery block in
 * PieceDetailPage.tsx) once PIECE-0001 has been recovered to DISPATCH_READY.
 *
 * Run: npx tsx src/__tests__/legacyRecovery.test.ts
 */
import { canRunLegacyRecovery } from '../pages/production/legacyRecovery';

let pass = true;
const fail = (msg: string) => { console.error(`FAIL: ${msg}`); pass = false; };
const check = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  else console.log(`OK  ${label} -> ${JSON.stringify(actual)}`);
};

const AUTHORIZED = ['super_admin', 'admin', 'owner', 'pm'];
const UNAUTHORIZED = ['dispatch', 'guard', 'tailor', 'store', 'designer', 'accounts', 'analysis', 'customer'];

// ── Authorized roles, correct piece, correct (legacy) stage -> true ──
for (const r of AUTHORIZED) {
  check(`"${r}" on PIECE-0001 at QC_PASS: allowed`, canRunLegacyRecovery(r, 'PIECE-0001', 'QC_PASS'), true);
}

// ── Unauthorized roles, correct piece, correct stage -> false ──
for (const r of UNAUTHORIZED) {
  check(`"${r}" on PIECE-0001 at QC_PASS: denied`, canRunLegacyRecovery(r, 'PIECE-0001', 'QC_PASS'), false);
}

// ── Wrong piece IDs: even an authorized role must never see this action
// on ANY piece other than the one legacy record it was built for ──
for (const r of AUTHORIZED) {
  check(`"${r}" on PIECE-0002 at QC_PASS: denied (wrong piece)`, canRunLegacyRecovery(r, 'PIECE-0002', 'QC_PASS'), false);
  check(`"${r}" on PIECE-9999 at QC_PASS: denied (wrong piece)`, canRunLegacyRecovery(r, 'PIECE-9999', 'QC_PASS'), false);
  check(`"${r}" on undefined pieceId: denied`, canRunLegacyRecovery(r, undefined, 'QC_PASS'), false);
}

// ── Repeated recovery is rejected safely: once PIECE-0001 is no longer at
// the legacy QC_PASS stage (i.e. the first recovery already succeeded, or
// it was never stuck there), the control must disappear on its own — this
// is what actually prevents a second click from ever reaching the backend
// a second time, since the piece's own re-fetched stage drives the gate ──
for (const r of AUTHORIZED) {
  check(`"${r}" on PIECE-0001 at DISPATCH_READY (already recovered): denied`, canRunLegacyRecovery(r, 'PIECE-0001', 'DISPATCH_READY'), false);
  check(`"${r}" on PIECE-0001 at OPEN: denied`, canRunLegacyRecovery(r, 'PIECE-0001', 'OPEN'), false);
  check(`"${r}" on PIECE-0001 at IN_WORK: denied`, canRunLegacyRecovery(r, 'PIECE-0001', 'IN_WORK'), false);
}

// ── Missing/empty role, role casing ──
check('empty role: denied', canRunLegacyRecovery('', 'PIECE-0001', 'QC_PASS'), false);
check('undefined role: denied', canRunLegacyRecovery(undefined, 'PIECE-0001', 'QC_PASS'), false);
check('null role: denied', canRunLegacyRecovery(null, 'PIECE-0001', 'QC_PASS'), false);
check('uppercase "OWNER": allowed (case-insensitive, matches can() convention)', canRunLegacyRecovery('OWNER', 'PIECE-0001', 'QC_PASS'), true);

if (!pass) {
  console.error('LEGACY RECOVERY REGRESSION TEST: FAIL');
  process.exitCode = 1;
} else {
  console.log(
    'LEGACY RECOVERY REGRESSION TEST: PASS — only super_admin/admin/owner/pm are allowed, only for PIECE-0001, ' +
    'only while it is still sitting at the legacy QC_PASS stage; every other role, piece, or stage is denied.'
  );
}
