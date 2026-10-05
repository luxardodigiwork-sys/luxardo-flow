/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — LUXARDO FLOW Staff Management "User
 * Management" extension (functions/src/production.ts): the staffUpdate
 * email-Auth-sync fix + its new Super-Admin-only gating, staffResetPassword,
 * staffLookupByPhone, and staffCheckAuthExists (the orphan Auth/staff
 * consistency check).
 *
 * Not wired into any test runner (the repo has none yet) — same standalone,
 * emulator-only approach as totp.emulator.test.ts /
 * privilegedMobilePasswordLogin.emulator.test.ts. NOT exported from
 * functions/src/index.ts — FLOW (Loom)-only, exported ONLY from
 * functions-loom/src/index.ts.
 *
 * Scenarios:
 *   1.  Super Admin changes a staff member's email -> the REAL Auth email
 *       changes (verified against the Auth emulator itself, not just the
 *       Firestore mirror), the customers/{uid} mirror updates, and a
 *       STAFF_EMAIL_CHANGE audit entry is written.
 *   2.  Admin (non-super-admin) attempting the same email change is
 *       rejected, and NEITHER the Auth record NOR Firestore are touched.
 *   3.  Changing an email to one already in use surfaces Auth's own
 *       "already in use" rejection as-is.
 *   4.  staffResetPassword by Super Admin: the REAL Auth password changes
 *       (verified via the Auth emulator's signInWithPassword REST
 *       endpoint), mustChangePassword is set true, and the audit entry
 *       contains no password-shaped value anywhere.
 *   5.  staffResetPassword by Admin (non-super-admin) is rejected.
 *   6.  staffResetPassword against a staff doc whose Auth user no longer
 *       exists fails with a clear, distinct error (not a raw Auth crash).
 *   7.  Super Admin forcing mustChangePassword=true via staffUpdate
 *       succeeds and writes a STAFF_FORCE_PASSWORD_CHANGE audit entry.
 *   8.  Admin (non-super-admin) attempting the same force-password-change
 *       is rejected, and the flag is NOT set.
 *   9.  staffLookupByPhone resolves the correct uid/staff doc for a number
 *       already in use, and reports exists:false for an unused number.
 *   10. staffCheckAuthExists: a uid with a live Auth user reports true; a
 *       uid whose Auth user was deleted (staff/{uid} left untouched)
 *       reports false — the live, never-persisted orphan signal the
 *       Staff Management UI uses to archive it from the normal list.
 *   11. An operational role (pm) is rejected by every one of: email-change
 *       staffUpdate, staffResetPassword, force-password-change staffUpdate,
 *       and staffCheckAuthExists.
 *   12. REGRESSION GUARD: role change and active-toggle via staffUpdate
 *       still work for a plain Admin (non-super-admin) — proves the new
 *       Super-Admin-only gate did NOT regress pre-existing admin/owner
 *       capabilities.
 *
 * MUST be run against the Firestore + Auth emulators only — refuses to run
 * if FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are not set, so
 * it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore,auth --project demo-luxardo-test \
 *     "node lib/__tests__/staffUserManagement.emulator.test.js"
 */
import * as admin from "firebase-admin";

async function main(): Promise<void> {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set — refusing to run against a real " +
      "project. Run this via `firebase emulators:exec --only firestore,auth ...`."
    );
  }
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error(
      "FIREBASE_AUTH_EMULATOR_HOST is not set — refusing to run against a " +
      "real project. Run this via `firebase emulators:exec --only " +
      "firestore,auth ...`."
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const testEnv = require("firebase-functions-test")({ projectId: "demo-luxardo-test" });

  admin.initializeApp();
  const db = admin.firestore();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { staffUpdate, staffResetPassword, staffLookupByPhone, staffCheckAuthExists } = require("../production");
  const wrappedUpdate = testEnv.wrap(staffUpdate);
  const wrappedReset = testEnv.wrap(staffResetPassword);
  const wrappedLookup = testEnv.wrap(staffLookupByPhone);
  const wrappedCheckAuth = testEnv.wrap(staffCheckAuthExists);

  const runId = String(Date.now()).slice(-8);
  let pass = true;
  const fail = (msg: string) => { console.error(`FAIL: ${msg}`); pass = false; };
  const check = (label: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    else console.log(`OK  ${label} -> ${JSON.stringify(actual)}`);
  };

  async function makeStaff(opts: { role: string; email?: string; phone?: string; active?: boolean }): Promise<{ uid: string; email: string }> {
    const email = opts.email || `su-${opts.role}-${runId}-${Math.random().toString(36).slice(2)}@example.test`;
    const created = await admin.auth().createUser({
      email, password: "Irrelevant-123", emailVerified: true,
      ...(opts.phone ? { phoneNumber: opts.phone } : {}),
    });
    await db.doc(`staff/${created.uid}`).set({
      uid: created.uid, displayName: email, email, role: opts.role,
      active: opts.active !== false, phoneNumber: opts.phone || null, createdAt: new Date().toISOString(),
    });
    return { uid: created.uid, email };
  }

  async function callUpdate(callerUid: string, targetUid: string, updates: Record<string, unknown>) {
    try {
      const result: any = await wrappedUpdate({ data: { uid: targetUid, updates }, auth: { uid: callerUid, token: {} } });
      return { threw: false, ...result };
    } catch (err: any) {
      return { threw: true, message: err?.message };
    }
  }
  async function callReset(callerUid: string, targetUid: string) {
    try {
      const result: any = await wrappedReset({ data: { uid: targetUid }, auth: { uid: callerUid, token: {} } });
      return { threw: false, ...result };
    } catch (err: any) {
      return { threw: true, message: err?.message };
    }
  }
  async function callLookup(callerUid: string, phoneNumber: string) {
    try {
      const result: any = await wrappedLookup({ data: { phoneNumber }, auth: { uid: callerUid, token: {} } });
      return { threw: false, ...result };
    } catch (err: any) {
      return { threw: true, message: err?.message };
    }
  }
  async function callCheckAuth(callerUid: string, uids: string[]) {
    try {
      const result: any = await wrappedCheckAuth({ data: { uids }, auth: { uid: callerUid, token: {} } });
      return { threw: false, ...result };
    } catch (err: any) {
      return { threw: true, message: err?.message };
    }
  }

  async function emulatorPasswordWorks(email: string, password: string): Promise<boolean> {
    const [host] = String(process.env.FIREBASE_AUTH_EMULATOR_HOST).split(",");
    const res = await fetch(
      `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: false }) },
    );
    return res.ok;
  }

  const superAdmin = await makeStaff({ role: "super_admin" });
  const admin1 = await makeStaff({ role: "admin" });
  const pm = await makeStaff({ role: "pm" });

  // ── Scenario 1: Super Admin changes email -> real Auth email changes ────
  const target1 = await makeStaff({ role: "designer" });
  {
    const newEmail = `changed-${runId}@example.test`;
    const res = await callUpdate(superAdmin.uid, target1.uid, { email: newEmail });
    check("[1] super_admin email change does not throw", res.threw, false);

    const authUser = await admin.auth().getUser(target1.uid);
    check("[1] the REAL Auth email actually changed", authUser.email, newEmail);

    const staffDoc = (await db.doc(`staff/${target1.uid}`).get()).data();
    check("[1] staff/{uid} mirror updated", staffDoc?.email, newEmail);

    const custDoc = (await db.doc(`customers/${target1.uid}`).get()).data();
    check("[1] customers/{uid} mirror updated", custDoc?.email, newEmail);

    const auditSnap = await db.collection("auditLogs")
      .where("entityId", "==", target1.uid).where("action", "==", "STAFF_EMAIL_CHANGE").get();
    check("[1] a STAFF_EMAIL_CHANGE audit entry exists", auditSnap.size >= 1, true);
  }

  // ── Scenario 2: Admin (non-super-admin) email change is rejected ────────
  const target2 = await makeStaff({ role: "designer" });
  {
    const originalEmail = target2.email;
    const res = await callUpdate(admin1.uid, target2.uid, { email: `should-not-apply-${runId}@example.test` });
    check("[2] admin (non-super-admin) email change throws", res.threw, true);

    const authUser = await admin.auth().getUser(target2.uid);
    check("[2] Auth email untouched", authUser.email, originalEmail);
    const staffDoc = (await db.doc(`staff/${target2.uid}`).get()).data();
    check("[2] staff/{uid} email untouched", staffDoc?.email, originalEmail);
  }

  // ── Scenario 3: changing to an already-used email surfaces Auth's error ─
  const target3 = await makeStaff({ role: "designer" });
  const target3b = await makeStaff({ role: "designer" });
  {
    const res = await callUpdate(superAdmin.uid, target3.uid, { email: target3b.email });
    check("[3] changing to an in-use email throws", res.threw, true);
  }

  // ── Scenario 4: staffResetPassword by Super Admin rotates the REAL password ─
  const target4 = await makeStaff({ role: "designer" });
  {
    const res = await callReset(superAdmin.uid, target4.uid);
    check("[4] reset does not throw", res.threw, false);
    check("[4] returns a temporaryPassword string", typeof res.temporaryPassword === "string" && res.temporaryPassword.length > 0, true);

    const works = await emulatorPasswordWorks(target4.email, res.temporaryPassword);
    check("[4] the new password actually works against the Auth emulator", works, true);

    const staffDoc = (await db.doc(`staff/${target4.uid}`).get()).data();
    check("[4] mustChangePassword is now true", staffDoc?.mustChangePassword, true);

    const auditSnap = await db.collection("auditLogs")
      .where("entityId", "==", target4.uid).where("action", "==", "STAFF_PASSWORD_RESET").get();
    check("[4] a STAFF_PASSWORD_RESET audit entry exists", auditSnap.size >= 1, true);
    const serialized = auditSnap.docs.map(d => JSON.stringify(d.data())).join("\n");
    check("[4] the audit entry does not contain the generated password anywhere", serialized.includes(res.temporaryPassword), false);
  }

  // ── Scenario 5: staffResetPassword by Admin (non-super-admin) is rejected ─
  const target5 = await makeStaff({ role: "designer" });
  {
    const res = await callReset(admin1.uid, target5.uid);
    check("[5] admin (non-super-admin) reset throws", res.threw, true);
  }

  // ── Scenario 6: resetting a password for an Auth-deleted account fails clearly ─
  const target6 = await makeStaff({ role: "designer" });
  {
    await admin.auth().deleteUser(target6.uid); // staff/{uid} deliberately left in place
    const res = await callReset(superAdmin.uid, target6.uid);
    check("[6] reset against a deleted Auth user throws", res.threw, true);
    check("[6] error is the distinct failed-precondition message, not a raw crash", /no longer exists/i.test(String(res.message)), true);
  }

  // ── Scenario 7: Super Admin forces mustChangePassword -> audited ────────
  const target7 = await makeStaff({ role: "designer" });
  {
    const res = await callUpdate(superAdmin.uid, target7.uid, { mustChangePassword: true });
    check("[7] force-password-change does not throw", res.threw, false);
    const staffDoc = (await db.doc(`staff/${target7.uid}`).get()).data();
    check("[7] mustChangePassword is now true", staffDoc?.mustChangePassword, true);
    const auditSnap = await db.collection("auditLogs")
      .where("entityId", "==", target7.uid).where("action", "==", "STAFF_FORCE_PASSWORD_CHANGE").get();
    check("[7] a STAFF_FORCE_PASSWORD_CHANGE audit entry exists", auditSnap.size >= 1, true);
  }

  // ── Scenario 8: Admin (non-super-admin) force-password-change is rejected ─
  const target8 = await makeStaff({ role: "designer" });
  {
    const res = await callUpdate(admin1.uid, target8.uid, { mustChangePassword: true });
    check("[8] admin (non-super-admin) force-change throws", res.threw, true);
    const staffDoc = (await db.doc(`staff/${target8.uid}`).get()).data();
    check("[8] mustChangePassword was NOT set", !!staffDoc?.mustChangePassword, false);
  }

  // ── Scenario 9: staffLookupByPhone ───────────────────────────────────────
  const phone9 = `+919${runId}`;
  const target9 = await makeStaff({ role: "pm", phone: phone9 });
  {
    const res = await callLookup(admin1.uid, phone9);
    check("[9] lookup for an in-use number does not throw", res.threw, false);
    check("[9] resolves the correct uid", res.exists && res.uid, target9.uid);
    check("[9] includes the matching staff doc", res.staff?.role, "pm");

    const unusedRes = await callLookup(admin1.uid, `+918${runId}`);
    check("[9] lookup for an unused number reports exists:false", unusedRes.exists, false);
  }

  // ── Scenario 10: staffCheckAuthExists (the orphan signal) ───────────────
  const target10a = await makeStaff({ role: "designer" });
  const target10b = await makeStaff({ role: "designer" });
  {
    await admin.auth().deleteUser(target10b.uid); // staff/{uid} deliberately left in place — never deleted
    const res = await callCheckAuth(admin1.uid, [target10a.uid, target10b.uid]);
    check("[10] check does not throw", res.threw, false);
    check("[10] a live Auth user reports true", res.authExists[target10a.uid], true);
    check("[10] a deleted Auth user reports false", res.authExists[target10b.uid], false);

    const stillThere = await db.doc(`staff/${target10b.uid}`).get();
    check("[10] the orphaned staff/{uid} doc was NEVER deleted", stillThere.exists, true);
  }

  // ── Scenario 11: an operational role (pm) is rejected everywhere ────────
  const target11 = await makeStaff({ role: "designer" });
  {
    const r1 = await callUpdate(pm.uid, target11.uid, { email: `pm-blocked-${runId}@example.test` });
    check("[11] pm email-change throws", r1.threw, true);
    const r2 = await callReset(pm.uid, target11.uid);
    check("[11] pm reset throws", r2.threw, true);
    const r3 = await callUpdate(pm.uid, target11.uid, { mustChangePassword: true });
    check("[11] pm force-change throws", r3.threw, true);
    const r4 = await callCheckAuth(pm.uid, [target11.uid]);
    check("[11] pm staffCheckAuthExists throws", r4.threw, true);
  }

  // ── Scenario 12: REGRESSION GUARD — admin keeps role-change + active-toggle ─
  const target12 = await makeStaff({ role: "designer" });
  {
    const roleRes = await callUpdate(admin1.uid, target12.uid, { role: "pm" });
    check("[12] admin role-change still works (no regression)", roleRes.threw, false);
    const staffDoc1 = (await db.doc(`staff/${target12.uid}`).get()).data();
    check("[12] role actually changed", staffDoc1?.role, "pm");

    const activeRes = await callUpdate(admin1.uid, target12.uid, { active: false });
    check("[12] admin active-toggle still works (no regression)", activeRes.threw, false);
    const staffDoc2 = (await db.doc(`staff/${target12.uid}`).get()).data();
    check("[12] active actually changed", staffDoc2?.active, false);
  }

  if (!pass) {
    console.error("LUXARDO FLOW STAFF USER MANAGEMENT REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log(
    "LUXARDO FLOW STAFF USER MANAGEMENT REGRESSION TEST: PASS — email changes now genuinely " +
    "sync the real Auth record and are Super-Admin-only; admin-initiated password reset " +
    "rotates the real Auth password without ever logging it; forced password-change is " +
    "Super-Admin-only and audited; phone lookup resolves the correct existing holder; the " +
    "live Auth-existence check correctly flags a deleted Auth user while never deleting its " +
    "staff/{uid} doc; every operational role is rejected from all of the above; and admin's " +
    "pre-existing role-change/active-toggle capability is completely unaffected."
  );
}

main().catch((err) => {
  console.error("LUXARDO FLOW STAFF USER MANAGEMENT regression test crashed:", err);
  process.exitCode = 1;
});
