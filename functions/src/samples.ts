/* eslint-disable */
/**
 * LUXARDO FASHION — PHASE 2 · BLOCK 2.2 · SAMPLE DESIGN (BLOCK 2.3 : SAMPLE PIECE)
 * ============================================================================
 * Cloud Functions for Sample Design and Sample Piece.
 *
 * SAMPLE DESIGN  = a small fabric piece (swatch) showing a portion of the
 *                  catalogue design — NOT the complete garment.
 * SAMPLE PIECE   = the complete garment / sample garment created for
 *                  catalogue approval — NOT the same entity as Sample Design.
 *
 * Both link to the approved design version (designVersionId) via a catalogue
 * design. Every write is audited. Approved sample documents are frozen
 * (isFrozen) and never hard-deleted.
 * ============================================================================
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { generateId } from "./production";
import { requireStaff, hasAnyRole, StaffIdentity } from "./staffAuth";
import { auditDoc, writeAudit } from "./audit";

const db = admin.firestore();

const SAMPLE_WRITERS = ["admin", "owner", "designer"];
const SAMPLE_APPROVERS = ["admin", "owner"];

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

/** Guard: the referenced catalogue design must be approved + frozen. */
async function assertApprovedDesign(designId: string): Promise<void> {
  const snap = await db.doc(`catalogueDesigns/${designId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", `Catalogue design ${designId} not found.`);
  const d = snap.data()!;
  if (!d.isFrozen && d.status !== "APPROVED" && d.status !== "FROZEN") {
    throw new HttpsError("failed-precondition", "Sample entities can only be created against an Owner-approved design.");
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * sampleDesignCreate — create a small fabric swatch sample.
 * Input : { name, description?, image?, imagePath?, images?, catalogDesignId?, designVersionId? }
 * Output: { ok, id, sample }
 * ═══════════════════════════════════════════════════════════════════ */
export const sampleDesignCreate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, SAMPLE_WRITERS)) {
    throw new HttpsError("permission-denied", "Designer/Admin/Owner access required.");
  }

  const { name, description, image, imagePath, images, catalogDesignId, designVersionId } = (request.data || {}) as {
    name?: string; description?: string; image?: string; imagePath?: string; images?: string[];
    catalogDesignId?: string; designVersionId?: string;
  };
  if (!name || !String(name).trim()) throw new HttpsError("invalid-argument", "Sample design name is required.");
  if (catalogDesignId) await assertApprovedDesign(catalogDesignId);

  const sampleId = await generateId("sampleDesign");
  const now = new Date().toISOString();
  const sample = {
    id: sampleId,
    originalSampleId: null, // legacy SAMPLE-10021 format — optional, preserve original if migrated
    catalogDesignId: catalogDesignId || null,
    designVersionId: designVersionId || null,
    name: String(name).trim(),
    description: String(description ?? ""),
    image: String(image ?? ""),
    imagePath: imagePath || null, // storage path backing `image` when uploaded, not pasted
    images: Array.isArray(images) ? images.map(String) : [],
    status: "DRAFT",
    currentVersion: 1,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    createdBy: actor.uid,
    createdByName: actor.name,
    createdAt: now,
    updatedAt: now,
  };

  await db.doc(`sampleDesigns/${sampleId}`).set(sample);
  await writeAudit("SAMPLE_DESIGN_CREATE", "sampleDesigns", sampleId, actor, null, sample);

  return { ok: true, id: sampleId, sample };
});

/* ═══════════════════════════════════════════════════════════════════
 * sampleDesignUpdate — edit a DRAFT sample design.
 * ═══════════════════════════════════════════════════════════════════ */
export const sampleDesignUpdate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, SAMPLE_WRITERS)) {
    throw new HttpsError("permission-denied", "Designer/Admin/Owner access required.");
  }

  const { id, name, description, image, imagePath, images, catalogDesignId, designVersionId } = (request.data || {}) as {
    id?: string; name?: string; description?: string; image?: string; imagePath?: string; images?: string[];
    catalogDesignId?: string; designVersionId?: string;
  };
  if (!id) throw new HttpsError("invalid-argument", "Sample design id required.");

  const ref = db.doc(`sampleDesigns/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `Sample design ${id} not found.`);
    const d = snap.data()!;
    if (d.status !== "DRAFT") throw new HttpsError("failed-precondition", "Only DRAFT sample designs can be edited.");

    const patch: Record<string, unknown> = {};
    if (name !== undefined) {
      if (!String(name).trim()) throw new HttpsError("invalid-argument", "Sample name cannot be empty.");
      patch.name = String(name).trim();
    }
    if (description !== undefined) patch.description = String(description);
    if (image !== undefined) {
      patch.image = String(image);
      patch.imagePath = imagePath || null; // see designUpdate's identical pairing
    }
    if (images !== undefined) {
      if (!Array.isArray(images)) throw new HttpsError("invalid-argument", "images must be an array.");
      patch.images = images.map(String);
    }
    if (catalogDesignId !== undefined) {
      if (catalogDesignId) await assertApprovedDesign(catalogDesignId);
      patch.catalogDesignId = String(catalogDesignId) || null;
    }
    if (designVersionId !== undefined) patch.designVersionId = String(designVersionId) || null;
    if (Object.keys(patch).length === 0) throw new HttpsError("invalid-argument", "No valid fields to update.");
    patch.updatedAt = new Date().toISOString();
    tx.update(ref, patch);

    const before = { name: d.name, description: d.description };
    const after = { name: patch.name ?? d.name, description: patch.description ?? d.description };
    txAudit(tx, "SAMPLE_DESIGN_UPDATE", "sampleDesigns", id, actor, before, after);
  });

  return { ok: true, id };
});

/* ═══════════════════════════════════════════════════════════════════
 * sampleDesignSubmit — DRAFT → PENDING_APPROVAL.
 * ═══════════════════════════════════════════════════════════════════ */
export const sampleDesignSubmit = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, SAMPLE_WRITERS)) {
    throw new HttpsError("permission-denied", "Designer/Admin/Owner access required.");
  }
  const { id } = (request.data || {}) as { id?: string };
  if (!id) throw new HttpsError("invalid-argument", "Sample design id required.");

  const ref = db.doc(`sampleDesigns/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `Sample design ${id} not found.`);
    const d = snap.data()!;
    if (d.status !== "DRAFT") throw new HttpsError("already-exists", "Sample design is not in DRAFT state.");
    tx.update(ref, { status: "PENDING_APPROVAL", updatedAt: new Date().toISOString() });
    txAudit(tx, "SAMPLE_DESIGN_SUBMIT", "sampleDesigns", id, actor,
      { status: "DRAFT" }, { status: "PENDING_APPROVAL" });
  });
  return { ok: true, id };
});

/* ═══════════════════════════════════════════════════════════════════
 * sampleDesignApprove — Owner/Admin approval → frozen.
 * Category note: a sample swatch becomes the approved visual reference.
 * ═══════════════════════════════════════════════════════════════════ */
export const sampleDesignApprove = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, SAMPLE_APPROVERS)) {
    throw new HttpsError("permission-denied", "Owner/Admin approval required.");
  }
  const { id } = (request.data || {}) as { id?: string };
  if (!id) throw new HttpsError("invalid-argument", "Sample design id required.");

  const ref = db.doc(`sampleDesigns/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `Sample design ${id} not found.`);
    const d = snap.data()!;
    if (d.status === "APPROVED" || d.status === "FROZEN") throw new HttpsError("already-exists", "Already approved.");
    if (d.status !== "PENDING_APPROVAL") throw new HttpsError("failed-precondition", "Sample design must be submitted first.");

    const now = new Date().toISOString();
    tx.update(ref, {
      status: "APPROVED",
      approvedBy: actor.uid,
      approvedByName: actor.name,
      approvedAt: now,
      updatedAt: now,
    });
    txAudit(tx, "SAMPLE_DESIGN_APPROVE", "sampleDesigns", id, actor,
      { status: d.status }, { status: "APPROVED" });
  });
  return { ok: true, id };
});

/* ═══════════════════════════════════════════════════════════════════
 * samplePieceCreate — create a sample piece (complete garment for approval).
 * Input : { designId, designVersionId?, notes?, image? }
 * Output: { ok, id, piece }
 * ═══════════════════════════════════════════════════════════════════ */
export const samplePieceCreate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, SAMPLE_WRITERS)) {
    throw new HttpsError("permission-denied", "Designer/Admin/Owner access required.");
  }

  const { designId, designVersionId, sampleDesignId, notes, image } = (request.data || {}) as {
    designId?: string; designVersionId?: string; sampleDesignId?: string; notes?: string; image?: string;
  };
  if (!designId) throw new HttpsError("invalid-argument", "Catalogue design id (designId) is required.");
  await assertApprovedDesign(designId);

  const pieceId = await generateId("samplePiece");
  const now = new Date().toISOString();
  const piece = {
    id: pieceId,
    designId,
    designVersionId: designVersionId || null,
    sampleDesignId: sampleDesignId || null,
    status: "IN_WORK",
    notes: String(notes ?? ""),
    image: String(image ?? ""),
    createdBy: actor.uid,
    createdByName: actor.name,
    createdAt: now,
    updatedAt: now,
  };

  await db.doc(`samplePieces/${pieceId}`).set(piece);
  await writeAudit("SAMPLE_PIECE_CREATE", "samplePieces", pieceId, actor, null, piece);

  return { ok: true, id: pieceId, piece };
});

/* ═══════════════════════════════════════════════════════════════════
 * samplePieceComplete — mark sample piece garment complete (image compulsory).
 * Input : { id, image, imagePath?, notes? }
 * ═══════════════════════════════════════════════════════════════════ */
export const samplePieceComplete = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, SAMPLE_WRITERS)) {
    throw new HttpsError("permission-denied", "Designer/Admin/Owner access required.");
  }
  const { id, image, imagePath, notes } = (request.data || {}) as { id?: string; image?: string; imagePath?: string; notes?: string };
  if (!id) throw new HttpsError("invalid-argument", "Sample piece id required.");
  if (!image || !String(image).trim()) {
    throw new HttpsError("invalid-argument", "A completed garment photo (image) is compulsory.");
  }

  const ref = db.doc(`samplePieces/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `Sample piece ${id} not found.`);
    const d = snap.data()!;
    if (d.status === "COMPLETE" || d.status === "APPROVED") throw new HttpsError("already-exists", "Sample piece already complete.");
    tx.update(ref, {
      status: "COMPLETE",
      image: String(image).trim(),
      imagePath: imagePath || null, // storage path backing `image` when uploaded, not pasted
      notes: notes !== undefined ? String(notes) : d.notes,
      updatedAt: new Date().toISOString(),
    });
    txAudit(tx, "SAMPLE_PIECE_COMPLETE", "samplePieces", id, actor,
      { status: d.status }, { status: "COMPLETE" });
  });
  return { ok: true, id };
});

/* ═══════════════════════════════════════════════════════════════════
 * samplePieceApprove — Owner/Admin approves the complete sample piece.
 * The approved sample piece becomes the catalogue garment reference.
 * ═══════════════════════════════════════════════════════════════════ */
export const samplePieceApprove = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, SAMPLE_APPROVERS)) {
    throw new HttpsError("permission-denied", "Owner/Admin approval required.");
  }
  const { id } = (request.data || {}) as { id?: string };
  if (!id) throw new HttpsError("invalid-argument", "Sample piece id required.");

  const ref = db.doc(`samplePieces/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `Sample piece ${id} not found.`);
    const d = snap.data()!;
    if (d.status !== "COMPLETE") {
      throw new HttpsError("failed-precondition", "Only a COMPLETE sample piece can be approved for the catalogue.");
    }
    const now = new Date().toISOString();
    tx.update(ref, {
      status: "APPROVED",
      approvedBy: actor.uid,
      approvedByName: actor.name,
      approvedAt: now,
      updatedAt: now,
    });
    txAudit(tx, "SAMPLE_PIECE_APPROVE", "samplePieces", id, actor,
      { status: "COMPLETE" }, { status: "APPROVED" });
  });
  return { ok: true, id };
});