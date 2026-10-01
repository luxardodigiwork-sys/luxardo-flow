/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — QC_PENDING -> QC_PASS (PieceDetailPage fix verification).
 *
 * Not wired into any test runner (the repo has none yet) — same standalone,
 * emulator-only approach as functions/src/__tests__/pieces.med1.test.ts.
 *
 * Context: PieceDetailPage.tsx had a stale local NEXT_STAGES copy listing
 * `QC_PENDING: ['QC_PASS', 'REWORK']`, which rendered a "QC_PASS" button in
 * its generic "Stage Movement" panel calling recordPieceMovement. The
 * backend's canonical NEXT_STAGES (functions/src/pieces.ts) has always had
 * `QC_PENDING: []` by design — QC verdicts are guardQcPerform()'s exclusive
 * domain. The button was therefore guaranteed to fail with exactly:
 *   "Invalid transition: QC_PENDING -> QC_PASS is not allowed."
 * The fix (already applied) changes the frontend copy to `QC_PENDING: []`,
 * removing the broken button. This test proves the backend contract that
 * fix now correctly respects, unchanged:
 *
 * Scenarios:
 *   1. guardQcPerform({verdict:"PASS"}) on a QC_PENDING piece, called by a
 *      "guard" actor, succeeds and moves the piece to DISPATCH_READY / active
 *      (updated: the locked business rule now has Guard PASS itself hand off
 *      to Dispatch directly, rather than resting at an intermediate QC_PASS
 *      stage — see guardQc.ts and pieces.dispatchHandoff.test.ts for the
 *      full behavior + movement-history/audit verification).
 *   2. recordPieceMovement({toStage:"QC_PASS"}) on a QC_PENDING piece,
 *      called by an "owner" actor (i.e. exactly what the removed button
 *      used to do), is rejected with failed-precondition and the exact
 *      reported error text — confirming this was a frontend UI/action-
 *      wiring bug, not a backend or RBAC bug.
 *
 * MUST be run against the Firestore emulator only — refuses to run if
 * FIRESTORE_EMULATOR_HOST is not set, so it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore --project demo-luxardo-test \
 *     "node lib/__tests__/pieces.qcpass-ui-fix.test.js"
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

  async function seedQcPendingPiece(pieceId: string): Promise<void> {
    await db.doc(`pieces/${pieceId}`).set({
      id: pieceId, stage: "QC_PENDING", status: "active",
      qcVerdict: null, rejectionType: null, rejectionReason: null,
      reworkCount: 0, rejectedAt: null, rejectedBy: null, rejectedByName: null,
      prId: null, totalLabourMinutes: 0, totalLabourCost: 0,
      updatedAt: new Date(0).toISOString(),
    });
  }

  // ── Scenario 1: Guard performs QC PASS via guardQcPerform — must succeed ──
  {
    const guardUid = await seedActor("guard");
    const pieceId = `PIECE-QCFIX-GUARD-${runId}`;
    await seedQcPendingPiece(pieceId);

    try {
      const result = await wrappedGuardQc({
        data: { pieceId, verdict: "PASS" },
        auth: { uid: guardUid, token: {} },
      });
      const snap = await db.doc(`pieces/${pieceId}`).get();
      const d = snap.data();
      console.log(`[1] guardQcPerform(PASS) -> stage now "${d?.stage}", status "${d?.status}", qcVerdict "${d?.qcVerdict}".`);
      if (d?.stage !== "DISPATCH_READY") fail(`[1] expected stage DISPATCH_READY, got "${d?.stage}".`);
      if (d?.status !== "active") fail(`[1] expected status active, got "${d?.status}".`);
      if (d?.qcVerdict !== "PASS") fail(`[1] expected qcVerdict PASS, got "${d?.qcVerdict}".`);
      if (!result || result.toStage !== "DISPATCH_READY") fail(`[1] expected return toStage DISPATCH_READY, got ${JSON.stringify(result)}.`);
    } catch (err: any) {
      fail(`[1] expected guardQcPerform(PASS) to succeed for a guard actor, but it threw: ${err?.code ?? err}: ${err?.message ?? ""}`);
    }
  }

  // ── Scenario 2: Owner attempts the same transition via the REMOVED button's
  //    call (recordPieceMovement toStage=QC_PASS) — must still be rejected ──
  {
    const ownerUid = await seedActor("owner");
    const pieceId = `PIECE-QCFIX-OWNERMOVE-${runId}`;
    await seedQcPendingPiece(pieceId);
    const before = (await db.doc(`pieces/${pieceId}`).get()).data();

    try {
      await wrappedMovePiece({
        data: { pieceId, toStage: "QC_PASS", action: "STAGE_MOVE", direction: "FORWARD" },
        auth: { uid: ownerUid, token: {} },
      });
      fail(`[2] expected recordPieceMovement(QC_PENDING -> QC_PASS) to be rejected, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      const message = err?.message ?? "";
      console.log(`[2] recordPieceMovement(QC_PENDING -> QC_PASS) rejected with code "${code}": ${message}`);
      if (code !== "failed-precondition") fail(`[2] expected rejection code "failed-precondition", got "${code}".`);
      if (!message.includes("Invalid transition: QC_PENDING -> QC_PASS is not allowed")) {
        fail(`[2] expected the exact reported error text, got: "${message}"`);
      }
    }

    const after = (await db.doc(`pieces/${pieceId}`).get()).data();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fail(`[2] expected the piece document to be completely unmutated after rejection.\n  before: ${JSON.stringify(before)}\n  after:  ${JSON.stringify(after)}`);
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
