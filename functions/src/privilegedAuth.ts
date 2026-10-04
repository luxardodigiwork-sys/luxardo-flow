/* eslint-disable */
/**
 * LUXARDO FLOW — MOBILE NUMBER + PASSWORD LOGIN (P0-2, generalized in V1
 * Auth Stabilization)
 *
 * Two exports share the mechanism below (see createMobilePasswordLogin):
 * privilegedMobilePasswordLogin (Owner/Admin/Super Admin, unchanged since
 * P0-2) and staffMobilePasswordLogin (the 8 operational roles). Each tier
 * keeps its own eligibility check and its own rate-limit collection, so a
 * lockout or behavior change in one tier never affects the other.
 *
 * Firebase Auth has no native "phone number + password" sign-in primitive
 * (it supports Email+Password, Phone+SMS-OTP, and OAuth providers, but no
 * combination of the two). This composes three EXISTING, legitimate
 * mechanisms instead of inventing a new credential store:
 *
 *   1. admin.auth().getUserByPhoneNumber() resolves phone -> uid via
 *      Firebase Auth's own phone-number index. Phone numbers are unique per
 *      Firebase project, so this can never resolve to more than one account.
 *   2. staff/{uid} is re-read fresh on every attempt for the privileged-tier
 *      + active check (isPrivilegedMobileLoginEligible, staffAuth.ts) — the
 *      SAME authoritative source every other login method already uses.
 *   3. The password itself is verified via the Google Identity Toolkit REST
 *      API's accounts:signInWithPassword endpoint — the exact endpoint the
 *      Firebase Web SDK calls internally for signInWithEmailAndPassword — so
 *      the ONLY password store in the system remains Firebase Auth itself;
 *      nothing here duplicates or shadows it, and no password is ever
 *      persisted anywhere by this function.
 *
 * On success, mints a Firebase custom token for the SAME uid so the client
 * establishes an ordinary Firebase Auth session via signInWithCustomToken().
 * AuthContext's existing onAuthStateChanged resolution and AdminLoginPage's
 * existing verifyAdminRole() require NO changes — neither can tell which
 * credential produced the session.
 *
 * Every failure path — malformed input, rate-limited, unknown phone,
 * non-privileged role, inactive account, missing email, or a failed
 * password check — throws the exact SAME generic HttpsError (GENERIC_FAILURE
 * below), so no response ever reveals which of those actually occurred.
 *
 * Rate limiting is server-side (Firestore transaction), independent of any
 * client-side localStorage lockout, keyed by SHA-256(E.164 phone) — never
 * the plaintext number — so the privilegedMobileLoginAttempts collection is
 * not an enumerable directory of registered privileged phone numbers.
 *
 * Input : { phoneNumber: string, password: string }
 * Output: { token: string }
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { isPrivilegedMobileLoginEligible, isStaffMobileLoginEligible } from "./staffAuth";

const db = admin.firestore();

/** Must match functions/src/production.ts's E164_RE exactly. */
const E164_RE = /^\+[1-9]\d{7,14}$/;

const MAX_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/**
 * Public, non-secret Web API key for the luxardo-flow Firebase project
 * (same value as .env.loom's VITE_FIREBASE_API_KEY / src/firebase.ts's
 * Loom-mode config). Firebase Web API keys are not secrets — they only
 * route a request to the correct Google Cloud project, and this exact
 * value already ships inside the public Loom client bundle. Hardcoded here
 * because this function is exported ONLY from functions-loom/src/index.ts
 * and is therefore only ever deployed to the luxardo-flow project.
 */
const LOOM_WEB_API_KEY = "AIzaSyCUGbsEyHsDLudK3zoR2-rXjdA1uBfh3ls";

/**
 * The Identity Toolkit REST base URL — redirected to the local Auth
 * EMULATOR's REST endpoint when FIREBASE_AUTH_EMULATOR_HOST is set (the
 * Admin SDK auto-detects this env var for admin.auth() calls, but a raw
 * fetch() to the real Google endpoint would NOT be redirected on its own,
 * so this must be handled explicitly). Mirrors the exact same
 * emulator-redirect pattern already used by
 * functions/src/__tests__/staffChangePassword.authCorrection.test.ts's
 * emulatorSignInSucceeds() helper.
 */
function identityToolkitUrl(path: string): string {
  const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const base = emulatorHost
    ? `http://${emulatorHost}/identitytoolkit.googleapis.com/v1`
    : "https://identitytoolkit.googleapis.com/v1";
  const key = emulatorHost ? "fake-api-key" : LOOM_WEB_API_KEY;
  return `${base}/${path}?key=${key}`;
}

/**
 * One fixed error, reused for every rejection reason (malformed input,
 * rate-limited, unknown phone, wrong tier, inactive, missing email, wrong
 * password, or any internal error). Never construct a different message
 * for a different reason — that distinguishing signal is exactly what
 * would let an attacker enumerate registered privileged phone numbers.
 */
const GENERIC_FAILURE = () =>
  new HttpsError("permission-denied", "Invalid mobile number or password.");

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Rejects immediately if this phone key is currently locked out. Read-only
 * — does not itself record an attempt (that happens once, in
 * recordAttempt, after the real attempt completes).
 */
async function checkRateLimit(collection: string, phoneKey: string): Promise<void> {
  const snap = await db.doc(`${collection}/${phoneKey}`).get();
  if (!snap.exists) return;
  const data = snap.data()!;
  if (data.lockedUntil && Date.now() < data.lockedUntil) {
    throw GENERIC_FAILURE();
  }
}

/**
 * Records the outcome of one completed attempt. A success resets the
 * counter to zero; a failure increments it and, on reaching MAX_ATTEMPTS,
 * sets a 15-minute lockout. An already-expired lockout resets the count
 * instead of compounding indefinitely. Firestore transaction so concurrent
 * attempts against the same phone number cannot race past the limit.
 */
async function recordAttempt(collection: string, phoneKey: string, success: boolean): Promise<void> {
  const ref = db.doc(`${collection}/${phoneKey}`);
  await db.runTransaction(async (tx) => {
    if (success) {
      tx.set(ref, { count: 0, lockedUntil: null }, { merge: true });
      return;
    }
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.exists ? snap.data()! : { count: 0, lockedUntil: null };
    const expired = !!data.lockedUntil && now >= data.lockedUntil;
    const newCount = (expired ? 0 : Number(data.count) || 0) + 1;
    tx.set(
      ref,
      {
        count: newCount,
        lockedUntil: newCount >= MAX_ATTEMPTS ? now + LOCKOUT_DURATION_MS : null,
      },
      { merge: true },
    );
  });
}

/**
 * Shared core for every Mobile Number + Password login method. Both
 * exports below are thin, tier-specific wrappers around this ONE
 * implementation (rate limiting, Identity Toolkit REST password check,
 * custom-token minting) so there is exactly one code path to audit for
 * this security-sensitive flow — only the eligibility predicate and the
 * rate-limit collection (kept separate per tier so a lockout on one tier's
 * phone number can never affect the other) differ between tiers.
 */
function createMobilePasswordLogin(opts: {
  rateLimitCollection: string;
  isEligible: (role: unknown, active: unknown) => boolean;
  logTag: string;
}) {
  return onCall(async (request) => {
    const { phoneNumber, password } = request.data as { phoneNumber?: string; password?: string };

    if (typeof phoneNumber !== "string" || !E164_RE.test(phoneNumber.trim())) {
      throw GENERIC_FAILURE();
    }
    if (typeof password !== "string" || !password) {
      throw GENERIC_FAILURE();
    }

    const e164 = phoneNumber.trim();
    const phoneKey = sha256Hex(e164);

    // Server-side rate limit, checked BEFORE any Auth/REST call — independent
    // of client-side localStorage, which an attacker can simply clear.
    await checkRateLimit(opts.rateLimitCollection, phoneKey);

    let success = false;
    try {
      let userRecord;
      try {
        userRecord = await admin.auth().getUserByPhoneNumber(e164);
      } catch {
        throw GENERIC_FAILURE();
      }

      const staffSnap = await db.doc(`staff/${userRecord.uid}`).get();
      const staffData = staffSnap.exists ? staffSnap.data() : null;
      if (!opts.isEligible(staffData?.role, staffData?.active)) {
        throw GENERIC_FAILURE();
      }

      if (!userRecord.email) {
        // An account with no email on the Auth record cannot be verified
        // via Identity Toolkit's email/password endpoint — fails closed
        // exactly like every other ineligible case above.
        throw GENERIC_FAILURE();
      }

      let restRes: Response;
      try {
        restRes = await fetch(
          identityToolkitUrl("accounts:signInWithPassword"),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: userRecord.email, password, returnSecureToken: false }),
          },
        );
      } catch {
        throw GENERIC_FAILURE();
      }
      if (!restRes.ok) {
        throw GENERIC_FAILURE();
      }

      const token = await admin.auth().createCustomToken(userRecord.uid);
      success = true;
      return { token };
    } catch (err) {
      // Deliberately logs a FIXED string only — never request.data, the REST
      // request body, the REST response body, or the caught error object,
      // any of which could contain or be derived from the password.
      console.error(`[${opts.logTag}] login attempt rejected`);
      throw err instanceof HttpsError ? err : GENERIC_FAILURE();
    } finally {
      await recordAttempt(opts.rateLimitCollection, phoneKey, success);
    }
  });
}

/** Unchanged behavior/collection/eligibility — see createMobilePasswordLogin above. */
export const privilegedMobilePasswordLogin = createMobilePasswordLogin({
  rateLimitCollection: "privilegedMobileLoginAttempts",
  isEligible: isPrivilegedMobileLoginEligible,
  logTag: "privilegedMobilePasswordLogin",
});

/**
 * V1 Auth Stabilization — the SAME mechanism, open to the 8 OPERATIONAL
 * staff roles only (never Owner/Admin/Super Admin, who keep the export
 * above and their own dedicated /admin/login page). A separate rate-limit
 * collection (staffMobileLoginAttempts) keeps lockouts isolated per tier.
 */
export const staffMobilePasswordLogin = createMobilePasswordLogin({
  rateLimitCollection: "staffMobileLoginAttempts",
  isEligible: isStaffMobileLoginEligible,
  logTag: "staffMobilePasswordLogin",
});
