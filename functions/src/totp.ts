/* eslint-disable */
/**
 * LUXARDO FLOW — TOTP (Google Authenticator) second factor.
 *
 * Scoped to super_admin and admin ONLY (never owner or any operational
 * role) — gated via requireStaff()+hasAnyRole(identity, ["admin"]), the
 * SAME helper pair every other admin-tier callable in this codebase uses
 * (hasAnyRole elevates super_admin to an "admin" allow-list, which is
 * exactly the {admin, super_admin} set this feature targets).
 *
 * The secret NEVER lives in a client-readable location: totpSecrets/{uid}
 * has no corresponding match block in firestore.loom.rules, so it falls
 * through to the file's own catch-all `allow read, write: if false` — only
 * these Admin-SDK callables can ever read or write it. The client only
 * ever sees a secret during the brief enroll-start response (to display
 * for manual entry into an authenticator app) and never again afterwards.
 *
 * RFC 4226 (HOTP) / RFC 6238 (TOTP) implemented directly against Node's
 * built-in crypto — no new dependency — HMAC-SHA1, 6 digits, 30s step, a
 * ±1 step window to tolerate clock drift (mirrors the tolerance any real
 * authenticator app assumes).
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { requireStaff, hasAnyRole } from "./staffAuth";

const db = admin.firestore();

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete enrollment
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const STEP_SECONDS = 30;
const DIGITS = 6;

async function requireAdminTier(uid: string): Promise<{ name: string; role: string }> {
  const identity = await requireStaff(uid);
  if (!hasAnyRole(identity, ["admin"])) {
    throw new HttpsError("permission-denied", "TOTP is available to Admin and Super Admin accounts only.");
  }
  return { name: identity.name, role: identity.role };
}

function writeAudit(action: string, actorUid: string, actorName: string, actorRole: string) {
  return db.collection("auditLogs").add({
    id: "",
    ts: new Date().toISOString(),
    actorUid,
    actorName,
    actorRole,
    action,
    entity: "totpSecrets",
    entityId: actorUid,
    before: null,
    after: null,
    reason: null,
    ip: null,
  }).then((ref) => { ref.update({ id: ref.id }); });
}

/* ───────────────────────── Base32 (RFC 4648, no padding) ────────────── */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

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

/* ───────────────────────────── TOTP core ─────────────────────────────
 * Standard RFC 6238 derivation: HOTP(secret, floor(unixSeconds / step)),
 * HOTP itself per RFC 4226 (HMAC-SHA1 of the 8-byte big-endian counter,
 * dynamic truncation to a DIGITS-digit code). */

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

  return String(binCode % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** Accepts the current step and the one immediately before/after it, to tolerate clock drift. */
function verifyTotpCode(secretBase32: string, code: string): boolean {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretBase32);
  const currentStep = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (const delta of [0, -1, 1]) {
    const expected = hotp(secret, currentStep + delta);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) {
      return true;
    }
  }
  return false;
}

async function checkNotLocked(uid: string): Promise<void> {
  const snap = await db.doc(`totpSecrets/${uid}`).get();
  const data = snap.exists ? snap.data()! : null;
  if (data?.lockedUntil && Date.now() < data.lockedUntil) {
    throw new HttpsError("resource-exhausted", "Too many incorrect codes. Try again later.");
  }
}

async function recordVerifyAttempt(uid: string, success: boolean): Promise<void> {
  const ref = db.doc(`totpSecrets/${uid}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data()! : {};
    if (success) {
      tx.set(ref, { failCount: 0, lockedUntil: null }, { merge: true });
      return;
    }
    const now = Date.now();
    const expired = !!data.lockedUntil && now >= data.lockedUntil;
    const newCount = (expired ? 0 : Number(data.failCount) || 0) + 1;
    tx.set(
      ref,
      {
        failCount: newCount,
        lockedUntil: newCount >= MAX_ATTEMPTS ? now + LOCKOUT_DURATION_MS : null,
      },
      { merge: true },
    );
  });
}

/* ═══════════════════════════════════════════════════════════════════
 * totpEnrollStart (callable)
 * Generates a NEW pending secret (does not activate it). Returns the
 * secret for manual entry into an authenticator app, plus a standard
 * otpauth:// URI for apps/password managers that accept it directly.
 * Input : {}
 * Output: { secretBase32, otpauthUri }
 * ═══════════════════════════════════════════════════════════════════*/
export const totpEnrollStart = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  await requireAdminTier(uid);

  const secretBase32 = base32Encode(crypto.randomBytes(20));

  await db.doc(`totpSecrets/${uid}`).set(
    { pendingSecretBase32: secretBase32, pendingCreatedAt: Date.now() },
    { merge: true },
  );

  const email = request.auth.token.email || uid;
  const label = encodeURIComponent(`LUXARDO FLOW:${email}`);
  const issuer = encodeURIComponent("LUXARDO FLOW");
  const otpauthUri = `otpauth://totp/${label}?secret=${secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

  return { secretBase32, otpauthUri };
});

/* ═══════════════════════════════════════════════════════════════════
 * totpEnrollVerify (callable)
 * Confirms the pending secret with a live 6-digit code and activates it.
 * Input : { code: string }
 * Output: { enabled: true }
 * ═══════════════════════════════════════════════════════════════════*/
export const totpEnrollVerify = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const identity = await requireAdminTier(uid);

  await checkNotLocked(uid);

  const { code } = request.data as { code?: string };
  const snap = await db.doc(`totpSecrets/${uid}`).get();
  const data = snap.exists ? snap.data()! : null;
  const pending = data?.pendingSecretBase32 as string | undefined;
  const pendingAge = Date.now() - (Number(data?.pendingCreatedAt) || 0);

  if (!pending || pendingAge > PENDING_TTL_MS) {
    throw new HttpsError("failed-precondition", "No enrollment in progress. Start enrollment again.");
  }

  const ok = typeof code === "string" && verifyTotpCode(pending, code);
  await recordVerifyAttempt(uid, ok);
  if (!ok) {
    throw new HttpsError("permission-denied", "Incorrect code.");
  }

  await db.doc(`totpSecrets/${uid}`).set(
    {
      secretBase32: pending,
      enabled: true,
      pendingSecretBase32: null,
      pendingCreatedAt: null,
      enabledAt: new Date().toISOString(),
    },
    { merge: true },
  );
  await writeAudit("TOTP_ENABLED", uid, identity.name, identity.role);

  return { enabled: true };
});

/* ═══════════════════════════════════════════════════════════════════
 * totpDisable (callable)
 * Requires a currently-valid 6-digit code (proves live possession of the
 * authenticator) before turning TOTP off.
 * Input : { code: string }
 * Output: { enabled: false }
 * ═══════════════════════════════════════════════════════════════════*/
export const totpDisable = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const identity = await requireAdminTier(uid);

  await checkNotLocked(uid);

  const { code } = request.data as { code?: string };
  const snap = await db.doc(`totpSecrets/${uid}`).get();
  const data = snap.exists ? snap.data()! : null;
  const active = data?.secretBase32 as string | undefined;

  if (!data?.enabled || !active) {
    throw new HttpsError("failed-precondition", "TOTP is not enabled.");
  }

  const ok = typeof code === "string" && verifyTotpCode(active, code);
  await recordVerifyAttempt(uid, ok);
  if (!ok) {
    throw new HttpsError("permission-denied", "Incorrect code.");
  }

  await db.doc(`totpSecrets/${uid}`).set(
    { secretBase32: null, enabled: false, pendingSecretBase32: null, pendingCreatedAt: null },
    { merge: true },
  );
  await writeAudit("TOTP_DISABLED", uid, identity.name, identity.role);

  return { enabled: false };
});

/* ═══════════════════════════════════════════════════════════════════
 * totpStatus (callable)
 * Input : {}
 * Output: { enabled: boolean }
 * ═══════════════════════════════════════════════════════════════════*/
export const totpStatus = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  await requireAdminTier(uid);

  const snap = await db.doc(`totpSecrets/${uid}`).get();
  return { enabled: !!snap.data()?.enabled };
});
