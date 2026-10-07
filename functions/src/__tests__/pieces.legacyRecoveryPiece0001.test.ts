/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — backend coverage for the PIECE-0001 legacy
 * data recovery control (temporary Piece Detail UI, src/pages/production/
 * legacyRecovery.ts). This file tests PERMANENT, pre-existing backend
 * behavior of recordPieceMovement (functions/src/pieces.ts) — it is NOT
 * deleted when the temporary frontend control is removed after use.
 *
 * recordPieceMovement already allows QC_PASS -> DISPATCH_READY as a
 * PIECE_MANAGERS-only recovery path (see pieces.dispatchHandoff.test.ts
 * scenario 7, which proves this for a pm actor). This file broadens that
 * same proof to every role the temporary UI control allows
 * (super_admin/admin/owner/pm — hasAnyRole's super_admin->admin bypass,
 * functions/src/staffAuth.ts, means super_admin is covered even though
 * PIECE_MANAGERS literally lists only ["admin","owner","pm"]) and to every
 * role it does not (guard/dispatch/tailor/store), using the exact
 * action/direction strings the UI sends: action "LEGACY_RECOVERY",
 * direction "FORWARD".
 *
 * Scope note — repeated recovery: recordPieceMovement has no backend-level
 * guard against being called again once the piece is already at the
 * requested toStage (fromStage === toStage simply skips the transition-
 * validation/update block; it still unconditionally appends a movement/
 * audit record). That is pre-existing, unmodified behavior — out of scope
 * here ("do not alter business logic"). Repeat-safety for THIS temporary
 * control comes entirely from the frontend gate (canRunLegacyRecovery),
 * which stops rendering the instant the piece's own re-fetched stage is no
 * longer QC_PASS — see src/__tests__/legacyRecovery.test.ts.
 *
 * MUST be run against the Firestore emulator only — refuses to run if
 * FIRESTORE_EMULATOR_HOST is not set, so it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore --project demo-luxardo-test \
 *     "node lib/__tests__/pieces.legacyRecoveryPiece0001.test.js"
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
  const { recordPieceMovement } = require("../pieces");
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

  async function seedPiece(pieceId: string): Promise<void> {
    await db.doc(`pieces/${pieceId}`).set({
      id: pieceId, stage: "QC_PASS", status: "active",
      qcVerdict: "PASS", rejectionType: null, rejectionReason: null,
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

  const recover = (pieceId: string, uid: string) =>
    wrappedMovePiece({
      data: { pieceId, toStage: "DISPATCH_READY", action: "LEGACY_RECOVERY", direction: "FORWARD" },
      auth: { uid, token: {} },
    });

  // ── Authorized roles: admin, owner, pm, super_admin — each on its own
  // freshly seeded QC_PASS piece, each must succeed and land DISPATCH_READY,
  // with exactly one correctly-shaped movement + audit record ──
  for (const role of ["admin", "owner", "pm", "super_admin"]) {
    const uid = await seedActor(role);
    const pieceId = `PIECE-LEGACY-OK-${role}-${runId}`;
    await seedPiece(pieceId);
    try {
      const result: any = await recover(pieceId, uid);
      const snap = await db.doc(`pieces/${pieceId}`).get();
      console.log(`[${role}] recovery -> stage "${snap.data()?.stage}", result.ok ${result?.ok}.`);
      if (snap.data()?.stage !== "DISPATCH_READY") fail(`[${role}] expected stage DISPATCH_READY, got "${snap.data()?.stage}".`);
      if (result?.ok !== true) fail(`[${role}] expected result.ok true, got ${result?.ok}.`);

      const movements = await movementsFor(pieceId);
      if (movements.length !== 1) fail(`[${role}] expected exactly 1 movement record, got ${movements.length}.`);
      else {
        const m: any = movements[0];
        if (m.fromStage !== "QC_PASS") fail(`[${role}] expected movement fromStage QC_PASS, got "${m.fromStage}".`);
        if (m.toStage !== "DISPATCH_READY") fail(`[${role}] expected movement toStage DISPATCH_READY, got "${m.toStage}".`);
        if (m.action !== "LEGACY_RECOVERY") fail(`[${role}] expected movement action LEGACY_RECOVERY, got "${m.action}".`);
        if (m.actorUid !== uid) fail(`[${role}] expected movement actorUid "${uid}", got "${m.actorUid}".`);
      }

      const audits = await auditLogsFor(pieceId);
      if (audits.length !== 1) fail(`[${role}] expected exactly 1 audit log record, got ${audits.length}.`);
      else if (audits[0].action !== "PIECE_STAGE_MOVE") fail(`[${role}] expected audit action PIECE_STAGE_MOVE, got "${audits[0].action}".`);
    } catch (err: any) {
      fail(`[${role}] expected legacy recovery to succeed, but it threw: ${err?.code ?? err}`);
    }
  }

  // ── Unauthorized roles: guard, dispatch, tailor, store — each rejected
  // permission-denied, piece left completely unmutated ──
  for (const role of ["guard", "dispatch", "tailor", "store"]) {
    const uid = await seedActor(role);
    const pieceId = `PIECE-LEGACY-DENY-${role}-${runId}`;
    await seedPiece(pieceId);
    const before = (await db.doc(`pieces/${pieceId}`).get()).data();
    try {
      await recover(pieceId, uid);
      fail(`[${role}] expected rejection on the legacy recovery path, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[${role}] recovery attempt rejected with code "${code}".`);
      if (code !== "permission-denied") fail(`[${role}] expected rejection code "permission-denied", got "${code}".`);
    }
    const after = (await db.doc(`pieces/${pieceId}`).get()).data();
    if (JSON.stringify(before) !== JSON.stringify(after)) fail(`[${role}] expected piece to be completely unmutated after rejection.`);
    const movements = await movementsFor(pieceId);
    if (movements.length !== 0) fail(`[${role}] expected 0 movement records after rejection, got ${movements.length}.`);
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
