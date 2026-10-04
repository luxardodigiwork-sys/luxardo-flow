/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — Fabric Inventory V1 (functions/src/fabric.ts).
 *
 * Covers the locked V1 scope end-to-end against a real Firestore emulator:
 *   - fabricMasterCreate: PM/Admin/Owner only; stock starts at 0.
 *   - fabricMasterUpdate: descriptive fields only — stockQtyMeters can NEVER
 *     be tampered with through this path.
 *   - fabricStockReceive: increments stock, writes ONE fabricReceipts record
 *     + ONE fabricLedger entry (type RECEIPT) with the correct
 *     balanceAfterMeters.
 *   - fabricStockIssue: decrements stock, writes ONE fabricIssues record +
 *     ONE fabricLedger entry (type ISSUE, relatedPrId set); rejects when the
 *     referenced Production Request does not exist; rejects (and leaves
 *     stock COMPLETELY unmutated) when the requested quantity exceeds
 *     current stock — stock must never go negative.
 *   - Concurrency: two concurrent fabricStockIssue calls that would together
 *     overdraw the fabric must resolve to exactly one success and one
 *     rejection, with the final stock matching exactly one deduction (never
 *     negative) — same transactional-retry property as labour.f2.test.ts's
 *     duplicate-session race, applied here to stock instead of a session.
 *
 * Scenarios:
 *   1. fabricMasterCreate succeeds for pm; stock starts at 0.
 *   2. fabricMasterCreate rejected for guard (permission-denied).
 *   3. fabricMasterUpdate updates name/gsm but ignores an attempted
 *      stockQtyMeters tamper in the same call.
 *   4. fabricStockReceive increases stock correctly; fabricReceipts +
 *      fabricLedger (RECEIPT) records are correct.
 *   5. fabricStockIssue decreases stock correctly against a real PR;
 *      fabricIssues + fabricLedger (ISSUE) records are correct.
 *   6. fabricStockIssue rejected for a nonexistent PR — stock unmutated.
 *   7. fabricStockIssue rejected when qty exceeds stock — stock unmutated,
 *      never negative.
 *   8. Concurrent over-draw: two simultaneous issues that together exceed
 *      stock -> exactly one succeeds, one rejected, final stock is never
 *      negative.
 *
 * MUST be run against the Firestore emulator only — refuses to run if
 * FIRESTORE_EMULATOR_HOST is not set, so it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore --project demo-luxardo-test \
 *     "node lib/__tests__/fabric.test.js"
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
  const { fabricMasterCreate, fabricMasterUpdate, fabricStockReceive, fabricStockIssue } = require("../fabric");

  const wrappedCreate = testEnv.wrap(fabricMasterCreate);
  const wrappedUpdate = testEnv.wrap(fabricMasterUpdate);
  const wrappedReceive = testEnv.wrap(fabricStockReceive);
  const wrappedIssue = testEnv.wrap(fabricStockIssue);

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

  async function seedPr(prId: string): Promise<void> {
    await db.doc(`productionRequests/${prId}`).set({
      id: prId, status: "APPROVED", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    });
  }

  async function getFabric(id: string): Promise<any> {
    const snap = await db.doc(`fabricMasters/${id}`).get();
    return snap.data();
  }

  async function ledgerFor(fabricId: string): Promise<any[]> {
    const snap = await db.collection("fabricLedger").where("fabricId", "==", fabricId).get();
    return snap.docs.map((d) => d.data());
  }

  const pmUid = await seedActor("pm");

  // ── 1. fabricMasterCreate succeeds for pm; stock starts at 0 ────────────
  let fabricId = "";
  {
    try {
      const result: any = await wrappedCreate({
        data: { name: "Cotton Poplin", gsm: 120, colour: "Ivory", colourCode: "#F5F0E6", notes: "test fabric" },
        auth: { uid: pmUid, token: {} },
      });
      fabricId = result.id;
      const f = await getFabric(fabricId);
      console.log(`[1] fabricMasterCreate -> id "${fabricId}", stockQtyMeters ${f?.stockQtyMeters}, active ${f?.active}.`);
      if (!fabricId || !fabricId.startsWith("FM-")) fail(`[1] expected an FM-XXXX id, got "${fabricId}".`);
      if (f?.stockQtyMeters !== 0) fail(`[1] expected stockQtyMeters 0, got ${f?.stockQtyMeters}.`);
      if (f?.active !== true) fail(`[1] expected active true, got ${f?.active}.`);
    } catch (err: any) {
      fail(`[1] expected fabricMasterCreate to succeed for pm, but it threw: ${err?.code ?? err}`);
    }
  }

  // ── 2. fabricMasterCreate rejected for guard ─────────────────────────────
  {
    const guardUid = await seedActor("guard");
    try {
      await wrappedCreate({ data: { name: "Linen", gsm: 150, colour: "White" }, auth: { uid: guardUid, token: {} } });
      fail(`[2] expected fabricMasterCreate to be rejected for guard, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[2] guard fabricMasterCreate rejected with code "${code}".`);
      if (code !== "permission-denied") fail(`[2] expected "permission-denied", got "${code}".`);
    }
  }

  // ── 3. fabricMasterUpdate: descriptive fields only, stock un-tamperable ──
  {
    try {
      await wrappedUpdate({
        data: { id: fabricId, updates: { name: "Cotton Poplin (Updated)", gsm: 130, stockQtyMeters: 99999 } },
        auth: { uid: pmUid, token: {} },
      });
      const f = await getFabric(fabricId);
      console.log(`[3] after update -> name "${f?.name}", gsm ${f?.gsm}, stockQtyMeters ${f?.stockQtyMeters} (tamper attempted: 99999).`);
      if (f?.name !== "Cotton Poplin (Updated)") fail(`[3] expected name to update, got "${f?.name}".`);
      if (f?.gsm !== 130) fail(`[3] expected gsm 130, got ${f?.gsm}.`);
      if (f?.stockQtyMeters !== 0) fail(`[3] expected stockQtyMeters to remain 0 (ignored tamper), got ${f?.stockQtyMeters}.`);
    } catch (err: any) {
      fail(`[3] expected fabricMasterUpdate to succeed, but it threw: ${err?.code ?? err}`);
    }
  }

  // ── 4. fabricStockReceive increases stock correctly ──────────────────────
  {
    try {
      const result: any = await wrappedReceive({
        data: { fabricId, qtyMeters: 100, supplier: "Acme Textiles", notes: "first receipt" },
        auth: { uid: pmUid, token: {} },
      });
      const f = await getFabric(fabricId);
      console.log(`[4] fabricStockReceive(100) -> balanceAfterMeters ${result.balanceAfterMeters}, stock now ${f?.stockQtyMeters}.`);
      if (result.balanceAfterMeters !== 100) fail(`[4] expected balanceAfterMeters 100, got ${result.balanceAfterMeters}.`);
      if (f?.stockQtyMeters !== 100) fail(`[4] expected stockQtyMeters 100, got ${f?.stockQtyMeters}.`);

      const receiptSnap = await db.doc(`fabricReceipts/${result.id}`).get();
      const r = receiptSnap.data();
      if (!receiptSnap.exists) fail(`[4] expected a fabricReceipts/${result.id} doc.`);
      if (r?.qtyMeters !== 100 || r?.balanceAfterMeters !== 100) fail(`[4] fabricReceipts record mismatch: ${JSON.stringify(r)}.`);

      const ledger = await ledgerFor(fabricId);
      const receiptEntries = ledger.filter((e) => e.type === "RECEIPT");
      if (receiptEntries.length !== 1) fail(`[4] expected exactly 1 RECEIPT ledger entry, got ${receiptEntries.length}.`);
      if (receiptEntries[0]?.balanceAfterMeters !== 100) fail(`[4] RECEIPT ledger entry balanceAfterMeters mismatch: ${JSON.stringify(receiptEntries[0])}.`);
    } catch (err: any) {
      fail(`[4] expected fabricStockReceive to succeed, but it threw: ${err?.code ?? err}`);
    }
  }

  // ── 5. fabricStockIssue decreases stock correctly against a real PR ─────
  const prId = `PR-FABTEST-${runId}`;
  await seedPr(prId);
  {
    try {
      const result: any = await wrappedIssue({
        data: { fabricId, prId, qtyMeters: 30, reason: "cutting for PR" },
        auth: { uid: pmUid, token: {} },
      });
      const f = await getFabric(fabricId);
      console.log(`[5] fabricStockIssue(30, ${prId}) -> balanceAfterMeters ${result.balanceAfterMeters}, stock now ${f?.stockQtyMeters}.`);
      if (result.balanceAfterMeters !== 70) fail(`[5] expected balanceAfterMeters 70, got ${result.balanceAfterMeters}.`);
      if (f?.stockQtyMeters !== 70) fail(`[5] expected stockQtyMeters 70, got ${f?.stockQtyMeters}.`);

      const issueSnap = await db.doc(`fabricIssues/${result.id}`).get();
      const iss = issueSnap.data();
      if (!issueSnap.exists) fail(`[5] expected a fabricIssues/${result.id} doc.`);
      if (iss?.prId !== prId || iss?.qtyMeters !== 30) fail(`[5] fabricIssues record mismatch: ${JSON.stringify(iss)}.`);

      const ledger = await ledgerFor(fabricId);
      const issueEntries = ledger.filter((e) => e.type === "ISSUE");
      if (issueEntries.length !== 1) fail(`[5] expected exactly 1 ISSUE ledger entry, got ${issueEntries.length}.`);
      if (issueEntries[0]?.relatedPrId !== prId) fail(`[5] ISSUE ledger entry relatedPrId mismatch: ${JSON.stringify(issueEntries[0])}.`);
    } catch (err: any) {
      fail(`[5] expected fabricStockIssue to succeed, but it threw: ${err?.code ?? err}`);
    }
  }

  // ── 6. fabricStockIssue rejected for a nonexistent PR — stock unmutated ──
  {
    const before = await getFabric(fabricId);
    try {
      await wrappedIssue({
        data: { fabricId, prId: `PR-DOES-NOT-EXIST-${runId}`, qtyMeters: 5 },
        auth: { uid: pmUid, token: {} },
      });
      fail(`[6] expected fabricStockIssue to be rejected for a nonexistent PR, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[6] fabricStockIssue with unknown PR rejected with code "${code}".`);
      if (code !== "not-found") fail(`[6] expected "not-found", got "${code}".`);
    }
    const after = await getFabric(fabricId);
    if (after?.stockQtyMeters !== before?.stockQtyMeters) fail(`[6] expected stock unmutated, went ${before?.stockQtyMeters} -> ${after?.stockQtyMeters}.`);
  }

  // ── 7. fabricStockIssue rejected when qty exceeds stock — never negative ─
  {
    const before = await getFabric(fabricId); // stock = 70 at this point
    try {
      await wrappedIssue({
        data: { fabricId, prId, qtyMeters: 1000 },
        auth: { uid: pmUid, token: {} },
      });
      fail(`[7] expected fabricStockIssue to be rejected for insufficient stock, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[7] over-draw fabricStockIssue(1000) rejected with code "${code}": ${err?.message ?? ""}`);
      if (code !== "failed-precondition") fail(`[7] expected "failed-precondition", got "${code}".`);
    }
    const after = await getFabric(fabricId);
    if (after?.stockQtyMeters !== before?.stockQtyMeters) fail(`[7] expected stock unmutated, went ${before?.stockQtyMeters} -> ${after?.stockQtyMeters}.`);
    if (after?.stockQtyMeters < 0) fail(`[7] stock must never go negative, got ${after?.stockQtyMeters}.`);
  }

  // ── 8. Concurrent over-draw: exactly one of two simultaneous issues wins ─
  {
    // Fresh fabric, receive exactly 50m, then fire two concurrent issues of
    // 30m each (60m total requested against 50m available) — exactly one
    // must succeed, the other must be rejected, and final stock must be
    // 20m (NOT negative, and not double-deducted).
    const raceFabric: any = await wrappedCreate({
      data: { name: "Race Fabric", gsm: 100, colour: "Black" },
      auth: { uid: pmUid, token: {} },
    });
    const raceFabricId = raceFabric.id;
    await wrappedReceive({ data: { fabricId: raceFabricId, qtyMeters: 50 }, auth: { uid: pmUid, token: {} } });

    const results = await Promise.allSettled([
      wrappedIssue({ data: { fabricId: raceFabricId, prId, qtyMeters: 30 }, auth: { uid: pmUid, token: {} } }),
      wrappedIssue({ data: { fabricId: raceFabricId, prId, qtyMeters: 30 }, auth: { uid: pmUid, token: {} } }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    const finalFabric = await getFabric(raceFabricId);
    console.log(`[8] concurrent 30m+30m issues against 50m stock -> ${fulfilled} fulfilled, ${rejected} rejected, final stock ${finalFabric?.stockQtyMeters}.`);
    if (fulfilled !== 1 || rejected !== 1) fail(`[8] expected exactly 1 fulfilled and 1 rejected, got ${fulfilled} fulfilled, ${rejected} rejected.`);
    if (finalFabric?.stockQtyMeters !== 20) fail(`[8] expected final stock 20 (50 - one 30 deduction), got ${finalFabric?.stockQtyMeters}.`);
    if (finalFabric?.stockQtyMeters < 0) fail(`[8] stock must never go negative, got ${finalFabric?.stockQtyMeters}.`);
  }

  if (!pass) {
    console.error("FABRIC INVENTORY V1 REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log(
    "FABRIC INVENTORY V1 REGRESSION TEST: PASS — master CRUD is RBAC-gated " +
    "and stock is never directly tamperable via update; receive/issue " +
    "correctly move stock with matching receipt/issue + ledger records; " +
    "an issue against an unknown PR or insufficient stock is rejected with " +
    "the fabric left completely unmutated; and two concurrent issues that " +
    "would together overdraw the fabric resolve to exactly one success, " +
    "leaving stock correct and never negative."
  );
}

main().catch((err) => {
  console.error("Fabric Inventory V1 regression test crashed:", err);
  process.exitCode = 1;
});
