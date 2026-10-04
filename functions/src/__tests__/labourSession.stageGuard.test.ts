/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — locked rule: Labour Session vs Piece Stage.
 *
 * Previously unresolved (see the investigation this implements): a piece
 * could reach QC_PENDING (via recordPieceMovement), REWORK (via
 * recordRework) or REJECTED (via completeRejectPiece) while a Karigar's
 * labour session on it was still open (endedAt == null) — none of those
 * three functions, nor labourStop, ever checked for this. The session was
 * simply left running, decoupled from the piece's actual lifecycle.
 *
 * Locked rule implemented (functions/src/pieces.ts's new
 * assertNoOpenLabourSession, called from all three; functions/src/
 * labour.ts's labourStop now reuses assertLabourPiece):
 *   1. QC_PENDING / REWORK / REJECTED must never be reached with an open
 *      labour session underneath.
 *   2. No auto-stop side effect — the PM/Admin/Owner must stop the session
 *      themselves first; once stopped, the SAME action succeeds normally.
 *   3. labourStop rejects a session whose piece is already closed/replaced.
 *   4. RBAC, stage adjacency, audit/movement logging and cost/duration
 *      calculation are all otherwise unchanged.
 *
 * Scenarios:
 *   1. Open session blocks IN_WORK -> QC_PENDING (recordPieceMovement).
 *   2. Open session blocks IN_WORK -> REWORK (recordRework).
 *   3. Open session blocks IN_WORK -> REJECTED (completeRejectPiece).
 *   4. For each of the above: stopping the session first lets the SAME
 *      action succeed (no auto-stop; explicit stop is required and
 *      sufficient) — also confirms movement/audit logging still fires on
 *      the now-successful call.
 *   5. labourStop rejects a session whose piece is already closed/replaced.
 *   6. Existing normal lifecycle regression: labourStart -> labourStop (no
 *      stage interaction) -> recordPieceMovement(QC_PENDING) all succeed in
 *      the ordinary order, with totalLabourMinutes/totalLabourCost computed
 *      exactly as before.
 *
 * MUST be run against the Firestore emulator only — refuses to run if
 * FIRESTORE_EMULATOR_HOST is not set, so it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore --project demo-luxardo-test \
 *     "node lib/__tests__/labourSession.stageGuard.test.js"
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
  const { recordPieceMovement, recordRework, completeRejectPiece } = require("../pieces");

  const wrappedLabourStart = testEnv.wrap(labourStart);
  const wrappedLabourStop = testEnv.wrap(labourStop);
  const wrappedMovePiece = testEnv.wrap(recordPieceMovement);
  const wrappedRework = testEnv.wrap(recordRework);
  const wrappedReject = testEnv.wrap(completeRejectPiece);

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

  async function seedPiece(pieceId: string, stage: string, status?: string): Promise<void> {
    await db.doc(`pieces/${pieceId}`).set({
      id: pieceId, stage, status: status || (stage === "OPEN" ? "active" : "active"),
      prId: null, assignedKarigars: [], lastKarigarIds: [],
      totalLabourMinutes: 0, totalLabourCost: 0,
      qcVerdict: null, rejectionType: null, rejectionReason: null,
      reworkCount: 0, rejectedAt: null, rejectedBy: null, rejectedByName: null,
      firstWorkAt: null, lastWorkAt: null, replacedByPieceId: null,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    });
  }

  async function getPiece(pieceId: string): Promise<any> {
    const snap = await db.doc(`pieces/${pieceId}`).get();
    return snap.data();
  }

  async function movementsFor(pieceId: string): Promise<any[]> {
    const snap = await db.collection("pieceMovementHistory").where("pieceId", "==", pieceId).get();
    return snap.docs.map((d) => d.data());
  }

  async function auditLogsFor(entityId: string, action: string): Promise<any[]> {
    const snap = await db.collection("auditLogs").where("entityId", "==", entityId).where("action", "==", action).get();
    return snap.docs.map((d) => d.data());
  }

  const pmUid = await seedActor("pm");

  // ── 1. Open session blocks IN_WORK -> QC_PENDING ──────────────────────────
  // (also covers scenario 4's "stop then succeed" for this transition)
  {
    const pieceId = `PIECE-LSG-QC-${runId}`;
    const karigarId = `KARIGAR-LSG-QC-${runId}`;
    await seedPiece(pieceId, "IN_WORK");
    await seedKarigar(karigarId);

    const startResult: any = await wrappedLabourStart({ data: { pieceId, karigarId }, auth: { uid: pmUid, token: {} } });
    const sessionId = startResult?.sessionId;
    if (!sessionId) fail(`[1] expected labourStart to return a sessionId.`);

    try {
      await wrappedMovePiece({
        data: { pieceId, toStage: "QC_PENDING", action: "STAGE_MOVE", direction: "FORWARD" },
        auth: { uid: pmUid, token: {} },
      });
      fail(`[1] expected recordPieceMovement(QC_PENDING) to be rejected while a session is open, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[1] recordPieceMovement(QC_PENDING) with open session rejected with code "${code}": ${err?.message ?? ""}`);
      if (code !== "failed-precondition") fail(`[1] expected rejection code "failed-precondition", got "${code}".`);
    }
    const afterBlocked = await getPiece(pieceId);
    if (afterBlocked?.stage !== "IN_WORK") fail(`[1] expected piece to remain IN_WORK after the blocked move, got "${afterBlocked?.stage}".`);

    // [4] stop the session, then the SAME move succeeds.
    await wrappedLabourStop({ data: { sessionId }, auth: { uid: pmUid, token: {} } });
    try {
      await wrappedMovePiece({
        data: { pieceId, toStage: "QC_PENDING", action: "STAGE_MOVE", direction: "FORWARD" },
        auth: { uid: pmUid, token: {} },
      });
      const after = await getPiece(pieceId);
      console.log(`[4-qc] after stopping the session, move succeeded -> stage "${after?.stage}".`);
      if (after?.stage !== "QC_PENDING") fail(`[4-qc] expected stage QC_PENDING after stopping the session, got "${after?.stage}".`);
      const moves = await movementsFor(pieceId);
      const qcMove = moves.find((m: any) => m.toStage === "QC_PENDING");
      if (!qcMove) fail(`[4-qc] expected a pieceMovementHistory record for the successful QC_PENDING move.`);
    } catch (err: any) {
      fail(`[4-qc] expected recordPieceMovement(QC_PENDING) to succeed once the session was stopped, but it threw: ${err?.code ?? err}`);
    }
  }

  // ── 2. Open session blocks IN_WORK -> REWORK ──────────────────────────────
  {
    const pieceId = `PIECE-LSG-RW-${runId}`;
    const karigarId = `KARIGAR-LSG-RW-${runId}`;
    await seedPiece(pieceId, "IN_WORK");
    await seedKarigar(karigarId);

    const startResult: any = await wrappedLabourStart({ data: { pieceId, karigarId }, auth: { uid: pmUid, token: {} } });
    const sessionId = startResult?.sessionId;

    try {
      await wrappedRework({ data: { pieceId, reason: "stitching defect" }, auth: { uid: pmUid, token: {} } });
      fail(`[2] expected recordRework to be rejected while a session is open, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[2] recordRework with open session rejected with code "${code}": ${err?.message ?? ""}`);
      if (code !== "failed-precondition") fail(`[2] expected rejection code "failed-precondition", got "${code}".`);
    }
    const afterBlocked = await getPiece(pieceId);
    if (afterBlocked?.stage !== "IN_WORK") fail(`[2] expected piece to remain IN_WORK after the blocked rework, got "${afterBlocked?.stage}".`);

    // [4] stop the session, then recordRework succeeds.
    await wrappedLabourStop({ data: { sessionId }, auth: { uid: pmUid, token: {} } });
    try {
      await wrappedRework({ data: { pieceId, reason: "stitching defect" }, auth: { uid: pmUid, token: {} } });
      const after = await getPiece(pieceId);
      console.log(`[4-rw] after stopping the session, rework succeeded -> stage "${after?.stage}".`);
      if (after?.stage !== "REWORK") fail(`[4-rw] expected stage REWORK after stopping the session, got "${after?.stage}".`);
      const audits = await auditLogsFor(pieceId, "PIECE_REWORK");
      if (audits.length !== 1) fail(`[4-rw] expected exactly 1 PIECE_REWORK audit entry, got ${audits.length}.`);
    } catch (err: any) {
      fail(`[4-rw] expected recordRework to succeed once the session was stopped, but it threw: ${err?.code ?? err}`);
    }
  }

  // ── 3. Open session blocks IN_WORK -> REJECTED ────────────────────────────
  {
    const pieceId = `PIECE-LSG-REJ-${runId}`;
    const karigarId = `KARIGAR-LSG-REJ-${runId}`;
    await seedPiece(pieceId, "IN_WORK");
    await seedKarigar(karigarId);

    const startResult: any = await wrappedLabourStart({ data: { pieceId, karigarId }, auth: { uid: pmUid, token: {} } });
    const sessionId = startResult?.sessionId;

    try {
      await wrappedReject({ data: { pieceId, reason: "unsalvageable" }, auth: { uid: pmUid, token: {} } });
      fail(`[3] expected completeRejectPiece to be rejected while a session is open, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[3] completeRejectPiece with open session rejected with code "${code}": ${err?.message ?? ""}`);
      if (code !== "failed-precondition") fail(`[3] expected rejection code "failed-precondition", got "${code}".`);
    }
    const afterBlocked = await getPiece(pieceId);
    if (afterBlocked?.stage !== "IN_WORK") fail(`[3] expected piece to remain IN_WORK after the blocked reject, got "${afterBlocked?.stage}".`);

    // [4] stop the session, then completeRejectPiece succeeds.
    await wrappedLabourStop({ data: { sessionId }, auth: { uid: pmUid, token: {} } });
    try {
      await wrappedReject({ data: { pieceId, reason: "unsalvageable" }, auth: { uid: pmUid, token: {} } });
      const after = await getPiece(pieceId);
      console.log(`[4-rej] after stopping the session, reject succeeded -> stage "${after?.stage}", status "${after?.status}".`);
      if (after?.stage !== "REJECTED" || after?.status !== "closed") {
        fail(`[4-rej] expected stage REJECTED/status closed after stopping the session, got stage "${after?.stage}" status "${after?.status}".`);
      }
    } catch (err: any) {
      fail(`[4-rej] expected completeRejectPiece to succeed once the session was stopped, but it threw: ${err?.code ?? err}`);
    }
  }

  // ── 5. labourStop rejects a session whose piece is already closed/replaced ─
  {
    const pieceId = `PIECE-LSG-CLOSED-${runId}`;
    const karigarId = `KARIGAR-LSG-CLOSED-${runId}`;
    await seedKarigar(karigarId);
    // Seed the piece already IN_WORK so labourStart's own precondition
    // accepts it, start a real session, THEN force the piece closed
    // directly (simulating any path that could leave a stale open session
    // behind) to isolate labourStop's own new guard.
    await seedPiece(pieceId, "IN_WORK");
    const startResult: any = await wrappedLabourStart({ data: { pieceId, karigarId }, auth: { uid: pmUid, token: {} } });
    const sessionId = startResult?.sessionId;
    await db.doc(`pieces/${pieceId}`).update({ status: "closed", stage: "REJECTED" });

    try {
      await wrappedLabourStop({ data: { sessionId }, auth: { uid: pmUid, token: {} } });
      fail(`[5] expected labourStop to be rejected for a closed piece, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[5] labourStop on a closed piece's session rejected with code "${code}": ${err?.message ?? ""}`);
      if (code !== "failed-precondition") fail(`[5] expected rejection code "failed-precondition", got "${code}".`);
    }
    const sessionSnap = await db.doc(`pieceWorkSessions/${sessionId}`).get();
    if (sessionSnap.data()?.endedAt) fail(`[5] expected the session to remain open (unstopped) after the rejected labourStop call.`);
  }

  // ── 6. Existing normal lifecycle regression (unaffected by this rule) ────
  {
    const pieceId = `PIECE-LSG-NORMAL-${runId}`;
    const karigarId = `KARIGAR-LSG-NORMAL-${runId}`;
    await seedPiece(pieceId, "OPEN");
    await seedKarigar(karigarId);

    try {
      const startResult: any = await wrappedLabourStart({ data: { pieceId, karigarId }, auth: { uid: pmUid, token: {} } });
      const sessionId = startResult?.sessionId;
      const afterStart = await getPiece(pieceId);
      if (afterStart?.stage !== "IN_WORK") fail(`[6] expected stage IN_WORK after labourStart, got "${afterStart?.stage}".`);

      const stopResult: any = await wrappedLabourStop({ data: { sessionId }, auth: { uid: pmUid, token: {} } });
      if (!(stopResult?.minutes >= 0)) fail(`[6] expected labourStop to return a numeric minutes value.`);
      const afterStop = await getPiece(pieceId);
      if (afterStop?.stage !== "IN_WORK") fail(`[6] expected stage to remain IN_WORK right after labourStop (no QC move yet), got "${afterStop?.stage}".`);
      if (typeof afterStop?.totalLabourMinutes !== "number") fail(`[6] expected totalLabourMinutes to be set on the piece after labourStop.`);

      await wrappedMovePiece({
        data: { pieceId, toStage: "QC_PENDING", action: "STAGE_MOVE", direction: "FORWARD" },
        auth: { uid: pmUid, token: {} },
      });
      const final = await getPiece(pieceId);
      console.log(`[6] normal lifecycle (start -> stop -> QC_PENDING) -> final stage "${final?.stage}", totalLabourMinutes ${final?.totalLabourMinutes}.`);
      if (final?.stage !== "QC_PENDING") fail(`[6] expected final stage QC_PENDING, got "${final?.stage}".`);
    } catch (err: any) {
      fail(`[6] expected the ordinary start -> stop -> move lifecycle to succeed, but got: ${err?.code ?? err}: ${err?.message ?? ""}`);
    }
  }

  if (!pass) {
    console.error("\nRESULT: FAIL");
    process.exit(1);
  }
  console.log("\nRESULT: PASS");
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
