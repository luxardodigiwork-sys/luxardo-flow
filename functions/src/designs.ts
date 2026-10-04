/* eslint-disable */
/**
 * LUXARDO FASHION — PHASE 2 · BLOCK 2.1 · CATALOGUE DESIGN
 * ============================================================================
 * Cloud Functions for catalogue design management.
 *
 * Every write to catalogueDesigns / designVersions goes through these
 * callable functions so that:
 *  - IDs are KL-XXXX, generated transaction-safely
 *  - version history is preserved (designVersions snapshots)
 *  - an approved/frozen design version can never be silently overwritten
 *  - every transition is audited (append-only auditLogs)
 *  - firestore rules can keep client writes locked down (see firestore.rules)
 *
 * Lifecycle: DRAFT → (designer edits) → PENDING_APPROVAL → APPROVED(≈frozen)
 * Designer assigns catalogueShortName + designNumber AFTER Owner approval.
 * A new version (V2) is a fresh revision, never a modification of the frozen one.
 * ============================================================================
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { generateId } from "./production";
import { requireStaff, hasAnyRole, StaffIdentity } from "./staffAuth";
import { auditDoc, writeAudit } from "./audit";

const db = admin.firestore();

const DESIGN_WRITERS = ["admin", "owner", "designer"];
const DESIGN_APPROVERS = ["admin", "owner"];

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

/* ═══════════════════════════════════════════════════════════════════
 * designCreate — create a new catalogue design (DRAFT).
 * Input : { name, description?, image?, imagePath?, images? }
 * Output: { ok, id, design }
 * ═══════════════════════════════════════════════════════════════════ */
export const designCreate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, DESIGN_WRITERS)) {
    throw new HttpsError("permission-denied", "Designer/Admin/Owner access required.");
  }

  const { name, description, image, imagePath, images } = (request.data || {}) as {
    name?: string; description?: string; image?: string; imagePath?: string; images?: string[];
  };
  if (!name || !String(name).trim()) {
    throw new HttpsError("invalid-argument", "Design name is required.");
  }

  const designId = await generateId("design");
  const now = new Date().toISOString();
  const design = {
    id: designId,
    designType: "catalogue",
    name: String(name).trim(),
    description: String(description ?? ""),
    image: String(image ?? ""),
    // Storage path backing `image` when it came from an upload (Design
    // Create's camera/gallery picker) rather than a pasted URL — audit
    // trail only, same optional-field pattern as PieceDoc.garmentImagePath.
    imagePath: imagePath || null,
    images: Array.isArray(images) ? images.map(String) : [],
    status: "DRAFT",
    currentVersion: 1,
    isFrozen: false,
    catalogueShortName: null,
    designNumber: null,
    designerUid: actor.uid,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    createdBy: actor.uid,
    createdByName: actor.name,
    createdAt: now,
    updatedAt: now,
  };

  await db.doc(`catalogueDesigns/${designId}`).set(design);
  await writeAudit("DESIGN_CREATE", "catalogueDesigns", designId, actor, null, design);

  return { ok: true, id: designId, design };
});

/* ═══════════════════════════════════════════════════════════════════
 * designUpdate — edit a DRAFT catalogue design.
 * Input : { id, name?, description?, image?, imagePath?, images? }
 * Output: { ok, id }
 * ═══════════════════════════════════════════════════════════════════ */
export const designUpdate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, DESIGN_WRITERS)) {
    throw new HttpsError("permission-denied", "Designer/Admin/Owner access required.");
  }

  const { id, name, description, image, imagePath, images } = (request.data || {}) as {
    id?: string; name?: string; description?: string; image?: string; imagePath?: string; images?: string[];
  };
  if (!id) throw new HttpsError("invalid-argument", "Design id required.");

  const ref = db.doc(`catalogueDesigns/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `Design ${id} not found.`);
    const d = snap.data()!;
    if (d.status !== "DRAFT") {
      throw new HttpsError("failed-precondition", "Only DRAFT designs can be edited; submit or start a new version instead.");
    }
    if (d.isFrozen) throw new HttpsError("failed-precondition", "Frozen design cannot be edited.");

    const patch: Record<string, unknown> = {};
    if (name !== undefined) {
      if (!String(name).trim()) throw new HttpsError("invalid-argument", "Design name cannot be empty.");
      patch.name = String(name).trim();
    }
    if (description !== undefined) patch.description = String(description);
    if (image !== undefined) {
      patch.image = String(image);
      // A freshly uploaded photo always carries its own imagePath; a
      // manually pasted/cleared URL has none — mirrors tailorCompleteStitching's
      // garmentImageUrl/garmentImagePath pairing (functions/src/tailor.ts).
      patch.imagePath = imagePath || null;
    }
    if (images !== undefined) {
      if (!Array.isArray(images)) throw new HttpsError("invalid-argument", "images must be an array.");
      patch.images = images.map(String);
    }
    if (Object.keys(patch).length === 0) {
      throw new HttpsError("invalid-argument", "No valid fields to update.");
    }
    patch.updatedAt = new Date().toISOString();
    tx.update(ref, patch);

    const before = { name: d.name, description: d.description, image: d.image };
    const after = {
      name: patch.name ?? d.name,
      description: patch.description ?? d.description,
      image: patch.image ?? d.image,
    };
    txAudit(tx, "DESIGN_UPDATE", "catalogueDesigns", id, actor, before, after);
  });

  return { ok: true, id };
});

/* ═══════════════════════════════════════════════════════════════════
 * designSubmit — move design DRAFT → PENDING_APPROVAL (owner review).
 * Input : { id }
 * Output: { ok, id }
 * ═══════════════════════════════════════════════════════════════════ */
export const designSubmit = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, DESIGN_WRITERS)) {
    throw new HttpsError("permission-denied", "Designer/Admin/Owner access required.");
  }

  const { id } = (request.data || {}) as { id?: string };
  if (!id) throw new HttpsError("invalid-argument", "Design id required.");

  const ref = db.doc(`catalogueDesigns/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `Design ${id} not found.`);
    const d = snap.data()!;
    if (d.isFrozen) throw new HttpsError("already-exists", "Approved design is already frozen.");
    if (d.status !== "DRAFT") {
      throw new HttpsError("already-exists", "Design can only be submitted from DRAFT state.");
    }
    tx.update(ref, { status: "PENDING_APPROVAL", updatedAt: new Date().toISOString() });
    txAudit(tx, "DESIGN_SUBMIT", "catalogueDesigns", id, actor,
      { status: "DRAFT" }, { status: "PENDING_APPROVAL" });
  });

  return { ok: true, id };
});

/* ═══════════════════════════════════════════════════════════════════
 * designApprove — Owner/Admin approval → freeze + archive version snapshot.
 * Input : { id }
 * Output: { ok, id }
 * Freezes the design (isFrozen = true) and writes designVersions/{id}-v{N}
 * so the approved version is preserved forever. Existing production keeps
 * referencing the frozen version — never silently switches.
 * ═══════════════════════════════════════════════════════════════════ */
export const designApprove = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, DESIGN_APPROVERS)) {
    throw new HttpsError("permission-denied", "Owner/Admin approval required.");
  }

  const { id } = (request.data || {}) as { id?: string };
  if (!id) throw new HttpsError("invalid-argument", "Design id required.");

  const ref = db.doc(`catalogueDesigns/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `Design ${id} not found.`);
    const d = snap.data()!;
    if (d.status === "APPROVED" || d.status === "FROZEN") {
      throw new HttpsError("already-exists", "Design is already approved.");
    }
    if (d.status !== "PENDING_APPROVAL") {
      throw new HttpsError("failed-precondition", "Design must be submitted for approval first.");
    }
    const now = new Date().toISOString();
    const versionNo = Number(d.currentVersion) || 1;

    tx.update(ref, {
      status: "APPROVED",
      isFrozen: true,
      approvedBy: actor.uid,
      approvedByName: actor.name,
      approvedAt: now,
      updatedAt: now,
    });

    const approvedSnapshot = {
      ...d,
      status: "APPROVED",
      isFrozen: true,
      approvedBy: actor.uid,
      approvedByName: actor.name,
      approvedAt: now,
      updatedAt: now,
    };
    const versionId = `${id}-v${versionNo}`;
    tx.set(db.doc(`designVersions/${versionId}`), {
      id: versionId,
      designId: id,
      versionNo,
      snapshot: approvedSnapshot,
      frozen: true,
      approvedBy: actor.uid,
      approvedByName: actor.name,
      approvedAt: now,
      note: "",
      createdAt: now,
    });

    txAudit(tx, "DESIGN_APPROVE", "catalogueDesigns", id, actor,
      { status: d.status, isFrozen: d.isFrozen },
      { status: "APPROVED", isFrozen: true, versionNo });
  });

  return { ok: true, id };
});

/* ═══════════════════════════════════════════════════════════════════
 * designSetCatalogueMeta — Designer assigns catalogueShortName + designNumber
 * AFTER Owner approval (finalized workflow).
 * Input : { id, catalogueShortName, designNumber }
 * Output: { ok, id }
 * ═══════════════════════════════════════════════════════════════════ */
export const designSetCatalogueMeta = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, DESIGN_WRITERS)) {
    throw new HttpsError("permission-denied", "Designer/Admin/Owner access required.");
  }

  const { id, catalogueShortName, designNumber } = (request.data || {}) as {
    id?: string; catalogueShortName?: string; designNumber?: string;
  };
  if (!id) throw new HttpsError("invalid-argument", "Design id required.");
  const shortName = String(catalogueShortName ?? "").trim();
  const dNumber = String(designNumber ?? "").trim();
  if (!shortName || !dNumber) {
    throw new HttpsError("invalid-argument", "catalogueShortName and designNumber are required.");
  }

  const ref = db.doc(`catalogueDesigns/${id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `Design ${id} not found.`);
    const d = snap.data()!;
    if (!d.isFrozen || (d.status !== "APPROVED" && d.status !== "FROZEN")) {
      throw new HttpsError("failed-precondition", "Catalogue metadata can only be assigned after Owner approval.");
    }
    tx.update(ref, { catalogueShortName: shortName, designNumber: dNumber, updatedAt: new Date().toISOString() });
    txAudit(tx, "DESIGN_SET_CATALOGUE_META", "catalogueDesigns", id, actor,
      { catalogueShortName: d.catalogueShortName ?? null, designNumber: d.designNumber ?? null },
      { catalogueShortName: shortName, designNumber: dNumber });
  });

  return { ok: true, id };
});

/* ═══════════════════════════════════════════════════════════════════
 * designNewVersion — start a new version (V2) of an approved design.
 * Input : { id }
 * Output: { ok, id, currentVersion }
 * The approved (frozen) version stays archived in designVersions. The working
 * design document becomes DRAFT with currentVersion+1. Existing production
 * always references the frozen version — never switches silently.
 * ═══════════════════════════════════════════════════════════════════ */
export const designNewVersion = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, DESIGN_WRITERS)) {
    throw new HttpsError("permission-denied", "Designer/Admin/Owner access required.");
  }

  const { id } = (request.data || {}) as { id?: string };
  if (!id) throw new HttpsError("invalid-argument", "Design id required.");

  const ref = db.doc(`catalogueDesigns/${id}`);
  let nextVersionNo = 0;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `Design ${id} not found.`);
    const d = snap.data()!;
    if (!d.isFrozen) {
      throw new HttpsError("failed-precondition", "A new version can only be created from an approved (frozen) design.");
    }
    nextVersionNo = (Number(d.currentVersion) || 1) + 1;
    tx.update(ref, {
      status: "DRAFT",
      isFrozen: false,
      currentVersion: nextVersionNo,
      updatedAt: new Date().toISOString(),
    });
    txAudit(tx, "DESIGN_NEW_VERSION", "catalogueDesigns", id, actor,
      { currentVersion: d.currentVersion, status: d.status, isFrozen: true },
      { currentVersion: nextVersionNo, status: "DRAFT", isFrozen: false });
  });

  return { ok: true, id, currentVersion: nextVersionNo };
});