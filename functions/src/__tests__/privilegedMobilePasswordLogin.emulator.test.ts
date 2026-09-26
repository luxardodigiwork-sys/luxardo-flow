/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — LUXARDO FLOW Mobile Number + Password login for
 * the privileged tier (P0-2): privilegedMobilePasswordLogin
 * (functions/src/privilegedAuth.ts).
 *
 * Not wired into any test runner (the repo has none yet) — same standalone,
 * emulator-only approach as staffChangePassword.authCorrection.test.ts /
 * tailorRequests.high2.test.ts. NOT exported from functions/src/index.ts, so
 * it is never bundled/deployed to the B2C project — it is exported ONLY
 * from functions-loom/src/index.ts.
 *
 * Scenarios (matching the P0-2 spec's required coverage):
 *   1.  Correct privileged phone + password -> a custom token that
 *       genuinely belongs to the right uid (verified against the Auth
 *       emulator's own signInWithCustomToken REST endpoint, not just
 *       "the callable returned something").
 *   2.  Wrong password -> the exact same generic error as every other
 *       failure reason.
 *   3.  Unknown/unregistered phone number -> same generic error.
 *   4.  A registered OPERATIONAL staff member's phone number -> same
 *       generic error (never distinguishable from "wrong password").
 *   5.  An INACTIVE privileged account's phone number -> same generic
 *       error.
 *   6.  Three failed attempts against one phone number -> locked out.
 *   7.  A fourth attempt (even with the CORRECT password) is rejected
 *       server-side while locked out.
 *   8.  A successful login resets the failure counter to zero.
 *   9.  The password never appears anywhere in the stored rate-limit
 *       document.
 *   10. The rate-limit document's id is SHA-256(phone), never the
 *       plaintext phone number itself.
 *   11. P0-2 AUTHORIZATION-BUG REGRESSION — a privileged role (owner) whose
 *       staff/{uid} document has the `active` field genuinely MISSING
 *       (never written at all, not merely false/undefined-in-memory) is
 *       REJECTED with the same generic error. Before the fix,
 *       isPrivilegedMobileLoginEligible used `active !== false`, which
 *       treats a missing field as eligible — this is the exact case a
 *       locked-spec audit flagged as a blocking authorization gap.
 *   12. Same regression, for active === null explicitly stored on an
 *       otherwise-valid privileged role doc — also REJECTED.
 *
 * MUST be run against the Firestore + Auth emulators only — refuses to run
 * if FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are not set, so
 * it can never touch a real project or make a real network call to Google's
 * production Identity Toolkit.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore,auth --project demo-luxardo-test \
 *     "node lib/__tests__/privilegedMobilePasswordLogin.emulator.test.js"
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
  const { privilegedMobilePasswordLogin } = require("../privilegedAuth");
  const wrappedLogin = testEnv.wrap(privilegedMobilePasswordLogin);

  // 8 digits — combined with "+91" + a 1-digit scenario discriminator below,
  // this stays a valid E.164 number (11 total digits after "+", well within
  // the 8-15 range E164_RE requires).
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

  // Exchanges a custom token against the AUTH EMULATOR's own REST endpoint —
  // the only way to genuinely confirm the token actually authenticates as
  // the expected uid, not just that createCustomToken() returned a string.
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
    // signInWithCustomToken's response has no top-level localId (unlike
    // signInWithPassword's) — the uid is the user_id claim inside the
    // returned idToken JWT's payload (second, base64url-encoded segment).
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

  // ── Scenario 1: correct privileged phone + password -> valid token ───────
  const ownerPhone = `+911${runId}`;
  const ownerPassword = `Owner-Pass-${runId}`;
  const ownerUid = await createTestUser({
    email: `owner-${runId}@example.test`, password: ownerPassword, phone: ownerPhone, role: "owner",
  });
  {
    const res = await callLogin(ownerPhone, ownerPassword);
    check("[1] correct owner phone+password does not throw", res.threw, false);
    check("[1] returns a token string", typeof res.token, "string");
    const exchange = await emulatorExchangeCustomToken(res.token!);
    check("[1] the custom token exchanges successfully", exchange.ok, true);
    check("[1] the custom token belongs to the CORRECT uid", exchange.localId, ownerUid);
  }

  // ── Scenario 2: wrong password -> generic failure ─────────────────────────
  {
    const res = await callLogin(ownerPhone, "definitely-the-wrong-password");
    check("[2] wrong password throws", res.threw, true);
    check("[2] wrong password uses the generic message", res.message, GENERIC_MESSAGE);
  }

  // ── Scenario 3: unknown/unregistered phone number -> same generic failure ─
  {
    const unknownPhone = `+912${runId}`;
    const res = await callLogin(unknownPhone, "any-password-at-all");
    check("[3] unknown phone throws", res.threw, true);
    check("[3] unknown phone uses the SAME generic message as wrong password", res.message, GENERIC_MESSAGE);
  }

  // ── Scenario 4: an OPERATIONAL staff phone number -> same generic failure ─
  const pmPhone = `+913${runId}`;
  const pmPassword = `Pm-Pass-${runId}`;
  await createTestUser({ email: `pm-${runId}@example.test`, password: pmPassword, phone: pmPhone, role: "pm" });
  {
    const res = await callLogin(pmPhone, pmPassword);
    check("[4] operational staff (pm) phone+CORRECT password still throws", res.threw, true);
    check("[4] operational staff uses the SAME generic message", res.message, GENERIC_MESSAGE);
  }

  // ── Scenario 5: an INACTIVE privileged account -> same generic failure ────
  const inactiveAdminPhone = `+914${runId}`;
  const inactiveAdminPassword = `Inactive-Pass-${runId}`;
  await createTestUser({
    email: `inactive-admin-${runId}@example.test`, password: inactiveAdminPassword,
    phone: inactiveAdminPhone, role: "admin", active: false,
  });
  {
    const res = await callLogin(inactiveAdminPhone, inactiveAdminPassword);
    check("[5] inactive admin phone+CORRECT password still throws", res.threw, true);
    check("[5] inactive admin uses the SAME generic message", res.message, GENERIC_MESSAGE);
  }

  // ── Scenario 6/7: 3 failed attempts -> lockout; 4th (even correct) fails ──
  const lockoutPhone = `+915${runId}`;
  const lockoutPassword = `Lockout-Pass-${runId}`;
  await createTestUser({ email: `lockout-${runId}@example.test`, password: lockoutPassword, phone: lockoutPhone, role: "super_admin" });
  {
    const r1 = await callLogin(lockoutPhone, "wrong-1");
    const r2 = await callLogin(lockoutPhone, "wrong-2");
    const r3 = await callLogin(lockoutPhone, "wrong-3");
    check("[6] attempt 1 throws", r1.threw, true);
    check("[6] attempt 2 throws", r2.threw, true);
    check("[6] attempt 3 throws", r3.threw, true);

    const attemptDoc = (await db.doc(`privilegedMobileLoginAttempts/${sha256Hex(lockoutPhone)}`).get()).data();
    check("[6] attempt count reached 3", attemptDoc?.count, 3);
    check("[6] lockedUntil is now set (in the future)", typeof attemptDoc?.lockedUntil === "number" && attemptDoc!.lockedUntil > Date.now(), true);

    const r4 = await callLogin(lockoutPhone, lockoutPassword); // CORRECT password
    check("[7] 4th attempt throws EVEN with the correct password (locked out)", r4.threw, true);
    check("[7] 4th attempt uses the SAME generic message", r4.message, GENERIC_MESSAGE);
  }

  // ── Scenario 8: a successful login resets the failure counter ────────────
  const resetPhone = `+916${runId}`;
  const resetPassword = `Reset-Pass-${runId}`;
  await createTestUser({ email: `reset-${runId}@example.test`, password: resetPassword, phone: resetPhone, role: "owner" });
  {
    await callLogin(resetPhone, "wrong-once"); // one failure -> count=1
    const midDoc = (await db.doc(`privilegedMobileLoginAttempts/${sha256Hex(resetPhone)}`).get()).data();
    check("[8] one failure recorded (count=1)", midDoc?.count, 1);

    const successRes = await callLogin(resetPhone, resetPassword); // correct -> resets
    check("[8] the subsequent correct login succeeds", successRes.threw, false);

    const afterDoc = (await db.doc(`privilegedMobileLoginAttempts/${sha256Hex(resetPhone)}`).get()).data();
    check("[8] count is reset to 0 after a successful login", afterDoc?.count, 0);
    check("[8] lockedUntil is reset to null after a successful login", afterDoc?.lockedUntil, null);
  }

  // ── Scenario 11: P0-2 regression — active field GENUINELY MISSING ─────────
  // Bypasses createTestUser deliberately (it always writes an explicit
  // boolean via `active: opts.active !== false`) so the staff/{uid} document
  // truly has no `active` field at all, not merely a falsy in-memory value.
  const missingActivePhone = `+917${runId}`;
  const missingActivePassword = `MissingActive-Pass-${runId}`;
  {
    const created = await admin.auth().createUser({
      email: `missing-active-${runId}@example.test`,
      password: missingActivePassword,
      phoneNumber: missingActivePhone,
      emailVerified: true,
    });
    await db.doc(`staff/${created.uid}`).set({
      uid: created.uid,
      displayName: "Missing Active Owner",
      email: `missing-active-${runId}@example.test`,
      role: "owner",
      // `active` deliberately NOT included in this write at all.
      phoneNumber: missingActivePhone,
      createdAt: new Date().toISOString(),
    });
    const staffDoc = (await db.doc(`staff/${created.uid}`).get()).data();
    check("[11] the staff doc genuinely has no 'active' field", "active" in (staffDoc || {}), false);

    const res = await callLogin(missingActivePhone, missingActivePassword);
    check("[11] owner with a MISSING active field is rejected (CORRECT password)", res.threw, true);
    check("[11] rejection uses the SAME generic message", res.message, GENERIC_MESSAGE);
  }

  // ── Scenario 12: P0-2 regression — active === null explicitly ────────────
  const nullActivePhone = `+918${runId}`;
  const nullActivePassword = `NullActive-Pass-${runId}`;
  {
    const created = await admin.auth().createUser({
      email: `null-active-${runId}@example.test`,
      password: nullActivePassword,
      phoneNumber: nullActivePhone,
      emailVerified: true,
    });
    await db.doc(`staff/${created.uid}`).set({
      uid: created.uid,
      displayName: "Null Active Admin",
      email: `null-active-${runId}@example.test`,
      role: "admin",
      active: null,
      phoneNumber: nullActivePhone,
      createdAt: new Date().toISOString(),
    });
    const staffDoc = (await db.doc(`staff/${created.uid}`).get()).data();
    check("[12] the staff doc has active === null", staffDoc?.active, null);

    const res = await callLogin(nullActivePhone, nullActivePassword);
    check("[12] admin with active === null is rejected (CORRECT password)", res.threw, true);
    check("[12] rejection uses the SAME generic message", res.message, GENERIC_MESSAGE);
  }

  // ── Scenario 9/10: no password and no plaintext phone ever persisted ─────
  {
    const doc = (await db.doc(`privilegedMobileLoginAttempts/${sha256Hex(ownerPhone)}`).get()).data();
    const serialized = JSON.stringify(doc);
    check("[9] the rate-limit document contains no field named 'password'", "password" in (doc || {}), false);
    check("[9] the serialized rate-limit document does not contain the owner's password value", serialized.includes(ownerPassword), false);
    check("[10] the rate-limit document has ONLY count/lockedUntil fields", Object.keys(doc || {}).sort().join(","), "count,lockedUntil");

    const plaintextDoc = await db.doc(`privilegedMobileLoginAttempts/${ownerPhone}`).get();
    check("[10] no document exists keyed by the PLAINTEXT phone number", plaintextDoc.exists, false);
  }

  if (!pass) {
    console.error("LUXARDO FLOW PRIVILEGED MOBILE PASSWORD LOGIN REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log(
    "LUXARDO FLOW PRIVILEGED MOBILE PASSWORD LOGIN REGRESSION TEST: PASS — correct " +
    "privileged phone+password yields a token for the right uid; wrong password, unknown " +
    "phone, operational-staff phone, and inactive-privileged phone all produce the exact " +
    "same generic error; 3 failures lock out a 4th attempt even with the correct password; " +
    "a successful login resets the counter; and the rate-limit store never contains a " +
    "password or a plaintext phone number."
  );
}

main().catch((err) => {
  console.error("LUXARDO FLOW PRIVILEGED MOBILE PASSWORD LOGIN regression test crashed:", err);
  process.exitCode = 1;
});
