/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — MED-1 (recordRework stage precondition).
 *
 * Not wired into any test runner (the repo has none yet) — same standalone,
 * emulator-only approach as the other functions/src/__tests__ scripts. NOT
 * exported from functions/src/index.ts, so it is never bundled/deployed.
 *
 * Established (not invented) preconditions, per PieceDetailPage.tsx's own
 * `!isClosed && !isReworked` gate and pieces.ts's own documented
 * QC_PENDING-is-guard-exclusive design:
 *   - recordRework must reject a QC_PENDING piece (Guard QC's exclusive
 *     domain for recording a REWORK verdict).
 *   - recordRework must reject a piece already at REWORK (matches the UI's
 *     own !isReworked gate, which already hides the action in this state).
 *   - Every OTHER active stage (OPEN, IN_WORK, QC_PASS, DISPATCH_READY,
 *     TAILOR_ASSIGNED, STITCHING, STITCH_COMPLETE, STORE) remains reworkable
 *     — this is a deliberately broad PM/Admin/Owner correction mechanism,
 *     not a single-predecessor transition, so this test also confirms a
 *     late-stage rework (from DISPATCH_READY) still succeeds unchanged.
 *
 * Scenarios:
 *   1. Rework from OPEN is rejected (Owner rule, Oct 2026); from IN_WORK succeeds.
 *   2. Valid rework from a late stage (DISPATCH_READY) still succeeds
 *      (confirms the fix did NOT over-restrict beyond the established rule).
 *   3. Invalid: QC_PENDING is rejected with failed-precondition, and the
 *      piece document is completely unmutated afterward.
 *   4. Invalid: an already-REWORK piece is rejected with failed-precondition,
 *      and the piece document is completely unmutated afterward.
 *
 * MUST be run against the Firestore emulator only — refuses to run if
 * FIRESTORE_EMULATOR_HOST is not set, so it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore --project demo-luxardo-test \
 *     "node lib/__tests__/pieces.med1.test.js"
 */
import * as admin from "firebase-admin";

async function main(): Promise<void> {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set — refusing to run against a real " +
      "project. Run this via `firebase emulators:exec --only firestore ...`."
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const testEnv = require("firebase-functions-test")({ projectId: "demo-luxardo-test" });

  admin.initializeApp();
  const db = admin.firestore();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { recordRework } = require("../pieces");
  const wrappedRework = testEnv.wrap(recordRework);

  const runId = String(Date.now());
  let pass = true;
  const fail = (msg: string) => {
    console.error(`FAIL: ${msg}`);
    pass = false;
  };

  async function seedActor(): Promise<string> {
    const uid = `test-pm-${runId}-${Math.random().toString(36).slice(2, 8)}`;
    await db.doc(`staff/${uid}`).set({ role: "pm", active: true, displayName: "Test PM" });
    return uid;
  }

  async function seedPiece(pieceId: string, stage: string, status: string): Promise<void> {
    await db.doc(`pieces/${pieceId}`).set({
      id: pieceId, stage, status,
      qcVerdict: null, rejectionType: null, rejectionReason: null,
      reworkCount: 0, rejectedAt: null, rejectedBy: null, rejectedByName: null,
      totalLabourMinutes: 0, totalLabourCost: 0,
      updatedAt: new Date(0).toISOString(),
    });
  }

  async function countMovementAndAudit(pieceId: string): Promise<{ movements: number; audits: number }> {
    const movSnap = await db.collection("pieceMovementHistory").where("pieceId", "==", pieceId).get();
    const auditSnap = await db.collection("auditLogs").where("entityId", "==", pieceId).get();
    return { movements: movSnap.size, audits: auditSnap.size };
  }

  // ── Scenario 1 (Owner rule, Oct 2026): rework from OPEN is REJECTED, and
  //    rework from IN_WORK (work actually started) still succeeds. ──────────
  {
    const uid = await seedActor();
    const pieceId = `PIECE-MED1TEST-OPEN-${runId}`;
    await seedPiece(pieceId, "OPEN", "active");
    try {
      await wrappedRework({ data: { pieceId, reason: "test rework from OPEN" }, auth: { uid, token: {} } });
      fail(`[1] expected recordRework to be rejected from OPEN, but it succeeded.`);
    } catch (err: any) {
      console.log(`[1] OPEN rework rejected with code "${err?.code}": ${err?.message}`);
      if (err?.code !== "failed-precondition") fail(`[1] expected failed-precondition, got ${err?.code ?? err}`);
    }
    const workedId = `PIECE-MED1TEST-INWORK-${runId}`;
    await seedPiece(workedId, "IN_WORK", "active");
    try {
      await wrappedRework({ data: { pieceId: workedId, reason: "test rework from IN_WORK" }, auth: { uid, token: {} } });
      const d = (await db.doc(`pieces/${workedId}`).get()).data();
      console.log(`[1b] IN_WORK rework -> stage now "${d?.stage}", status "${d?.status}", reworkCount ${d?.reworkCount}.`);
      if (d?.stage !== "REWORK") fail(`[1b] expected stage REWORK, got "${d?.stage}".`);
      if (d?.status !== "in_rework") fail(`[1b] expected status in_rework, got "${d?.status}".`);
      if (d?.reworkCount !== 1) fail(`[1b] expected reworkCount 1, got ${d?.reworkCount}.`);
    } catch (err: any) {
      fail(`[1b] expected recordRework to succeed from IN_WORK, but it threw: ${err?.code ?? err}`);
    }
  }

  // ── Scenario 2: valid rework from a LATE stage (DISPATCH_READY) ────────
  {
    const uid = await seedActor();
    const pieceId = `PIECE-MED1TEST-LATE-${runId}`;
    await seedPiece(pieceId, "DISPATCH_READY", "active");

    try {
      await wrappedRework({ data: { pieceId, reason: "test rework from DISPATCH_READY" }, auth: { uid, token: {} } });
      const snap = await db.doc(`pieces/${pieceId}`).get();
      const d = snap.data();
      console.log(`[2] DISPATCH_READY rework -> stage now "${d?.stage}".`);
      if (d?.stage !== "REWORK") {
        fail(`[2] expected late-stage rework (from DISPATCH_READY) to still succeed per the existing broad UI rule, got stage "${d?.stage}".`);
      }
    } catch (err: any) {
      fail(`[2] expected recordRework to still succeed from DISPATCH_READY (established broad behavior), but it threw: ${err?.code ?? err}`);
    }
  }

  // ── Scenario 3: invalid — QC_PENDING is guard-exclusive ────────────────
  {
    const uid = await seedActor();
    const pieceId = `PIECE-MED1TEST-QCPENDING-${runId}`;
    await seedPiece(pieceId, "QC_PENDING", "active");
    const before = (await db.doc(`pieces/${pieceId}`).get()).data();
    const beforeCounts = await countMovementAndAudit(pieceId);

    try {
      await wrappedRework({ data: { pieceId, reason: "should be rejected" }, auth: { uid, token: {} } });
      fail(`[3] expected recordRework to be rejected from QC_PENDING, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[3] QC_PENDING rework rejected with code "${code}": ${err?.message ?? err}`);
      if (code !== "failed-precondition") fail(`[3] expected rejection code "failed-precondition", got "${code}".`);
    }

    const after = (await db.doc(`pieces/${pieceId}`).get()).data();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fail(`[3] expected the piece document to be completely unmutated after rejection.\n  before: ${JSON.stringify(before)}\n  after:  ${JSON.stringify(after)}`);
    }
    const afterCounts = await countMovementAndAudit(pieceId);
    if (afterCounts.movements !== beforeCounts.movements || afterCounts.audits !== beforeCounts.audits) {
      fail(`[3] expected no new movement/audit records for a rejected call, got movements ${beforeCounts.movements}->${afterCounts.movements}, audits ${beforeCounts.audits}->${afterCounts.audits}.`);
    }
  }

  // ── Scenario 4: invalid — already in REWORK ────────────────────────────
  {
    const uid = await seedActor();
    const pieceId = `PIECE-MED1TEST-ALREADYREWORK-${runId}`;
    await seedPiece(pieceId, "REWORK", "in_rework");
    const before = (await db.doc(`pieces/${pieceId}`).get()).data();
    const beforeCounts = await countMovementAndAudit(pieceId);

    try {
      await wrappedRework({ data: { pieceId, reason: "should be rejected" }, auth: { uid, token: {} } });
      fail(`[4] expected recordRework to be rejected on an already-REWORK piece, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[4] already-REWORK rework rejected with code "${code}": ${err?.message ?? err}`);
      if (code !== "failed-precondition") fail(`[4] expected rejection code "failed-precondition", got "${code}".`);
    }

    const after = (await db.doc(`pieces/${pieceId}`).get()).data();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fail(`[4] expected the piece document to be completely unmutated after rejection.\n  before: ${JSON.stringify(before)}\n  after:  ${JSON.stringify(after)}`);
    }
    const afterCounts = await countMovementAndAudit(pieceId);
    if (afterCounts.movements !== beforeCounts.movements || afterCounts.audits !== beforeCounts.audits) {
      fail(`[4] expected no new movement/audit records for a rejected call, got movements ${beforeCounts.movements}->${afterCounts.movements}, audits ${beforeCounts.audits}->${afterCounts.audits}.`);
    }
  }

  if (!pass) {
    console.error("MED-1 REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log(
    "MED-1 REGRESSION TEST: PASS — valid rework (including from a late " +
    "stage) succeeds, QC_PENDING and already-REWORK are correctly rejected " +
    "with no piece mutation and no stray movement/audit records."
  );
}

main().catch((err) => {
  console.error("MED-1 regression test crashed:", err);
  process.exitCode = 1;
});
