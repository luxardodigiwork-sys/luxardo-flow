/* eslint-disable */
/**
 * LUXARDO FASHION — PHASE 2 · BLOCK 2.4 · PRODUCTION REQUEST
 * ============================================================================
 * Cloud Functions for the production-request foundation.
 *
 * Finalized rules (locked):
 *  - Dispatch creates / submits reproduction or additional production requests.
 *  - Each PR has its own PR-XXXX ID (transaction-safe).
 *  - Quantity defaults to 0. A PR CANNOT be submitted at quantity 0.
 *  - Quantity may be edited BEFORE Owner approval. After approval the
 *    originalOrderedQty is PERMANENTLY FROZEN.
 *  - An approved PR's design version can never be silently changed.
 *  - Additional quantity ALWAYS requires a NEW PR (never merged in).
 *  - Owner approval is REQUIRED before PM can receive/work the PR.
 *  - Rejection by Owner stores actor, timestamp and mandatory reason.
 *  - Post-approval edits are limited to urgency + requiredDate (audited).
 * ============================================================================
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { generateId } from "./production";
import { requireStaff, hasAnyRole, StaffIdentity } from "./staffAuth";
import { auditDoc, writeAudit } from "./audit";
import { recordMovement } from "./movement";

const db = admin.firestore();

const PR_CREATORS = ["admin", "owner", "dispatch"];
const PR_EDITORS = ["admin", "owner", "dispatch"];
const PR_APPROVERS = ["admin", "owner"];
const PR_AUDIT_EDITORS = ["admin", "owner"];
const PIECE_GENERATORS = ["admin", "owner", "pm"]; // PM generates physical pieces for approved PRs

const URGENCY_LEVELS = ["HIGH", "MEDIUM", "LOW"];
const REQUIRED_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Audit helper inside a transaction (atomic with the state change). */
function txAudit(
  tx: admin.firestore.Transaction,
  action: string,
  entity: string,
  entityId: string,
  actor: StaffIdentity,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
) {
  const rec = auditDoc(action, entity, entityId, actor, before, after);
  rec.id = crypto.randomUUID();
  tx.set(db.collection("auditLogs").doc(rec.id), rec);
}

/** The referenced design version must be an approved, frozen version. */
async function assertFrozenDesignVersion(designId: string, designVersionId: string): Promise<void> {
  const snap = await db.doc(`designVersions/${designVersionId}`).get();
  if (!snap.exists) {
    throw new HttpsError("invalid-argument", `Design version ${designVersionId} not found.`);
  }
  const v = snap.data()!;
  if (v.designId !== designId || !v.frozen || v.snapshot?.status !== "APPROVED") {
    throw new HttpsError("failed-precondition", "Only an Owner-approved (frozen) design version can be produced.");
  }
}

/** Owner-approved PRs that are still running (post-approval edits and piece
 * generation stay allowed once production has started). */
const PR_LIVE_STATUSES = ["APPROVED", "IN_PRODUCTION"];

/**
 * Owner rule (Oct 2026): PR status follows real piece progress.
 *  - APPROVED -> IN_PRODUCTION as soon as any piece leaves OPEN
 *    (active, completed or rejected counter > 0).
 *  - APPROVED/IN_PRODUCTION -> COMPLETED only when delivered (STORE_OUT)
 *    pieces reach the Owner-frozen ordered quantity. Rejected pieces never
 *    count as delivered; a rejected piece must be replaced and delivered.
 * Pure function so it can be unit-tested without Firestore.
 */
export function derivePrStatus(d: Record<string, any>): string | null {
  const status = String(d.status || "");
  if (!PR_LIVE_STATUSES.includes(status) || !d.originalQtyFrozen) return null;
  const ordered = Number(d.originalOrderedQty) || 0;
  const completed = Number(d.completedQty) || 0;
  const started = (Number(d.currentActiveQty) || 0) + completed + (Number(d.rejectedQty) || 0);
  if (ordered > 0 && completed >= ordered) return status === "COMPLETED" ? null : "COMPLETED";
  if (status === "APPROVED" && started > 0) return "IN_PRODUCTION";
  return null;
}

/** Firestore trigger: keeps PR status in sync with its piece counters. Every
 * piece-moving callable already updates the counters via
 * applyPrQuantityDelta, so this one place covers all of them. Idempotent: a
 * status write re-triggers it, derivePrStatus then returns null. */
export const prStatusSync = onDocumentUpdated("productionRequests/{prId}", async (event) => {
  const after = event.data?.after;
  if (!after?.exists) return;
  const next = derivePrStatus(after.data() || {});
  if (!next) return;
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status: next, updatedAt: now };
  if (next === "IN_PRODUCTION") patch.productionStartedAt = now;
  if (next === "COMPLETED") patch.completedAt = now;
  await after.ref.update(patch);
  await writeAudit("PR_STATUS_AUTO", "productionRequests", event.params.prId,
    { uid: "system", name: "system", role: "system" },
    { status: after.data()?.status }, { status: next });
});

function normalizeQty(n: unknown): number {
  const q = Number(n);
  if (!Number.isFinite(q) || q < 0) throw new HttpsError("invalid-argument", "Quantity must be a non-negative number.");
  return Math.floor(q);
}

/** Derive the 6-facet quantity map from the ordered quantity. */
function qtyMap(ordered: number) {
  return {
    originalOrderedQty: ordered,
    currentActiveQty: 0,
    completedQty: 0,
    reworkQty: 0,
    rejectedQty: 0,
    pendingQty: ordered,
    totalPieceCount: ordered,
  };
}

/**
 * PR quantity-counter bucket for a piece stage, per the locked definitions:
 *   pendingQty       = OPEN
 *   currentActiveQty = IN_WORK, QC_PENDING, REWORK, QC_PASS, DISPATCH_READY,
 *                       TAILOR_ASSIGNED, STITCHING, STITCH_COMPLETE, STORE
 *   completedQty     = STORE_OUT
 *   rejectedQty      = REJECTED
 * reworkQty is NOT one of these buckets — see applyPrQuantityDelta.
 */
function prQtyBucket(stage: string): "pending" | "active" | "completed" | "rejected" | null {
  if (stage === "OPEN") return "pending";
  if (stage === "STORE_OUT") return "completed";
  if (stage === "REJECTED") return "rejected";
  if (
    stage === "IN_WORK" || stage === "QC_PENDING" || stage === "REWORK" ||
    stage === "QC_PASS" || stage === "DISPATCH_READY" || stage === "TAILOR_ASSIGNED" ||
    stage === "STITCHING" || stage === "STITCH_COMPLETE" || stage === "STORE"
  ) return "active";
  return null;
}

/**
 * Apply the PR-level quantity-counter delta for one piece's stage change.
 * MUST be called inside the same transaction as the piece's own stage
 * mutation, with fromStage/toStage taken from that transaction's own fresh
 * read (never a pre-transaction read) — so a concurrent move cannot
 * double-update. Uses FieldValue.increment (no read of the PR doc needed),
 * which also keeps this safe to call after the piece write within the same
 * transaction without violating Firestore's reads-before-writes ordering.
 *
 * pendingQty/currentActiveQty/completedQty/rejectedQty come from the
 * mutually-exclusive bucket above. reworkQty is a separate, current-state
 * tag: a piece AT stage REWORK is counted in BOTH currentActiveQty AND
 * reworkQty (REWORK is an "active" bucket per the locked definitions);
 * reworkQty is decremented the moment the piece leaves REWORK (e.g. back to
 * IN_WORK), so repeated rework cycles never double-count.
 *
 * No-ops when there is no real stage change, or the piece has no prId.
 */
export function applyPrQuantityDelta(
  tx: admin.firestore.Transaction,
  prId: string | null | undefined,
  fromStage: string,
  toStage: string
): void {
  if (!prId || fromStage === toStage) return;
  const from = prQtyBucket(fromStage);
  const to = prQtyBucket(toStage);

  const inc: Record<string, admin.firestore.FieldValue> = {};
  const bump = (field: string, n: number) => { inc[field] = admin.firestore.FieldValue.increment(n); };

  if (from === "pending" && to !== "pending") bump("pendingQty", -1);
  if (from === "active" && to !== "active") bump("currentActiveQty", -1);
  if (to === "active" && from !== "active") bump("currentActiveQty", 1);
  if (to === "completed" && from !== "completed") bump("completedQty", 1);
  if (to === "rejected" && from !== "rejected") bump("rejectedQty", 1);
  if (toStage === "REWORK" && fromStage !== "REWORK") bump("reworkQty", 1);
  if (fromStage === "REWORK" && toStage !== "REWORK") bump("reworkQty", -1);

  if (Object.keys(inc).length === 0) return;
  tx.update(db.doc(`productionRequests/${prId}`), { ...inc, updatedAt: new Date().toISOString() });
}

/* ═══════════════════════════════════════════════════════════════════
 * prCreate — Dispatch/admin/owner creates a production request (DRAFT).
 * Input : { designId, designVersionId, quantity?, urgency?, requiredDate?, garmentType? }
 * Output: { ok, id, pr }
 * Quantity defaults to 0 and must be > 0 to submit.
 * ═══════════════════════════════════════════════════════════════════ */
export const prCreate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, PR_CREATORS)) {
    throw new HttpsError("permission-denied", "Dispatch/Admin/Owner access required.");
  }

  const { designId, designVersionId, quantity, urgency, requiredDate, garmentType } = (request.data || {}) as {
    designId?: string; designVersionId?: string; quantity?: number;
    urgency?: string; requiredDate?: string; garmentType?: string;
  };
  if (!designId || !designVersionId) {
    throw new HttpsError("invalid-argument", "designId and designVersionId are required.");
  }
  await assertFrozenDesignVersion(designId, designVersionId);

  const qty = normalizeQty(quantity ?? 0);
  const urgencyLevel = String(urgency ?? "MEDIUM").toUpperCase();
  if (!URGENCY_LEVELS.includes(urgencyLevel)) throw new HttpsError("invalid-argument", "Invalid urgency level.");
  if (requiredDate !== undefined && !REQUIRED_DATE_RE.test(String(requiredDate))) {
    throw new HttpsError("invalid-argument", "requiredDate must be YYYY-MM-DD.");
  }

  const prId = await generateId("pr");
  const now = new Date().toISOString();
  const pr = {
    id: prId,
    requestedBy: actor.uid,
    requestedByName: actor.name,
    requestedByRole: actor.role,
    createdAt: now,
    updatedAt: now,
    designId,
    designVersionId,
    garmentType: String(garmentType ?? ""),
    ...qtyMap(qty),
    originalQtyFrozen: false,
    status: "DRAFT",
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedByName: null,
    rejectedAt: null,
    rejectionReason: null,
    urgency: urgencyLevel as "HIGH" | "MEDIUM" | "LOW",
    requiredDate: String(requiredDate ?? ""),
    cancelledBy: null,
    cancelledAt: null,
    createdBy: actor.uid,
    createdByName: actor.name,
  };

  await db.doc(`productionRequests/${prId}`).set(pr);
  await writeAudit("PR_CREATE", "productionRequests", prId, actor, null, pr);

  return { ok: true, id: prId, pr };
});

/* ═══════════════════════════════════════════════════════════════════
 * prUpdate — edit a PRE-approval PR (quantity, urgency, requiredDate, garmentType).
 * Quantity edits permitted only while originalQtyFrozen === false.
 * Input : { id, quantity?, urgency?, requiredDate?, garmentType? }
 * ═══════════════════════════════════════════════════════════════════ */
export const prUpdate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, PR_EDITORS)) {
    throw new HttpsError("permission-denied", "Dispatch/Admin/Owner access required.");
  }

  const { id, quantity, urgency, requiredDate, garmentType } = (request.data || {}) as {
    id?: string; quantity?: number; urgency?: string; requiredDate?: string; garmentType?: string;
  };
  if (!id) throw new HttpsError("invalid-argument", "PR id required.");

  const ref = db.doc(`productionRequests/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `PR ${id} not found.`);
    const d = snap.data()!;
    if (d.originalQtyFrozen || d.status === "APPROVED" || d.status === "IN_PRODUCTION" || d.status === "COMPLETED") {
      throw new HttpsError("failed-precondition", "Approved PR quantity is immutable. Additional quantity requires a NEW request.");
    }

    const patch: Record<string, unknown> = {};
    if (quantity !== undefined) {
      const q = normalizeQty(quantity);
      Object.assign(patch, qtyMap(q));
      txAudit(tx, "PR_EDIT_QTY", "productionRequests", id, actor,
        { originalOrderedQty: d.originalOrderedQty }, { originalOrderedQty: q });
    }
    if (urgency !== undefined) {
      const u = String(urgency).toUpperCase();
      if (!URGENCY_LEVELS.includes(u)) throw new HttpsError("invalid-argument", "Invalid urgency level.");
      patch.urgency = u;
    }
    if (requiredDate !== undefined) {
      if (!REQUIRED_DATE_RE.test(String(requiredDate))) throw new HttpsError("invalid-argument", "requiredDate must be YYYY-MM-DD.");
      patch.requiredDate = String(requiredDate);
    }
    if (garmentType !== undefined) patch.garmentType = String(garmentType);
    if (Object.keys(patch).length === 0) throw new HttpsError("invalid-argument", "No valid fields to update.");
    patch.updatedAt = new Date().toISOString();
    tx.update(ref, patch);
  });

  return { ok: true, id };
});

/* ═══════════════════════════════════════════════════════════════════
 * prSubmit — submit PR for Owner approval. Rejected at quantity 0.
 * Input : { id }
 * ═══════════════════════════════════════════════════════════════════ */
export const prSubmit = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, PR_CREATORS)) {
    throw new HttpsError("permission-denied", "Dispatch/Admin/Owner access required.");
  }
  const { id } = (request.data || {}) as { id?: string };
  if (!id) throw new HttpsError("invalid-argument", "PR id required.");

  const ref = db.doc(`productionRequests/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `PR ${id} not found.`);
    const d = snap.data()!;
    if (d.originalQtyFrozen || d.status === "APPROVED" || d.status === "IN_PRODUCTION" || d.status === "COMPLETED") {
      throw new HttpsError("failed-precondition", "PR already approved.");
    }
    if (Number(d.originalOrderedQty) <= 0) {
      throw new HttpsError("invalid-argument", "A production request CANNOT be submitted with quantity 0.");
    }
    await assertFrozenDesignVersion(String(d.designId), String(d.designVersionId));
    tx.update(ref, { status: "SUBMITTED", updatedAt: new Date().toISOString() });
    txAudit(tx, "PR_SUBMIT", "productionRequests", id, actor,
      { status: d.status }, { status: "SUBMITTED" });
  });
  return { ok: true, id };
});

/* ═══════════════════════════════════════════════════════════════════
 * prApprove — Owner/Admin approves. Freezes originalOrderedQty + design version.
 * PM may only receive Owner-approved PRs.
 * Input : { id }
 * ═══════════════════════════════════════════════════════════════════ */
export const prApprove = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, PR_APPROVERS)) {
    throw new HttpsError("permission-denied", "Owner/Admin approval required.");
  }
  const { id } = (request.data || {}) as { id?: string };
  if (!id) throw new HttpsError("invalid-argument", "PR id required.");

  const ref = db.doc(`productionRequests/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `PR ${id} not found.`);
    const d = snap.data()!;
    if (d.status === "APPROVED" || d.status === "IN_PRODUCTION" || d.status === "COMPLETED") {
      throw new HttpsError("already-exists", "PR already approved.");
    }
    if (d.status !== "SUBMITTED") throw new HttpsError("failed-precondition", "PR must be submitted before approval.");
    if (Number(d.originalOrderedQty) <= 0) {
      throw new HttpsError("invalid-argument", "Cannot approve a PR with quantity 0.");
    }
    await assertFrozenDesignVersion(String(d.designId), String(d.designVersionId));

    const now = new Date().toISOString();
    tx.update(ref, {
      status: "APPROVED",
      originalQtyFrozen: true,
      approvedBy: actor.uid,
      approvedByName: actor.name,
      approvedAt: now,
      updatedAt: now,
    });
    txAudit(tx, "PR_APPROVE", "productionRequests", id, actor,
      { status: d.status, originalOrderedQty: d.originalOrderedQty }, { status: "APPROVED", originalQtyFrozen: true });
  });
  return { ok: true, id };
});

/* ═══════════════════════════════════════════════════════════════════
 * prReject — Owner (or Admin) rejects; mandatory reason recorded.
 * Input : { id, reason }
 * ═══════════════════════════════════════════════════════════════════ */
export const prReject = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, PR_APPROVERS)) {
    throw new HttpsError("permission-denied", "Owner/Admin access required.");
  }
  const { id, reason } = (request.data || {}) as { id?: string; reason?: string };
  if (!id) throw new HttpsError("invalid-argument", "PR id required.");
  const reasonText = String(reason ?? "").trim();
  if (!reasonText) throw new HttpsError("invalid-argument", "A rejection reason is mandatory.");

  const ref = db.doc(`productionRequests/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `PR ${id} not found.`);
    const d = snap.data()!;
    if (d.status === "APPROVED" || d.status === "IN_PRODUCTION" || d.status === "COMPLETED") {
      throw new HttpsError("failed-precondition", "Approved PR cannot be rejected — create a new request instead.");
    }
    if (d.originalQtyFrozen) throw new HttpsError("failed-precondition", "Quantity already frozen; cannot reject.");

    const now = new Date().toISOString();
    tx.update(ref, {
      status: "REJECTED_BY_OWNER",
      rejectedBy: actor.uid,
      rejectedByName: actor.name,
      rejectedAt: now,
      rejectionReason: reasonText,
      updatedAt: now,
    });
    txAudit(tx, "PR_REJECT", "productionRequests", id, actor,
      { status: d.status }, { status: "REJECTED_BY_OWNER", rejectionReason: reasonText });
  });
  return { ok: true, id };
});

/* ═══════════════════════════════════════════════════════════════════
 * prEditApproved — post-approval edits. Only urgency + requiredDate,
 * and only Owner/Admin. Every edit is written to the PR audit sub-collection.
 * Input : { id, urgency?, requiredDate? }
 * ═══════════════════════════════════════════════════════════════════ */
export const prEditApproved = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, PR_AUDIT_EDITORS)) {
    throw new HttpsError("permission-denied", "Owner/Admin access required.");
  }
  const { id, urgency, requiredDate } = (request.data || {}) as {
    id?: string; urgency?: string; requiredDate?: string;
  };
  if (!id) throw new HttpsError("invalid-argument", "PR id required.");

  const ref = db.doc(`productionRequests/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `PR ${id} not found.`);
    const d = snap.data()!;
    if (!d.originalQtyFrozen || !PR_LIVE_STATUSES.includes(d.status)) {
      throw new HttpsError("failed-precondition", "Only approved PRs support post-approval edits (urgency/requiredDate).");
    }

    const patch: Record<string, unknown> = {};
    const audits: Array<{ field: string; oldValue: string | number; newValue: string | number }> = [];

    if (urgency !== undefined) {
      const u = String(urgency).toUpperCase();
      if (!URGENCY_LEVELS.includes(u)) throw new HttpsError("invalid-argument", "Invalid urgency level.");
      if (u !== d.urgency) {
        patch.urgency = u;
        audits.push({ field: "urgency", oldValue: d.urgency, newValue: u });
      }
    }
    if (requiredDate !== undefined) {
      if (!REQUIRED_DATE_RE.test(String(requiredDate))) throw new HttpsError("invalid-argument", "requiredDate must be YYYY-MM-DD.");
      if (String(requiredDate) !== d.requiredDate) {
        patch.requiredDate = String(requiredDate);
        audits.push({ field: "requiredDate", oldValue: d.requiredDate, newValue: String(requiredDate) });
      }
    }
    if (Object.keys(patch).length === 0) throw new HttpsError("invalid-argument", "No valid fields to edit.");

    patch.updatedAt = new Date().toISOString();
    tx.update(ref, patch);

    for (const a of audits) {
      const docId = `${id}-ed-${crypto.randomUUID().slice(0, 8)}`;
      tx.set(db.doc(`productionRequests/${id}/audit/${docId}`), {
        id: docId,
        field: a.field,
        oldValue: a.oldValue,
        newValue: a.newValue,
        editedBy: actor.uid,
        editedByName: actor.name,
        editedByRole: actor.role,
        at: new Date().toISOString(),
      });
      txAudit(tx, a.field === "urgency" ? "PR_EDIT_URGENCY" : "PR_EDIT_REQUIREDDATE",
        "productionRequests", id, actor, { [a.field]: a.oldValue }, { [a.field]: a.newValue });
    }
  });
  return { ok: true, id };
});

/* ═══════════════════════════════════════════════════════════════════
 * prReproduce — Dispatch/Admin/Owner creates a REPRODUCTION request.
 * The reproduction is ALWAYS a NEW PR with its OWN PR-XXXX ID.
 * It reproduces the same approved (frozen) design version as the source PR.
 * Original quantities of the source PR are never touched.
 * Input : { sourcePrId, quantity?, urgency?, requiredDate?, garmentType? }
 * ═══════════════════════════════════════════════════════════════════ */
export const prReproduce = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, PR_CREATORS)) {
    throw new HttpsError("permission-denied", "Dispatch/Admin/Owner access required.");
  }

  const { sourcePrId, quantity, urgency, requiredDate, garmentType } = (request.data || {}) as {
    sourcePrId?: string; quantity?: number; urgency?: string; requiredDate?: string; garmentType?: string;
  };
  if (!sourcePrId) throw new HttpsError("invalid-argument", "sourcePrId is required.");

  // The source PR binds the approved design version to reproduce.
  const srcSnap = await db.doc(`productionRequests/${sourcePrId}`).get();
  if (!srcSnap.exists) throw new HttpsError("not-found", `Source PR ${sourcePrId} not found.`);
  const src = srcSnap.data()!;
  const designId = String(src.designId || "");
  const designVersionId = String(src.designVersionId || "");
  if (!designId || !designVersionId) {
    throw new HttpsError("failed-precondition", "Source PR has no approved design version to reproduce.");
  }
  await assertFrozenDesignVersion(designId, designVersionId);

  const qty = normalizeQty(quantity ?? 0);
  const urgencyLevel = String(urgency ?? "MEDIUM").toUpperCase();
  if (!URGENCY_LEVELS.includes(urgencyLevel)) throw new HttpsError("invalid-argument", "Invalid urgency level.");
  if (requiredDate !== undefined && !REQUIRED_DATE_RE.test(String(requiredDate))) {
    throw new HttpsError("invalid-argument", "requiredDate must be YYYY-MM-DD.");
  }

  const prId = await generateId("pr");
  const now = new Date().toISOString();
  const pr = {
    id: prId,
    requestedBy: actor.uid,
    requestedByName: actor.name,
    requestedByRole: actor.role,
    createdAt: now,
    updatedAt: now,
    designId,
    designVersionId,
    garmentType: String(garmentType ?? ""),
    ...qtyMap(qty),
    piecesGeneratedCount: 0,
    originalQtyFrozen: false,
    status: "DRAFT",
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedByName: null,
    rejectedAt: null,
    rejectionReason: null,
    urgency: urgencyLevel as "HIGH" | "MEDIUM" | "LOW",
    requiredDate: String(requiredDate ?? ""),
    cancelledBy: null,
    cancelledAt: null,
    createdBy: actor.uid,
    createdByName: actor.name,
  };

  await db.doc(`productionRequests/${prId}`).set(pr);
  await writeAudit("PR_REPRODUCE", "productionRequests", prId, actor, null, {
    pr, sourcePrId, designId, designVersionId,
  });

  return { ok: true, id: prId, pr };
});

/* ═══════════════════════════════════════════════════════════════════
 * prGeneratePieces — generate physical PIECE-XXXX docs for an APPROVED PR.
 * Owner approval (originalQtyFrozen) is mandatory. Piece IDs are generated
 * via the shared transaction-safe ID counter (never client-side).
 * A piece can NEVER exceed totalPieceCount; stems duplicates within a call.
 * Input : { prId, count? }  — count defaults to (originalOrderedQty - already generated)
 * ═══════════════════════════════════════════════════════════════════ */
export const prGeneratePieces = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, PIECE_GENERATORS)) {
    throw new HttpsError("permission-denied", "PM/Admin/Owner access required.");
  }

  const { prId, count } = (request.data || {}) as { prId?: string; count?: number };
  if (!prId) throw new HttpsError("invalid-argument", "prId is required.");

  const prRef = db.doc(`productionRequests/${prId}`);
  const prSnap = await prRef.get();
  if (!prSnap.exists) throw new HttpsError("not-found", `PR ${prId} not found.`);
  const pr = prSnap.data()!;
  if (!PR_LIVE_STATUSES.includes(pr.status) || !pr.originalQtyFrozen) {
    throw new HttpsError("failed-precondition", "Pieces can only be generated after Owner approval.");
  }

  const ordered = Number(pr.originalOrderedQty) || 0;
  const existing = Number(pr.piecesGeneratedCount) || 0;
  const remaining = ordered - existing;
  if (remaining <= 0) throw new HttpsError("failed-precondition", "All ordered pieces already generated.");

  const toCreate = Math.min(Math.floor(Number(count ?? remaining)), remaining);
  if (toCreate <= 0) throw new HttpsError("invalid-argument", "No pieces to generate (count is 0 or exceeds remaining).");

  const designId = String(pr.designId || "");
  const designVersionId = String(pr.designVersionId || "");
  await assertFrozenDesignVersion(designId, designVersionId);

  // Pre-generate Piece IDs (each its own atomic counter transaction).
  const pieceIds: string[] = [];
  for (let i = 0; i < toCreate; i++) {
    pieceIds.push(await generateId("piece"));
  }

  const now = new Date().toISOString();
  // Atomic: PR capacity + pieces written together; re-read inside the tx for safety.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(prRef);
    const cur = snap.data()!;
    const gen = Number(cur.piecesGeneratedCount) || 0;
    if (gen + toCreate > Number(cur.originalOrderedQty) || Number(cur.originalOrderedQty) <= 0) {
      throw new HttpsError("failed-precondition", "Piece generation would exceed the approved quantity.");
    }
    tx.update(prRef, {
      piecesGeneratedCount: gen + toCreate,
      updatedAt: new Date().toISOString(),
    });

    for (const pieceId of pieceIds) {
      tx.set(db.doc(`pieces/${pieceId}`), {
        id: pieceId,
        designId,
        prId,
        designVersionId,
        kind: "PHYSICAL",
        stage: "OPEN",
        status: "active",
        assignedKarigars: [],
        lastKarigarIds: [],
        totalLabourMinutes: 0,
        totalLabourCost: 0,
        firstWorkAt: null,
        lastWorkAt: null,
        qcVerdict: null,
        rejectionReason: null,
        rejectionType: null,
        rejectedAt: null,
        rejectedBy: null,
        rejectedByName: null,
        reworkCount: 0,
        lastGuardQcId: null,
        assignedTailorUid: null,
        assignedTailorName: null,
        tailorSessionId: null,
        tailorStartAt: null,
        tailorEndAt: null,
        storeInAt: null,
        storeOutAt: null,
        storeOutId: null,
        billNumber: null,
        replacesPieceId: null,
        replacedByPieceId: null,
        notes: "Generated from approved production request",
        createdBy: actor.uid,
        createdByName: actor.name,
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  // Append creation movement records (append-only, after the atomic state change).
  for (const pieceId of pieceIds) {
    await recordMovement({
      pieceId,
      fromStage: null,
      toStage: "OPEN",
      direction: "FORWARD",
      action: "PIECE_CREATE",
      actor,
      reason: `Generated from approved PR ${prId}`,
      relatedRequestId: prId,
      source: "SYSTEM",
      snapshot: { pieceStage: "OPEN", totalLabourMinutes: 0, totalLabourCost: 0 },
    });
  }

  await writeAudit("PR_GENERATE_PIECES", "productionRequests", prId, actor,
    { piecesGeneratedCount: existing }, { piecesGeneratedCount: existing + toCreate, pieceIds });

  return { ok: true, prId, pieceIds, generated: toCreate };
});