/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — LUXARDO FLOW Mobile Number + Password login,
 * OPERATIONAL tier (V1 Auth Stabilization): staffMobilePasswordLogin
 * (functions/src/privilegedAuth.ts). Mirrors
 * privilegedMobilePasswordLogin.emulator.test.ts's structure exactly — the
 * same shared mechanism (createMobilePasswordLogin), a different
 * eligibility predicate and rate-limit collection.
 *
 * Scenarios:
 *   1.  Correct operational (pm) phone + password -> a custom token that
 *       genuinely belongs to the right uid.
 *   2.  Wrong password -> the exact same generic error as every other
 *       failure reason.
 *   3.  Unknown/unregistered phone number -> same generic error.
 *   4.  A PRIVILEGED (owner) account's phone number -> same generic error
 *       (this tier is operational-only; privileged keeps the SEPARATE
 *       privilegedMobilePasswordLogin export and its own rate-limit
 *       collection).
 *   5.  An INACTIVE operational account's phone number -> same generic
 *       error.
 *   6/7. Three failed attempts against one phone number -> locked out; a
 *       4th attempt (even with the correct password) is rejected.
 *   8.  A successful login resets the failure counter to zero.
 *   9.  staffMobileLoginAttempts and privilegedMobileLoginAttempts are
 *       genuinely SEPARATE collections — a lockout on one tier's phone
 *       number never writes to, or is readable from, the other tier's
 *       collection.
 *
 * MUST be run against the Firestore + Auth emulators only.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore,auth --project demo-luxardo-test \
 *     "node lib/__tests__/staffMobilePasswordLogin.emulator.test.js"
 */
import * as admin from "firebase-admin";
import * as crypto from "crypto";

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
  const { staffMobilePasswordLogin } = require("../privilegedAuth");
  const wrappedLogin = testEnv.wrap(staffMobilePasswordLogin);

  const runId = String(Date.now()).slice(-8);
  let pass = true;
  const fail = (msg: string) => {
    console.error(`FAIL: ${msg}`);
    pass = false;
  };
  const check = (label: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    else console.log(`OK  ${label} -> ${JSON.stringify(actual)}`);
  };

  function sha256Hex(input: string): string {
    return crypto.createHash("sha256").update(input).digest("hex");
  }

  async function emulatorExchangeCustomToken(token: string): Promise<{ ok: boolean; localId?: string }> {
    const [host] = String(process.env.FIREBASE_AUTH_EMULATOR_HOST).split(",");
    const res = await fetch(
      `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, returnSecureToken: true }),
      },
    );
    if (!res.ok) return { ok: false };
    const body: any = await res.json();
    const payload = JSON.parse(Buffer.from(body.idToken.split(".")[1], "base64").toString("utf8"));
    return { ok: true, localId: payload.user_id };
  }

  async function callLogin(phoneNumber: string, password: string): Promise<{ threw: boolean; message?: string; token?: string }> {
    try {
      const result: any = await wrappedLogin({ data: { phoneNumber, password } });
      return { threw: false, token: result?.token };
    } catch (err: any) {
      return { threw: true, message: err?.message };
    }
  }

  async function createTestUser(opts: { email: string; password: string; phone: string; role: string; active?: boolean }) {
    const created = await admin.auth().createUser({
      email: opts.email,
      password: opts.password,
      phoneNumber: opts.phone,
      emailVerified: true,
    });
    await db.doc(`staff/${created.uid}`).set({
      uid: created.uid,
      displayName: opts.email,
      email: opts.email,
      role: opts.role,
      active: opts.active !== false,
      phoneNumber: opts.phone,
      createdAt: new Date().toISOString(),
    });
    return created.uid;
  }

  const GENERIC_MESSAGE = "Invalid mobile number or password.";

  // ── Scenario 1: correct operational (pm) phone + password -> valid token ─
  const pmPhone = `+921${runId}`;
  const pmPassword = `Pm-Pass-${runId}`;
  const pmUid = await createTestUser({
    email: `pm-${runId}@example.test`, password: pmPassword, phone: pmPhone, role: "pm",
  });
  {
    const res = await callLogin(pmPhone, pmPassword);
    check("[1] correct pm phone+password does not throw", res.threw, false);
    check("[1] returns a token string", typeof res.token, "string");
    const exchange = await emulatorExchangeCustomToken(res.token!);
    check("[1] the custom token exchanges successfully", exchange.ok, true);
    check("[1] the custom token belongs to the CORRECT uid", exchange.localId, pmUid);
  }

  // ── Scenario 2: wrong password -> generic failure ─────────────────────────
  {
    const res = await callLogin(pmPhone, "definitely-the-wrong-password");
    check("[2] wrong password throws", res.threw, true);
    check("[2] wrong password uses the generic message", res.message, GENERIC_MESSAGE);
  }

  // ── Scenario 3: unknown/unregistered phone number -> same generic failure ─
  {
    const unknownPhone = `+922${runId}`;
    const res = await callLogin(unknownPhone, "any-password-at-all");
    check("[3] unknown phone throws", res.threw, true);
    check("[3] unknown phone uses the SAME generic message as wrong password", res.message, GENERIC_MESSAGE);
  }

  // ── Scenario 4: a PRIVILEGED (owner) phone number -> same generic failure ─
  // This tier is operational-only; privileged accounts must be rejected
  // here even with the correct password (they use the SEPARATE
  // privilegedMobilePasswordLogin export instead).
  const ownerPhone = `+923${runId}`;
  const ownerPassword = `Owner-Pass-${runId}`;
  await createTestUser({ email: `owner-${runId}@example.test`, password: ownerPassword, phone: ownerPhone, role: "owner" });
  {
    const res = await callLogin(ownerPhone, ownerPassword);
    check("[4] privileged (owner) phone+CORRECT password still throws on the operational tier", res.threw, true);
    check("[4] privileged phone uses the SAME generic message", res.message, GENERIC_MESSAGE);
  }

  // ── Scenario 5: an INACTIVE operational account -> same generic failure ──
  const inactiveTailorPhone = `+924${runId}`;
  const inactiveTailorPassword = `Inactive-Pass-${runId}`;
  await createTestUser({
    email: `inactive-tailor-${runId}@example.test`, password: inactiveTailorPassword,
    phone: inactiveTailorPhone, role: "tailor", active: false,
  });
  {
    const res = await callLogin(inactiveTailorPhone, inactiveTailorPassword);
    check("[5] inactive tailor phone+CORRECT password still throws", res.threw, true);
    check("[5] inactive tailor uses the SAME generic message", res.message, GENERIC_MESSAGE);
  }

  // ── Scenario 6/7: 3 failed attempts -> lockout; 4th (even correct) fails ──
  const lockoutPhone = `+925${runId}`;
  const lockoutPassword = `Lockout-Pass-${runId}`;
  await createTestUser({ email: `lockout-${runId}@example.test`, password: lockoutPassword, phone: lockoutPhone, role: "guard" });
  {
    const r1 = await callLogin(lockoutPhone, "wrong-1");
    const r2 = await callLogin(lockoutPhone, "wrong-2");
    const r3 = await callLogin(lockoutPhone, "wrong-3");
    check("[6] attempt 1 throws", r1.threw, true);
    check("[6] attempt 2 throws", r2.threw, true);
    check("[6] attempt 3 throws", r3.threw, true);

    const attemptDoc = (await db.doc(`staffMobileLoginAttempts/${sha256Hex(lockoutPhone)}`).get()).data();
    check("[6] attempt count reached 3", attemptDoc?.count, 3);
    check("[6] lockedUntil is now set (in the future)", typeof attemptDoc?.lockedUntil === "number" && attemptDoc!.lockedUntil > Date.now(), true);

    const r4 = await callLogin(lockoutPhone, lockoutPassword); // CORRECT password
    check("[7] 4th attempt throws EVEN with the correct password (locked out)", r4.threw, true);
    check("[7] 4th attempt uses the SAME generic message", r4.message, GENERIC_MESSAGE);
  }

  // ── Scenario 8: a successful login resets the failure counter ────────────
  const resetPhone = `+926${runId}`;
  const resetPassword = `Reset-Pass-${runId}`;
  await createTestUser({ email: `reset-${runId}@example.test`, password: resetPassword, phone: resetPhone, role: "store" });
  {
    await callLogin(resetPhone, "wrong-once");
    const midDoc = (await db.doc(`staffMobileLoginAttempts/${sha256Hex(resetPhone)}`).get()).data();
    check("[8] one failure recorded (count=1)", midDoc?.count, 1);

    const successRes = await callLogin(resetPhone, resetPassword);
    check("[8] the subsequent correct login succeeds", successRes.threw, false);

    const afterDoc = (await db.doc(`staffMobileLoginAttempts/${sha256Hex(resetPhone)}`).get()).data();
    check("[8] count is reset to 0 after a successful login", afterDoc?.count, 0);
    check("[8] lockedUntil is reset to null after a successful login", afterDoc?.lockedUntil, null);
  }

  // ── Scenario 9: tier isolation — separate rate-limit collections ─────────
  {
    const privilegedCollisionDoc = await db.doc(`privilegedMobileLoginAttempts/${sha256Hex(lockoutPhone)}`).get();
    check("[9] the operational lockout phone has NO entry in the privileged collection", privilegedCollisionDoc.exists, false);
  }

  if (!pass) {
    console.error("LUXARDO FLOW STAFF MOBILE PASSWORD LOGIN REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log(
    "LUXARDO FLOW STAFF MOBILE PASSWORD LOGIN REGRESSION TEST: PASS — correct " +
    "operational phone+password yields a token for the right uid; wrong password, unknown " +
    "phone, a privileged account's phone, and an inactive operational phone all produce the " +
    "exact same generic error; 3 failures lock out a 4th attempt even with the correct " +
    "password; a successful login resets the counter; and the operational tier's rate-limit " +
    "collection stays fully isolated from the privileged tier's."
  );
}

main().catch((err) => {
  console.error("LUXARDO FLOW STAFF MOBILE PASSWORD LOGIN regression test crashed:", err);
  process.exitCode = 1;
});
