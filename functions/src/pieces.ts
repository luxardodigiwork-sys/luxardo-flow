/* eslint-disable */
/**
 * LUXARDO FASHION — PHASE 2 · BLOCK 3 · PHYSICAL PIECE DOMAIN
 * ============================================================================
 * Cloud Functions for the physical-piece lifecycle.
 *
 * Finalized rules (locked):
 *  - Every physical piece receives a unique PIECE-XXXX ID (never reused).
 *  - A piece belongs to a Production Request and references the approved
 *    Design Version (designVersionId).
 *  - REWORK keeps the SAME Piece ID and creates NEW work sessions; previous
 *    work history is preserved and never overwritten.
 *  - COMPLETE_REJECT permanently closes the Piece. The Piece ID remains
 *    historical and is NEVER deleted.
 *  - Replacement is MANUAL only (automatic replacement is forbidden). A
 *    manual replacement receives a NEW Piece ID and references the rejected
 *    piece it replaces.
 *  - Every transition appends a pieceMovementHistory record (Block 5).
 *  - No client-side generic update function exists for protected fields.
 * ============================================================================
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { generateId } from "./production";
import { requireStaff, hasAnyRole } from "./staffAuth";
import { writeAudit } from "./audit";
import { recordMovement } from "./movement";
import { applyPrQuantityDelta, syncPrStatus } from "./productionRequests";

const db = admin.firestore();

const PIECE_MANAGERS = ["admin", "owner", "pm"];

/**
 * Canonical forward piece-stage graph, exactly as already specified in
 * src/pages/production/PieceDetailPage.tsx's NEXT_STAGES map — this is the
 * server-side source of truth recordPieceMovement() validates against.
 *
 * QC_PENDING deliberately has NO outbound entries here: PASS/REWORK/REJECTED
 * verdicts out of QC_PENDING are exclusively guardQcPerform()'s domain (its
 * own role check requires the literal "guard" role — no admin/owner/pm/
 * super_admin can call it). Letting recordPieceMovement also move a piece
 * out of QC_PENDING would let an admin/owner/pm fake a QC pass with none of
 * guardQcPerform's verdict record-keeping (guardQCRecords doc, mandatory
 * reason, checked actions/photos) — so that exit is intentionally absent
 * from this table, forcing it through the dedicated QC path instead.
 */
export const NEXT_STAGES: Record<string, string[]> = {
  OPEN: ["IN_WORK"],
  IN_WORK: ["QC_PENDING"],
  QC_PENDING: [],
  REWORK: ["IN_WORK"],
  QC_PASS: ["DISPATCH_READY"],
  DISPATCH_READY: ["TAILOR_ASSIGNED", "STORE"],
  TAILOR_ASSIGNED: ["STITCHING"],
  STITCHING: ["STITCH_COMPLETE"],
  STITCH_COMPLETE: ["STORE"],
  STORE: ["STORE_OUT"],
  STORE_OUT: [],
  REJECTED: [],
};

/**
 * Transitions that now have a dedicated specialist Cloud Function
 * (dispatchAssignTailor, dispatchSendToStore, tailorStartStitching,
 * tailorCompleteStitching, storeOutCreate). When PM/Admin/Owner drives one of
 * these SAME transitions via the generic recordPieceMovement below, that is
 * an emergency override of the specialist path, not routine PM usage — so it
 * gets flagged isOverride: true on the movement/audit record. Transitions
 * with no specialist owner (e.g. QC_PASS -> DISPATCH_READY) are unaffected;
 * recordPieceMovement remains their only, ordinary mechanism.
 */
const SPECIALIST_OWNED_TRANSITIONS = new Set<string>([
  "DISPATCH_READY->TAILOR_ASSIGNED",
  "DISPATCH_READY->STORE",
  "TAILOR_ASSIGNED->STITCHING",
  "STITCHING->STITCH_COMPLETE",
  "STITCH_COMPLETE->STORE",
  "STORE->STORE_OUT",
]);

/** Piece must exist and not be permanently closed. */
export async function assertOpenPiece(pieceId: string): Promise<{ ref: admin.firestore.DocumentReference; data: admin.firestore.DocumentData }> {
  const ref = db.doc(`pieces/${pieceId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", `Piece ${pieceId} not found.`);
  const d = snap.data()!;
  if (d.status === "closed" || d.status === "replaced") {
    throw new HttpsError("failed-precondition", `Piece ${pieceId} is ${d.status} and cannot be re-opened.`);
  }
  return { ref, data: d };
}

/** Karigar must exist and be active. */
async function assertActiveKarigar(karigarId: string): Promise<admin.firestore.DocumentData> {
  const snap = await db.doc(`karigars/${karigarId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", `Karigar ${karigarId} not found.`);
  const k = snap.data()!;
  if (k.active === false) throw new HttpsError("failed-precondition", `Karigar ${karigarId} is inactive.`);
  return k;
}

/* ═══════════════════════════════════════════════════════════════════
 * pieceAssignKarigar — PM/Admin/Owner assigns a Karigar to a Piece.
 * Registration only (labour is tracked via labourStart/labourStop).
 * Input : { pieceId, karigarId }
 * ═══════════════════════════════════════════════════════════════════ */
export const pieceAssignKarigar = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, PIECE_MANAGERS)) {
    throw new HttpsError("permission-denied", "PM/Admin/Owner access required.");
  }
  const { pieceId, karigarId } = (request.data || {}) as { pieceId?: string; karigarId?: string };
  if (!pieceId || !karigarId) throw new HttpsError("invalid-argument", "pieceId and karigarId are required.");
  const { ref, data } = await assertOpenPiece(pieceId);
  await assertActiveKarigar(karigarId);

  const assigned = Array.isArray(data.assignedKarigars) ? (data.assignedKarigars as string[]) : [];
  if (assigned.includes(karigarId)) {
    throw new HttpsError("already-exists", `Karigar ${karigarId} is already assigned to ${pieceId}.`);
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data()!;
    const curAssigned = Array.isArray(cur.assignedKarigars) ? (cur.assignedKarigars as string[]) : [];
    if (curAssigned.includes(karigarId)) throw new HttpsError("already-exists", `Karigar ${karigarId} is already assigned.`);
    tx.update(ref, {
      assignedKarigars: [...curAssigned, karigarId],
      lastKarigarIds: [...(Array.isArray(cur.lastKarigarIds) ? cur.lastKarigarIds : []).slice(-9), karigarId],
      updatedAt: new Date().toISOString(),
    });
  });

  await recordMovement({
    pieceId, fromStage: data.stage as string, toStage: data.stage as string,
    direction: "FORWARD", action: "PIECE_ASSIGN_KARIGAR", actor,
    reason: `Karigar ${karigarId} assigned`, relatedRequestId: data.prId || null,
  });
  await writeAudit("PIECE_ASSIGN_KARIGAR", "pieces", pieceId, actor,
    { assignedKarigars: assigned }, { assignedKarigars: [...assigned, karigarId] });

  return { ok: true, pieceId, karigarId };
});

/* ═══════════════════════════════════════════════════════════════════
 * pieceRemoveKarigar — remove a Karigar from a Piece's assignment list.
 * Input : { pieceId, karigarId, reason? }
 * ═══════════════════════════════════════════════════════════════════ */
export const pieceRemoveKarigar = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, PIECE_MANAGERS)) {
    throw new HttpsError("permission-denied", "PM/Admin/Owner access required.");
  }
  const { pieceId, karigarId, reason } = (request.data || {}) as { pieceId?: string; karigarId?: string; reason?: string };
  if (!pieceId || !karigarId) throw new HttpsError("invalid-argument", "pieceId and karigarId are required.");
  const { ref, data } = await assertOpenPiece(pieceId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data()!;
    const curAssigned = Array.isArray(cur.assignedKarigars) ? (cur.assignedKarigars as string[]) : [];
    if (!curAssigned.includes(karigarId)) throw new HttpsError("not-found", `Karigar ${karigarId} is not assigned to this piece.`);
    const nextAssigned = curAssigned.filter((id: string) => id !== karigarId);
    tx.update(ref, {
      assignedKarigars: nextAssigned,
      lastKarigarIds: (Array.isArray(cur.lastKarigarIds) ? cur.lastKarigarIds : []).filter((id: string) => id !== karigarId),
      updatedAt: new Date().toISOString(),
    });
  });

  await recordMovement({
    pieceId, fromStage: data.stage as string, toStage: data.stage as string,
    direction: "REVERSE", action: "PIECE_REMOVE_KARIGAR", actor,
    reason: reason || `Karigar ${karigarId} removed`, relatedRequestId: data.prId || null,
  });
  await writeAudit("PIECE_REMOVE_KARIGAR", "pieces", pieceId, actor,
    { removedKarigarId: karigarId }, { reason: reason || null });

  return { ok: true, pieceId, karigarId };
});

/* ═══════════════════════════════════════════════════════════════════
 * recordRework — PM/Admin/Owner moves a piece into REWORK.
 * The Piece ID is preserved. New work sessions can follow via labourStart.
 * A mandatory reason is recorded. reworkCount is incremented.
 * Input : { pieceId, reason }
 * ═══════════════════════════════════════════════════════════════════ */
export const recordRework = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, PIECE_MANAGERS)) {
    throw new HttpsError("permission-denied", "PM/Admin/Owner access required.");
  }
  const { pieceId, reason } = (request.data || {}) as { pieceId?: string; reason?: string };
  if (!pieceId) throw new HttpsError("invalid-argument", "pieceId is required.");
  const reasonText = String(reason ?? "").trim();
  if (!reasonText) throw new HttpsError("invalid-argument", "A rework reason is mandatory.");
  const { ref, data } = await assertOpenPiece(pieceId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data()!;
    if (cur.status === "closed" || cur.status === "replaced") {
      throw new HttpsError("failed-precondition", `Piece ${pieceId} is ${cur.status} and cannot be reworked.`);
    }
    const fromStage = String(cur.stage || "OPEN");
    // MED-1 — two preconditions established from the existing, already-shipped
    // design rather than a newly-invented rule:
    //  1. QC_PENDING is guard-exclusive (NEXT_STAGES["QC_PENDING"] = [] and its
    //     own comment above states PASS/REWORK/REJECTED verdicts out of
    //     QC_PENDING are exclusively guardQcPerform()'s domain, precisely so a
    //     PM/Admin/Owner can never record a REWORK verdict — this function
    //     also sets qcVerdict:"REWORK" — without guardQcPerform's mandatory
    //     reason/checkedActions/guardQCRecords record-keeping). recordRework
    //     was the one path that could still do this; it's now blocked here
    //     the same way recordPieceMovement already is via NEXT_STAGES.
    //  2. A piece already at REWORK cannot be reworked again — this mirrors
    //     PieceDetailPage.tsx's own existing `!isReworked` UI gate
    //     (isReworked = status==='in_rework' || stage==='REWORK'), which
    //     already hides the "Mark Rework" action in this state; the server
    //     simply didn't enforce what the UI already assumed.
    // Every OTHER active stage (OPEN, IN_WORK, QC_PASS, DISPATCH_READY,
    // TAILOR_ASSIGNED, STITCHING, STITCH_COMPLETE, STORE) remains reworkable,
    // matching the UI's deliberately broad `!isClosed && !isReworked` gate —
    // recordRework is a PM/Admin/Owner correction mechanism usable at any
    // point in a piece's active lifecycle, not a single-predecessor
    // transition like labourStart, so no additional stage is restricted here.
    if (fromStage === "QC_PENDING") {
      throw new HttpsError(
        "failed-precondition",
        `Piece ${pieceId} is QC_PENDING — REWORK can only be recorded via Guard QC.`
      );
    }
    if (fromStage === "REWORK") {
      throw new HttpsError("failed-precondition", `Piece ${pieceId} is already in REWORK.`);
    }
    // Owner rule (Oct 2026): rework only applies to a piece that has actually
    // been worked on. An OPEN piece (no karigar work yet) cannot be reworked.
    if (fromStage === "OPEN") {
      throw new HttpsError(
        "failed-precondition",
        `Piece ${pieceId} is OPEN — work has not started, so it cannot be sent to rework.`
      );
    }
    const now = new Date().toISOString();
    tx.update(ref, {
      stage: "REWORK",
      status: "in_rework",
      qcVerdict: "REWORK",
      rejectionType: "REWORK",
      rejectionReason: reasonText,
      reworkCount: (Number(cur.reworkCount) || 0) + 1,
      rejectedAt: now,
      rejectedBy: actor.uid,
      rejectedByName: actor.name,
      updatedAt: now,
    });
    applyPrQuantityDelta(tx, cur.prId || null, fromStage, "REWORK");
  });

  await recordMovement({
    pieceId, fromStage: data.stage as string, toStage: "REWORK",
    direction: "FORWARD", action: "REWORK", actor,
    reason: reasonText, relatedRequestId: data.prId || null,
    snapshot: { pieceStage: "REWORK", totalLabourMinutes: data.totalLabourMinutes || 0, totalLabourCost: data.totalLabourCost || 0 },
  });
  await writeAudit("PIECE_REWORK", "pieces", pieceId, actor,
    { stage: data.stage, reworkCount: data.reworkCount || 0 }, { stage: "REWORK", rejectionReason: reasonText });

  return { ok: true, pieceId };
});

/* ═══════════════════════════════════════════════════════════════════
 * completeRejectPiece — permanently close a physical piece (COMPLETE_REJECT).
 * The Piece ID remains historical and is NEVER deleted.
 * Replacement is manual via createManualReplacementPiece.
 * Input : { pieceId, reason }
 * ═══════════════════════════════════════════════════════════════════ */
export const completeRejectPiece = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, PIECE_MANAGERS)) {
    throw new HttpsError("permission-denied", "PM/Admin/Owner access required.");
  }
  const { pieceId, reason } = (request.data || {}) as { pieceId?: string; reason?: string };
  if (!pieceId) throw new HttpsError("invalid-argument", "pieceId is required.");
  const reasonText = String(reason ?? "").trim();
  if (!reasonText) throw new HttpsError("invalid-argument", "A complete-rejection reason is mandatory.");
  const { ref, data } = await assertOpenPiece(pieceId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data()!;
    if (cur.status === "closed" || cur.status === "replaced") {
      throw new HttpsError("failed-precondition", `Piece ${pieceId} is ${cur.status} and cannot be rejected.`);
    }
    const now = new Date().toISOString();
    const fromStage = String(cur.stage || "OPEN");
    tx.update(ref, {
      stage: "REJECTED",
      status: "closed",
      qcVerdict: "COMPLETE_REJECT",
      rejectionType: "COMPLETE_REJECT",
      rejectionReason: reasonText,
      rejectedAt: now,
      rejectedBy: actor.uid,
      rejectedByName: actor.name,
      updatedAt: now,
    });
    applyPrQuantityDelta(tx, cur.prId || null, fromStage, "REJECTED");
  });

  await recordMovement({
    pieceId, fromStage: data.stage as string, toStage: "REJECTED",
    direction: "FORWARD", action: "COMPLETE_REJECT", actor,
    reason: reasonText, relatedRequestId: data.prId || null,
    snapshot: { pieceStage: "REJECTED", totalLabourMinutes: data.totalLabourMinutes || 0, totalLabourCost: data.totalLabourCost || 0 },
  });
  await writeAudit("PIECE_COMPLETE_REJECT", "pieces", pieceId, actor,
    { stage: data.stage, status: data.status }, { stage: "REJECTED", status: "closed", rejectionReason: reasonText });

  await syncPrStatus(data.prId || null);
  return { ok: true, pieceId };
});

/* ═══════════════════════════════════════════════════════════════════
 * createManualReplacementPiece — MANUAL replacement for a COMPLETE_REJECTED
 * piece. A NEW Piece ID is created and linked to the rejected piece.
 * Automatic replacement is forbidden; this is the only replace path.
 * Input : { rejectedPieceId, reason }
 * ═══════════════════════════════════════════════════════════════════ */
export const createManualReplacementPiece = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, PIECE_MANAGERS)) {
    throw new HttpsError("permission-denied", "PM/Admin/Owner access required.");
  }
  const { rejectedPieceId, reason } = (request.data || {}) as { rejectedPieceId?: string; reason?: string };
  if (!rejectedPieceId) throw new HttpsError("invalid-argument", "rejectedPieceId is required.");
  const reasonText = String(reason ?? "").trim();
  if (!reasonText) throw new HttpsError("invalid-argument", "A replacement reason is mandatory.");

  const rejectedRef = db.doc(`pieces/${rejectedPieceId}`);
  const rejectedSnap = await rejectedRef.get();
  if (!rejectedSnap.exists) throw new HttpsError("not-found", `Piece ${rejectedPieceId} not found.`);
  const rejected = rejectedSnap.data()!;
  if (rejected.status !== "closed" || rejected.stage !== "REJECTED" || rejected.rejectionType !== "COMPLETE_REJECT") {
    throw new HttpsError("failed-precondition", "Only a COMPLETE_REJECTED piece can be manually replaced.");
  }
  if (rejected.replacedByPieceId) {
    throw new HttpsError("already-exists", `Piece ${rejectedPieceId} is already replaced by ${rejected.replacedByPieceId}.`);
  }

  const newPieceId = await generateId("piece");
  const now = new Date().toISOString();
  const replacementId = `REPL-${crypto.randomUUID()}`;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(rejectedRef);
    const r = snap.data()!;
    if (r.replacedByPieceId) throw new HttpsError("already-exists", `Piece ${rejectedPieceId} is already replaced.`);
    tx.update(rejectedRef, { replacedByPieceId: newPieceId, updatedAt: now });

    tx.set(db.doc(`pieces/${newPieceId}`), {
      id: newPieceId,
      designId: r.designId || null,
      prId: r.prId || null,
      designVersionId: r.designVersionId || null,
      kind: r.kind || "PHYSICAL",
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
      replacesPieceId: rejectedPieceId,
      replacedByPieceId: null,
      notes: `Manual replacement for ${rejectedPieceId} — ${reasonText}`,
      createdBy: actor.uid,
      createdByName: actor.name,
      createdAt: now,
      updatedAt: now,
    });

    tx.set(db.doc(`replacementLinks/${newPieceId}`), {
      id: newPieceId,
      rejectedPieceId,
      replacementPieceId: newPieceId,
      reason: reasonText,
      createdBy: actor.uid,
      createdByName: actor.name,
      createdAt: now,
    });

    // The rejected piece stays REJECTED (rejectedQty unaffected) and
    // originalOrderedQty is never touched. The new replacement piece is a
    // real additional OPEN piece the shop must still produce, so pendingQty
    // gains exactly the one slot it occupies; its later transitions flow
    // through the same recordPieceMovement/labourStart/guardQcPerform paths
    // and are counted by applyPrQuantityDelta like any other piece.
    if (r.prId) {
      tx.update(db.doc(`productionRequests/${r.prId}`), {
        pendingQty: admin.firestore.FieldValue.increment(1),
        rejectedQty: admin.firestore.FieldValue.increment(-1),
        updatedAt: now,
      });
    }
  });

  // Movement: new piece creation (replacing) for the replacement piece + the rejected piece link.
  await recordMovement({
    pieceId: newPieceId, fromStage: null, toStage: "OPEN",
    direction: "FORWARD", action: "REPLACE", actor,
    reason: reasonText, relatedRequestId: rejected.prId || null, relatedPieceId: rejectedPieceId,
    snapshot: { pieceStage: "OPEN", totalLabourMinutes: 0, totalLabourCost: 0 },
  });
  await recordMovement({
    pieceId: rejectedPieceId, fromStage: "REJECTED", toStage: "REJECTED",
    direction: "FORWARD", action: "REPLACE", actor,
    reason: `Replaced by ${newPieceId} — ${reasonText}`, relatedRequestId: rejected.prId || null, relatedPieceId: newPieceId,
  });

  await writeAudit("REPLACEMENT_CREATE", "replacementLinks", newPieceId, actor,
    { rejectedPieceId, reason: reasonText, id: replacementId },
    { replacementPieceId: newPieceId, rejectedPieceId, reason: reasonText });

  return { ok: true, pieceId: newPieceId, rejectedPieceId, replacementId };
});

/* ═══════════════════════════════════════════════════════════════════
 * recordPieceMovement — generic PM/Admin/Owner piece movement (Block 5).
 * Appends ONE append-only history record. Reverse movement creates a NEW
 * history event with direction REVERSE — the original record is untouched.
 * Optionally moves the piece stage (forward) when toStage differs.
 * Input : { pieceId, toStage, action, direction?, reason?, relatedRequestId?, relatedPieceId? }
 * ═══════════════════════════════════════════════════════════════════ */
export const recordPieceMovement = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, PIECE_MANAGERS)) {
    throw new HttpsError("permission-denied", "PM/Admin/Owner access required.");
  }
  const { pieceId, toStage, action, direction, reason, relatedRequestId, relatedPieceId } = (request.data || {}) as {
    pieceId?: string; toStage?: string; action?: string; direction?: string;
    reason?: string; relatedRequestId?: string; relatedPieceId?: string;
  };
  if (!pieceId || !toStage || !action) throw new HttpsError("invalid-argument", "pieceId, toStage, action are required.");

  const validStages = ["OPEN", "IN_WORK", "QC_PENDING", "REWORK", "QC_PASS", "DISPATCH_READY",
    "TAILOR_ASSIGNED", "STITCHING", "STITCH_COMPLETE", "STORE", "STORE_OUT", "REJECTED"];
  if (!validStages.includes(String(toStage))) throw new HttpsError("invalid-argument", `Invalid stage: ${toStage}`);

  const { ref } = await assertOpenPiece(pieceId);
  const dir = String(direction ?? "FORWARD").toUpperCase() === "REVERSE" ? "REVERSE" : "FORWARD";
  const requestedToStage = String(toStage);
  const now = new Date().toISOString();

  // fromStage (and the snapshot fields below) are populated inside the
  // transaction from a freshly re-read piece doc, never from a pre-
  // transaction read — so a concurrent move cannot race past the
  // adjacency check with stale data.
  let fromStage = "OPEN";
  let prId: string | null = null;
  let totalLabourMinutes = 0;
  let totalLabourCost = 0;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data()!;
    fromStage = String(cur.stage || "OPEN");
    prId = cur.prId || null;
    totalLabourMinutes = cur.totalLabourMinutes || 0;
    totalLabourCost = cur.totalLabourCost || 0;
    if (fromStage !== requestedToStage) {
      const allowed = NEXT_STAGES[fromStage] || [];
      if (!allowed.includes(requestedToStage)) {
        throw new HttpsError(
          "failed-precondition",
          `Invalid transition: ${fromStage} -> ${requestedToStage} is not allowed.`
        );
      }
      // Owner rule (Oct 2026): a piece cannot go to QC while any karigar
      // labour session on it is still running — otherwise labour time keeps
      // accruing while the piece sits at QC. Read inside the transaction so a
      // concurrent labourStart forces a retry instead of racing past.
      if (requestedToStage === "QC_PENDING") {
        const open = await tx.get(
          db.collection("pieceWorkSessions")
            .where("pieceId", "==", pieceId)
            .where("endedAt", "==", null)
            .limit(1)
        );
        if (!open.empty) {
          throw new HttpsError(
            "failed-precondition",
            `Stop the running karigar session on ${pieceId} before sending it to QC.`
          );
        }
      }
      tx.update(ref, {
        stage: requestedToStage,
        status: requestedToStage === "REJECTED" || requestedToStage === "STORE_OUT"
          ? "closed"
          : (requestedToStage === "REWORK" ? "in_rework" : cur.status),
        updatedAt: now,
      });
      applyPrQuantityDelta(tx, prId, fromStage, requestedToStage);
    }
  });

  const isOverride = SPECIALIST_OWNED_TRANSITIONS.has(`${fromStage}->${requestedToStage}`);

  const recId = await recordMovement({
    pieceId, fromStage, toStage: String(toStage),
    direction: dir, action: String(action), actor,
    reason: reason || null, relatedRequestId: relatedRequestId || prId || null, relatedPieceId: relatedPieceId || null,
    snapshot: { pieceStage: String(toStage), totalLabourMinutes, totalLabourCost },
    isOverride,
  });

  await writeAudit(dir === "REVERSE" ? "PIECE_REVERSE_MOVE" : "PIECE_STAGE_MOVE", "pieces", pieceId, actor,
    { fromStage, toStage: String(toStage), action, movementId: recId }, { direction: dir, isOverride });

  await syncPrStatus(prId);
  return { ok: true, pieceId, movementId: recId };
});