/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — locked rule: an OPEN/untouched piece must NOT be
 * manually moved to REWORK.
 *
 * Problem: recordRework (functions/src/pieces.ts) was a broad PM/Admin/Owner
 * correction mechanism usable from almost any active stage, but it never
 * checked whether the piece had actually had any production work done on it.
 * A piece fresh out of generation (stage OPEN, no Karigar ever assigned, no
 * labourStart ever called) could still be manually marked REWORK — nonsense,
 * since "redo the work" presupposes work happened at least once.
 *
 * Locked rule implemented (functions/src/pieces.ts's recordRework): reject
 * with failed-precondition when the piece has no `firstWorkAt`. firstWorkAt
 * is not a new field — it already exists on every piece doc and is set
 * EXACTLY ONCE, only by labourStart() (functions/src/labour.ts) the first
 * time a work session begins on that piece, and is never cleared or
 * backdated afterward. Because piece.stage is only ever set to "OPEN" at
 * piece creation/replacement and NEVER transitions back to it (see
 * NEXT_STAGES in pieces.ts), "no firstWorkAt" and "stage OPEN" are the same
 * condition in practice — this test checks the condition via the real
 * labourStart/labourStop flow rather than hard-coding stage "OPEN", so it
 * also covers any other stage a piece might reach without genuine work.
 *
 * This rule does NOT touch:
 *   - Guard-driven REWORK (guardQcPerform, functions/src/guardQc.ts) — a
 *     completely separate function/code path that never reads firstWorkAt
 *     at all. It only ever fires from QC_PENDING, which by construction
 *     always has prior work underneath. Scenario 3 below confirms it is
 *     wholly unaffected by this change, even on a piece seeded with no
 *     firstWorkAt.
 *   - recordRework's existing QC_PENDING-exclusive and already-REWORK
 *     preconditions (see pieces.med1.test.ts) — unchanged, and ordered
 *     before this new check so their error messages still take priority.
 *   - The MED-1 "locked rule: REWORK must never be reached with an open
 *     labour session underneath" check — unchanged (see
 *     labourSession.stageGuard.test.ts), and ordered after this new check.
 *
 * Scenarios:
 *   1. An OPEN/untouched piece (no firstWorkAt, never had labourStart
 *      called) -> recordRework rejected with failed-precondition; the piece
 *      document is completely unmutated and no movement/audit record is
 *      added.
 *   2. A piece that genuinely went through labourStart -> labourStop (real
 *      production work, now IN_WORK with firstWorkAt set) -> recordRework
 *      succeeds exactly as before (stage REWORK, status in_rework,
 *      reworkCount incremented).
 *   3. Guard-driven QC rework (guardQcPerform verdict REWORK) remains fully
 *      allowed and completely unaffected by this rule — tested even on a
 *      QC_PENDING piece with no firstWorkAt set, to prove the guard path
 *      genuinely does not depend on it.
 *   4. Existing lifecycle regression: a normal full cycle — labourStart ->
 *      labourStop -> recordRework -> labourStart (rework session) ->
 *      labourStop -> recordPieceMovement(QC_PENDING) — still completes
 *      end-to-end with correct totals, confirming the new check does not
 *      over-restrict a piece once it has genuine prior work.
 *
 * MUST be run against the Firestore emulator only — refuses to run if
 * FIRESTORE_EMULATOR_HOST is not set, so it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore --project demo-luxardo-test \
 *     "node lib/__tests__/pieceRework.untouchedGuard.test.js"
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
  const { labourStart, labourStop } = require("../labour");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { recordRework, recordPieceMovement } = require("../pieces");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { guardQcPerform } = require("../guardQc");

  const wrappedLabourStart = testEnv.wrap(labourStart);
  const wrappedLabourStop = testEnv.wrap(labourStop);
  const wrappedRework = testEnv.wrap(recordRework);
  const wrappedMovePiece = testEnv.wrap(recordPieceMovement);
  const wrappedGuardQc = testEnv.wrap(guardQcPerform);

  const runId = String(Date.now());
  let pass = true;
  const fail = (msg: string) => {
    console.error(`FAIL: ${msg}`);
    pass = false;
  };

  async function seedActor(role: string): Promise<string> {
    const uid = `test-${role}-${runId}-${Math.random().toString(36).slice(2, 8)}`;
    await db.doc(`staff/${uid}`).set({ role, active: true, displayName: `Test ${role}` });
    return uid;
  }

  async function seedKarigar(karigarId: string): Promise<void> {
    await db.doc(`karigars/${karigarId}`).set({
      id: karigarId, name: `Karigar ${karigarId}`, hourlyRate: 100, active: true,
    });
  }

  async function seedPiece(pieceId: string, stage: string, firstWorkAt: string | null = null): Promise<void> {
    await db.doc(`pieces/${pieceId}`).set({
      id: pieceId, stage, status: "active",
      prId: null, assignedKarigars: [], lastKarigarIds: [],
      totalLabourMinutes: 0, totalLabourCost: 0,
      qcVerdict: null, rejectionType: null, rejectionReason: null,
      reworkCount: 0, rejectedAt: null, rejectedBy: null, rejectedByName: null,
      firstWorkAt, lastWorkAt: null, replacedByPieceId: null,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    });
  }

  async function getPiece(pieceId: string): Promise<any> {
    const snap = await db.doc(`pieces/${pieceId}`).get();
    return snap.data();
  }

  async function countMovementAndAudit(pieceId: string): Promise<{ movements: number; audits: number }> {
    const movSnap = await db.collection("pieceMovementHistory").where("pieceId", "==", pieceId).get();
    const auditSnap = await db.collection("auditLogs").where("entityId", "==", pieceId).get();
    return { movements: movSnap.size, audits: auditSnap.size };
  }

  const pmUid = await seedActor("pm");

  // ── 1. OPEN/untouched piece -> REWORK rejected ──────────────────────────
  {
    const pieceId = `PIECE-UNTOUCHED-OPEN-${runId}`;
    await seedPiece(pieceId, "OPEN"); // firstWorkAt stays null — never touched
    const before = await getPiece(pieceId);
    const beforeCounts = await countMovementAndAudit(pieceId);

    try {
      await wrappedRework({ data: { pieceId, reason: "should be rejected" }, auth: { uid: pmUid, token: {} } });
      fail(`[1] expected recordRework to be rejected on an OPEN/untouched piece, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[1] OPEN/untouched recordRework rejected with code "${code}": ${err?.message ?? err}`);
      if (code !== "failed-precondition") fail(`[1] expected rejection code "failed-precondition", got "${code}".`);
    }

    const after = await getPiece(pieceId);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fail(`[1] expected the piece document to be completely unmutated after rejection.\n  before: ${JSON.stringify(before)}\n  after:  ${JSON.stringify(after)}`);
    }
    const afterCounts = await countMovementAndAudit(pieceId);
    if (afterCounts.movements !== beforeCounts.movements || afterCounts.audits !== beforeCounts.audits) {
      fail(`[1] expected no new movement/audit records for a rejected call, got movements ${beforeCounts.movements}->${afterCounts.movements}, audits ${beforeCounts.audits}->${afterCounts.audits}.`);
    }
  }

  // ── 2. Genuine IN_WORK (firstWorkAt set via real labourStart/labourStop)
  //      -> REWORK still allowed ───────────────────────────────────────────
  {
    const pieceId = `PIECE-REAL-INWORK-${runId}`;
    const karigarId = `KARIGAR-REAL-INWORK-${runId}`;
    await seedPiece(pieceId, "OPEN");
    await seedKarigar(karigarId);

    const startResult: any = await wrappedLabourStart({ data: { pieceId, karigarId }, auth: { uid: pmUid, token: {} } });
    await wrappedLabourStop({ data: { sessionId: startResult.sessionId }, auth: { uid: pmUid, token: {} } });

    const midPiece = await getPiece(pieceId);
    if (!midPiece?.firstWorkAt) fail(`[2] expected firstWorkAt to be set after labourStart/labourStop, got "${midPiece?.firstWorkAt}".`);

    try {
      await wrappedRework({ data: { pieceId, reason: "stitching defect found" }, auth: { uid: pmUid, token: {} } });
      const after = await getPiece(pieceId);
      console.log(`[2] genuine IN_WORK rework -> stage "${after?.stage}", status "${after?.status}", reworkCount ${after?.reworkCount}.`);
      if (after?.stage !== "REWORK") fail(`[2] expected stage REWORK, got "${after?.stage}".`);
      if (after?.status !== "in_rework") fail(`[2] expected status in_rework, got "${after?.status}".`);
      if (after?.reworkCount !== 1) fail(`[2] expected reworkCount 1, got ${after?.reworkCount}.`);
    } catch (err: any) {
      fail(`[2] expected recordRework to succeed on a piece with genuine prior work, but it threw: ${err?.code ?? err}`);
    }
  }

  // ── 3. Guard-driven QC rework remains allowed, unaffected — even on a
  //      QC_PENDING piece seeded with NO firstWorkAt ──────────────────────
  {
    const pieceId = `PIECE-GUARD-REWORK-${runId}`;
    const guardUid = await seedActor("guard");
    await seedPiece(pieceId, "QC_PENDING"); // firstWorkAt stays null, deliberately

    try {
      await wrappedGuardQc({ data: { pieceId, verdict: "REWORK", reason: "defect found at QC" }, auth: { uid: guardUid, token: {} } });
      const after = await getPiece(pieceId);
      console.log(`[3] guardQcPerform(REWORK) on no-firstWorkAt piece -> stage "${after?.stage}", status "${after?.status}".`);
      if (after?.stage !== "REWORK") fail(`[3] expected guardQcPerform(REWORK) to still succeed and set stage REWORK, got "${after?.stage}".`);
      if (after?.status !== "in_rework") fail(`[3] expected status in_rework, got "${after?.status}".`);
    } catch (err: any) {
      fail(`[3] expected guardQcPerform(REWORK) to remain completely unaffected by the firstWorkAt rule, but it threw: ${err?.code ?? err}`);
    }
  }

  // ── 4. Existing lifecycle regression: full cycle still works end-to-end ─
  {
    const pieceId = `PIECE-LIFECYCLE-${runId}`;
    const karigarId = `KARIGAR-LIFECYCLE-${runId}`;
    await seedPiece(pieceId, "OPEN");
    await seedKarigar(karigarId);

    try {
      const s1: any = await wrappedLabourStart({ data: { pieceId, karigarId }, auth: { uid: pmUid, token: {} } });
      await wrappedLabourStop({ data: { sessionId: s1.sessionId }, auth: { uid: pmUid, token: {} } });
      await wrappedRework({ data: { pieceId, reason: "needs redo" }, auth: { uid: pmUid, token: {} } });
      const s2: any = await wrappedLabourStart({ data: { pieceId, karigarId }, auth: { uid: pmUid, token: {} } });
      await wrappedLabourStop({ data: { sessionId: s2.sessionId }, auth: { uid: pmUid, token: {} } });
      await wrappedMovePiece({
        data: { pieceId, toStage: "QC_PENDING", action: "STAGE_MOVE", direction: "FORWARD" },
        auth: { uid: pmUid, token: {} },
      });
      const after = await getPiece(pieceId);
      console.log(`[4] full lifecycle (start->stop->rework->start->stop->QC_PENDING) -> final stage "${after?.stage}", reworkCount ${after?.reworkCount}.`);
      if (after?.stage !== "QC_PENDING") fail(`[4] expected final stage QC_PENDING, got "${after?.stage}".`);
      if (after?.reworkCount !== 1) fail(`[4] expected reworkCount 1, got ${after?.reworkCount}.`);
    } catch (err: any) {
      fail(`[4] expected the full existing lifecycle to still complete end-to-end, but it threw: ${err?.code ?? err}`);
    }
  }

  if (!pass) {
    console.error("PIECE REWORK UNTOUCHED-GUARD REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log(
    "PIECE REWORK UNTOUCHED-GUARD REGRESSION TEST: PASS — an OPEN/untouched " +
    "piece (no firstWorkAt) is correctly rejected by recordRework with no " +
    "mutation and no stray records, a piece with genuine prior work can " +
    "still be reworked, guard-driven QC rework remains completely " +
    "unaffected, and the full existing start/stop/rework/start/stop/move " +
    "lifecycle still completes end-to-end."
  );
}

main().catch((err) => {
  console.error("Piece rework untouched-guard regression test crashed:", err);
  process.exitCode = 1;
});
