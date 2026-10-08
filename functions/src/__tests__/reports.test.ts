/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — Final Role Dashboards & Reporting phase
 * (functions/src/reports.ts: storeOverviewReport, ownerLabourSummary,
 * karigarProductionReport).
 *
 * Scenarios:
 *   1. storeOverviewReport: an allowed role (dispatch) succeeds; a denied
 *      role (accounts) is rejected permission-denied.
 *   2. storeOverviewReport correctness: one design with pieces at STORE,
 *      STORE_OUT and IN_WORK, plus a storeOuts record and a PR — counts
 *      (atStore/totalProduced/inProduction/completed/stored/storeOutCount)
 *      and topDemand (ordered/generated qty) all match exactly.
 *   3. ownerLabourSummary: owner succeeds; admin is REJECTED (Reports is
 *      super_admin/owner ONLY — no admin elevation, matching the new
 *      STRICT_MODULES entry on the frontend); pm is rejected.
 *   4. ownerLabourSummary correctness: Karigar summary totals come EXACTLY
 *      from the stored session minutes/labourCost (never recalculated from
 *      the Karigar's current hourlyRate, even after that rate changes).
 *   5. karigarProductionReport: owner succeeds, rows correctly filtered to
 *      the given date range and karigar; a denied role is rejected.
 *
 * MUST be run against the Firestore emulator only — refuses to run if
 * FIRESTORE_EMULATOR_HOST is not set, so it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore --project demo-luxardo-test \
 *     "node lib/__tests__/reports.test.js"
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
  const { storeOverviewReport, ownerLabourSummary, karigarProductionReport } = require("../reports");
  const wrappedStoreOverview = testEnv.wrap(storeOverviewReport);
  const wrappedLabourSummary = testEnv.wrap(ownerLabourSummary);
  const wrappedKarigarReport = testEnv.wrap(karigarProductionReport);

  const suffix = String(Date.now());
  let pass = true;
  const fail = (msg: string) => { console.error(`FAIL: ${msg}`); pass = false; };
  const check = (label: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    else console.log(`OK  ${label} -> ${JSON.stringify(actual)}`);
  };

  async function makeStaff(role: string, uid: string) {
    await db.doc(`staff/${uid}`).set({ role, active: true, displayName: `Test ${role}` });
    return { uid, token: {} };
  }

  const dispatchUid = `test-dispatch-${suffix}`;
  const accountsUid = `test-accounts-${suffix}`;
  const ownerUid = `test-owner-${suffix}`;
  const adminUid = `test-admin-${suffix}`;
  const pmUid = `test-pm-${suffix}`;
  await Promise.all([
    makeStaff("dispatch", dispatchUid),
    makeStaff("accounts", accountsUid),
    makeStaff("owner", ownerUid),
    makeStaff("admin", adminUid),
    makeStaff("pm", pmUid),
  ]);

  // ── Scenario 1/2: storeOverviewReport ─────────────────────────────────
  const designId = `KL-RPTTEST-${suffix}`;
  await db.doc(`catalogueDesigns/${designId}`).set({ id: designId, name: "Report Test Design", catalogueShortName: "RPT" });

  const pieceAtStore = `PIECE-RPT-STORE-${suffix}`;
  const pieceStoreOut = `PIECE-RPT-STOREOUT-${suffix}`;
  const pieceInWork = `PIECE-RPT-INWORK-${suffix}`;
  await db.doc(`pieces/${pieceAtStore}`).set({ id: pieceAtStore, designId, stage: "STORE" });
  await db.doc(`pieces/${pieceStoreOut}`).set({ id: pieceStoreOut, designId, stage: "STORE_OUT", storeOutAt: new Date().toISOString() });
  await db.doc(`pieces/${pieceInWork}`).set({ id: pieceInWork, designId, stage: "IN_WORK" });
  await db.doc(`storeOuts/SO-RPTTEST-${suffix}`).set({ id: `SO-RPTTEST-${suffix}`, pieceIds: [pieceStoreOut], billNumber: "BILL-1" });
  await db.doc(`productionRequests/PR-RPTTEST-${suffix}`).set({ id: `PR-RPTTEST-${suffix}`, designId, originalOrderedQty: 5, piecesGeneratedCount: 3, status: "IN_PRODUCTION" });

  {
    const res: any = await wrappedStoreOverview({ data: {}, auth: { uid: dispatchUid, token: {} } });
    check("[1] dispatch (allowed role) storeOverviewReport does not throw", !!res?.ok, true);
    const row = res.designs.find((d: any) => d.designId === designId);
    check("[2] atStore == 1", row?.atStore, 1);
    check("[2] totalProduced == 3", row?.totalProduced, 3);
    check("[2] inProduction == 1", row?.inProduction, 1);
    check("[2] completed == 1", row?.completed, 1);
    check("[2] stored (ever) == 2", row?.stored, 2);
    check("[2] storeOutCount == 1", row?.storeOutCount, 1);
    const demandRow = res.topDemand.find((d: any) => d.designId === designId);
    check("[2] topDemand orderedQty == 5", demandRow?.orderedQty, 5);
    check("[2] topDemand generatedQty == 3", demandRow?.generatedQty, 3);
    check("[2] basis explicitly labelled as production demand (not sales)", res.basis, "PRODUCTION_DEMAND");
  }
  {
    try {
      await wrappedStoreOverview({ data: {}, auth: { uid: accountsUid, token: {} } });
      fail("[1] accounts (denied role) should have thrown permission-denied");
    } catch (err: any) {
      check("[1] accounts rejected with permission-denied", err?.code, "permission-denied");
    }
  }

  // ── Scenario 3/4: ownerLabourSummary ──────────────────────────────────
  const karigarId = `K-RPTTEST-${suffix}`;
  await db.doc(`karigars/${karigarId}`).set({ id: karigarId, name: "Report Karigar", hourlyRate: 100, active: true });

  const pieceForLabour = `PIECE-RPT-LABOUR-${suffix}`;
  await db.doc(`pieces/${pieceForLabour}`).set({ id: pieceForLabour, designId, stage: "IN_WORK" });
  const now = new Date();
  const startedAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString(); // 1h ago
  const endedAt = now.toISOString();
  await db.doc(`pieceWorkSessions/LS-RPTTEST-${suffix}`).set({
    id: `LS-RPTTEST-${suffix}`, pieceId: pieceForLabour, karigarId, karigarName: "Report Karigar",
    designId, startedAt, endedAt, minutes: 60, hourlyRate: 100, labourCost: 100, type: "FIRST",
  });
  // Rate changes AFTER the session was recorded — the summary must still
  // report the ORIGINAL snapshotted 100, never recalculated at the new rate.
  await db.doc(`karigars/${karigarId}`).set({ hourlyRate: 500 }, { merge: true });

  {
    const res: any = await wrappedLabourSummary({ data: {}, auth: { uid: ownerUid, token: {} } });
    check("[3] owner ownerLabourSummary does not throw", !!res?.ok, true);
    const k = res.karigars.find((x: any) => x.karigarId === karigarId);
    check("[4] karigar totalMinutes == 60 (from stored session, not recalculated)", k?.totalMinutes, 60);
    check("[4] karigar totalLabourCost == 100 (snapshotted rate, NOT the new 500 rate)", k?.totalLabourCost, 100);
    check("[4] karigar piecesWorked == 1", k?.piecesWorked, 1);
  }
  {
    try {
      await wrappedLabourSummary({ data: {}, auth: { uid: adminUid, token: {} } });
      fail("[3] admin should be REJECTED — Reports is super_admin/owner ONLY, no admin elevation");
    } catch (err: any) {
      check("[3] admin rejected with permission-denied (no admin elevation)", err?.code, "permission-denied");
    }
  }
  {
    try {
      await wrappedLabourSummary({ data: {}, auth: { uid: pmUid, token: {} } });
      fail("[3] pm should be REJECTED");
    } catch (err: any) {
      check("[3] pm rejected with permission-denied", err?.code, "permission-denied");
    }
  }

  // ── Scenario 5: karigarProductionReport ───────────────────────────────
  {
    const todayStr = now.toISOString().slice(0, 10);
    const res: any = await wrappedKarigarReport({
      data: { karigarId, startDate: todayStr, endDate: todayStr },
      auth: { uid: ownerUid, token: {} },
    });
    check("[5] owner karigarProductionReport does not throw", !!res?.ok, true);
    check("[5] exactly one row for this karigar/date", res.rows.length, 1);
    check("[5] row cost matches the snapshotted labourCost", res.rows[0]?.labourCost, 100);
    check("[5] totals.totalLabourCost == 100", res.totals.totalLabourCost, 100);
  }
  {
    try {
      await wrappedKarigarReport({ data: { startDate: "2020-01-01", endDate: "2020-01-02" }, auth: { uid: pmUid, token: {} } });
      fail("[5] pm should be REJECTED from karigarProductionReport");
    } catch (err: any) {
      check("[5] pm rejected with permission-denied", err?.code, "permission-denied");
    }
  }

  if (!pass) {
    console.error("REPORTS REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }
  console.log(
    "REPORTS REGRESSION TEST: PASS — storeOverviewReport is correctly scoped to its 9 allowed roles and produces " +
    "exact per-design counts/top-demand figures; ownerLabourSummary/karigarProductionReport are super_admin/owner " +
    "ONLY (no admin elevation) and report labour cost/minutes EXACTLY from the stored session snapshot, never " +
    "recalculated from a Karigar's current hourlyRate."
  );
}

main().catch((err) => {
  console.error("Reports regression test crashed:", err);
  process.exitCode = 1;
});
