/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — LUXARDO FLOW "complete Super Admin control"
 * User Management simplification (functions/src/production.ts):
 * staffCreate, staffUpdate, staffDelete, staffResetPassword,
 * staffLookupByPhone, and the new post/salaryPerHour/salaryPerDay fields.
 *
 * Not wired into any test runner (the repo has none yet) — same
 * standalone, emulator-only approach as the other *.emulator.test.ts
 * files. NOT exported from functions/src/index.ts — FLOW (Loom)-only,
 * exported ONLY from functions-loom/src/index.ts.
 *
 * Every staff-account mutation is now Super-Admin-only (no more admin/
 * owner tier) — this file's "Admin (non-super-admin)" scenarios
 * deliberately assert REJECTION where an earlier version of this feature
 * asserted the opposite (admin could create/edit/activate staff). That
 * flip is intentional: see the "REGRESSION GUARD" scenario below.
 *
 * Scenarios:
 *   1.  Super Admin changes a staff member's email -> the REAL Auth email
 *       changes, the customers/{uid} mirror updates, and a
 *       STAFF_EMAIL_CHANGE audit entry is written.
 *   2.  Admin (non-super-admin) attempting ANY mutation (email, role,
 *       active, mobile, post, salary) is rejected — Super Admin only now.
 *   3.  Changing an email to one already in use surfaces Auth's own
 *       rejection as-is.
 *   4.  staffResetPassword by Super Admin: the REAL Auth password changes,
 *       mustChangePassword is set true, and the audit entry contains no
 *       password-shaped value anywhere.
 *   5.  staffResetPassword by Admin is rejected.
 *   6.  staffResetPassword against a staff doc whose Auth user no longer
 *       exists fails with a clear, distinct error.
 *   7.  Super Admin forcing mustChangePassword=true writes a
 *       STAFF_FORCE_PASSWORD_CHANGE audit entry.
 *   8.  Admin attempting the same force-password-change is rejected.
 *   9.  staffLookupByPhone: Super Admin succeeds; Admin is now REJECTED
 *       (tightened from the previous admin-tier read access).
 *   10. staffCreate ("Add User") by Admin is REJECTED — creation is now
 *       Super-Admin-only.
 *   11. An operational role (pm) is rejected by every one of: staffCreate,
 *       email-change staffUpdate, role-change staffUpdate, active-toggle
 *       staffUpdate, staffResetPassword, staffDelete, and
 *       staffLookupByPhone.
 *   12. REGRESSION GUARD (intentionally flipped): Admin (non-super-admin)
 *       is now REJECTED from role-change AND active-toggle too — these
 *       used to be admin/owner-tier; they are Super-Admin-only now.
 *   13. Super Admin edits mobile number -> the REAL Auth phone AND
 *       staff/{uid}.phoneNumber both update (never a Firestore-only
 *       write).
 *   14. Super Admin tries to set a phone already used by ANOTHER staff
 *       member -> rejected with a clear "already assigned to another
 *       account" message; the target's phone is left UNCHANGED; no
 *       duplicate Auth identity is ever created.
 *   15. staffCreate ("Add User") with a phone already in use by an
 *       existing account -> rejected BEFORE any Auth user is created
 *       (verified: the intended new email never resolves to an Auth
 *       user afterward).
 *   16. staffDelete by Super Admin: the REAL Auth user, staff/{uid}, and
 *       its customers/{uid} mirror (staffLinked) are all gone, and a
 *       STAFF_DELETE audit entry preserves the pre-delete snapshot.
 *   17. staffDelete by Admin (non-super-admin) is rejected; nothing is
 *       deleted.
 *   18. staffDelete of the CALLER'S OWN uid is rejected (self-delete
 *       guard).
 *   19. staffDelete of the ONLY remaining 'owner' record is rejected EVEN
 *       WHEN that record is active:false; deleting one of TWO 'owner'
 *       records succeeds.
 *   20. staffDelete on a uid whose Auth user was ALREADY removed (e.g. via
 *       Console) still cleans up staff/{uid} + customers/{uid} and
 *       succeeds, rather than throwing.
 *   21. staffDelete does NOT delete a customers/{uid} doc that exists but
 *       is missing the staffLinked:true marker (defense-in-depth guard) —
 *       staff/{uid} is still deleted.
 *   22. post / salaryPerHour / salaryPerDay: validation (rejects a
 *       negative number) and a successful Super Admin update.
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
  const { staffCreate, staffUpdate, staffDelete, staffResetPassword, staffLookupByPhone } = require("../production");
  const wrappedCreate = testEnv.wrap(staffCreate);
  const wrappedUpdate = testEnv.wrap(staffUpdate);
  const wrappedDelete = testEnv.wrap(staffDelete);
  const wrappedReset = testEnv.wrap(staffResetPassword);
  const wrappedLookup = testEnv.wrap(staffLookupByPhone);

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

  async function callCreate(callerUid: string, data: Record<string, unknown>) {
    try {
      const result: any = await wrappedCreate({ data, auth: { uid: callerUid, token: {} } });
      return { threw: false, ...result };
    } catch (err: any) {
      return { threw: true, message: err?.message };
    }
  }
  async function callUpdate(callerUid: string, targetUid: string, updates: Record<string, unknown>) {
    try {
      const result: any = await wrappedUpdate({ data: { uid: targetUid, updates }, auth: { uid: callerUid, token: {} } });
      return { threw: false, ...result };
    } catch (err: any) {
      return { threw: true, message: err?.message };
    }
  }
  async function callDelete(callerUid: string, targetUid: string) {
    try {
      const result: any = await wrappedDelete({ data: { uid: targetUid }, auth: { uid: callerUid, token: {} } });
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

  async function authExists(uid: string): Promise<boolean> {
    try { await admin.auth().getUser(uid); return true; }
    catch { return false; }
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

  // ── Scenario 2: Admin (non-super-admin) is rejected from EVERY mutation ─
  const target2 = await makeStaff({ role: "designer", phone: `+914${runId}` });
  {
    const originalEmail = target2.email;
    const r1 = await callUpdate(admin1.uid, target2.uid, { email: `should-not-apply-${runId}@example.test` });
    check("[2] admin email change throws", r1.threw, true);
    const r2 = await callUpdate(admin1.uid, target2.uid, { role: "pm" });
    check("[2] admin role change throws", r2.threw, true);
    const r3 = await callUpdate(admin1.uid, target2.uid, { active: false });
    check("[2] admin active-toggle throws", r3.threw, true);
    const r4 = await callUpdate(admin1.uid, target2.uid, { phoneNumber: `+918${runId}` });
    check("[2] admin mobile change throws", r4.threw, true);
    const r5 = await callUpdate(admin1.uid, target2.uid, { post: "Should Not Apply" });
    check("[2] admin post change throws", r5.threw, true);
    const r6 = await callUpdate(admin1.uid, target2.uid, { salaryPerDay: 500 });
    check("[2] admin salary change throws", r6.threw, true);

    const authUser = await admin.auth().getUser(target2.uid);
    check("[2] Auth email untouched", authUser.email, originalEmail);
    const staffDoc = (await db.doc(`staff/${target2.uid}`).get()).data();
    check("[2] staff/{uid} completely untouched", JSON.stringify({ email: staffDoc?.email, role: staffDoc?.role, active: staffDoc?.active, post: staffDoc?.post }),
      JSON.stringify({ email: originalEmail, role: "designer", active: true, post: undefined }));
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
    check("[5] admin reset throws", res.threw, true);
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
    check("[8] admin force-change throws", res.threw, true);
    const staffDoc = (await db.doc(`staff/${target8.uid}`).get()).data();
    check("[8] mustChangePassword was NOT set", !!staffDoc?.mustChangePassword, false);
  }

  // ── Scenario 9: staffLookupByPhone — Super Admin ok, Admin now rejected ──
  const phone9 = `+919${runId}`;
  const target9 = await makeStaff({ role: "pm", phone: phone9 });
  {
    const res = await callLookup(superAdmin.uid, phone9);
    check("[9] super_admin lookup does not throw", res.threw, false);
    check("[9] resolves the correct uid", res.exists && res.uid, target9.uid);

    const adminRes = await callLookup(admin1.uid, phone9);
    check("[9] admin lookup is now rejected", adminRes.threw, true);
  }

  // ── Scenario 10: staffCreate ("Add User") by Admin is rejected ──────────
  {
    const res = await callCreate(admin1.uid, {
      displayName: "Should Not Exist", email: `admin-created-${runId}@example.test`, role: "designer", password: "Temp-Pass-123",
    });
    check("[10] admin-initiated staffCreate throws", res.threw, true);
  }

  // ── Scenario 11: an operational role (pm) is rejected everywhere ───────
  const target11 = await makeStaff({ role: "designer" });
  {
    const r1 = await callCreate(pm.uid, { displayName: "X", email: `pm-created-${runId}@example.test`, role: "designer", password: "Temp-Pass-123" });
    check("[11] pm staffCreate throws", r1.threw, true);
    const r2 = await callUpdate(pm.uid, target11.uid, { email: `pm-blocked-${runId}@example.test` });
    check("[11] pm email-change throws", r2.threw, true);
    const r3 = await callUpdate(pm.uid, target11.uid, { role: "guard" });
    check("[11] pm role-change throws", r3.threw, true);
    const r4 = await callUpdate(pm.uid, target11.uid, { active: false });
    check("[11] pm active-toggle throws", r4.threw, true);
    const r5 = await callReset(pm.uid, target11.uid);
    check("[11] pm reset throws", r5.threw, true);
    const r6 = await callDelete(pm.uid, target11.uid);
    check("[11] pm delete throws", r6.threw, true);
    const r7 = await callLookup(pm.uid, phone9);
    check("[11] pm lookup throws", r7.threw, true);
  }

  // ── Scenario 12: REGRESSION GUARD (flipped) — admin NO LONGER has
  // role-change / active-toggle; this used to assert the opposite. ───────
  const target12 = await makeStaff({ role: "designer" });
  {
    const roleRes = await callUpdate(admin1.uid, target12.uid, { role: "pm" });
    check("[12] admin role-change is now rejected (was previously allowed)", roleRes.threw, true);
    const staffDoc1 = (await db.doc(`staff/${target12.uid}`).get()).data();
    check("[12] role unchanged", staffDoc1?.role, "designer");

    const activeRes = await callUpdate(admin1.uid, target12.uid, { active: false });
    check("[12] admin active-toggle is now rejected (was previously allowed)", activeRes.threw, true);
    const staffDoc2 = (await db.doc(`staff/${target12.uid}`).get()).data();
    check("[12] active unchanged", staffDoc2?.active, true);
  }

  // ── Scenario 13: Super Admin mobile edit syncs Auth AND Firestore ──────
  const target13 = await makeStaff({ role: "designer" });
  {
    const newPhone = `+917${runId}`;
    const res = await callUpdate(superAdmin.uid, target13.uid, { phoneNumber: newPhone });
    check("[13] mobile edit does not throw", res.threw, false);
    const authUser = await admin.auth().getUser(target13.uid);
    check("[13] the REAL Auth phone changed", authUser.phoneNumber, newPhone);
    const staffDoc = (await db.doc(`staff/${target13.uid}`).get()).data();
    check("[13] staff/{uid}.phoneNumber mirror updated", staffDoc?.phoneNumber, newPhone);
  }

  // ── Scenario 14: assigning an already-taken phone is rejected cleanly ───
  const phone14 = `+916${runId}`;
  const holder14 = await makeStaff({ role: "designer", phone: phone14 });
  const target14 = await makeStaff({ role: "designer" });
  {
    const res = await callUpdate(superAdmin.uid, target14.uid, { phoneNumber: phone14 });
    check("[14] assigning a taken phone throws", res.threw, true);
    check("[14] error names the conflict clearly", /already assigned to another account/i.test(String(res.message)), true);
    const targetDoc = (await db.doc(`staff/${target14.uid}`).get()).data();
    check("[14] target's phoneNumber is unchanged (still null)", targetDoc?.phoneNumber ?? null, null);
    const targetAuth = await admin.auth().getUser(target14.uid);
    check("[14] target's Auth phone is unchanged (still none)", targetAuth.phoneNumber ?? null, null);
    const holderAuth = await admin.auth().getUser(holder14.uid);
    check("[14] original holder keeps the number — no duplicate identity created", holderAuth.phoneNumber, phone14);
  }

  // ── Scenario 15: staffCreate with an already-taken phone is rejected
  // BEFORE any Auth user is created ───────────────────────────────────────
  const phone15 = `+915${runId}`;
  await makeStaff({ role: "designer", phone: phone15 });
  {
    const newEmail15 = `never-created-${runId}@example.test`;
    const res = await callCreate(superAdmin.uid, {
      displayName: "Should Not Be Created", email: newEmail15, role: "designer",
      password: "Temp-Pass-123", phoneNumber: phone15,
    });
    check("[15] staffCreate with a taken phone throws", res.threw, true);
    check("[15] error names the conflict clearly", /already assigned to another account/i.test(String(res.message)), true);
    let createdAnyway = false;
    try { await admin.auth().getUserByEmail(newEmail15); createdAnyway = true; } catch {}
    check("[15] no Auth user was created for the rejected email", createdAnyway, false);
  }

  // ── Scenario 16: staffDelete by Super Admin — Auth + Firestore + mirror ─
  const target16 = await makeStaff({ role: "designer" });
  {
    const before = (await db.doc(`staff/${target16.uid}`).get()).data();
    const res = await callDelete(superAdmin.uid, target16.uid);
    check("[16] delete does not throw", res.threw, false);
    check("[16] Auth user is gone", await authExists(target16.uid), false);
    check("[16] staff/{uid} is gone", (await db.doc(`staff/${target16.uid}`).get()).exists, false);
    check("[16] customers/{uid} mirror is gone", (await db.doc(`customers/${target16.uid}`).get()).exists, false);
    const auditSnap = await db.collection("auditLogs")
      .where("entityId", "==", target16.uid).where("action", "==", "STAFF_DELETE").get();
    check("[16] a STAFF_DELETE audit entry exists", auditSnap.size >= 1, true);
    const auditBefore = auditSnap.docs[0]?.data()?.before;
    check("[16] the audit entry preserves the pre-delete email", auditBefore?.email, before?.email);
  }

  // ── Scenario 17: staffDelete by Admin (non-super-admin) is rejected ─────
  const target17 = await makeStaff({ role: "designer" });
  {
    const res = await callDelete(admin1.uid, target17.uid);
    check("[17] admin delete throws", res.threw, true);
    check("[17] staff/{uid} still exists", (await db.doc(`staff/${target17.uid}`).get()).exists, true);
    check("[17] Auth user still exists", await authExists(target17.uid), true);
  }

  // ── Scenario 18: self-delete is rejected ────────────────────────────────
  {
    const res = await callDelete(superAdmin.uid, superAdmin.uid);
    check("[18] self-delete throws", res.threw, true);
    check("[18] caller's own staff/{uid} still exists", (await db.doc(`staff/${superAdmin.uid}`).get()).exists, true);
  }

  // ── Scenario 19: last-Owner guard — counts regardless of active state ──
  // The Firestore emulator is SHARED across every test file in one
  // `emulators:exec` run — several unrelated test files (totp,
  // staffMobilePasswordLogin, productionPhotoUpload, etc.) create their
  // own 'owner' staff/{uid} fixtures as part of their own scenarios.
  // Clear every pre-existing one first (direct Admin SDK delete, not
  // staffDelete — those tests have already run and asserted their own
  // PASS by this point) so this scenario's "the only Owner" assertions
  // are deterministic rather than depending on execution order.
  {
    const preExisting = await db.collection("staff").where("role", "==", "owner").get();
    for (const doc of preExisting.docs) {
      try { await admin.auth().deleteUser(doc.id); } catch {}
      await doc.ref.delete();
    }
  }
  const owner19a = await makeStaff({ role: "owner", active: false }); // inactive duplicate
  {
    // Only one 'owner' staff doc exists right now (owner19a) — deleting it
    // must be rejected even though it is INACTIVE.
    const resLast = await callDelete(superAdmin.uid, owner19a.uid);
    check("[19] deleting the only Owner (inactive) is rejected", resLast.threw, true);
    check("[19] last-Owner error is clear", /last remaining owner/i.test(String(resLast.message)), true);
    check("[19] owner19a still exists", (await db.doc(`staff/${owner19a.uid}`).get()).exists, true);

    // Add a second Owner — now deleting either one should succeed.
    const owner19b = await makeStaff({ role: "owner", active: true });
    const resOk = await callDelete(superAdmin.uid, owner19a.uid);
    check("[19] deleting one of TWO Owners succeeds", resOk.threw, false);
    check("[19] owner19a is now gone", (await db.doc(`staff/${owner19a.uid}`).get()).exists, false);
    check("[19] owner19b (the remaining Owner) is untouched", (await db.doc(`staff/${owner19b.uid}`).get()).exists, true);
  }

  // ── Scenario 20: staffDelete tolerates an already-Auth-deleted account ──
  const target20 = await makeStaff({ role: "designer" });
  {
    await admin.auth().deleteUser(target20.uid); // simulate prior Console deletion
    const res = await callDelete(superAdmin.uid, target20.uid);
    check("[20] delete of an already-Auth-gone uid does not throw", res.threw, false);
    check("[20] staff/{uid} is now cleaned up", (await db.doc(`staff/${target20.uid}`).get()).exists, false);
  }

  // ── Scenario 21: customers/{uid} without staffLinked:true is NEVER deleted ─
  const target21 = await makeStaff({ role: "designer" });
  {
    // Overwrite the mirror staffCreate wrote, removing the staffLinked marker
    // — simulates a doc that this mechanism cannot unambiguously claim as its
    // own disposable mirror.
    await db.doc(`customers/${target21.uid}`).set({ id: target21.uid, name: "Ambiguous", email: target21.email, role: "designer" });
    const res = await callDelete(superAdmin.uid, target21.uid);
    check("[21] delete does not throw", res.threw, false);
    check("[21] staff/{uid} is deleted", (await db.doc(`staff/${target21.uid}`).get()).exists, false);
    check("[21] customers/{uid} WITHOUT staffLinked is preserved, not deleted", (await db.doc(`customers/${target21.uid}`).get()).exists, true);
  }

  // ── Scenario 22: post / salaryPerHour / salaryPerDay ────────────────────
  const target22 = await makeStaff({ role: "designer" });
  {
    const badRes = await callUpdate(superAdmin.uid, target22.uid, { salaryPerHour: -5 });
    check("[22] a negative salaryPerHour is rejected", badRes.threw, true);

    const okRes = await callUpdate(superAdmin.uid, target22.uid, {
      post: "Production Manager", salaryPerHour: 150, salaryPerDay: 1200,
    });
    check("[22] a valid post/salary update does not throw", okRes.threw, false);
    const doc = (await db.doc(`staff/${target22.uid}`).get()).data();
    check("[22] post persisted", doc?.post, "Production Manager");
    check("[22] salaryPerHour persisted", doc?.salaryPerHour, 150);
    check("[22] salaryPerDay persisted", doc?.salaryPerDay, 1200);
  }

  if (!pass) {
    console.error("LUXARDO FLOW STAFF USER MANAGEMENT REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log(
    "LUXARDO FLOW STAFF USER MANAGEMENT REGRESSION TEST: PASS — every staff-account " +
    "mutation (create, update, delete, reset password, phone lookup) is now Super-Admin-only " +
    "with no admin/owner carve-out; mobile edits sync Auth AND Firestore together and a " +
    "proactive phone-uniqueness check rejects collisions with a clear message and never " +
    "creates a duplicate identity; staffDelete removes the Auth user + staff/{uid} + a " +
    "clearly-marked customer mirror while preserving audit history, guards against self-" +
    "delete and against deleting the last Owner (even inactive), tolerates an already-" +
    "Auth-deleted account, and never deletes a customers/{uid} doc it can't unambiguously " +
    "claim as its own; and the new post/salaryPerHour/salaryPerDay fields validate and " +
    "persist correctly."
  );
}

main().catch((err) => {
  console.error("LUXARDO FLOW STAFF USER MANAGEMENT regression test crashed:", err);
  process.exitCode = 1;
});
