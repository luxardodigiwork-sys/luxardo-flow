/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — fabricUpdate rename duplicate-name collision.
 *
 * fabricCreate already blocks a duplicate fabric name (nameKey match) before
 * creating. fabricUpdate did NOT: renaming a fabric via `updates.name` wrote
 * the new nameKey straight into the transaction with no collision check, so
 * two fabricMasters docs could end up sharing the same nameKey. This test
 * locks in the fix: fabricUpdate must reject a rename that collides with
 * another fabric's nameKey (same already-exists error fabricCreate uses),
 * leave that fabric's doc completely unchanged, while still allowing a
 * rename to a genuinely free name AND a no-op "rename" to the fabric's own
 * current name (different case/whitespace) — the current fabric must be
 * excluded from its own collision check.
 *
 * Not wired into any test runner (the repo has none yet) — same standalone,
 * emulator-only approach as the other functions/src/__tests__ scripts. NOT
 * exported from functions/src/index.ts, so it is never bundled/deployed.
 *
 * MUST be run against the Firestore emulator only — refuses to run if
 * FIRESTORE_EMULATOR_HOST is not set, so it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore --project demo-luxardo-test \
 *     "node lib/__tests__/fabric.updateDuplicateName.test.js"
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
  const { fabricUpdate } = require("../fabric");
  const wrappedUpdate = testEnv.wrap(fabricUpdate);

  const runId = String(Date.now());
  let pass = true;
  const fail = (msg: string) => {
    console.error(`FAIL: ${msg}`);
    pass = false;
  };

  async function seedDispatch(): Promise<string> {
    const uid = `test-dispatch-${runId}-${Math.random().toString(36).slice(2, 8)}`;
    await db.doc(`staff/${uid}`).set({ role: "dispatch", active: true, displayName: "Test Dispatch" });
    return uid;
  }

  async function seedFabric(id: string, name: string, stockMeters = 0): Promise<void> {
    const now = new Date().toISOString();
    await db.doc(`fabricMasters/${id}`).set({
      id, name, nameKey: name.toLowerCase(), colour: "", gsm: null, unit: "meter",
      stockMeters, lowStockMeters: 0, lowStock: false, notes: "", active: true,
      createdBy: "seed", createdByName: "Seed", createdAt: now, updatedAt: now,
    });
  }

  const dispatchUid = await seedDispatch();
  const fabA = `FAB-DUPTEST-A-${runId}`;
  const fabB = `FAB-DUPTEST-B-${runId}`;
  await seedFabric(fabA, "Navy Wool", 10);
  await seedFabric(fabB, "Satin Lining", 5);

  // ── Scenario 1: rename B to a colliding name (A's name, different case)
  // is rejected, and B's document is completely unchanged ────────────────
  {
    const beforeSnap = await db.doc(`fabricMasters/${fabB}`).get();
    const before = beforeSnap.data();
    try {
      await wrappedUpdate({ data: { id: fabB, updates: { name: "navy wool" } }, auth: { uid: dispatchUid, token: {} } });
      fail(`[1] expected renaming "${fabB}" to a name colliding with "${fabA}" to be rejected, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[1] colliding rename correctly rejected with code "${code}": ${err?.message ?? err}`);
      if (code !== "already-exists") fail(`[1] expected rejection code "already-exists", got "${code}".`);
      if (!/already exists/i.test(String(err?.message ?? ""))) fail(`[1] expected an "already exists" message, got: ${err?.message}`);
    }
    const afterSnap = await db.doc(`fabricMasters/${fabB}`).get();
    const after = afterSnap.data();
    console.log(`[1] fabric ${fabB} after rejected rename: name="${after?.name}", nameKey="${after?.nameKey}", updatedAt="${after?.updatedAt}".`);
    if (after?.name !== before?.name) fail(`[1] expected name unchanged ("${before?.name}"), got "${after?.name}".`);
    if (after?.nameKey !== before?.nameKey) fail(`[1] expected nameKey unchanged ("${before?.nameKey}"), got "${after?.nameKey}".`);
    if (after?.updatedAt !== before?.updatedAt) fail(`[1] expected updatedAt unchanged ("${before?.updatedAt}"), got "${after?.updatedAt}" — doc must be completely unmutated on rejection.`);
  }

  // ── Scenario 2: renaming B to a genuinely free name still succeeds ─────
  {
    try {
      await wrappedUpdate({ data: { id: fabB, updates: { name: "Poly Lining" } }, auth: { uid: dispatchUid, token: {} } });
      const snap = await db.doc(`fabricMasters/${fabB}`).get();
      const d = snap.data();
      console.log(`[2] rename to a free name: name="${d?.name}", nameKey="${d?.nameKey}".`);
      if (d?.name !== "Poly Lining") fail(`[2] expected name "Poly Lining", got "${d?.name}".`);
      if (d?.nameKey !== "poly lining") fail(`[2] expected nameKey "poly lining", got "${d?.nameKey}".`);
    } catch (err: any) {
      fail(`[2] expected a rename to a free name to succeed, but it threw: ${err?.code ?? err}`);
    }
  }

  // ── Scenario 3: a no-op "rename" to the fabric's OWN current name
  // (different case/whitespace) must NOT be rejected as a self-collision ──
  {
    try {
      await wrappedUpdate({ data: { id: fabB, updates: { name: "  POLY LINING  " } }, auth: { uid: dispatchUid, token: {} } });
      const snap = await db.doc(`fabricMasters/${fabB}`).get();
      const d = snap.data();
      console.log(`[3] self-rename (case/whitespace only): name="${d?.name}", nameKey="${d?.nameKey}".`);
      if (d?.name !== "POLY LINING") fail(`[3] expected trimmed name "POLY LINING", got "${d?.name}".`);
      if (d?.nameKey !== "poly lining") fail(`[3] expected nameKey "poly lining", got "${d?.nameKey}".`);
    } catch (err: any) {
      fail(`[3] expected a no-op rename to the fabric's own current name to succeed (current fabric must be excluded from its own collision check), but it threw: ${err?.code ?? err}`);
    }
  }

  if (!pass) {
    console.error("FABRIC UPDATE DUPLICATE-NAME REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log(
    "FABRIC UPDATE DUPLICATE-NAME REGRESSION TEST: PASS — renaming a fabric " +
    "to another fabric's name is rejected with already-exists and leaves " +
    "the document unmutated, a rename to a free name still works, and a " +
    "no-op rename to the fabric's own current name is not blocked as a " +
    "self-collision."
  );
}

main().catch((err) => {
  console.error("fabric update duplicate-name regression test crashed:", err);
  process.exitCode = 1;
});
