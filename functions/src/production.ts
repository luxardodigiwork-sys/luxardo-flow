/* eslint-disable */
/**
 * LUXARDO FASHION — V1 PRODUCTION SYSTEM
 * Cloud Functions for master-data CRUD (staff + karigar) and atomic ID generation.
 *
 * All functions:
 *  - require Firebase Auth (request.auth.uid)
 *  - verify admin role from staff/{uid} (Loom identity), with a
 *    customers/{uid} fallback for the legacy B2C admin identity
 *  - run inside Firestore transactions for atomicity
 *  - append audit logs (never delete)
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import {
  CANONICAL_STAFF_ROLES,
  LEGACY_STAFF_ROLE_MAP,
  normalizeStaffRole,
  CanonicalStaffRole,
  requireStaff,
  hasAnyRole,
  CANONICAL_DEPARTMENTS,
} from "./staffAuth";

const db = admin.firestore();

/* ───────────────────── HELPER: verify admin ─────────────────────── */

const ADMIN_STAFF_ROLES = ["owner", "admin", "super_admin"];

async function requireAdmin(uid: string): Promise<{ name: string; role: string }> {
  // Prefer staff/{uid} (Loom identity doc) with an owner/admin/super_admin role.
  // This enables bootstrap on a fresh Loom project (luxardo-flow) where the B2C
  // customers/{uid} doc does not exist. staff/{uid} is itself admin-managed, so no
  // unauthorized escalation is introduced.
  const staffSnap = await db.doc(`staff/${uid}`).get();
  if (staffSnap.exists) {
    const s = staffSnap.data()!;
    // Fail closed: a non-canonical / legacy role string (e.g. "grade") is
    // never treated as admin. Legacy roles are repaired only by the
    // sanctioned staffBackfillCustomerDocs job.
    const srole = String(s.role || "").toLowerCase().trim();
    if (ADMIN_STAFF_ROLES.includes(srole) && s.active !== false) {
      return { name: String(s.displayName || "Admin"), role: srole };
    }
  }
  // Fallback: B2C customers/{uid} admin identity (compat with existing master admin).
  const snap = await db.doc(`customers/${uid}`).get();
  if (!snap.exists) throw new HttpsError("permission-denied", "User doc not found.");
  const d = snap.data()!;
  const role = (d.role || "").toLowerCase();
  if (role !== "admin" && role !== "super_admin") {
    throw new HttpsError("permission-denied", "Admin role required.");
  }
  return { name: d.firstName ? `${d.firstName} ${d.lastName || ""}`.trim() : d.name || "Admin", role };
}

/**
 * The gate for every staff-account-management mutation (create, update,
 * delete, password reset, phone lookup) — Super Admin ONLY. requireAdmin()
 * above is now used elsewhere in this file (karigar management, the staff
 * backfill job) but no longer by any staff-mutating callable: Staff
 * Management gives admin/owner read-only visibility only (gated by
 * rolePermissions.ts's 'production.staff'), never a mutation path.
 * hasAnyRole(identity, ["super_admin"]) is an exact-match check (it only
 * elevates super_admin INTO an "admin"-listed permission, never the
 * reverse), so this never admits plain admin or owner.
 */
async function requireSuperAdmin(uid: string): Promise<{ name: string; role: string }> {
  const identity = await requireStaff(uid);
  if (!hasAnyRole(identity, ["super_admin"])) {
    throw new HttpsError("permission-denied", "Super Admin role required for this operation.");
  }
  return { name: identity.name, role: identity.role };
}

/**
 * Resolves a phone number to its current Firebase Auth uid, or null if the
 * number isn't registered to anyone. The one place getUserByPhoneNumber is
 * called for this purpose — both assertPhoneNotTaken (below) and
 * staffLookupByPhone use it.
 */
async function getUidByPhone(phoneNumber: string): Promise<string | null> {
  try {
    const rec = await admin.auth().getUserByPhoneNumber(phoneNumber);
    return rec.uid;
  } catch (err: any) {
    if (err?.code === "auth/user-not-found") return null;
    throw err;
  }
}

/**
 * Proactively rejects a phone-number assignment that would collide with a
 * DIFFERENT Auth user, with a clear, specific error — rather than relying
 * only on Firebase Auth's own uniqueness constraint (which still applies as
 * the authoritative, race-safe backstop; this check just gives a better
 * message and fails before any write is attempted). excludeUid lets a
 * staffUpdate call pass its own uid, so re-saving a User's EXISTING number
 * back onto themselves is never rejected as "already in use."
 */
async function assertPhoneNotTaken(phoneNumber: string, excludeUid?: string): Promise<void> {
  const holderUid = await getUidByPhone(phoneNumber);
  if (holderUid && holderUid !== excludeUid) {
    throw new HttpsError("already-exists", "This phone number is already assigned to another account.");
  }
}

/* ──────────────────── HELPER: audit log ─────────────────────────── */

function writeAudit(
  action: string,
  entity: string,
  entityId: string,
  actorUid: string,
  actorName: string,
  actorRole: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  reason?: string,
) {
  return db.collection("auditLogs").add({
    id: "", // set below after add()
    ts: new Date().toISOString(),
    actorUid,
    actorName,
    actorRole,
    action,
    entity,
    entityId,
    before,
    after,
    reason: reason || null,
    ip: null,
  }).then((ref) => { ref.update({ id: ref.id }); });
}

/* ═══════════════════════════════════════════════════════════════════
 * nextId — atomic ID generation via Firestore transaction.
 *
 * Input : { domain: string }
 *         domain is one of: "design", "sampleDesign", "samplePiece",
 *         "piece", "karigar", "pr", "so", "storeOutIssue", "guardQc",
 *         "tailorSession", "labourSession"
 * Output: { id: string }
 *
 * IdCounter doc: idCounters/{domain}  { domain, prefix, next, updatedAt }
 *
 * ID families (finalized):
 *   Catalogue Design  KL-XXXX
 *   Sample Design     SAMPLE-DESIGN-XXXX
 *   Sample Piece      SAMPLE-PIECE-XXXX
 *   Physical Piece    PIECE-XXXX
 *   Production Request PR-XXXX
 *   Karigar           K-XXXX
 *   Store-Out         SO-XXXX
 *   Store-Out Issue   SOI-XXXX
 *   Guard QC Record   QC-XXXX
 *   Work Session      LS-XXXX
 *   Fabric Master     FM-XXXX
 *   Fabric Receipt    FR-XXXX
 *   Fabric Issue      FI-XXXX
 *
 * IDs are NEVER reused after deletion/closure (monotonic counter).
 * ═══════════════════════════════════════════════════════════════════ */

const ID_PREFIXES: Record<string, string> = {
  design:           "KL-",           // KL-0001, KL-0002, ...
  sampleDesign:     "SAMPLE-DESIGN-", // SAMPLE-DESIGN-0001, ...
  samplePiece:      "SAMPLE-PIECE-",  // SAMPLE-PIECE-0001, ...
  piece:            "PIECE-",         // PIECE-0001, PIECE-0002, ... (global sequential)
  karigar:          "K-",
  pr:               "PR-",
  so:               "SO-",
  storeOutIssue:    "SOI-",
  guardQc:          "QC-",
  tailorSession:    "TS-",
  labourSession:    "LS-",
  tailorRequest:    "TR-",
  fabricMaster:     "FM-",
  fabricReceipt:    "FR-",
  fabricIssue:      "FI-",
};

/**
 * generateId — shared atomic ID generator (used by nextId and Phase 2 CFs).
 * Transaction-safe: increments idCounters/{domain} and returns the new ID.
 */
export async function generateId(domain: string): Promise<string> {
  const counterRef = db.doc(`idCounters/${domain}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    let next: number;
    let prefix: string;
    if (snap.exists) {
      const d = snap.data()!;
      next = (d.next || 0) + 1;
      prefix = d.prefix;
      tx.update(counterRef, { next, updatedAt: new Date().toISOString() });
    } else {
      next = 1;
      prefix = ID_PREFIXES[domain];
      tx.set(counterRef, { domain, prefix, next, updatedAt: new Date().toISOString() });
    }
    const padded = String(next).padStart(4, "0");
    return `${prefix}${padded}`;
  });
}

export const nextId = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  // CRIT-1 — a generic multi-domain ID utility, not an admin-exclusive
  // management action (unlike staffCreate/karigarCreate below), so any
  // canonical production staff identity may call it — never an unauthorized
  // B2C customer or anonymous session.
  await requireStaff(request.auth.uid);
  const { domain } = request.data as { domain?: string };
  if (!domain || !ID_PREFIXES[domain]) {
    throw new HttpsError("invalid-argument", `Invalid domain. Allowed: ${Object.keys(ID_PREFIXES).join(", ")}`);
  }

  const newId = await generateId(domain);

  return { id: newId };
});

/* ═══════════════════════════════════════════════════════════════════
 * STAFF IDENTITY MODEL
 *
 * staff/{uid} is the AUTHORITATIVE Loom production identity (role, name,
 * active flag). It is the only doc that gates Firestore rules and every
 * server-side role check (see staffAuth.ts).
 *
 * customers/{uid} is maintained as a COMPATIBILITY MIRROR because the
 * shared B2C AuthContext + the role login pages resolve a user's role
 * from customers/{uid} first. Keeping a mirror doc means an
 * app-provisioned staff member can actually sign in. The mirror never
 * grants B2C privilege: B2C isAdmin() only accepts role ∈
 * {admin, super_admin}, which are also legitimate Loom roles.
 * ═══════════════════════════════════════════════════════════════════ */

const VALID_STAFF_ROLES = new Set<string>(CANONICAL_STAFF_ROLES as readonly string[]);
const VALID_DEPARTMENTS = new Set<string>(CANONICAL_DEPARTMENTS as readonly string[]);

/** E.164 phone format (+ followed by 8-15 digits) — required for Firebase Auth phone sign-in. */
const E164_RE = /^\+[1-9]\d{7,14}$/;
/** HH:MM 24-hour, e.g. "09:30" — kept deliberately simple, no timezone handling. */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** YYYY-MM-DD — Firestore stores dates as ISO strings throughout this module. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates the USER-PROFILE fields (department/post/salaryPerHour/
 * salaryPerDay/workingHours/joiningDate/employeeId/notes/profilePhotoUrl)
 * — all staffUpdate-only now (Super Admin). Throws HttpsError on the first
 * invalid field. Never touches role/active/email/phoneNumber — those keep
 * their own existing validation.
 */
function validateProfilePatch(patch: Record<string, unknown>): void {
  if (patch.department !== undefined) {
    const d = String(patch.department ?? "").trim();
    if (d && !VALID_DEPARTMENTS.has(d)) {
      throw new HttpsError("invalid-argument", `Invalid department: ${d}`);
    }
    patch.department = d || null;
  }
  if (patch.post !== undefined) {
    const p = patch.post;
    if (p !== null && (typeof p !== "string" || p.length > 200)) {
      throw new HttpsError("invalid-argument", "post must be a string up to 200 characters.");
    }
    patch.post = p === null ? null : String(p).trim() || null;
  }
  if (patch.salaryPerHour !== undefined) {
    const n = patch.salaryPerHour;
    if (n !== null && (typeof n !== "number" || !Number.isFinite(n) || n < 0)) {
      throw new HttpsError("invalid-argument", "salaryPerHour must be a non-negative number.");
    }
  }
  if (patch.salaryPerDay !== undefined) {
    const n = patch.salaryPerDay;
    if (n !== null && (typeof n !== "number" || !Number.isFinite(n) || n < 0)) {
      throw new HttpsError("invalid-argument", "salaryPerDay must be a non-negative number.");
    }
  }
  if (patch.joiningDate !== undefined) {
    const jd = patch.joiningDate;
    if (jd !== null && (typeof jd !== "string" || !ISO_DATE_RE.test(jd))) {
      throw new HttpsError("invalid-argument", "joiningDate must be YYYY-MM-DD.");
    }
  }
  if (patch.employeeId !== undefined) {
    const eid = patch.employeeId;
    if (eid !== null && (typeof eid !== "string" || eid.length > 64)) {
      throw new HttpsError("invalid-argument", "employeeId must be a string up to 64 characters.");
    }
  }
  if (patch.notes !== undefined) {
    const n = patch.notes;
    if (n !== null && (typeof n !== "string" || n.length > 2000)) {
      throw new HttpsError("invalid-argument", "notes must be a string up to 2000 characters.");
    }
  }
  if (patch.profilePhotoUrl !== undefined) {
    const url = patch.profilePhotoUrl;
    if (url !== null && (typeof url !== "string" || url.length > 2048 || !/^https:\/\//.test(url))) {
      throw new HttpsError("invalid-argument", "profilePhotoUrl must be an https URL.");
    }
  }
  if (patch.workingHours !== undefined) {
    const wh = patch.workingHours;
    if (wh !== null) {
      if (typeof wh !== "object" || Array.isArray(wh)) {
        throw new HttpsError("invalid-argument", "workingHours must be an object with start/end.");
      }
      const { start, end } = wh as Record<string, unknown>;
      if (typeof start !== "string" || !HHMM_RE.test(start) || typeof end !== "string" || !HHMM_RE.test(end)) {
        throw new HttpsError("invalid-argument", "workingHours.start/end must be HH:MM (24-hour).");
      }
      const [sh, sm] = start.split(":").map(Number);
      const [eh, em] = end.split(":").map(Number);
      let totalMinutes = (eh * 60 + em) - (sh * 60 + sm);
      if (totalMinutes < 0) totalMinutes += 24 * 60; // overnight shift
      patch.workingHours = { start, end, totalHours: Math.round((totalMinutes / 60) * 100) / 100 };
    }
  }
  if (patch.displayName !== undefined) {
    const dn = patch.displayName;
    if (typeof dn !== "string" || !dn.trim() || dn.length > 200) {
      throw new HttpsError("invalid-argument", "displayName must be a non-empty string up to 200 characters.");
    }
    patch.displayName = dn.trim();
  }
}

/** Shape of the customers/{uid} compatibility mirror for a staff member. */
function staffCustomerMirror(
  uid: string,
  displayName: string,
  email: string,
  role: string,
  now: string,
): Record<string, unknown> {
  return {
    id: uid,
    name: displayName,
    email,
    role,               // same canonical staff role — single source of truth
    isPrimeMember: false,
    staffLinked: true,  // marker: this customer doc mirrors staff/{uid}
    updatedAt: now,
  };
}

/**
 * provisionStaffAccount — shared staff-account provisioning used by both
 * staffCreate (direct Admin creation) and approveTailorRequest (New Tailor
 * Request auto-provisioning on approval). Creates the Firebase Auth user,
 * then staff/{uid} + customers/{uid} in one atomic batch. Never generates a
 * mechanism-specific duplicate of this logic elsewhere — this IS the single
 * staff-creation code path.
 *
 * This is explicitly a TWO-STAGE, compensating-rollback flow, not one
 * atomic transaction spanning Auth and Firestore (the two systems don't
 * share a transaction mechanism): (1) create the Auth user — a single
 * coherent identity, since admin.auth().createUser() itself atomically
 * enforces email AND phone uniqueness, helped along by the proactive phone
 * check just before it for a clearer rejection message; (2) write
 * staff/{uid} + customers/{uid} together in one Firestore batch (atomic
 * with each other, so the two Firestore docs can never diverge — there is
 * no "staff created but customer mirror didn't" state to roll back
 * separately). If step 2 fails, step 1 is compensated by deleting the Auth
 * user, so no orphan Auth-without-staff account is left behind.
 *
 * The generated temporary password is NEVER returned or persisted anywhere
 * (not in Firestore, not in the function's response) — only the resulting
 * uid is handed back. Password delivery/reset is a separate, existing
 * concern (see the admin password-reset tooling), out of scope here.
 */
export async function provisionStaffAccount(params: {
  displayName: string;
  email: string;
  role: CanonicalStaffRole;
  createdByUid: string;
  password?: string;
  phoneNumber?: string;
}): Promise<{ uid: string; staffDoc: Record<string, unknown> }> {
  const { displayName, email, role, createdByUid, password, phoneNumber } = params;

  // Proactive, clear rejection BEFORE creating anything — rather than
  // relying only on admin.auth().createUser()'s own (still authoritative,
  // race-safe) uniqueness error, which doesn't distinguish "phone taken"
  // from "email taken" in its message.
  if (phoneNumber) {
    await assertPhoneNotTaken(phoneNumber);
  }

  let authUid: string;
  try {
    const created = await admin.auth().createUser({
      email,
      displayName,
      password: password || crypto.randomBytes(10).toString("hex"),
      emailVerified: false,
      ...(phoneNumber ? { phoneNumber } : {}),
    });
    authUid = created.uid;
  } catch (err: any) {
    console.error("provisionStaffAccount: Auth user creation failed", err);
    throw new HttpsError("already-exists", err?.message || "Could not create Auth user (email may already be registered).");
  }

  const now = new Date().toISOString();
  const staffDoc = {
    uid: authUid,
    displayName,
    email,
    role,
    active: true,
    phoneNumber: phoneNumber || null,
    // New accounts always start in a mandatory-password-change state,
    // whether the caller supplied an explicit temp password or a random one
    // was generated above — the assigning admin is never the account's
    // permanent password. Cleared by staffChangePassword on first success.
    mustChangePassword: true,
    createdAt: now,
    updatedAt: now,
    createdBy: createdByUid,
  };
  const customerMirror = {
    ...staffCustomerMirror(authUid, displayName, email, role, now),
    createdAt: now,
    createdBy: createdByUid,
  };

  try {
    const batch = db.batch();
    batch.set(db.doc(`staff/${authUid}`), staffDoc);
    batch.set(db.doc(`customers/${authUid}`), customerMirror, { merge: true });
    await batch.commit();
  } catch (err) {
    // Clean up the Auth user if the doc write fails, to avoid orphan accounts.
    try {
      await admin.auth().deleteUser(authUid);
    } catch (cleanupErr: any) {
      // MED-3 — the compensating delete ALSO failed: without a record here,
      // the orphaned Auth account (no staff/customers doc) is invisible to
      // every dashboard and audit trail, and the only future symptom is an
      // unrelated-looking "already-exists" error the next time this email
      // is provisioned. Best-effort: a failure writing this record must
      // never mask the original batch-commit error thrown below.
      console.error("provisionStaffAccount: orphan cleanup failed", { authUid, email, cleanupErr });
      await writeAudit(
        "STAFF_PROVISION_ORPHAN", "staff", authUid, createdByUid, "system", "system",
        null, { uid: authUid, email, role },
        `Auth user created but staff/customers write failed, and the compensating Auth user delete also failed: ${String(cleanupErr?.message || cleanupErr)}`
      ).catch(() => {});
    }
    throw err;
  }

  return { uid: authUid, staffDoc };
}

/* ═══════════════════════════════════════════════════════════════════
 * staffCreate — create a production staff member.
 *
 * Input : { displayName: string, email: string, role: StaffRole, password?: string }
 * Output: { ok: true, uid: string }
 *
 * Creates:
 *  - a Firebase Auth user (so the staff member can log in)
 *  - staff/{uid}      — authoritative Loom identity
 *  - customers/{uid}  — compatibility mirror (see STAFF IDENTITY MODEL)
 * The two Firestore docs are written in one atomic batch, via the shared
 * provisionStaffAccount() helper (also used by approveTailorRequest).
 * ═══════════════════════════════════════════════════════════════════ */

export const staffCreate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireSuperAdmin(request.auth.uid);

  const { displayName, email, role, password, phoneNumber } = request.data as {
    displayName?: string; email?: string; role?: string; password?: string; phoneNumber?: string;
  };

  if (!displayName || !email || !role) {
    throw new HttpsError("invalid-argument", "displayName, email, role are required.");
  }
  const canonicalRole = normalizeStaffRole(role);
  if (!canonicalRole || !VALID_STAFF_ROLES.has(canonicalRole)) {
    throw new HttpsError("invalid-argument", `Invalid role: ${role}`);
  }
  const trimmedPhone = phoneNumber ? String(phoneNumber).trim() : undefined;
  if (trimmedPhone && !E164_RE.test(trimmedPhone)) {
    throw new HttpsError("invalid-argument", "phoneNumber must be E.164 format, e.g. +919876543210.");
  }

  const { uid: authUid, staffDoc } = await provisionStaffAccount({
    displayName, email, role: canonicalRole, createdByUid: request.auth.uid, password,
    phoneNumber: trimmedPhone,
  });

  await writeAudit("STAFF_CREATE", "staff", authUid, request.auth.uid, actor.name, actor.role, null, staffDoc);

  return { ok: true, uid: authUid };
});

/* ═══════════════════════════════════════════════════════════════════
 * staffUpdate — update an existing staff member's fields. Super-Admin-only.
 *
 * Input : { uid: string, updates: { displayName?, email?, role?, active?,
 *           phoneNumber?, post?, department?, salaryPerHour?, salaryPerDay?,
 *           workingHours?, joiningDate?, employeeId?, notes?,
 *           mustChangePassword? } }
 * Output: { ok: true }
 *
 * Role/email/phone/force-password-change each get their own audit action;
 * every other field change falls back to the generic STAFF_UPDATE action.
 * ═══════════════════════════════════════════════════════════════════ */

export const staffUpdate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireSuperAdmin(request.auth.uid);

  const { uid, updates } = request.data as { uid?: string; updates?: Record<string, unknown> };
  if (!uid || !updates || typeof updates !== "object") {
    throw new HttpsError("invalid-argument", "uid and updates object required.");
  }

  const ref = db.doc(`staff/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", `Staff doc ${uid} not found.`);
  const before = snap.data()!;

  // Whitelist allowed fields. Super-Admin-only path (requireSuperAdmin
  // above) — every staff profile mutation lives here now; there is no
  // separate, looser tier for any of these fields.
  const allowed = [
    "displayName", "email", "role", "active", "phoneNumber", "post",
    "department", "profilePhotoUrl", "salaryPerHour", "salaryPerDay", "workingHours",
    "joiningDate", "employeeId", "notes", "mustChangePassword",
  ];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) {
    if (k in updates) patch[k] = updates[k];
  }
  if (Object.keys(patch).length === 0) {
    throw new HttpsError("invalid-argument", "No valid fields to update.");
  }
  if (patch.role !== undefined) {
    const canonicalRole = normalizeStaffRole(patch.role);
    if (!canonicalRole || !VALID_STAFF_ROLES.has(canonicalRole)) {
      throw new HttpsError("invalid-argument", `Invalid role: ${patch.role}`);
    }
    patch.role = canonicalRole;
  }
  if (patch.mustChangePassword !== undefined && typeof patch.mustChangePassword !== "boolean") {
    throw new HttpsError("invalid-argument", "mustChangePassword must be a boolean.");
  }

  validateProfilePatch(patch);

  // email lives on the Firebase Auth record (the actual sign-in credential)
  // — staff/{uid}.email below is only a display mirror, exactly like
  // phoneNumber. Applied via the Admin SDK BEFORE the Firestore batch, so
  // the mirror is never written unless the Auth record actually accepted
  // the change.
  if (patch.email !== undefined) {
    const rawEmail = String(patch.email ?? "").trim();
    if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      throw new HttpsError("invalid-argument", "email must be a valid address.");
    }
    try {
      await admin.auth().updateUser(uid, { email: rawEmail });
    } catch (err: any) {
      throw new HttpsError("invalid-argument", err?.message || "Could not update email on the Auth account.");
    }
    patch.email = rawEmail;
  }

  // phoneNumber lives on the Firebase Auth record (native phone-sign-in
  // credential) — staff/{uid}.phoneNumber below is only a display mirror.
  // An empty string clears the number on both. A non-empty number is
  // proactively checked against every OTHER Auth user first (excluding
  // this uid, so re-saving your own existing number is never rejected) —
  // Firebase Auth's own uniqueness constraint is still the authoritative,
  // race-safe backstop, but this gives a clear, specific error instead of
  // ever silently creating a duplicate identity. Applied BEFORE the
  // Firestore batch, so the mirror is never written unless the Auth
  // record actually accepted the change.
  if (patch.phoneNumber !== undefined) {
    const raw = String(patch.phoneNumber ?? "").trim();
    if (raw && !E164_RE.test(raw)) {
      throw new HttpsError("invalid-argument", "phoneNumber must be E.164 format, e.g. +919876543210.");
    }
    if (raw) {
      await assertPhoneNotTaken(raw, uid);
    }
    try {
      await admin.auth().updateUser(uid, { phoneNumber: raw || null });
    } catch (err: any) {
      throw new HttpsError("invalid-argument", err?.message || "Could not update phone number on the Auth account.");
    }
    patch.phoneNumber = raw || null;
  }

  const now = new Date().toISOString();
  patch.updatedAt = now;

  // Keep the customers/{uid} compatibility mirror in step with the
  // authoritative staff/{uid} doc (name / email / role). Written atomically.
  const mirror: Record<string, unknown> = { updatedAt: now, staffLinked: true };
  if (patch.displayName !== undefined) mirror.name = patch.displayName;
  if (patch.email !== undefined) mirror.email = patch.email;
  if (patch.role !== undefined) mirror.role = patch.role;

  // ref existence already asserted above, so set/merge == update here and
  // keeps both writes in one atomic batch.
  const batch = db.batch();
  batch.set(ref, patch, { merge: true });
  batch.set(db.doc(`customers/${uid}`), mirror, { merge: true });
  await batch.commit();

  // Audit: role change, email change, phone change, and an admin forcing a
  // password change each get their own distinct action (checked in this
  // order so a multi-field update is attributed to its most significant
  // change — mirrors the pre-existing role/phone precedent exactly).
  if (patch.role && patch.role !== before.role) {
    await writeAudit("STAFF_ROLE_CHANGE", "staff", uid, request.auth.uid, actor.name, actor.role,
      { role: before.role }, { role: patch.role });
  } else if (patch.email !== undefined && patch.email !== before.email) {
    await writeAudit("STAFF_EMAIL_CHANGE", "staff", uid, request.auth.uid, actor.name, actor.role,
      { email: before.email }, { email: patch.email });
  } else if (patch.phoneNumber !== undefined && patch.phoneNumber !== (before.phoneNumber ?? null)) {
    await writeAudit("STAFF_PHONE_CHANGE", "staff", uid, request.auth.uid, actor.name, actor.role,
      { phoneNumber: before.phoneNumber ?? null }, { phoneNumber: patch.phoneNumber });
  } else if (patch.mustChangePassword === true && before.mustChangePassword !== true) {
    await writeAudit("STAFF_FORCE_PASSWORD_CHANGE", "staff", uid, request.auth.uid, actor.name, actor.role,
      { mustChangePassword: before.mustChangePassword ?? false }, { mustChangePassword: true });
  } else {
    await writeAudit("STAFF_UPDATE", "staff", uid, request.auth.uid, actor.name, actor.role,
      { displayName: before.displayName, email: before.email, active: before.active },
      { displayName: patch.displayName ?? before.displayName, email: patch.email ?? before.email, active: patch.active ?? before.active });
  }

  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════════
 * staffChangePassword — self-service password change, used for BOTH the
 * voluntary "change my password" case and the MANDATORY first-login change
 * (staff/{uid}.mustChangePassword === true, set by provisionStaffAccount on
 * every new account and by the default-password migration script).
 *
 * Deliberately does the Auth password update AND the mustChangePassword
 * clear in one server-side, Admin-SDK operation — there is no way to clear
 * the flag without the Auth password having actually changed (unlike a
 * plain Firestore field write, which firestore.loom.rules would deny to a
 * client anyway).
 *
 * Any ACTIVE staff/{uid} identity may call this for their OWN uid — same
 * requireStaff() gate as everywhere else (fails closed if deactivated / no
 * doc), no admin role required. Does not touch any other field.
 *
 * Input : { newPassword: string }
 * Output: { ok: true }
 * ═══════════════════════════════════════════════════════════════════ */
export const staffChangePassword = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const actor = await requireStaff(uid); // fails closed if no active staff/{uid}/customers/{uid} identity

  const { newPassword } = request.data as { newPassword?: string };
  if (!newPassword || typeof newPassword !== "string" || newPassword.length < 8) {
    throw new HttpsError("invalid-argument", "New password must be at least 8 characters.");
  }

  try {
    await admin.auth().updateUser(uid, { password: newPassword });
  } catch (err: any) {
    throw new HttpsError("invalid-argument", err?.message || "Could not update password.");
  }

  const now = new Date().toISOString();
  const ref = db.doc(`staff/${uid}`);
  const snap = await ref.get();
  const hadFlag = snap.exists && !!snap.data()?.mustChangePassword;
  if (snap.exists) {
    await ref.set({ mustChangePassword: false, updatedAt: now }, { merge: true });
  }

  await writeAudit("STAFF_PASSWORD_CHANGED", "staff", uid, uid, actor.name, actor.role,
    { mustChangePassword: hadFlag }, { mustChangePassword: false });

  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════════
 * userProfileSelfUpdate — a signed-in Loom User updating THEIR OWN
 * profile. Deliberately narrower than staffUpdate: no admin check (any
 * signed-in staff/{uid} identity may call it), but restricted to a small,
 * low-risk self-service field whitelist. Business-sensitive fields
 * (department, ratePerDay, workingHours, joiningDate, employeeId, notes,
 * role, active) stay admin-only via staffUpdate — a User can update their
 * own photo/name/phone, never their own pay rate or department.
 *
 * Input : { updates: { displayName?, profilePhotoUrl?, phoneNumber? } }
 * Output: { ok: true }
 * ═══════════════════════════════════════════════════════════════════ */

export const userProfileSelfUpdate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;

  const { updates } = request.data as { updates?: Record<string, unknown> };
  if (!updates || typeof updates !== "object") {
    throw new HttpsError("invalid-argument", "updates object required.");
  }

  const ref = db.doc(`staff/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Your staff profile was not found.");
  const before = snap.data()!;

  const selfAllowed = ["displayName", "profilePhotoUrl", "phoneNumber"];
  const patch: Record<string, unknown> = {};
  for (const k of selfAllowed) {
    if (k in updates) patch[k] = updates[k];
  }
  if (Object.keys(patch).length === 0) {
    throw new HttpsError("invalid-argument", "No valid self-editable fields to update.");
  }
  validateProfilePatch(patch);

  if (patch.phoneNumber !== undefined) {
    const raw = String(patch.phoneNumber ?? "").trim();
    if (raw && !E164_RE.test(raw)) {
      throw new HttpsError("invalid-argument", "phoneNumber must be E.164 format, e.g. +919876543210.");
    }
    try {
      await admin.auth().updateUser(uid, { phoneNumber: raw || null });
    } catch (err: any) {
      throw new HttpsError("invalid-argument", err?.message || "Could not update phone number on the Auth account.");
    }
    patch.phoneNumber = raw || null;
  }

  const now = new Date().toISOString();
  patch.updatedAt = now;

  const mirror: Record<string, unknown> = { updatedAt: now, staffLinked: true };
  if (patch.displayName !== undefined) mirror.name = patch.displayName;

  const batch = db.batch();
  batch.set(ref, patch, { merge: true });
  batch.set(db.doc(`customers/${uid}`), mirror, { merge: true });
  await batch.commit();

  await writeAudit("STAFF_UPDATE", "staff", uid, uid, before.displayName || "Self", before.role || "",
    { displayName: before.displayName, phoneNumber: before.phoneNumber ?? null },
    { displayName: patch.displayName ?? before.displayName, phoneNumber: patch.phoneNumber !== undefined ? patch.phoneNumber : (before.phoneNumber ?? null) },
    "Self-service profile update");

  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════════
 * MOBILE-OTP PASSWORD RECOVERY — mobileResetLookup + mobileResetSendOtp
 *
 * Two-phase, so the full E.164 phone number is NEVER part of the response
 * to the initial, bare-email lookup:
 *
 *   mobileResetLookup(email) -> { eligible, maskedLast4, recoveryToken }
 *     Called UNAUTHENTICATED. Resolves email -> the AUTHORITATIVE stored
 *     mobile number, but returns ONLY its last 4 digits plus a short-lived
 *     (5 min), single-use, server-issued recoveryToken (mobileResetTokens/
 *     {token}, keyed by uid only — the phone number itself is never
 *     persisted in the token doc). The full number stays server-side.
 *
 *   mobileResetSendOtp(recoveryToken) -> { phoneNumber }
 *     Called only after the User explicitly confirms the masked number on
 *     screen. Re-validates the token (exists / not used / not expired),
 *     re-resolves eligibility FRESH (fail-closed against anything that
 *     changed in the window since the lookup), marks the token used, and
 *     ONLY THEN returns the phone number — the single moment the client
 *     needs it to call signInWithPhoneNumber(). There is no way to trigger
 *     Firebase's client-driven phone-auth SMS challenge without the
 *     browser holding the exact number for that one call; gating its
 *     release behind an explicit-confirmation-only, single-use, 5-minute
 *     token is the safest architecture achievable within that constraint,
 *     without reimplementing Firebase's own (undocumented, unsupported)
 *     server-side verification REST calls.
 *
 * Eligibility (both functions, identical logic): a recognised Loom
 * identity (canonical staff role OR the literal "super_admin" value some
 * staff/{uid} docs carry — see the isRecognisedRecoveryRole comment below)
 * that is active and has a phone number on the Auth record. Owner, Admin
 * and Super Admin are NOT excluded here — recovering a password via mobile
 * OTP is independent of LOGIN routing: Admin/Super Admin still sign in
 * exclusively via /admin/login (AdminLoginPage.tsx, unchanged, its own
 * real Gmail-based email reset untouched) regardless of which mechanism
 * last reset their password. Only the identify-time rate limit (client's
 * existing checkLocalLock/recordLocalFailure) throttles repeated lookups.
 *
 * Input : { email: string } / { recoveryToken: string }
 * Output: { eligible: false, reason: 'not_found'|'inactive'|'no_mobile' }
 *       | { eligible: true, maskedLast4: string, recoveryToken: string }
 *       ---
 *       | { phoneNumber: string }  (mobileResetSendOtp only)
 * ═══════════════════════════════════════════════════════════════════ */

const RECOVERY_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * True for any role a mobile-OTP recovery request may resolve to: every
 * CANONICAL_STAFF_ROLES value, PLUS the literal "super_admin" string —
 * some staff/{uid} docs (the Super Admin's own) carry role:"super_admin",
 * which normalizeStaffRole()/CANONICAL_STAFF_ROLES deliberately does NOT
 * include (it's an elevated identity, never assignable via staffCreate/
 * staffUpdate) — mirrors the client's isStaffRoleOrSuperAdmin() precedent
 * (src/utils/loomIdentity.ts) so "super_admin" isn't silently treated as
 * an unrecognised role purely on a terminology technicality.
 */
function isRecognisedRecoveryRole(role: unknown): boolean {
  const r = String(role || "").toLowerCase().trim();
  return r === "super_admin" || !!normalizeStaffRole(r);
}

/** Shared eligibility resolution for both recovery functions. */
async function resolveRecoveryEligibility(uid: string): Promise<
  | { ok: false; reason: "not_found" | "inactive" | "no_mobile" }
  | { ok: true; phone: string }
> {
  const userRecord = await admin.auth().getUser(uid).catch(() => null);
  if (!userRecord) return { ok: false, reason: "not_found" };

  const staffSnap = await db.doc(`staff/${uid}`).get();
  if (!staffSnap.exists) return { ok: false, reason: "not_found" };
  const data = staffSnap.data()!;

  if (!isRecognisedRecoveryRole(data.role)) return { ok: false, reason: "not_found" };
  if (data.active === false) return { ok: false, reason: "inactive" };

  // The Auth record is the actual credential; staff/{uid}.phoneNumber is
  // only ever a display mirror of it — prefer the Auth record.
  const phone = userRecord.phoneNumber || data.phoneNumber || null;
  if (!phone) return { ok: false, reason: "no_mobile" };

  return { ok: true, phone };
}

export const mobileResetLookup = onCall(async (request) => {
  const { email } = request.data as { email?: string };
  if (!email || typeof email !== "string") {
    throw new HttpsError("invalid-argument", "email is required.");
  }
  const normalizedEmail = email.trim().toLowerCase();

  let userRecord;
  try {
    userRecord = await admin.auth().getUserByEmail(normalizedEmail);
  } catch {
    return { eligible: false, reason: "not_found" };
  }

  const result = await resolveRecoveryEligibility(userRecord.uid);
  if (result.ok === false) return { eligible: false, reason: result.reason };

  const token = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  await db.doc(`mobileResetTokens/${token}`).set({
    uid: userRecord.uid,
    createdAt: now,
    expiresAt: now + RECOVERY_TOKEN_TTL_MS,
    used: false,
  });

  return { eligible: true, maskedLast4: result.phone.slice(-4), recoveryToken: token };
});

export const mobileResetSendOtp = onCall(async (request) => {
  const { recoveryToken } = request.data as { recoveryToken?: string };
  if (!recoveryToken || typeof recoveryToken !== "string") {
    throw new HttpsError("invalid-argument", "recoveryToken is required.");
  }

  const invalidOrExpired = () =>
    new HttpsError("permission-denied", "This recovery session is invalid or has expired. Please start again.");

  const ref = db.doc(`mobileResetTokens/${recoveryToken}`);
  const snap = await ref.get();
  if (!snap.exists) throw invalidOrExpired();
  const tokenData = snap.data()!;
  if (tokenData.used || Date.now() > tokenData.expiresAt) throw invalidOrExpired();

  // Re-resolve fresh — fail closed against anything that changed (account
  // deactivated, phone removed, etc.) in the window since the lookup.
  const result = await resolveRecoveryEligibility(String(tokenData.uid));
  if (!result.ok) throw invalidOrExpired();

  // Single-use: mark consumed before returning the number.
  await ref.update({ used: true, usedAt: Date.now() });

  return { phoneNumber: result.phone };
});

/* ═══════════════════════════════════════════════════════════════════
 * staffBackfillCustomerDocs — one-shot repair for pre-existing Loom
 * staff identities created before the customers/{uid} mirror existed.
 *
 * Input : {
 *   dryRun?: boolean        // default TRUE — report only, write nothing
 *   fixLegacyRoles?: boolean // default FALSE — also rewrite known legacy
 *                            //   role typos (LEGACY_STAFF_ROLE_MAP,
 *                            //   e.g. "grade" -> "guard") on staff/{uid}
 * }
 * Output: { ok: true, report: {...} }
 *
 * Idempotent: re-running against an already-repaired collection is a
 * no-op (every entry reports as "skipped"). Admin-only. Never deletes.
 * ═══════════════════════════════════════════════════════════════════ */

export const staffBackfillCustomerDocs = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireAdmin(request.auth.uid);

  const { dryRun = true, fixLegacyRoles = false } = (request.data ?? {}) as {
    dryRun?: boolean; fixLegacyRoles?: boolean;
  };

  const staffSnap = await db.collection("staff").get();
  if (staffSnap.size > 450) {
    // One atomic batch caps at 500 writes (≤2 per staff doc). The staff
    // collection is tiny by design; refuse rather than partially apply.
    throw new HttpsError("failed-precondition", `staff collection too large for a single batch (${staffSnap.size}). Paginate this job before running.`);
  }

  const now = new Date().toISOString();
  const report = {
    dryRun: !!dryRun,
    fixLegacyRoles: !!fixLegacyRoles,
    scanned: 0,
    customerDocsCreated: 0,
    customerDocsUpdated: 0,
    legacyRolesNormalized: 0,
    skipped: 0,
    unknownRoles: [] as Array<{ uid: string; role: string }>,
  };

  const batch = db.batch();
  let writes = 0;

  for (const doc of staffSnap.docs) {
    report.scanned++;
    const s = doc.data();
    const uid = doc.id;
    const rawRole = String(s.role || "").toLowerCase().trim();

    let effectiveRole = normalizeStaffRole(rawRole);

    // Optionally repair a known legacy/typo role on the authoritative doc.
    if (!effectiveRole && fixLegacyRoles && LEGACY_STAFF_ROLE_MAP[rawRole]) {
      effectiveRole = LEGACY_STAFF_ROLE_MAP[rawRole];
      report.legacyRolesNormalized++;
      if (!dryRun) {
        batch.update(doc.ref, {
          role: effectiveRole,
          roleLegacyBackfilledFrom: rawRole,
          updatedAt: now,
        });
        writes++;
      }
    }

    if (!effectiveRole) {
      // Unknown / unrepairable role — leave the data untouched, just report.
      report.unknownRoles.push({ uid, role: rawRole });
      report.skipped++;
      continue;
    }

    const custRef = db.doc(`customers/${uid}`);
    const cust = await custRef.get();
    const desiredName = String(s.displayName || s.name || "Staff");
    const desiredEmail = String(s.email || "");

    if (!cust.exists) {
      report.customerDocsCreated++;
      if (!dryRun) {
        batch.set(custRef, {
          ...staffCustomerMirror(uid, desiredName, desiredEmail, effectiveRole, now),
          createdAt: now,
          createdBy: request.auth.uid,
        }, { merge: true });
        writes++;
      }
    } else {
      const c = cust.data() || {};
      const drift =
        String(c.role || "").toLowerCase() !== effectiveRole ||
        String(c.name || "") !== desiredName ||
        String(c.email || "") !== desiredEmail;
      if (drift) {
        report.customerDocsUpdated++;
        if (!dryRun) {
          batch.set(custRef, staffCustomerMirror(uid, desiredName, desiredEmail, effectiveRole, now), { merge: true });
          writes++;
        }
      } else {
        report.skipped++;
      }
    }
  }

  if (!dryRun && writes > 0) {
    await batch.commit();
    await writeAudit("STAFF_BACKFILL", "staff", "ALL", request.auth.uid, actor.name, actor.role, null, report);
  }

  return { ok: true, report };
});

/* ═══════════════════════════════════════════════════════════════════
 * staffResetPassword — Super-Admin-initiated password reset for ANOTHER
 * staff member (distinct from staffChangePassword above, which is
 * self-service only). Generates a random temporary password server-side
 * (same convention as provisionStaffAccount's fallback), rotates it on the
 * real Auth record, and forces mustChangePassword so the target must set
 * their own password on next login. The generated password is returned to
 * the caller EXACTLY ONCE (there is no other channel to hand it to the
 * target) and is never written to Firestore or the audit log.
 *
 * Input : { uid: string }
 * Output: { ok: true, temporaryPassword: string }
 * ═══════════════════════════════════════════════════════════════════*/
export const staffResetPassword = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireSuperAdmin(request.auth.uid);

  const { uid } = request.data as { uid?: string };
  if (!uid || typeof uid !== "string") {
    throw new HttpsError("invalid-argument", "uid is required.");
  }

  const ref = db.doc(`staff/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", `Staff doc ${uid} not found.`);

  const temporaryPassword = crypto.randomBytes(10).toString("hex");
  try {
    await admin.auth().updateUser(uid, { password: temporaryPassword });
  } catch (err: any) {
    if (err?.code === "auth/user-not-found") {
      throw new HttpsError("failed-precondition", "This Auth account no longer exists — cannot reset its password.");
    }
    throw new HttpsError("internal", err?.message || "Could not reset password.");
  }

  const now = new Date().toISOString();
  await ref.set({ mustChangePassword: true, updatedAt: now }, { merge: true });

  // Deliberately logs no password-shaped field — only the boolean flag.
  await writeAudit("STAFF_PASSWORD_RESET", "staff", uid, request.auth.uid, actor.name, actor.role,
    null, { mustChangePassword: true });

  return { ok: true, temporaryPassword };
});

/* ═══════════════════════════════════════════════════════════════════
 * staffLookupByPhone — resolves which (if any) Auth user currently owns a
 * phone number, so Super Admin can see who holds a number BEFORE
 * attempting to reassign it (assertPhoneNotTaken/Firebase Auth's own
 * uniqueness constraint would reject the reassignment anyway — this just
 * surfaces who/what that is, rather than only the resulting error).
 * Super-Admin-only, matching every other staff-mutation-adjacent callable.
 *
 * Input : { phoneNumber: string }
 * Output: { exists: false } | { exists: true, uid, email, disabled, staff }
 * ═══════════════════════════════════════════════════════════════════*/
export const staffLookupByPhone = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  await requireSuperAdmin(request.auth.uid);

  const { phoneNumber } = request.data as { phoneNumber?: string };
  const trimmed = String(phoneNumber ?? "").trim();
  if (!trimmed || !E164_RE.test(trimmed)) {
    throw new HttpsError("invalid-argument", "phoneNumber must be E.164 format, e.g. +919876543210.");
  }

  try {
    const userRecord = await admin.auth().getUserByPhoneNumber(trimmed);
    const staffSnap = await db.doc(`staff/${userRecord.uid}`).get();
    return {
      exists: true,
      uid: userRecord.uid,
      email: userRecord.email ?? null,
      disabled: userRecord.disabled,
      staff: staffSnap.exists ? staffSnap.data() : null,
    };
  } catch (err: any) {
    if (err?.code === "auth/user-not-found") {
      return { exists: false };
    }
    throw new HttpsError("internal", "Failed to look up phone number.");
  }
});

/* ═══════════════════════════════════════════════════════════════════
 * staffLookupIdentity — resolves an email and/or phone number to the
 * Firebase Auth account(s) they belong to, and whether a staff/{uid}
 * profile already exists for the resolved uid. Super-Admin-only.
 * Read-only — the first step of "Add Staff", so a Super Admin can tell,
 * BEFORE creating anything, which of four situations applies:
 *   - neither identifier resolves to an Auth account -> create new
 *     (the existing staffCreate flow, unchanged).
 *   - resolves to ONE Auth account with no staff/{uid} doc yet ->
 *     Link Existing Account (staffLinkExistingAccount below).
 *   - resolves to an Auth account that ALREADY has a staff/{uid} doc ->
 *     edit the existing row instead of creating a duplicate.
 *   - email and phone resolve to TWO DIFFERENT Auth accounts -> a
 *     conflict the caller must never silently resolve; report both
 *     uids and let the Super Admin link one identifier at a time.
 *
 * Input : { email?: string, phoneNumber?: string } (at least one)
 * Output: { found: false }
 *       | { found: true, conflict: true, emailUid, emailEmail,
 *           phoneUid, phoneDisplayName, phoneNumberMaskedLast4 }
 *       | { found: true, conflict: false, uid, email, phoneNumber,
 *           displayName, disabled, existingStaffDoc: StaffDoc|null }
 * ═══════════════════════════════════════════════════════════════════*/
export const staffLookupIdentity = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  await requireSuperAdmin(request.auth.uid);

  const { email, phoneNumber } = request.data as { email?: string; phoneNumber?: string };
  const trimmedEmail = email ? String(email).trim().toLowerCase() : "";
  const trimmedPhone = phoneNumber ? String(phoneNumber).trim() : "";

  if (!trimmedEmail && !trimmedPhone) {
    throw new HttpsError("invalid-argument", "email or phoneNumber is required.");
  }
  if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    throw new HttpsError("invalid-argument", "email must be a valid address.");
  }
  if (trimmedPhone && !E164_RE.test(trimmedPhone)) {
    throw new HttpsError("invalid-argument", "phoneNumber must be E.164 format, e.g. +919876543210.");
  }

  const emailUser = trimmedEmail
    ? await admin.auth().getUserByEmail(trimmedEmail).catch(() => null)
    : null;
  const phoneUser = trimmedPhone
    ? await admin.auth().getUserByPhoneNumber(trimmedPhone).catch(() => null)
    : null;

  if (!emailUser && !phoneUser) {
    return { found: false };
  }

  // Two DIFFERENT Auth accounts — never silently resolved to one. This is
  // the exact situation a two-identity reconciliation (e.g. one account
  // holding the intended email, another holding the intended phone
  // number) must surface rather than merge.
  if (emailUser && phoneUser && emailUser.uid !== phoneUser.uid) {
    return {
      found: true,
      conflict: true,
      emailUid: emailUser.uid,
      emailEmail: emailUser.email ?? null,
      phoneUid: phoneUser.uid,
      phoneDisplayName: phoneUser.displayName ?? null,
      phoneNumberMaskedLast4: trimmedPhone.slice(-4),
    };
  }

  const resolved = emailUser ?? phoneUser;
  if (!resolved) {
    return { found: false }; // unreachable; keeps TS control-flow happy
  }

  const staffSnap = await db.doc(`staff/${resolved.uid}`).get();

  return {
    found: true,
    conflict: false,
    uid: resolved.uid,
    email: resolved.email ?? null,
    phoneNumber: resolved.phoneNumber ?? null,
    displayName: resolved.displayName ?? null,
    disabled: resolved.disabled,
    existingStaffDoc: staffSnap.exists ? staffSnap.data() : null,
  };
});

/* ═══════════════════════════════════════════════════════════════════
 * staffLinkExistingAccount — attaches a NEW staff/{uid} profile to an
 * EXISTING Firebase Auth account (one staffLookupIdentity has already
 * resolved), instead of creating a new Auth user. Super-Admin-only.
 *
 * The ONE structural difference from staffCreate: no
 * admin.auth().createUser() call, no password. Everything else — role/
 * profile-field validation, the customers/{uid} mirror, audit logging —
 * matches staffCreate/staffUpdate exactly, so a linked account behaves
 * identically to a freshly-created one everywhere else in the app.
 *
 * Guarded against ever fabricating an identity: admin.auth().getUser(uid)
 * MUST succeed first — this can never write a staff/{uid} doc for a uid
 * that isn't a real, already-existing Auth account. `email` is read from
 * the Auth record itself (never from caller input), so it can never
 * drift from the real credential. Does NOT touch mustChangePassword or
 * the password — this flow never generates or rotates a credential; use
 * staffResetPassword separately if one is needed.
 *
 * Idempotent by construction: staff/{uid}'s document ID IS the Auth uid,
 * so this can never create a second staff doc for the same account —
 * "exactly one Auth UID = one staff/{uid}" holds structurally, not as an
 * extra check. Calling this again for a uid that already has a doc is a
 * safe merge/update of that SAME doc (e.g. to adjust fields after the
 * initial link).
 *
 * Input : { uid: string, displayName: string, role: StaffRole,
 *           phoneNumber?, post?, department?, salaryPerHour?,
 *           salaryPerDay?, workingHours?, joiningDate?, employeeId?,
 *           notes?, active? }
 * Output: { ok: true, uid: string }
 * ═══════════════════════════════════════════════════════════════════*/
export const staffLinkExistingAccount = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireSuperAdmin(request.auth.uid);

  const data = request.data as {
    uid?: string;
    displayName?: string;
    role?: string;
    phoneNumber?: string;
    post?: string | null;
    department?: string | null;
    salaryPerHour?: number | null;
    salaryPerDay?: number | null;
    workingHours?: { start: string; end: string } | null;
    joiningDate?: string | null;
    employeeId?: string | null;
    notes?: string | null;
    active?: boolean;
  };
  const { uid, displayName, role } = data;

  if (!uid || typeof uid !== "string") {
    throw new HttpsError("invalid-argument", "uid is required.");
  }
  if (!displayName || typeof displayName !== "string" || !displayName.trim()) {
    throw new HttpsError("invalid-argument", "displayName is required.");
  }
  const canonicalRole = normalizeStaffRole(role);
  if (!canonicalRole || !VALID_STAFF_ROLES.has(canonicalRole)) {
    throw new HttpsError("invalid-argument", `Invalid role: ${role}`);
  }

  // Hard guarantee: never write a staff/{uid} doc for a uid that isn't a
  // real, already-existing Auth account — this is what makes "link" safe
  // to expose without an admin.auth().createUser() call anywhere in it.
  let authUser;
  try {
    authUser = await admin.auth().getUser(uid);
  } catch {
    throw new HttpsError("not-found", `No Firebase Auth account exists for uid ${uid}.`);
  }

  const patch: Record<string, unknown> = { displayName };
  const profileKeys = [
    "post", "department", "salaryPerHour", "salaryPerDay", "workingHours",
    "joiningDate", "employeeId", "notes",
  ] as const;
  for (const k of profileKeys) {
    if (data[k] !== undefined) patch[k] = data[k];
  }
  if (data.active !== undefined) {
    if (typeof data.active !== "boolean") {
      throw new HttpsError("invalid-argument", "active must be a boolean.");
    }
    patch.active = data.active;
  }
  validateProfilePatch(patch); // trims/validates displayName + profile fields IN PLACE

  // phoneNumber (optional): reuse the EXACT same uniqueness + Auth-update
  // path as staffUpdate — never silently create a duplicate identity, and
  // never attach a number another uid already holds.
  if (data.phoneNumber !== undefined) {
    const raw = String(data.phoneNumber ?? "").trim();
    if (raw && !E164_RE.test(raw)) {
      throw new HttpsError("invalid-argument", "phoneNumber must be E.164 format, e.g. +919876543210.");
    }
    if (raw) await assertPhoneNotTaken(raw, uid);
    try {
      await admin.auth().updateUser(uid, { phoneNumber: raw || null });
    } catch (err: any) {
      throw new HttpsError("invalid-argument", err?.message || "Could not set the phone number on the Auth account.");
    }
    patch.phoneNumber = raw || null;
  }

  const now = new Date().toISOString();
  const beforeSnap = await db.doc(`staff/${uid}`).get();
  const before = beforeSnap.exists ? beforeSnap.data()! : null;

  const staffDoc: Record<string, unknown> = {
    ...patch,
    uid,
    email: authUser.email || before?.email || "",
    role: canonicalRole,
    active: patch.active !== undefined ? patch.active : (before?.active ?? true),
    createdAt: before?.createdAt || now,
    updatedAt: now,
    createdBy: before?.createdBy || request.auth.uid,
  };

  const mirror: Record<string, unknown> = staffCustomerMirror(
    uid, staffDoc.displayName as string, staffDoc.email as string, canonicalRole, now,
  );
  if (!before) {
    mirror.createdAt = now;
    mirror.createdBy = request.auth.uid;
  }

  const batch = db.batch();
  batch.set(db.doc(`staff/${uid}`), staffDoc, { merge: true });
  batch.set(db.doc(`customers/${uid}`), mirror, { merge: true });
  await batch.commit();

  await writeAudit(
    "STAFF_LINK_EXISTING_ACCOUNT", "staff", uid, request.auth.uid, actor.name, actor.role,
    before, staffDoc,
    "Linked an existing Firebase Auth account to a staff profile",
  );

  return { ok: true, uid };
});

/* ═══════════════════════════════════════════════════════════════════
 * staffTransferPhoneNumber — Super-Admin-only. Moves a phone number from
 * one Firebase Auth account (source) to another (target) WITHOUT ever
 * deleting, merging, or creating any Auth user or staff/{uid} doc, and
 * WITHOUT ever touching either account's email. Exists for exactly the
 * case assertPhoneNotTaken (staffUpdate/staffCreate/staffLinkExisting-
 * Account) correctly refuses: a number currently held by a different,
 * unrelated-looking Auth account that the Super Admin has deliberately
 * decided should move to a specific other account instead — e.g.
 * reconciling two Auth identities that belong to the same real person.
 *
 * State-classified and resumable: a prior attempt that failed partway
 * (e.g. the number ended up attached to NEITHER account, because the
 * assign-to-target step failed and the automatic rollback also failed)
 * is safely resumed by calling this again with the SAME arguments — it
 * re-reads live Auth state and continues from wherever it actually is,
 * rather than assuming a fresh start. This is what keeps routine
 * reconciliation inside LUXARDO FLOW — the Firebase Console is never a
 * required step, only a theoretical last resort if the Auth API itself
 * keeps failing across retries.
 *
 * "Neither account currently holds the number" (ORPHANED) is deliberately
 * NEVER inferred as resumable from Auth state alone — that can't be told
 * apart from "source never held this number to begin with." A small
 * phoneTransferAttempts/{hash(sourceUid|targetUid|phoneNumber)} marker,
 * written BEFORE the first Auth mutation and cleared only on final
 * success, is the one thing that legitimises a resume; its absence makes
 * an otherwise-ORPHANED-looking state fail closed as MISMATCH instead.
 *
 * dryRun (default TRUE — same safety convention as staffBackfillCustomer-
 * Docs): performs ONLY the read-only verification/state-classification
 * below and returns a preview — zero writes. The confirmation UI is
 * built from this server-verified preview, never a client-side guess.
 * The caller must explicitly pass dryRun:false to actually execute.
 *
 * Verification (always, even when dryRun:false — re-checked fresh right
 * before writing, never trusted from an earlier dry run):
 *   - both sourceUid and targetUid resolve to real Auth accounts;
 *   - source actually holds the requested phone number (or the Auth-level
 *     move already happened in a prior partial run — see state below);
 *   - target does not already hold a DIFFERENT phone number (never
 *     silently overwritten).
 *   Anything else classifies as MISMATCH and the function refuses to
 *   guess, rather than resolving it automatically.
 *
 * Input : { sourceUid, targetUid, phoneNumber, dryRun?: boolean }
 * Output: { ok: true, preview: {...} }
 * Throws: HttpsError whose `details` carries { stepReached, sourceUid,
 *         targetUid, rolledBack? } on ANY failure — never a bare
 *         "failed" message, so the caller always knows the exact
 *         partial state and whether anything needs manual follow-up.
 * ═══════════════════════════════════════════════════════════════════*/

type PhoneTransferState = "NOT_STARTED" | "AUTH_TRANSFERRED" | "ORPHANED" | "MISMATCH";

/**
 * Pure, dependency-free classification of the current Auth-level phone
 * state relative to the requested transfer — kept separate so it can be
 * reasoned about (and unit-tested) independently of any Admin SDK call.
 */
function classifyPhoneTransferState(
  sourcePhone: string | null | undefined,
  targetPhone: string | null | undefined,
  phoneNumber: string,
): PhoneTransferState {
  if (sourcePhone === phoneNumber && !targetPhone) return "NOT_STARTED";
  if (!sourcePhone && targetPhone === phoneNumber) return "AUTH_TRANSFERRED";
  if (!sourcePhone && !targetPhone) return "ORPHANED";
  return "MISMATCH";
}

/** Masked last-4 + a SHA-256 hash, for audit entries that never carry the full number in plaintext. */
function maskPhoneForAudit(phone: string): { maskedLast4: string; hash: string } {
  return { maskedLast4: phone.slice(-4), hash: crypto.createHash("sha256").update(phone).digest("hex") };
}

export const staffTransferPhoneNumber = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireSuperAdmin(request.auth.uid);

  const { sourceUid, targetUid, phoneNumber, dryRun = true } = request.data as {
    sourceUid?: string; targetUid?: string; phoneNumber?: string; dryRun?: boolean;
  };

  if (!sourceUid || typeof sourceUid !== "string" || !targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "sourceUid and targetUid are required.");
  }
  if (sourceUid === targetUid) {
    throw new HttpsError("invalid-argument", "sourceUid and targetUid must be different accounts.");
  }
  const phone = String(phoneNumber ?? "").trim();
  if (!phone || !E164_RE.test(phone)) {
    throw new HttpsError("invalid-argument", "phoneNumber must be E.164 format, e.g. +919876543210.");
  }

  const fail = (step: string, message: string, extra?: Record<string, unknown>): HttpsError =>
    new HttpsError("failed-precondition", message, { stepReached: step, sourceUid, targetUid, ...extra });
  const mask = (p: string | null | undefined) => (p ? `••••${p.slice(-4)}` : "no number");

  let sourceUser;
  try {
    sourceUser = await admin.auth().getUser(sourceUid);
  } catch {
    throw fail("VERIFY_SOURCE", `Source Auth account ${sourceUid} was not found.`);
  }
  let targetUser;
  try {
    targetUser = await admin.auth().getUser(targetUid);
  } catch {
    throw fail("VERIFY_TARGET", `Target Auth account ${targetUid} was not found.`);
  }

  // Deterministic marker for THIS exact (source, target, phone) triple —
  // the only safe way to tell "a prior attempt of OUR OWN got interrupted
  // here" apart from "this number was never on source to begin with."
  // Written BEFORE any Auth mutation (below) and cleared only on final
  // success, so it survives exactly the window a resume needs to cover.
  const transferKey = crypto.createHash("sha256").update(`${sourceUid}|${targetUid}|${phone}`).digest("hex");
  const attemptRef = db.doc(`phoneTransferAttempts/${transferKey}`);

  let state = classifyPhoneTransferState(sourceUser.phoneNumber, targetUser.phoneNumber, phone);
  if (state === "ORPHANED") {
    // "Neither account currently holds it" is ONLY a legitimate resume when
    // OUR OWN marker says a transfer of this exact triple was already under
    // way — Auth state alone cannot distinguish that from an arbitrary
    // request where source never held this number at all. No marker ->
    // treat it exactly like any other MISMATCH, never guess.
    const attemptSnap = await attemptRef.get();
    if (!attemptSnap.exists) {
      state = "MISMATCH";
    }
  }
  if (state === "MISMATCH") {
    throw fail(
      "CLASSIFY",
      `Current phone state does not match this transfer request. Source currently holds ${mask(sourceUser.phoneNumber)}, target currently holds ${mask(targetUser.phoneNumber)}; expected source to hold ${mask(phone)} and target to hold none. Refusing to guess — resolve manually before retrying.`,
    );
  }

  const sourceStaffSnap = await db.doc(`staff/${sourceUid}`).get();
  const targetStaffSnap = await db.doc(`staff/${targetUid}`).get();
  const { maskedLast4, hash } = maskPhoneForAudit(phone);

  const preview = {
    state,
    sourceUid, sourceEmail: sourceUser.email ?? null, sourceHasStaffDoc: sourceStaffSnap.exists,
    targetUid, targetEmail: targetUser.email ?? null,
    targetDisplayName: targetStaffSnap.exists ? (targetStaffSnap.data()?.displayName ?? null) : null,
    targetRole: targetStaffSnap.exists ? (targetStaffSnap.data()?.role ?? null) : null,
    phoneNumberMaskedLast4: maskedLast4,
  };

  if (dryRun) {
    return { ok: true, preview };
  }

  const now = new Date().toISOString();

  if (state === "NOT_STARTED") {
    // Record the attempt BEFORE the first Auth mutation — if everything
    // after this point fails irrecoverably, this marker is what lets a
    // later call safely recognise "neither account holds it" as OUR OWN
    // interrupted attempt rather than refusing it as an unverified MISMATCH.
    await attemptRef.set({ sourceUid, targetUid, maskedLast4, hash, startedAt: now }, { merge: true });
    try {
      await admin.auth().updateUser(sourceUid, { phoneNumber: null });
    } catch (err: any) {
      throw fail("REMOVE_FROM_SOURCE", err?.message || "Could not remove the phone number from the source account. Nothing changed.");
    }
  }

  // Reachable from NOT_STARTED (just cleared above) or ORPHANED (a prior
  // run already cleared it but never completed the assignment) — either
  // way, the number currently belongs to neither account and must be
  // assigned to the target now.
  if (state === "NOT_STARTED" || state === "ORPHANED") {
    try {
      await admin.auth().updateUser(targetUid, { phoneNumber: phone });
    } catch (assignErr: any) {
      let rolledBack = false;
      try {
        await admin.auth().updateUser(sourceUid, { phoneNumber: phone });
        rolledBack = true;
      } catch {
        rolledBack = false;
      }

      await writeAudit(
        rolledBack ? "STAFF_PHONE_TRANSFER_ROLLED_BACK" : "STAFF_PHONE_TRANSFER_ORPHANED",
        "staff", targetUid, request.auth.uid, actor.name, actor.role,
        null,
        { sourceUid, targetUid, maskedLast4, hash },
        rolledBack
          ? "Assign-to-target step failed; automatically rolled back to source — nothing lost."
          : "CRITICAL: phone removed from source but not assigned to target, and automatic rollback also failed. Number is currently attached to neither account.",
      );

      throw fail(
        "ASSIGN_TO_TARGET",
        rolledBack
          ? `Could not assign the number to the target account (${assignErr?.message || "unknown error"}). Automatically rolled back — the source account still holds the number; nothing was lost.`
          : "CRITICAL: the number was removed from the source account but could NOT be assigned to the target, and automatic rollback ALSO failed. The number is attached to neither account. Re-run this same transfer to retry — it is safe to resume.",
        { rolledBack },
      );
    }
  }

  try {
    await db.doc(`staff/${targetUid}`).set({ phoneNumber: phone, updatedAt: now }, { merge: true });
  } catch (err: any) {
    await writeAudit(
      "STAFF_PHONE_TRANSFER_MIRROR_FAILED", "staff", targetUid, request.auth.uid, actor.name, actor.role,
      null, { sourceUid, targetUid, maskedLast4, hash, step: "UPDATE_TARGET_MIRROR" },
      "Auth-level transfer succeeded; target staff/{uid} mirror update failed.",
    );
    throw fail(
      "UPDATE_TARGET_MIRROR",
      `The Auth-level transfer succeeded — the target account now owns the number — but updating its staff profile failed: ${err?.message || "unknown error"}. Safe to retry; nothing else needs undoing.`,
    );
  }

  if (sourceStaffSnap.exists) {
    try {
      await db.doc(`staff/${sourceUid}`).set({ phoneNumber: null, updatedAt: now }, { merge: true });
    } catch (err: any) {
      await writeAudit(
        "STAFF_PHONE_TRANSFER_MIRROR_FAILED", "staff", targetUid, request.auth.uid, actor.name, actor.role,
        null, { sourceUid, targetUid, maskedLast4, hash, step: "CLEAR_SOURCE_MIRROR" },
        "Auth-level transfer and target mirror succeeded; clearing the source profile's stale mobile number failed.",
      );
      throw fail(
        "CLEAR_SOURCE_MIRROR",
        `The transfer succeeded and the target profile is correct, but clearing the old number from the source profile failed: ${err?.message || "unknown error"}. Safe to retry.`,
      );
    }
  }

  // Transfer is now fully complete and correct on both sides — the marker
  // has done its job and a leftover doc would only ever grant resume rights
  // for an already-finished triple, so clear it. Best-effort: a failure
  // here never un-does the transfer itself.
  await attemptRef.delete().catch(() => {});

  await writeAudit(
    "STAFF_PHONE_TRANSFER", "staff", targetUid, request.auth.uid, actor.name, actor.role,
    { sourceUid, maskedLast4, hash }, { targetUid, maskedLast4, hash },
    `Phone number transferred: ${sourceUid} -> ${targetUid}`,
  );

  return { ok: true, preview };
});

/* ═══════════════════════════════════════════════════════════════════
 * staffDelete — permanently removes a staff account: the Firebase Auth
 * user AND staff/{uid}. Super-Admin-only.
 *
 * Two safety guards (checked before anything is deleted):
 *   - Self-delete: the caller's own uid is always rejected.
 *   - Last Owner: if the target's role is 'owner', this refuses to delete
 *     it when it's the ONLY staff/{uid} with role 'owner' — counted
 *     regardless of that record's (or any other owner record's) active
 *     flag, so an inactive duplicate can never be used to sneak past the
 *     guard and leave zero Owner records of any kind.
 *
 * Deliberately NOT one atomic transaction spanning Auth and Firestore —
 * same compensating-rollback discipline as provisionStaffAccount, just
 * run in the opposite direction: Firestore first (staff/{uid}, and
 * customers/{uid} ONLY if it exists and is clearly marked staffLinked —
 * never a doc that isn't unambiguously this mechanism's own mirror),
 * since "staff/{uid} gone, Auth account still live" is the safer partial
 * state (the account simply can't resolve a Flow identity on next sign-in
 * attempt) than the reverse ("Auth gone, staff/{uid} still claiming to be
 * a real account" — exactly the orphan state this whole feature removed
 * tooling for). If the final Auth delete step fails, that's recorded in
 * the SAME audit entry's `after` field (never masked) and surfaced as an
 * error — the Firestore side has already genuinely changed by that point,
 * so reporting success would be dishonest, not because anything is rolled
 * back. Tolerates the Auth user already being gone (e.g. deleted via
 * Console previously), so this also doubles as the one remaining manual
 * cleanup path for a pre-existing orphan — same end state, through the
 * one mechanism, instead of a second one.
 *
 * Input : { uid: string }
 * Output: { ok: true }
 * ═══════════════════════════════════════════════════════════════════*/
export const staffDelete = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireSuperAdmin(request.auth.uid);

  const { uid } = request.data as { uid?: string };
  if (!uid || typeof uid !== "string") {
    throw new HttpsError("invalid-argument", "uid is required.");
  }
  if (uid === request.auth.uid) {
    throw new HttpsError("failed-precondition", "You cannot delete your own account.");
  }

  const ref = db.doc(`staff/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", `Staff doc ${uid} not found.`);
  const before = snap.data()!;

  if (normalizeStaffRole(before.role) === "owner") {
    const ownersSnap = await db.collection("staff").where("role", "==", "owner").get();
    if (ownersSnap.size <= 1) {
      throw new HttpsError("failed-precondition", "Cannot delete the last remaining Owner account.");
    }
  }

  const custRef = db.doc(`customers/${uid}`);
  const custSnap = await custRef.get();
  const deleteCustomerMirror = custSnap.exists && custSnap.data()?.staffLinked === true;

  const batch = db.batch();
  batch.delete(ref);
  if (deleteCustomerMirror) batch.delete(custRef);
  await batch.commit();

  try {
    await admin.auth().deleteUser(uid);
  } catch (err: any) {
    if (err?.code !== "auth/user-not-found") {
      await writeAudit("STAFF_DELETE", "staff", uid, request.auth.uid, actor.name, actor.role,
        before, { deleted: true, customerMirrorDeleted: deleteCustomerMirror, authDeleteFailed: true });
      throw new HttpsError("internal", "Staff profile deleted, but the Auth account could not be removed. Contact support.");
    }
    // Already gone (e.g. previously deleted via Console) — nothing more to do.
  }

  await writeAudit("STAFF_DELETE", "staff", uid, request.auth.uid, actor.name, actor.role,
    before, { deleted: true, customerMirrorDeleted: deleteCustomerMirror });

  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════════
 * karigarCreate — add a new Karigar to the registry.
 *
 * Input : { name, mobile, skillTags, hourlyRate, badgeId?, aadhaar?, notes? }
 * Output: { id: string }
 *
 * ID is generated via nextId (K-0001 format). Atomic transaction.
 * ═══════════════════════════════════════════════════════════════════ */

export const karigarCreate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireAdmin(request.auth.uid);

  const { name, mobile, skillTags, hourlyRate, badgeId, aadhaar, notes } = request.data as {
    name?: string; mobile?: string; skillTags?: string[];
    hourlyRate?: number; badgeId?: string; aadhaar?: string; notes?: string;
  };

  if (!name || !mobile || !skillTags || hourlyRate === undefined) {
    throw new HttpsError("invalid-argument", "name, mobile, skillTags, hourlyRate are required.");
  }
  if (typeof hourlyRate !== "number" || hourlyRate < 0) {
    throw new HttpsError("invalid-argument", "hourlyRate must be a non-negative number.");
  }

  // Atomic ID generation (K-0001, K-0002, ...)
  const counterRef = db.doc("idCounters/karigar");
  const karigarId = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    let next: number;
    if (snap.exists) {
      next = (snap.data()!.next || 0) + 1;
      tx.update(counterRef, { next, updatedAt: new Date().toISOString() });
    } else {
      next = 1;
      tx.set(counterRef, { domain: "karigar", prefix: "K-", next, updatedAt: new Date().toISOString() });
    }
    return `K-${String(next).padStart(4, "0")}`;
  });

  const now = new Date().toISOString();
  const karigarDoc = {
    id: karigarId,
    name,
    mobile,
    skillTags: Array.isArray(skillTags) ? skillTags : [],
    hourlyRate,
    active: true,
    badgeId: badgeId || null,
    aadhaar: aadhaar || null,
    notes: notes || "",
    createdBy: request.auth.uid,
    createdByName: actor.name,
    createdAt: now,
    updatedAt: now,
  };

  await db.doc(`karigars/${karigarId}`).set(karigarDoc);
  await writeAudit("KARIGAR_CREATE", "karigars", karigarId, request.auth.uid, actor.name, actor.role, null, karigarDoc);

  return { id: karigarId };
});

/* ═══════════════════════════════════════════════════════════════════
 * karigarUpdate — update an existing Karigar's fields.
 *
 * Input : { id: string, updates: { name?, mobile?, skillTags?, hourlyRate?,
 *          badgeId?, aadhaar?, notes?, active? } }
 * Output: { ok: true }
 *
 * hourlyRate change is always audited. active=false = deactivate (never delete).
 * ═══════════════════════════════════════════════════════════════════ */

export const karigarUpdate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireAdmin(request.auth.uid);

  const { id, updates } = request.data as { id?: string; updates?: Record<string, unknown> };
  if (!id || !updates || typeof updates !== "object") {
    throw new HttpsError("invalid-argument", "id and updates object required.");
  }

  const ref = db.doc(`karigars/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", `Karigar ${id} not found.`);
  const before = snap.data()!;

  const allowed = ["name", "mobile", "skillTags", "hourlyRate", "badgeId", "aadhaar", "notes", "active"];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) {
    if (k in updates) patch[k] = updates[k];
  }
  if (Object.keys(patch).length === 0) {
    throw new HttpsError("invalid-argument", "No valid fields to update.");
  }
  if (patch.hourlyRate !== undefined && (typeof patch.hourlyRate !== "number" || patch.hourlyRate < 0)) {
    throw new HttpsError("invalid-argument", "hourlyRate must be a non-negative number.");
  }

  patch.updatedAt = new Date().toISOString();
  await ref.update(patch);

  // Audit the update
  const auditAfter: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    if (k !== "updatedAt") auditAfter[k] = patch[k];
  }
  await writeAudit("KARIGAR_UPDATE", "karigars", id, request.auth.uid, actor.name, actor.role,
    { name: before.name, mobile: before.mobile, hourlyRate: before.hourlyRate, active: before.active },
    auditAfter);

  // Deactivation audit (separate action for the flag)
  if (patch.active === false && before.active === true) {
    await writeAudit("KARIGAR_DEACTIVATE", "karigars", id, request.auth.uid, actor.name, actor.role,
      { active: true }, { active: false });
  }

  return { ok: true };
});
