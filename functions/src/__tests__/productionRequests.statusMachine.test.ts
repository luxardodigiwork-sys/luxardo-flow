/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — Production Request status machine
 * (APPROVED -> IN_PRODUCTION -> COMPLETED), previously unimplemented:
 * firestore.loom.rules and the UI already anticipated these two statuses
 * (PM read access, STATUS_COLORS), but no Cloud Function ever wrote them —
 * a PR sat at APPROVED forever. See productionRequests.ts's
 * maybeCompletePr() and prGeneratePieces()'s new status transition.
 *
 * Locked rule under test: COMPLETED must NEVER be reached while any piece
 * toward the ordered quantity is still pending, active, or sitting
 * unresolved in REJECTED — i.e. rejected/cancelled/undelivered pieces must
 * never be counted as "completed". Only the completedQty bucket (pieces
 * that actually reached STORE_OUT) counts, and it must equal the full
 * originally-ordered quantity.
 *
 * Scenarios:
 *   1. prGeneratePieces on an APPROVED PR flips it to IN_PRODUCTION on the
 *      FIRST generation call, with a PR_IN_PRODUCTION audit entry; a SECOND
 *      generation call (completing a partial order) leaves status
 *      IN_PRODUCTION unchanged and writes no duplicate audit entry.
 *   2. storeOutCreate moving every remaining piece of a PR to STORE_OUT
 *      completes it: status COMPLETED, completedAt set, PR_COMPLETE audit.
 *   3. storeOutCreate moving only SOME of a PR's pieces to STORE_OUT does
 *      NOT complete it (status stays IN_PRODUCTION).
 *   4. THE CORE RULE: a PR with one piece permanently REJECTED (unresolved)
 *      and every OTHER piece genuinely delivered must NOT be marked
 *      COMPLETED — a rejected piece is never silently counted as done.
 *   5. Once that rejected piece is manually replaced and the replacement is
 *      ALSO genuinely delivered, the PR completes correctly (proves the fix
 *      isn't "stuck forever", only "not falsely done").
 *   6. The recordPieceMovement override path (STORE -> STORE_OUT via
 *      PM/Admin/Owner, not the ordinary storeOutCreate route) also triggers
 *      completion — the check isn't storeOutCreate-specific.
 *   7. Guard-clause parity: prApprove/prUpdate still correctly reject an
 *      IN_PRODUCTION / COMPLETED PR now that those statuses are actually
 *      reachable for the first time (pre-existing guard clauses, never
 *      exercised against a real IN_PRODUCTION/COMPLETED doc before).
 *
 * MUST be run against the Firestore emulator only — refuses to run if
 * FIRESTORE_EMULATOR_HOST is not set, so it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore --project demo-luxardo-test \
 *     "node lib/__tests__/productionRequests.statusMachine.test.js"
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
  const { prGeneratePieces, prApprove, prUpdate } = require("../productionRequests");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { recordPieceMovement, createManualReplacementPiece } = require("../pieces");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { storeOutCreate } = require("../store");

  const wrappedGeneratePieces = testEnv.wrap(prGeneratePieces);
  const wrappedPrApprove = testEnv.wrap(prApprove);
  const wrappedPrUpdate = testEnv.wrap(prUpdate);
  const wrappedMovePiece = testEnv.wrap(recordPieceMovement);
  const wrappedReplace = testEnv.wrap(createManualReplacementPiece);
  const wrappedStoreOut = testEnv.wrap(storeOutCreate);

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

  async function seedFrozenDesignVersion(designId: string, designVersionId: string): Promise<void> {
    await db.doc(`designVersions/${designVersionId}`).set({
      designId, frozen: true, snapshot: { status: "APPROVED" },
    });
  }

  /** Seed a PR directly at a given status with explicit quantity counters. */
  async function seedPr(prId: string, opts: {
    status: string; totalPieceCount: number; pendingQty: number; currentActiveQty: number;
    completedQty: number; rejectedQty: number; piecesGeneratedCount?: number;
    designId: string; designVersionId: string;
  }): Promise<void> {
    await db.doc(`productionRequests/${prId}`).set({
      id: prId, status: opts.status,
      originalOrderedQty: opts.totalPieceCount, totalPieceCount: opts.totalPieceCount,
      pendingQty: opts.pendingQty, currentActiveQty: opts.currentActiveQty,
      completedQty: opts.completedQty, rejectedQty: opts.rejectedQty, reworkQty: 0,
      piecesGeneratedCount: opts.piecesGeneratedCount ?? opts.totalPieceCount,
      originalQtyFrozen: true,
      designId: opts.designId, designVersionId: opts.designVersionId,
      garmentType: "", urgency: "MEDIUM", requiredDate: "",
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      approvedBy: null, approvedByName: null, approvedAt: opts.status !== "DRAFT" ? new Date(0).toISOString() : null,
      rejectedBy: null, rejectedByName: null, rejectedAt: null, rejectionReason: null,
      cancelledBy: null, cancelledAt: null, completedAt: null,
      requestedBy: "seed", requestedByName: "seed", requestedByRole: "dispatch",
      createdBy: "seed", createdByName: "seed",
    });
  }

  async function seedPiece(pieceId: string, prId: string, stage: string): Promise<void> {
    await db.doc(`pieces/${pieceId}`).set({
      id: pieceId, prId, stage, status: stage === "REJECTED" ? "closed" : "active",
      qcVerdict: stage === "REJECTED" ? "COMPLETE_REJECT" : null,
      rejectionType: stage === "REJECTED" ? "COMPLETE_REJECT" : null,
      rejectionReason: stage === "REJECTED" ? "test seed" : null,
      replacedByPieceId: null, reworkCount: 0, rejectedAt: null, rejectedBy: null, rejectedByName: null,
      totalLabourMinutes: 0, totalLabourCost: 0,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    });
  }

  async function getPr(prId: string): Promise<any> {
    const snap = await db.doc(`productionRequests/${prId}`).get();
    return snap.data();
  }

  async function auditLogsFor(entityId: string, action: string): Promise<any[]> {
    const snap = await db.collection("auditLogs").where("entityId", "==", entityId).where("action", "==", action).get();
    return snap.docs.map((d) => d.data());
  }

  const pmUid = await seedActor("pm");
  const storeUid = await seedActor("store");
  const ownerUid = await seedActor("owner");

  // ── 1. prGeneratePieces: APPROVED -> IN_PRODUCTION on first call, stays
  // IN_PRODUCTION (no duplicate audit) on a second, completing call ────────
  {
    const prId = `PR-STATUSMACHINE-GEN-${runId}`;
    const designId = `DESIGN-${prId}`, designVersionId = `DESIGNV-${prId}`;
    await seedFrozenDesignVersion(designId, designVersionId);
    await db.doc(`productionRequests/${prId}`).set({
      id: prId, status: "APPROVED", originalOrderedQty: 3, totalPieceCount: 3,
      pendingQty: 3, currentActiveQty: 0, completedQty: 0, rejectedQty: 0, reworkQty: 0,
      piecesGeneratedCount: 0, originalQtyFrozen: true, designId, designVersionId,
      garmentType: "", urgency: "MEDIUM", requiredDate: "",
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      approvedBy: "seed", approvedByName: "seed", approvedAt: new Date(0).toISOString(),
      rejectedBy: null, rejectedByName: null, rejectedAt: null, rejectionReason: null,
      cancelledBy: null, cancelledAt: null, completedAt: null,
      requestedBy: "seed", requestedByName: "seed", requestedByRole: "dispatch",
      createdBy: "seed", createdByName: "seed",
    });

    try {
      await wrappedGeneratePieces({ data: { prId, count: 2 }, auth: { uid: pmUid, token: {} } });
      const afterFirst = await getPr(prId);
      console.log(`[1] after first generation (2 of 3): status "${afterFirst?.status}", piecesGeneratedCount ${afterFirst?.piecesGeneratedCount}.`);
      if (afterFirst?.status !== "IN_PRODUCTION") fail(`[1] expected status IN_PRODUCTION after first generation, got "${afterFirst?.status}".`);
      const firstAudits = await auditLogsFor(prId, "PR_IN_PRODUCTION");
      if (firstAudits.length !== 1) fail(`[1] expected exactly 1 PR_IN_PRODUCTION audit entry, got ${firstAudits.length}.`);

      await wrappedGeneratePieces({ data: { prId, count: 1 }, auth: { uid: pmUid, token: {} } });
      const afterSecond = await getPr(prId);
      console.log(`[1] after second generation (remaining 1): status "${afterSecond?.status}", piecesGeneratedCount ${afterSecond?.piecesGeneratedCount}.`);
      if (afterSecond?.status !== "IN_PRODUCTION") fail(`[1] expected status to remain IN_PRODUCTION, got "${afterSecond?.status}".`);
      if (afterSecond?.piecesGeneratedCount !== 3) fail(`[1] expected piecesGeneratedCount 3, got ${afterSecond?.piecesGeneratedCount}.`);
      const secondAudits = await auditLogsFor(prId, "PR_IN_PRODUCTION");
      if (secondAudits.length !== 1) fail(`[1] expected STILL exactly 1 PR_IN_PRODUCTION audit entry (no duplicate), got ${secondAudits.length}.`);
    } catch (err: any) {
      fail(`[1] expected both generation calls to succeed, but got: ${err?.code ?? err}: ${err?.message ?? ""}`);
    }
  }

  // ── 2. storeOutCreate: every remaining piece -> STORE_OUT completes the PR ─
  {
    const prId = `PR-STATUSMACHINE-FULL-${runId}`;
    const designId = `DESIGN-${prId}`, designVersionId = `DESIGNV-${prId}`;
    await seedPr(prId, { status: "IN_PRODUCTION", totalPieceCount: 2, pendingQty: 0, currentActiveQty: 2, completedQty: 0, rejectedQty: 0, designId, designVersionId });
    const p1 = `PIECE-STATUSMACHINE-FULL-A-${runId}`, p2 = `PIECE-STATUSMACHINE-FULL-B-${runId}`;
    await seedPiece(p1, prId, "STORE");
    await seedPiece(p2, prId, "STORE");

    try {
      await wrappedStoreOut({ data: { pieceIds: [p1, p2], billNumber: `BILL-${runId}-FULL` }, auth: { uid: storeUid, token: {} } });
      const after = await getPr(prId);
      console.log(`[2] after full store-out: status "${after?.status}", completedQty ${after?.completedQty}, completedAt ${after?.completedAt}.`);
      if (after?.status !== "COMPLETED") fail(`[2] expected status COMPLETED, got "${after?.status}".`);
      if (after?.completedQty !== 2) fail(`[2] expected completedQty 2, got ${after?.completedQty}.`);
      if (!after?.completedAt) fail(`[2] expected completedAt to be set.`);
      const audits = await auditLogsFor(prId, "PR_COMPLETE");
      if (audits.length !== 1) fail(`[2] expected exactly 1 PR_COMPLETE audit entry, got ${audits.length}.`);
    } catch (err: any) {
      fail(`[2] expected storeOutCreate to succeed, but got: ${err?.code ?? err}: ${err?.message ?? ""}`);
    }
  }

  // ── 3. storeOutCreate: only SOME pieces -> STORE_OUT does NOT complete ────
  {
    const prId = `PR-STATUSMACHINE-PARTIAL-${runId}`;
    const designId = `DESIGN-${prId}`, designVersionId = `DESIGNV-${prId}`;
    await seedPr(prId, { status: "IN_PRODUCTION", totalPieceCount: 3, pendingQty: 0, currentActiveQty: 3, completedQty: 0, rejectedQty: 0, designId, designVersionId });
    const p1 = `PIECE-STATUSMACHINE-PARTIAL-A-${runId}`, p2 = `PIECE-STATUSMACHINE-PARTIAL-B-${runId}`, p3 = `PIECE-STATUSMACHINE-PARTIAL-C-${runId}`;
    await seedPiece(p1, prId, "STORE");
    await seedPiece(p2, prId, "STORE");
    await seedPiece(p3, prId, "STORE");

    try {
      await wrappedStoreOut({ data: { pieceIds: [p1, p2], billNumber: `BILL-${runId}-PARTIAL` }, auth: { uid: storeUid, token: {} } });
      const after = await getPr(prId);
      console.log(`[3] after partial store-out (2 of 3): status "${after?.status}", completedQty ${after?.completedQty}, currentActiveQty ${after?.currentActiveQty}.`);
      if (after?.status !== "IN_PRODUCTION") fail(`[3] expected status to remain IN_PRODUCTION (1 piece still active), got "${after?.status}".`);
      if (after?.completedQty !== 2) fail(`[3] expected completedQty 2, got ${after?.completedQty}.`);
      if (after?.currentActiveQty !== 1) fail(`[3] expected currentActiveQty 1 (p3 still at STORE), got ${after?.currentActiveQty}.`);
    } catch (err: any) {
      fail(`[3] expected partial storeOutCreate to succeed, but got: ${err?.code ?? err}: ${err?.message ?? ""}`);
    }
  }

  // ── 4. CORE RULE: an unresolved REJECTED piece must block completion even
  // though every OTHER piece has genuinely been delivered ──────────────────
  let rejectedPieceId = "";
  let corePrId = "";
  {
    const prId = `PR-STATUSMACHINE-REJECTBLOCK-${runId}`;
    corePrId = prId;
    const designId = `DESIGN-${prId}`, designVersionId = `DESIGNV-${prId}`;
    // 3 ordered: 1 already REJECTED (unresolved), 2 sitting at STORE ready
    // to be delivered.
    await seedPr(prId, { status: "IN_PRODUCTION", totalPieceCount: 3, pendingQty: 0, currentActiveQty: 2, completedQty: 0, rejectedQty: 1, designId, designVersionId });
    rejectedPieceId = `PIECE-STATUSMACHINE-REJECTBLOCK-REJ-${runId}`;
    const p1 = `PIECE-STATUSMACHINE-REJECTBLOCK-A-${runId}`, p2 = `PIECE-STATUSMACHINE-REJECTBLOCK-B-${runId}`;
    await seedPiece(rejectedPieceId, prId, "REJECTED");
    await seedPiece(p1, prId, "STORE");
    await seedPiece(p2, prId, "STORE");

    try {
      await wrappedStoreOut({ data: { pieceIds: [p1, p2], billNumber: `BILL-${runId}-REJECTBLOCK` }, auth: { uid: storeUid, token: {} } });
      const after = await getPr(prId);
      console.log(`[4] after delivering every non-rejected piece: status "${after?.status}", completedQty ${after?.completedQty}, rejectedQty ${after?.rejectedQty}.`);
      if (after?.status === "COMPLETED") fail(`[4] CORE RULE VIOLATION: PR was marked COMPLETED while a rejected piece was never delivered.`);
      if (after?.status !== "IN_PRODUCTION") fail(`[4] expected status to remain IN_PRODUCTION, got "${after?.status}".`);
      if (after?.completedQty !== 2) fail(`[4] expected completedQty 2 (only the 2 delivered pieces), got ${after?.completedQty}.`);
      if (after?.rejectedQty !== 1) fail(`[4] expected rejectedQty to remain 1 (unresolved), got ${after?.rejectedQty}.`);
      const audits = await auditLogsFor(prId, "PR_COMPLETE");
      if (audits.length !== 0) fail(`[4] expected NO PR_COMPLETE audit entry, got ${audits.length}.`);
    } catch (err: any) {
      fail(`[4] expected storeOutCreate to succeed (completion just shouldn't fire), but got: ${err?.code ?? err}: ${err?.message ?? ""}`);
    }
  }

  // ── 5. Replacing + genuinely delivering the rejected piece DOES complete it ─
  {
    try {
      const replaceResult: any = await wrappedReplace({
        data: { rejectedPieceId, reason: "re-cut and re-stitch" },
        auth: { uid: pmUid, token: {} },
      });
      const newPieceId = replaceResult?.pieceId;
      if (!newPieceId) fail(`[5] expected createManualReplacementPiece to return a new pieceId.`);

      const afterReplace = await getPr(corePrId);
      console.log(`[5] after replacement: pendingQty ${afterReplace?.pendingQty}, rejectedQty ${afterReplace?.rejectedQty}.`);
      if (afterReplace?.rejectedQty !== 0) fail(`[5] expected rejectedQty back to 0 after replacement, got ${afterReplace?.rejectedQty}.`);
      if (afterReplace?.pendingQty !== 1) fail(`[5] expected pendingQty 1 (the replacement slot), got ${afterReplace?.pendingQty}.`);

      // Fast-forward the replacement piece straight to STORE (bypassing the
      // full pipeline, which is already covered by other focused tests) so
      // this test stays scoped to the status-machine behaviour: simulate
      // "fully processed and ready for store-out" the same way other tests
      // in this suite seed an arbitrary stage directly.
      await db.doc(`pieces/${newPieceId}`).update({ stage: "STORE" });
      await db.doc(`productionRequests/${corePrId}`).update({
        pendingQty: admin.firestore.FieldValue.increment(-1),
        currentActiveQty: admin.firestore.FieldValue.increment(1),
      });

      await wrappedStoreOut({ data: { pieceIds: [newPieceId], billNumber: `BILL-${runId}-REPLACED` }, auth: { uid: storeUid, token: {} } });
      const final = await getPr(corePrId);
      console.log(`[5] after delivering the replacement: status "${final?.status}", completedQty ${final?.completedQty}, rejectedQty ${final?.rejectedQty}.`);
      if (final?.status !== "COMPLETED") fail(`[5] expected status COMPLETED once the replacement was genuinely delivered, got "${final?.status}".`);
      if (final?.completedQty !== 3) fail(`[5] expected completedQty 3 (full ordered quantity), got ${final?.completedQty}.`);
      if (final?.rejectedQty !== 0) fail(`[5] expected rejectedQty 0, got ${final?.rejectedQty}.`);
    } catch (err: any) {
      fail(`[5] expected the replace-then-deliver flow to succeed, but got: ${err?.code ?? err}: ${err?.message ?? ""}`);
    }
  }

  // ── 6. recordPieceMovement's override path also triggers completion ──────
  {
    const prId = `PR-STATUSMACHINE-OVERRIDE-${runId}`;
    const designId = `DESIGN-${prId}`, designVersionId = `DESIGNV-${prId}`;
    await seedPr(prId, { status: "IN_PRODUCTION", totalPieceCount: 1, pendingQty: 0, currentActiveQty: 1, completedQty: 0, rejectedQty: 0, designId, designVersionId });
    const pieceId = `PIECE-STATUSMACHINE-OVERRIDE-${runId}`;
    await seedPiece(pieceId, prId, "STORE");

    try {
      await wrappedMovePiece({
        data: { pieceId, toStage: "STORE_OUT", action: "LEGACY_STORE_OUT", direction: "FORWARD" },
        auth: { uid: pmUid, token: {} },
      });
      const after = await getPr(prId);
      console.log(`[6] after PM's override STORE -> STORE_OUT: status "${after?.status}".`);
      if (after?.status !== "COMPLETED") fail(`[6] expected status COMPLETED via the override path too, got "${after?.status}".`);
    } catch (err: any) {
      fail(`[6] expected the override recordPieceMovement call to succeed, but got: ${err?.code ?? err}: ${err?.message ?? ""}`);
    }
  }

  // ── 7. Guard-clause parity against a REAL IN_PRODUCTION / COMPLETED PR ───
  {
    const inProdId = `PR-STATUSMACHINE-GUARD-INPROD-${runId}`;
    const designId = `DESIGN-${inProdId}`, designVersionId = `DESIGNV-${inProdId}`;
    await seedPr(inProdId, { status: "IN_PRODUCTION", totalPieceCount: 1, pendingQty: 1, currentActiveQty: 0, completedQty: 0, rejectedQty: 0, designId, designVersionId });
    try {
      await wrappedPrApprove({ data: { id: inProdId }, auth: { uid: ownerUid, token: {} } });
      fail(`[7] expected prApprove on an IN_PRODUCTION PR to be rejected, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[7] prApprove on IN_PRODUCTION rejected with code "${code}".`);
      if (code !== "already-exists") fail(`[7] expected rejection code "already-exists", got "${code}".`);
    }

    const completedId = `PR-STATUSMACHINE-GUARD-DONE-${runId}`;
    await seedPr(completedId, { status: "COMPLETED", totalPieceCount: 1, pendingQty: 0, currentActiveQty: 0, completedQty: 1, rejectedQty: 0, designId: `${designId}-2`, designVersionId: `${designVersionId}-2` });
    try {
      await wrappedPrUpdate({ data: { id: completedId, urgency: "HIGH" }, auth: { uid: ownerUid, token: {} } });
      fail(`[7] expected prUpdate on a COMPLETED PR to be rejected, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[7] prUpdate on COMPLETED rejected with code "${code}".`);
      if (code !== "failed-precondition") fail(`[7] expected rejection code "failed-precondition", got "${code}".`);
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
