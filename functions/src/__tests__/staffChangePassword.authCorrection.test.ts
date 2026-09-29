/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — LUXARDO FLOW authentication correction:
 * mandatory first-login password change (staffChangePassword).
 *
 * Not wired into any test runner (the repo has none yet) — same standalone,
 * emulator-only approach as tailorRequests.high2.test.ts / production.med3
 * .test.ts. NOT exported from functions/src/index.ts, so it is never
 * bundled/deployed.
 *
 * Scenarios:
 *   1. Default-password first-login detection — provisionStaffAccount
 *      (used by staffCreate) sets staff/{uid}.mustChangePassword = true on
 *      every new account.
 *   2. Mandatory change rejects a too-short new password (<8 chars) and
 *      leaves mustChangePassword untouched (still true).
 *   3. Successful password-change state transition — staffChangePassword
 *      actually rotates the Firebase Auth password (verified against the
 *      Auth EMULATOR's own REST sign-in endpoint, not just "no throw"),
 *      clears mustChangePassword -> false, and writes a
 *      STAFF_PASSWORD_CHANGED audit entry.
 *   4. Unauthorized-role access rejection — a DEACTIVATED staff account
 *      cannot call staffChangePassword at all (requireStaff fails closed),
 *      and its mustChangePassword / Auth password are both left untouched.
 *
 * MUST be run against the Firestore + Auth emulators only — refuses to run
 * if FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are not set, so
 * it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore,auth --project demo-luxardo-test \
 *     "node lib/__tests__/staffChangePassword.authCorrection.test.js"
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
  const { provisionStaffAccount, staffChangePassword } = require("../production");
  const wrappedChangePassword = testEnv.wrap(staffChangePassword);

  const runId = String(Date.now());
  let pass = true;
  const fail = (msg: string) => {
    console.error(`FAIL: ${msg}`);
    pass = false;
  };
  const check = (label: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    else console.log(`OK  ${label} -> ${JSON.stringify(actual)}`);
  };

  // Signs in against the AUTH EMULATOR's own REST endpoint — the only way to
  // genuinely confirm the Firebase Auth password itself was rotated, not
  // just that the callable returned without throwing.
  async function emulatorSignInSucceeds(email: string, password: string): Promise<boolean> {
    const [host] = String(process.env.FIREBASE_AUTH_EMULATOR_HOST).split(",");
    const res = await fetch(
      `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );
    return res.ok;
  }

  async function findAudit(action: string, entityId: string): Promise<admin.firestore.QueryDocumentSnapshot | null> {
    const snap = await db.collection("auditLogs")
      .where("action", "==", action)
      .where("entityId", "==", entityId)
      .get();
    return snap.docs[0] || null;
  }

  // ── Scenario 1: new account starts mustChangePassword: true ──────────────
  const email = `authcorrection-${runId}@example.test`;
  const initialPassword = `Initial-${runId}`;
  const { uid } = await provisionStaffAccount({
    displayName: "Test First Login", email, role: "pm",
    createdByUid: "test-admin-uid", password: initialPassword,
  });
  {
    const doc = (await db.doc(`staff/${uid}`).get()).data();
    check("[1] new staff doc starts mustChangePassword=true", !!doc?.mustChangePassword, true);
    check("[1] initial password actually works at the Auth emulator", await emulatorSignInSucceeds(email, initialPassword), true);
  }

  // ── Scenario 2: too-short new password is rejected, flag untouched ──────
  {
    let threw = false;
    try {
      await wrappedChangePassword({ data: { newPassword: "short" }, auth: { uid, token: {} } });
    } catch (err: any) {
      threw = true;
      console.log(`[2] correctly rejected a too-short password: ${err?.message ?? err}`);
    }
    check("[2] a <8-character password is rejected", threw, true);
    const doc = (await db.doc(`staff/${uid}`).get()).data();
    check("[2] mustChangePassword is still true after the rejected attempt", !!doc?.mustChangePassword, true);
    check("[2] the OLD password still works (nothing was changed)", await emulatorSignInSucceeds(email, initialPassword), true);
  }

  // ── Scenario 3: a valid change rotates the password AND clears the flag ──
  const newPassword = `Rotated-${runId}-Password`;
  {
    const result: any = await wrappedChangePassword({ data: { newPassword }, auth: { uid, token: {} } });
    check("[3] staffChangePassword returns ok:true", result?.ok, true);
    check("[3] the NEW password now works at the Auth emulator", await emulatorSignInSucceeds(email, newPassword), true);
    check("[3] the OLD password no longer works", await emulatorSignInSucceeds(email, initialPassword), false);

    const doc = (await db.doc(`staff/${uid}`).get()).data();
    check("[3] mustChangePassword is now false", doc?.mustChangePassword, false);

    const audit = await findAudit("STAFF_PASSWORD_CHANGED", uid);
    if (!audit) {
      fail("[3] expected a STAFF_PASSWORD_CHANGED audit entry, found none.");
    } else {
      const data = audit.data();
      check("[3] audit before.mustChangePassword", data.before?.mustChangePassword, true);
      check("[3] audit after.mustChangePassword", data.after?.mustChangePassword, false);
      check("[3] audit actorUid is the User themself (self-service)", data.actorUid, uid);
    }
  }

  // ── Scenario 4: a deactivated account cannot use this at all ─────────────
  {
    await db.doc(`staff/${uid}`).set({ active: false }, { merge: true });
    let threw = false;
    try {
      await wrappedChangePassword({ data: { newPassword: "Another-Valid-Password" }, auth: { uid, token: {} } });
    } catch (err: any) {
      threw = true;
      console.log(`[4] correctly rejected a deactivated staff member: ${err?.message ?? err}`);
    }
    check("[4] a deactivated account is denied (requireStaff fails closed)", threw, true);
    check("[4] the password from scenario 3 is still the one that works", await emulatorSignInSucceeds(email, newPassword), true);
    // restore for test hygiene (not strictly required, but avoids leaving a
    // deactivated stray account behind)
    await db.doc(`staff/${uid}`).set({ active: true }, { merge: true });
  }

  if (!pass) {
    console.error("LUXARDO FLOW AUTH-CORRECTION (staffChangePassword) REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log(
    "LUXARDO FLOW AUTH-CORRECTION (staffChangePassword) REGRESSION TEST: PASS — new " +
    "accounts start mustChangePassword=true, a too-short password is rejected without " +
    "changing anything, a valid change genuinely rotates the Auth password (verified " +
    "against the Auth emulator itself) and clears the flag with a matching audit entry, " +
    "and a deactivated account cannot use this mechanism at all."
  );
}

main().catch((err) => {
  console.error("LUXARDO FLOW AUTH-CORRECTION (staffChangePassword) regression test crashed:", err);
  process.exitCode = 1;
});
