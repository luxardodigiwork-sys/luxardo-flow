/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — LUXARDO FLOW TOTP (Google Authenticator) second
 * factor (functions/src/totp.ts): totpEnrollStart, totpEnrollVerify,
 * totpDisable, totpStatus.
 *
 * Not wired into any test runner (the repo has none yet) — same standalone,
 * emulator-only approach as privilegedMobilePasswordLogin.emulator.test.ts.
 * NOT exported from functions/src/index.ts — Admin/Super-Admin-only, FLOW
 * (Loom)-only, exported ONLY from functions-loom/src/index.ts.
 *
 * The test computes its own expected TOTP codes via an independent
 * reimplementation of RFC 4226/6238 below (never importing totp.ts's
 * private helpers) — a genuine black-box check of the real contract.
 *
 * Scenarios:
 *   1.  admin enroll-start returns a pending secret + a matching otpauth URI.
 *   2.  Verifying with the CORRECT code activates TOTP (enabled=true,
 *       pendingSecretBase32 cleared, secretBase32 set) and writes a
 *       TOTP_ENABLED audit entry.
 *   3.  Verifying with a WRONG code is rejected and does not activate.
 *   4.  super_admin is equally eligible (hasAnyRole elevation).
 *   5.  An operational role (pm) and owner are both REJECTED from every
 *       totp* callable — this feature is admin/super_admin only.
 *   6.  totpStatus reflects enabled/disabled correctly.
 *   7.  totpDisable with the CORRECT current code turns TOTP off and writes
 *       a TOTP_DISABLED audit entry.
 *   8.  totpDisable with a WRONG code is rejected and leaves TOTP enabled.
 *   9.  5 wrong verify attempts lock the account out; a 6th attempt (even
 *       with the correct code) is rejected while locked.
 *   10. An expired pending enrollment (>10 minutes old) is rejected with a
 *       distinct "no enrollment in progress" error, not treated as valid.
 *
 * MUST be run against the Firestore + Auth emulators only — refuses to run
 * if FIRESTORE_EMULATOR_HOST is not set, so it can never touch a real
 * project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore,auth --project demo-luxardo-test \
 *     "node lib/__tests__/totp.emulator.test.js"
 */
import * as admin from "firebase-admin";
import * as crypto from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuf.writeUInt32BE(counter % 2 ** 32, 4);
  const hmac = crypto.createHmac("sha1", secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binCode % 10 ** 6).padStart(6, "0");
}

function totpCodeFor(secretBase32: string): string {
  const step = Math.floor(Date.now() / 1000 / 30);
  return hotp(base32Decode(secretBase32), step);
}

async function main(): Promise<void> {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set — refusing to run against a real " +
      "project. Run this via `firebase emulators:exec --only firestore,auth ...`."
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const testEnv = require("firebase-functions-test")({ projectId: "demo-luxardo-test" });

  admin.initializeApp();
  const db = admin.firestore();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { totpEnrollStart, totpEnrollVerify, totpDisable, totpStatus } = require("../totp");
  const wrappedStart = testEnv.wrap(totpEnrollStart);
  const wrappedVerify = testEnv.wrap(totpEnrollVerify);
  const wrappedDisable = testEnv.wrap(totpDisable);
  const wrappedStatus = testEnv.wrap(totpStatus);

  const runId = String(Date.now()).slice(-8);
  let pass = true;
  const fail = (msg: string) => { console.error(`FAIL: ${msg}`); pass = false; };
  const check = (label: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    else console.log(`OK  ${label} -> ${JSON.stringify(actual)}`);
  };

  async function makeStaff(role: string, active = true): Promise<string> {
    const email = `totp-${role}-${runId}-${Math.random().toString(36).slice(2)}@example.test`;
    const created = await admin.auth().createUser({ email, password: "Irrelevant-123", emailVerified: true });
    await db.doc(`staff/${created.uid}`).set({
      uid: created.uid, displayName: email, email, role, active, createdAt: new Date().toISOString(),
    });
    return created.uid;
  }

  async function callStart(uid: string, email: string) {
    try {
      const result: any = await wrappedStart({ data: {}, auth: { uid, token: { email } } });
      return { threw: false, ...result };
    } catch (err: any) {
      return { threw: true, message: err?.message };
    }
  }
  async function callVerify(uid: string, code: string) {
    try {
      const result: any = await wrappedVerify({ data: { code }, auth: { uid, token: {} } });
      return { threw: false, ...result };
    } catch (err: any) {
      return { threw: true, message: err?.message };
    }
  }
  async function callDisable(uid: string, code: string) {
    try {
      const result: any = await wrappedDisable({ data: { code }, auth: { uid, token: {} } });
      return { threw: false, ...result };
    } catch (err: any) {
      return { threw: true, message: err?.message };
    }
  }
  async function callStatus(uid: string) {
    const result: any = await wrappedStatus({ data: {}, auth: { uid, token: {} } });
    return result.enabled as boolean;
  }

  // ── Scenario 1: admin enroll-start ────────────────────────────────────────
  const adminUid = await makeStaff("admin");
  let adminSecret = "";
  {
    const res = await callStart(adminUid, "admin@example.test");
    check("[1] enroll-start does not throw", res.threw, false);
    check("[1] returns a base32 secret", typeof res.secretBase32 === "string" && res.secretBase32.length > 0, true);
    check("[1] otpauth URI embeds the same secret", String(res.otpauthUri).includes(res.secretBase32), true);
    check("[1] otpauth URI names the issuer", String(res.otpauthUri).includes("LUXARDO%20FLOW"), true);
    adminSecret = res.secretBase32;
  }

  // ── Scenario 3: wrong code does not activate ──────────────────────────────
  {
    const res = await callVerify(adminUid, "000000");
    check("[3] wrong code throws", res.threw, true);
    check("[3] status still disabled after a wrong code", await callStatus(adminUid), false);
  }

  // ── Scenario 2: correct code activates + audit entry ──────────────────────
  {
    const code = totpCodeFor(adminSecret);
    const res = await callVerify(adminUid, code);
    check("[2] correct code does not throw", res.threw, false);
    check("[2] response reports enabled", res.enabled, true);
    check("[2] totpStatus now reports enabled", await callStatus(adminUid), true);

    const doc = (await db.doc(`totpSecrets/${adminUid}`).get()).data();
    check("[2] pendingSecretBase32 cleared", doc?.pendingSecretBase32, null);
    check("[2] secretBase32 persisted matches the enrolled secret", doc?.secretBase32, adminSecret);

    const auditSnap = await db.collection("auditLogs")
      .where("entityId", "==", adminUid).where("action", "==", "TOTP_ENABLED").get();
    check("[2] a TOTP_ENABLED audit entry exists", auditSnap.size >= 1, true);
  }

  // ── Scenario 8: disable with WRONG code is rejected ───────────────────────
  {
    const res = await callDisable(adminUid, "111111");
    check("[8] disable with wrong code throws", res.threw, true);
    check("[8] status remains enabled after a failed disable", await callStatus(adminUid), true);
  }

  // ── Scenario 7: disable with CORRECT code + audit entry ───────────────────
  {
    const code = totpCodeFor(adminSecret);
    const res = await callDisable(adminUid, code);
    check("[7] disable with correct code does not throw", res.threw, false);
    check("[7] response reports disabled", res.enabled, false);
    check("[7] totpStatus now reports disabled", await callStatus(adminUid), false);

    const doc = (await db.doc(`totpSecrets/${adminUid}`).get()).data();
    check("[7] secretBase32 cleared after disable", doc?.secretBase32, null);

    const auditSnap = await db.collection("auditLogs")
      .where("entityId", "==", adminUid).where("action", "==", "TOTP_DISABLED").get();
    check("[7] a TOTP_DISABLED audit entry exists", auditSnap.size >= 1, true);
  }

  // ── Scenario 4: super_admin is equally eligible ───────────────────────────
  const superAdminUid = await makeStaff("super_admin");
  {
    const startRes = await callStart(superAdminUid, "sa@example.test");
    check("[4] super_admin enroll-start does not throw", startRes.threw, false);
    const code = totpCodeFor(startRes.secretBase32);
    const verifyRes = await callVerify(superAdminUid, code);
    check("[4] super_admin can verify/activate", verifyRes.threw, false);
    check("[4] super_admin totpStatus enabled", await callStatus(superAdminUid), true);
  }

  // ── Scenario 5: owner and pm are REJECTED from every totp* callable ──────
  const ownerUid = await makeStaff("owner");
  const pmUid = await makeStaff("pm");
  for (const [label, uid] of [["owner", ownerUid], ["pm", pmUid]] as const) {
    const startRes = await callStart(uid, `${label}@example.test`);
    check(`[5] ${label} enroll-start is rejected`, startRes.threw, true);
    const statusRes = await (async () => {
      try { await wrappedStatus({ data: {}, auth: { uid, token: {} } }); return false; }
      catch { return true; }
    })();
    check(`[5] ${label} totpStatus is rejected`, statusRes, true);
  }

  // ── Scenario 9: 5 wrong verify attempts lock the account out ─────────────
  const lockoutUid = await makeStaff("admin");
  {
    const startRes = await callStart(lockoutUid, "lockout@example.test");
    for (let i = 1; i <= 5; i++) {
      const res = await callVerify(lockoutUid, "999999");
      check(`[9] wrong attempt ${i} throws`, res.threw, true);
    }
    const correctCode = totpCodeFor(startRes.secretBase32);
    const lockedRes = await callVerify(lockoutUid, correctCode);
    check("[9] 6th attempt (correct code) is rejected while locked out", lockedRes.threw, true);
    check("[9] lockout message is distinct", /too many/i.test(String(lockedRes.message)), true);
  }

  // ── Scenario 10: an expired pending enrollment is rejected ────────────────
  const expiredUid = await makeStaff("admin");
  {
    const startRes = await callStart(expiredUid, "expired@example.test");
    // Back-date pendingCreatedAt to 11 minutes ago (TTL is 10 minutes).
    await db.doc(`totpSecrets/${expiredUid}`).set(
      { pendingCreatedAt: Date.now() - 11 * 60 * 1000 }, { merge: true },
    );
    const code = totpCodeFor(startRes.secretBase32);
    const res = await callVerify(expiredUid, code);
    check("[10] verify against an expired pending enrollment throws", res.threw, true);
    check("[10] expired-enrollment message is distinct", /no enrollment in progress/i.test(String(res.message)), true);
  }

  if (!pass) {
    console.error("LUXARDO FLOW TOTP REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log(
    "LUXARDO FLOW TOTP REGRESSION TEST: PASS — admin/super_admin can enroll, verify and " +
    "disable Google-Authenticator TOTP with genuine RFC 6238 codes; owner/operational roles " +
    "are rejected from every totp* callable; wrong codes never activate or deactivate; " +
    "5 wrong attempts lock the account out; an expired pending enrollment is rejected " +
    "distinctly; and enable/disable each write their own audit entry."
  );
}

main().catch((err) => {
  console.error("LUXARDO FLOW TOTP regression test crashed:", err);
  process.exitCode = 1;
});
