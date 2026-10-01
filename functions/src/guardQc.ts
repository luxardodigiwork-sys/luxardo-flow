/* eslint-disable */
/**
 * LUXARDO FASHION — PHASE 3 · BLOCK 5 · GUARD QC
 * ============================================================================
 * Server-authoritative Guard QC. A Guard (staff role `guard`) performs QC on a
 * physical piece that is in QC_PENDING stage. The ONLY finalized verdicts are
 * PASS | REWORK | COMPLETE_REJECT. REWORK / COMPLETE_REJECT require a reason.
 *
 * Every QC writes an append-only guardQCRecords/{QC-XXXX} record, updates the
 * Piece state through a Cloud Function (never client writes), and appends a
 * movement-history + audit entry. Clients may read QC records but can never
 * create/update/delete them (firestore.rules deny writes).
 *
 * Finalized semantics:
 *  - PASS            → piece stage DISPATCH_READY (locked business rule: a
 *                       Guard PASS verdict is itself the handoff to Dispatch
 *                       — there is no separate manual "Move to Dispatch
 *                       Ready" step for PM/Admin/Owner/Dispatch). qcVerdict
 *                       is still recorded as "PASS" and the guardQCRecords
 *                       entry is unchanged — only the persisted piece stage
 *                       differs from the pre-this-change behavior.
 *  - REWORK          → piece stage REWORK, status in_rework, reworkCount++.
 *  - COMPLETE_REJECT → piece stage REJECTED, status closed (permanent).
 *
 * Atomicity: the piece update, the guardQCRecords write, the
 * pieceMovementHistory entry and the auditLogs entry are ALL part of the
 * same Firestore transaction (recordMovement/writeAudit both accept an
 * optional `tx` and are passed this function's transaction) — either all
 * four commit or none do. This removes the previous window where the piece
 * could already show a new stage while its movement-history/audit record
 * failed to write separately afterward.
 * ============================================================================
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { generateId } from "./production";
import { requireStaff, hasAnyRole } from "./staffAuth";
import { writeAudit } from "./audit";
import { recordMovement } from "./movement";
import { applyPrQuantityDelta } from "./productionRequests";

const db = admin.firestore();

/** Only the Guard role may perform QC (matches production.qc.perform). */
const QC_ROLES = ["guard"];

const VERDICTS = ["PASS", "REWORK", "COMPLETE_REJECT"];

interface QCActionInput {
  label?: string;
  ok?: boolean;
  note?: string;
}

/**
 * guardQcPerform — Guard records a QC verdict for a QC_PENDING piece.
 * Input : { pieceId, verdict, reason?, checkedActions?, photos? }
 */
export const guardQcPerform = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, QC_ROLES)) {
    throw new HttpsError("permission-denied", "Guard access required.");
  }

  const { pieceId, verdict, reason, checkedActions, photos } = (request.data || {}) as {
    pieceId?: string;
    verdict?: string;
    reason?: string;
    checkedActions?: QCActionInput[];
    photos?: string[];
  };

  if (!pieceId) throw new HttpsError("invalid-argument", "pieceId is required.");
  if (!verdict || !VERDICTS.includes(String(verdict))) {
    throw new HttpsError("invalid-argument", `verdict must be one of: ${VERDICTS.join(", ")}`);
  }
  const reasonText = String(reason ?? "").trim();
  if (verdict !== "PASS" && !reasonText) {
    throw new HttpsError("invalid-argument", "A reason is mandatory for REWORK and COMPLETE_REJECT.");
  }

  const ref = db.doc(`pieces/${pieceId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", `Piece ${pieceId} not found.`);
  const d = snap.data()!;
  if (d.status === "closed" || d.status === "replaced") {
    throw new HttpsError("failed-precondition", `Piece ${pieceId} is ${d.status} and cannot be QC'd.`);
  }
  if (String(d.stage || "OPEN") !== "QC_PENDING") {
    throw new HttpsError(
      "failed-precondition",
      `Piece ${pieceId} must be in QC_PENDING to perform QC (current: ${d.stage || "OPEN"}).`
    );
  }

  const qcId = await generateId("guardQc");
  const now = new Date().toISOString();
  const actions = (Array.isArray(checkedActions) ? checkedActions : []).map((a) => ({
    label: String(a?.label || ""),
    ok: !!a?.ok,
    note: String(a?.note || ""),
  }));
  const photoPaths = (Array.isArray(photos) ? photos : []).filter(
    (p): p is string => typeof p === "string"
  );

  let toStage: string;
  let status: string;
  let qcVerdict: string;
  let action: string;
  let reworkDelta = 0;
  if (verdict === "PASS") {
    // Locked business rule: PASS *is* the handoff to Dispatch — persist
    // DISPATCH_READY directly rather than resting at an intermediate QC_PASS
    // stage that would then need a separate manual move.
    toStage = "DISPATCH_READY"; status = "active"; qcVerdict = "PASS"; action = "QC_PASS"; reworkDelta = 0;
  } else if (verdict === "REWORK") {
    toStage = "REWORK"; status = "in_rework"; qcVerdict = "REWORK"; action = "QC_REWORK"; reworkDelta = 1;
  } else {
    toStage = "REJECTED"; status = "closed"; qcVerdict = "COMPLETE_REJECT"; action = "QC_COMPLETE_REJECT"; reworkDelta = 0;
  }

  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const cur = s.data()!;
    if (cur.status === "closed" || cur.status === "replaced") {
      throw new HttpsError("failed-precondition", `Piece ${pieceId} is ${cur.status} and cannot be QC'd.`);
    }
    if (String(cur.stage || "OPEN") !== "QC_PENDING") {
      throw new HttpsError("failed-precondition", `Piece ${pieceId} must be QC_PENDING.`);
    }
    const isPass = verdict === "PASS";
    tx.update(ref, {
      stage: toStage,
      status,
      qcVerdict,
      rejectionType: isPass ? null : verdict,
      rejectionReason: isPass ? null : reasonText,
      rejectedAt: isPass ? null : now,
      rejectedBy: isPass ? null : actor.uid,
      rejectedByName: isPass ? null : actor.name,
      reworkCount: (Number(cur.reworkCount) || 0) + reworkDelta,
      lastGuardQcId: qcId,
      updatedAt: now,
    });
    applyPrQuantityDelta(tx, cur.prId || null, "QC_PENDING", toStage);

    tx.set(db.doc(`guardQCRecords/${qcId}`), {
      id: qcId,
      pieceId,
      designId: cur.designId || null,
      designVersionId: cur.designVersionId || null,
      prId: cur.prId || null,
      verdict,
      reason: isPass ? "" : reasonText,
      checkedActions: actions,
      guardUid: actor.uid,
      guardName: actor.name,
      at: now,
      photos: photoPaths,
      createdAt: now,
      updatedAt: now,
    });

    // Folded into the SAME transaction as the writes above (both accept an
    // optional tx) — piece state, QC record, movement history and audit log
    // all commit atomically, or none do. See module header.
    await recordMovement({
      pieceId,
      fromStage: "QC_PENDING",
      toStage,
      direction: "FORWARD",
      action,
      actor,
      reason: verdict === "PASS" ? null : reasonText,
      relatedRequestId: cur.prId || null,
      snapshot: {
        pieceStage: toStage,
        totalLabourMinutes: cur.totalLabourMinutes || 0,
        totalLabourCost: cur.totalLabourCost || 0,
      },
    }, tx);
    await writeAudit(
      "GUARD_QC",
      "guardQCRecords",
      qcId,
      actor,
      { pieceId, verdict, stage: cur.stage },
      { qcId, verdict, toStage, checkedActionsCount: actions.length },
      reasonText || undefined,
      tx
    );
  });

  return { ok: true, qcId, pieceId, verdict, toStage };
});
