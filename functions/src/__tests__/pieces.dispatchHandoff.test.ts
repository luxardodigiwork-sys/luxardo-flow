/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — locked business rule: Guard QC PASS is itself
 * the handoff to Dispatch.
 *
 * Supersedes this file's earlier version (which tested a manual PM "Move to
 * Dispatch Ready" action — that UI/flow has been removed; see
 * PieceDetailPage.tsx / pieceLifecycle.ts). guardQcPerform(PASS) now persists
 * DISPATCH_READY directly instead of resting at QC_PASS. qcVerdict, Guard
 * identity, timestamps and the guardQCRecords entry are unchanged. The piece
 * update, guardQCRecords write, pieceMovementHistory entry and auditLogs
 * entry are now all part of ONE Firestore transaction (see guardQc.ts /
 * audit.ts) — this test verifies all four land consistently, not just
 * piece.stage.
 *
 * Scenarios:
 *   1. guardQcPerform(PASS) on QC_PENDING -> piece.stage DISPATCH_READY,
 *      qcVerdict PASS, status active; guardQCRecords verdict/guard identity
 *      correct; EXACTLY one new pieceMovementHistory doc
 *      (QC_PENDING -> DISPATCH_READY, action QC_PASS, actor = the guard);
 *      EXACTLY one new auditLogs doc (action GUARD_QC, correct actor/after).
 *   2. REWORK semantics unchanged (stage REWORK, status in_rework,
 *      reworkCount++, movement action QC_REWORK, reason mandatory).
 *   3. COMPLETE_REJECT semantics unchanged (stage REJECTED, status closed,
 *      movement action QC_COMPLETE_REJECT).
 *   4. A non-Guard actor (pm) is rejected with permission-denied.
 *   5. guardQcPerform on a piece NOT at QC_PENDING (already DISPATCH_READY)
 *      is rejected with failed-precondition (invalid stage).
 *   6. Retry safety: calling guardQcPerform(PASS) twice for the same piece —
 *      the first succeeds, the second is rejected (piece left QC_PENDING
 *      already) with NO additional movement/audit/QC records created (no
 *      double-processing).
 *   7. Legacy recovery path (NOT the routine flow): the generic
 *      recordPieceMovement(QC_PASS -> DISPATCH_READY) is deliberately still
 *      valid on the backend (functions/src/pieces.ts NEXT_STAGES.QC_PASS is
 *      unchanged) ONLY as a non-UI-exposed recovery mechanism for any piece
 *      already sitting at legacy QC_PASS from before this rule. Still
 *      PIECE_MANAGERS-only — guard/dispatch remain rejected.
 *
 * MUST be run against the Firestore emulator only — refuses to run if
 * FIRESTORE_EMULATOR_HOST is not set, so it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore --project demo-luxardo-test \
 *     "node lib/__tests__/pieces.dispatchHandoff.test.js"
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
  const { guardQcPerform } = require("../guardQc");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { recordPieceMovement } = require("../pieces");
  const wrappedGuardQc = testEnv.wrap(guardQcPerform);
  const wrappedMovePiece = testEnv.wrap(recordPieceMovement);

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

  async function seedPiece(pieceId: string, stage: string): Promise<void> {
    await db.doc(`pieces/${pieceId}`).set({
      id: pieceId, stage, status: stage === "OPEN" ? "active" : "active",
      qcVerdict: null, rejectionType: null, rejectionReason: null,
      reworkCount: 0, rejectedAt: null, rejectedBy: null, rejectedByName: null,
      prId: null, totalLabourMinutes: 0, totalLabourCost: 0,
      updatedAt: new Date(0).toISOString(),
    });
  }

  async function movementsFor(pieceId: string) {
    const snap = await db.collection("pieceMovementHistory").where("pieceId", "==", pieceId).get();
    return snap.docs.map((d) => d.data());
  }

  async function auditLogsFor(entityId: string) {
    const snap = await db.collection("auditLogs").where("entityId", "==", entityId).get();
    return snap.docs.map((d) => d.data());
  }

  // ── 1. Guard PASS -> DISPATCH_READY, with consistent QC record, movement
  // history and audit log (all four writes verified, not just piece.stage) ──
  {
    const guardUid = await seedActor("guard");
    const pieceId = `PIECE-AUTODISPATCH-PASS-${runId}`;
    await seedPiece(pieceId, "QC_PENDING");

    try {
      const result: any = await wrappedGuardQc({ data: { pieceId, verdict: "PASS" }, auth: { uid: guardUid, token: {} } });
      const snap = await db.doc(`pieces/${pieceId}`).get();
      const d = snap.data();
      console.log(`[1] guardQcPerform(PASS) -> stage "${d?.stage}", qcVerdict "${d?.qcVerdict}", result.toStage "${result?.toStage}".`);
      if (d?.stage !== "DISPATCH_READY") fail(`[1] expected stage DISPATCH_READY, got "${d?.stage}".`);
      if (d?.status !== "active") fail(`[1] expected status active, got "${d?.status}".`);
      if (d?.qcVerdict !== "PASS") fail(`[1] expected qcVerdict PASS, got "${d?.qcVerdict}".`);
      if (result?.toStage !== "DISPATCH_READY") fail(`[1] expected returned toStage DISPATCH_READY, got "${result?.toStage}".`);

      const qcId = d?.lastGuardQcId;
      if (!qcId) fail(`[1] expected lastGuardQcId to be set on the piece.`);
      else {
        const qcSnap = await db.doc(`guardQCRecords/${qcId}`).get();
        const qc = qcSnap.data();
        console.log(`[1] guardQCRecords/${qcId}: verdict "${qc?.verdict}", guardUid "${qc?.guardUid}".`);
        if (qc?.verdict !== "PASS") fail(`[1] expected guardQCRecords verdict PASS, got "${qc?.verdict}".`);
        if (qc?.guardUid !== guardUid) fail(`[1] expected guardQCRecords guardUid "${guardUid}", got "${qc?.guardUid}".`);
      }

      const movements = await movementsFor(pieceId);
      console.log(`[1] movement history: ${movements.length} record(s): ${JSON.stringify(movements.map((m: any) => `${m.fromStage}->${m.toStage}(${m.action})`))}`);
      if (movements.length !== 1) fail(`[1] expected exactly 1 movement record, got ${movements.length}.`);
      else {
        const m: any = movements[0];
        if (m.fromStage !== "QC_PENDING") fail(`[1] expected movement fromStage QC_PENDING, got "${m.fromStage}".`);
        if (m.toStage !== "DISPATCH_READY") fail(`[1] expected movement toStage DISPATCH_READY, got "${m.toStage}".`);
        if (m.action !== "QC_PASS") fail(`[1] expected movement action QC_PASS, got "${m.action}".`);
        if (m.actorUid !== guardUid) fail(`[1] expected movement actorUid "${guardUid}", got "${m.actorUid}".`);
        if (m.actorRole !== "guard") fail(`[1] expected movement actorRole "guard", got "${m.actorRole}".`);
      }

      if (qcId) {
        const audits = await auditLogsFor(qcId);
        console.log(`[1] audit logs for ${qcId}: ${audits.length} record(s).`);
        if (audits.length !== 1) fail(`[1] expected exactly 1 audit log record, got ${audits.length}.`);
        else {
          const a: any = audits[0];
          if (a.action !== "GUARD_QC") fail(`[1] expected audit action GUARD_QC, got "${a.action}".`);
          if (a.actorRole !== "guard") fail(`[1] expected audit actorRole "guard", got "${a.actorRole}".`);
          if (a.after?.toStage !== "DISPATCH_READY") fail(`[1] expected audit after.toStage DISPATCH_READY, got "${a.after?.toStage}".`);
        }
      }
    } catch (err: any) {
      fail(`[1] expected guardQcPerform(PASS) to succeed, but it threw: ${err?.code ?? err}: ${err?.message ?? ""}`);
    }
  }

  // ── 2. REWORK unchanged ────────────────────────────────────────────────
  {
    const guardUid = await seedActor("guard");
    const pieceId = `PIECE-AUTODISPATCH-REWORK-${runId}`;
    await seedPiece(pieceId, "QC_PENDING");

    try {
      await wrappedGuardQc({ data: { pieceId, verdict: "REWORK", reason: "stitching defect" }, auth: { uid: guardUid, token: {} } });
      const snap = await db.doc(`pieces/${pieceId}`).get();
      const d = snap.data();
      console.log(`[2] guardQcPerform(REWORK) -> stage "${d?.stage}", status "${d?.status}", reworkCount ${d?.reworkCount}.`);
      if (d?.stage !== "REWORK") fail(`[2] expected stage REWORK, got "${d?.stage}".`);
      if (d?.status !== "in_rework") fail(`[2] expected status in_rework, got "${d?.status}".`);
      if (d?.reworkCount !== 1) fail(`[2] expected reworkCount 1, got ${d?.reworkCount}.`);
      const movements = await movementsFor(pieceId);
      if (movements.length !== 1 || (movements[0] as any).action !== "QC_REWORK") {
        fail(`[2] expected exactly 1 movement with action QC_REWORK, got ${JSON.stringify(movements)}.`);
      }
    } catch (err: any) {
      fail(`[2] expected guardQcPerform(REWORK) to succeed, but it threw: ${err?.code ?? err}`);
    }
  }

  // ── 3. COMPLETE_REJECT unchanged ────────────────────────────────────────
  {
    const guardUid = await seedActor("guard");
    const pieceId = `PIECE-AUTODISPATCH-REJECT-${runId}`;
    await seedPiece(pieceId, "QC_PENDING");

    try {
      await wrappedGuardQc({ data: { pieceId, verdict: "COMPLETE_REJECT", reason: "unsalvageable" }, auth: { uid: guardUid, token: {} } });
      const snap = await db.doc(`pieces/${pieceId}`).get();
      const d = snap.data();
      console.log(`[3] guardQcPerform(COMPLETE_REJECT) -> stage "${d?.stage}", status "${d?.status}".`);
      if (d?.stage !== "REJECTED") fail(`[3] expected stage REJECTED, got "${d?.stage}".`);
      if (d?.status !== "closed") fail(`[3] expected status closed, got "${d?.status}".`);
      const movements = await movementsFor(pieceId);
      if (movements.length !== 1 || (movements[0] as any).action !== "QC_COMPLETE_REJECT") {
        fail(`[3] expected exactly 1 movement with action QC_COMPLETE_REJECT, got ${JSON.stringify(movements)}.`);
      }
    } catch (err: any) {
      fail(`[3] expected guardQcPerform(COMPLETE_REJECT) to succeed, but it threw: ${err?.code ?? err}`);
    }
  }

  // ── 4. Non-Guard actor rejected ──────────────────────────────────────────
  {
    const pmUid = await seedActor("pm");
    const pieceId = `PIECE-AUTODISPATCH-NONGUARD-${runId}`;
    await seedPiece(pieceId, "QC_PENDING");

    try {
      await wrappedGuardQc({ data: { pieceId, verdict: "PASS" }, auth: { uid: pmUid, token: {} } });
      fail(`[4] expected pm to be rejected by guardQcPerform, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[4] pm rejected with code "${code}": ${err?.message ?? err}`);
      if (code !== "permission-denied") fail(`[4] expected rejection code "permission-denied", got "${code}".`);
    }
  }

  // ── 5. Invalid stage: piece not at QC_PENDING ───────────────────────────
  {
    const guardUid = await seedActor("guard");
    const pieceId = `PIECE-AUTODISPATCH-WRONGSTAGE-${runId}`;
    await seedPiece(pieceId, "DISPATCH_READY");

    try {
      await wrappedGuardQc({ data: { pieceId, verdict: "PASS" }, auth: { uid: guardUid, token: {} } });
      fail(`[5] expected guardQcPerform on a non-QC_PENDING piece to be rejected, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[5] non-QC_PENDING piece rejected with code "${code}": ${err?.message ?? err}`);
      if (code !== "failed-precondition") fail(`[5] expected rejection code "failed-precondition", got "${code}".`);
    }
  }

  // ── 6. Retry safety: second PASS call after success is rejected, no
  // double-processing (movement/audit/QC record counts stay at 1) ──────────
  {
    const guardUid = await seedActor("guard");
    const pieceId = `PIECE-AUTODISPATCH-RETRY-${runId}`;
    await seedPiece(pieceId, "QC_PENDING");

    await wrappedGuardQc({ data: { pieceId, verdict: "PASS" }, auth: { uid: guardUid, token: {} } });
    try {
      await wrappedGuardQc({ data: { pieceId, verdict: "PASS" }, auth: { uid: guardUid, token: {} } });
      fail(`[6] expected a retried guardQcPerform(PASS) call to be rejected, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[6] retry rejected with code "${code}": ${err?.message ?? err}`);
      if (code !== "failed-precondition") fail(`[6] expected rejection code "failed-precondition", got "${code}".`);
    }
    const movements = await movementsFor(pieceId);
    if (movements.length !== 1) fail(`[6] expected exactly 1 movement record after retry (no double-processing), got ${movements.length}.`);
    const snap = await db.doc(`pieces/${pieceId}`).get();
    if (snap.data()?.stage !== "DISPATCH_READY") fail(`[6] expected piece to remain DISPATCH_READY after the rejected retry, got "${snap.data()?.stage}".`);
  }

  // ── 7. Legacy recovery path still works (PM only) — NOT the routine flow ─
  {
    const pmUid = await seedActor("pm");
    const guardUid = await seedActor("guard");
    const dispatchUid = await seedActor("dispatch");

    const pmPieceId = `PIECE-AUTODISPATCH-LEGACY-PM-${runId}`;
    await seedPiece(pmPieceId, "QC_PASS");
    try {
      await wrappedMovePiece({
        data: { pieceId: pmPieceId, toStage: "DISPATCH_READY", action: "LEGACY_RECOVERY", direction: "FORWARD" },
        auth: { uid: pmUid, token: {} },
      });
      const snap = await db.doc(`pieces/${pmPieceId}`).get();
      console.log(`[7] pm legacy recovery move -> stage "${snap.data()?.stage}".`);
      if (snap.data()?.stage !== "DISPATCH_READY") fail(`[7] expected pm legacy recovery to reach DISPATCH_READY, got "${snap.data()?.stage}".`);
    } catch (err: any) {
      fail(`[7] expected pm's legacy recordPieceMovement(QC_PASS -> DISPATCH_READY) to still succeed, but it threw: ${err?.code ?? err}`);
    }

    const guardPieceId = `PIECE-AUTODISPATCH-LEGACY-GUARD-${runId}`;
    await seedPiece(guardPieceId, "QC_PASS");
    try {
      await wrappedMovePiece({
        data: { pieceId: guardPieceId, toStage: "DISPATCH_READY", action: "LEGACY_RECOVERY", direction: "FORWARD" },
        auth: { uid: guardUid, token: {} },
      });
      fail(`[7] expected guard to be rejected on the legacy recovery path, but it succeeded.`);
    } catch (err: any) {
      if ((err?.code ?? "unknown") !== "permission-denied") fail(`[7] expected guard rejection code "permission-denied", got "${err?.code}".`);
    }

    const dispatchPieceId = `PIECE-AUTODISPATCH-LEGACY-DISPATCH-${runId}`;
    await seedPiece(dispatchPieceId, "QC_PASS");
    try {
      await wrappedMovePiece({
        data: { pieceId: dispatchPieceId, toStage: "DISPATCH_READY", action: "LEGACY_RECOVERY", direction: "FORWARD" },
        auth: { uid: dispatchUid, token: {} },
      });
      fail(`[7] expected dispatch to be rejected on the legacy recovery path, but it succeeded.`);
    } catch (err: any) {
      if ((err?.code ?? "unknown") !== "permission-denied") fail(`[7] expected dispatch rejection code "permission-denied", got "${err?.code}".`);
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
