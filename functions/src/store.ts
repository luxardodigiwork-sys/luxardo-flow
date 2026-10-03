/* eslint-disable */
/**
 * LUXARDO FASHION — PHASE 4 · STORE DOMAIN
 * ============================================================================
 * Cloud Functions for the Store role's Store-Out (dispatch-to-customer)
 * actions.
 *
 * Finalized rules (locked):
 *  - Store-Out is a BATCH action: Store selects multiple STORE-stage pieces,
 *    enters a mandatory bill number, and closes them out together under one
 *    storeOuts record. All-or-nothing (one Firestore transaction).
 *  - Store-Out changes each piece: STORE -> STORE_OUT, status -> "closed".
 *  - Store-Out reduces currentActiveQty and increases completedQty per piece
 *    (via the existing, unmodified applyPrQuantityDelta).
 *  - A Store-Out Issue is PURELY a log — it does NOT change piece stage or
 *    any PR quantity counter.
 * ============================================================================
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { generateId } from "./production";
import { requireStaff, hasAnyRole } from "./staffAuth";
import { writeAudit } from "./audit";
import { recordMovement } from "./movement";
import { applyPrQuantityDelta, syncPrStatus } from "./productionRequests";
import { NEXT_STAGES } from "./pieces";

const db = admin.firestore();

const STORE_ROLES = ["store"];
const STORE_OUT_REASONS = ["DAMAGE_IN_TRANSIT", "SIZE_MISMATCH", "QUALITY_REJECT", "BILLING_DISPUTE", "OTHER"];

/* ═══════════════════════════════════════════════════════════════════
 * storeOutCreate — Store selects one or more STORE-stage pieces and closes
 * them out together under a mandatory bill number. All-or-nothing: if any
 * piece fails validation, the whole batch fails. Pieces may belong to
 * different Production Requests — each gets its own quantity delta.
 * Input : { pieceIds: string[], billNumber, party? }
 * ═══════════════════════════════════════════════════════════════════ */
export const storeOutCreate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, STORE_ROLES)) {
    throw new HttpsError("permission-denied", "Store access required.");
  }
  const { pieceIds: rawPieceIds, billNumber, party } = (request.data || {}) as { pieceIds?: string[]; billNumber?: string; party?: string };
  if (!Array.isArray(rawPieceIds) || rawPieceIds.length === 0) {
    throw new HttpsError("invalid-argument", "pieceIds must be a non-empty array.");
  }
  // De-duplicate server-side — never trust the caller (UI or direct API) to
  // have already de-duplicated. A repeated id here must not double-apply
  // the quantity delta for that one physical piece.
  const pieceIds = Array.from(new Set(rawPieceIds));
  const bill = String(billNumber ?? "").trim();
  if (!bill) throw new HttpsError("invalid-argument", "billNumber is mandatory.");

  const storeOutId = await generateId("so");
  const now = new Date().toISOString();
  const pieceRefs = pieceIds.map((id) => db.doc(`pieces/${id}`));
  const piecePrIds: Record<string, string | null> = {};

  await db.runTransaction(async (tx) => {
    // All reads first — Firestore requires every read before any write.
    const snaps = await Promise.all(pieceRefs.map((ref) => tx.get(ref)));
    const currents: admin.firestore.DocumentData[] = [];
    for (let i = 0; i < snaps.length; i++) {
      const snap = snaps[i];
      const pieceId = pieceIds[i];
      if (!snap.exists) throw new HttpsError("not-found", `Piece ${pieceId} not found.`);
      const cur = snap.data()!;
      if (String(cur.stage || "OPEN") !== "STORE") {
        throw new HttpsError("failed-precondition", `Piece ${pieceId} must be STORE to store-out (current: ${cur.stage}).`);
      }
      currents.push(cur);
    }
    const allowed = NEXT_STAGES["STORE"] || [];
    if (!allowed.includes("STORE_OUT")) {
      throw new HttpsError("failed-precondition", "STORE -> STORE_OUT is not an allowed transition.");
    }

    // Now the writes.
    tx.set(db.doc(`storeOuts/${storeOutId}`), {
      id: storeOutId,
      storeOutNumber: storeOutId,
      pieceIds,
      billNumber: bill,
      party: party ? String(party) : null,
      totalPieces: pieceIds.length,
      createdBy: actor.uid,
      createdByName: actor.name,
      createdAt: now,
    });

    for (let i = 0; i < pieceRefs.length; i++) {
      const pieceId = pieceIds[i];
      const cur = currents[i];
      piecePrIds[pieceId] = cur.prId || null;
      tx.update(pieceRefs[i], {
        stage: "STORE_OUT",
        status: "closed",
        storeOutAt: now,
        storeOutId,
        billNumber: bill,
        updatedAt: now,
      });
      applyPrQuantityDelta(tx, cur.prId || null, "STORE", "STORE_OUT");
    }
  });

  for (const pieceId of pieceIds) {
    await recordMovement({
      pieceId, fromStage: "STORE", toStage: "STORE_OUT",
      direction: "FORWARD", action: "STORE_OUT", actor,
      reason: `Store-Out ${storeOutId} (bill ${bill})`, relatedRequestId: piecePrIds[pieceId] || null,
    });
  }
  await writeAudit("STORE_OUT_CREATE", "storeOuts", storeOutId, actor,
    null, { storeOutId, pieceIds, billNumber: bill, party: party || null, totalPieces: pieceIds.length });

  for (const p of new Set(Object.values(piecePrIds))) await syncPrStatus(p);
  return { ok: true, storeOutId, pieceIds, totalPieces: pieceIds.length };
});

/* ═══════════════════════════════════════════════════════════════════
 * storeOutReportIssue — Store logs a problem with a piece from a completed
 * Store-Out. PURE LOG ONLY: does not change piece stage or any quantity
 * counter (locked rule — that business decision is explicitly deferred).
 * Input : { storeOutId, pieceId, reason, otherText? }
 * ═══════════════════════════════════════════════════════════════════ */
export const storeOutReportIssue = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, STORE_ROLES)) {
    throw new HttpsError("permission-denied", "Store access required.");
  }
  const { storeOutId, pieceId, reason, otherText } = (request.data || {}) as {
    storeOutId?: string; pieceId?: string; reason?: string; otherText?: string;
  };
  if (!storeOutId || !pieceId) throw new HttpsError("invalid-argument", "storeOutId and pieceId are required.");
  const reasonVal = String(reason ?? "");
  if (!STORE_OUT_REASONS.includes(reasonVal)) {
    throw new HttpsError("invalid-argument", `reason must be one of: ${STORE_OUT_REASONS.join(", ")}`);
  }
  const otherTextVal = String(otherText ?? "").trim();
  if (reasonVal === "OTHER" && !otherTextVal) {
    throw new HttpsError("invalid-argument", "otherText is mandatory when reason is OTHER.");
  }

  const storeOutSnap = await db.doc(`storeOuts/${storeOutId}`).get();
  if (!storeOutSnap.exists) throw new HttpsError("not-found", `Store-Out ${storeOutId} not found.`);

  const issueId = await generateId("storeOutIssue");
  const now = new Date().toISOString();
  await db.doc(`storeOutIssues/${issueId}`).set({
    id: issueId,
    storeOutId,
    pieceId,
    reason: reasonVal,
    otherText: reasonVal === "OTHER" ? otherTextVal : null,
    reportedBy: actor.uid,
    reportedByName: actor.name,
    at: now,
  });

  await writeAudit("STORE_OUT_REPORT_ISSUE", "storeOutIssues", issueId, actor,
    null, { storeOutId, pieceId, reason: reasonVal, otherText: reasonVal === "OTHER" ? otherTextVal : null });

  return { ok: true, issueId };
});
