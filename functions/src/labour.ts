/* eslint-disable */
/**
 * LUXARDO FASHION — PHASE 2 · BLOCK 4 · KARIGAR + LABOUR DOMAIN
 * ============================================================================
 * Cloud Functions for piece work sessions (labour tracking).
 *
 * Finalized rules (locked):
 *  - A Karigar is NOT a login user — a registry/master record. PM assigns a
 *    Karigar to work on a Piece. Multiple Karigars may work on the same Piece.
 *  - Labour is tracked per Piece + Karigar + session. Every session has a
 *    start and stop timestamp (mandatory).
 *  - The Karigar's hourlyRate is SNAPSHOTTED onto the session at start, so
 *    historical cost does not change when the current rate changes.
 *  - Cost = (minutes / 60) × snapshotted hourlyRate, computed once on stop.
 *  - Completed sessions are NEVER silently edited or deleted.
 *  - REWORK creates NEW work sessions (type REWORK) — history is preserved.
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

const LABOUR_ROLES = ["admin", "owner", "pm"];

/** Piece must exist and not be permanently closed. */
async function assertLabourPiece(pieceId: string): Promise<{ ref: admin.firestore.DocumentReference; data: admin.firestore.DocumentData }> {
  const ref = db.doc(`pieces/${pieceId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", `Piece ${pieceId} not found.`);
  const d = snap.data()!;
  if (d.status === "closed" || d.status === "replaced") {
    throw new HttpsError("failed-precondition", `Piece ${pieceId} is ${d.status} and cannot receive work.`);
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

/** Round a duration (ms) up to the nearest whole minute. */
function toMinutes(startedAtIso: string, endedAtIso: string): number {
  const diffMs = new Date(endedAtIso).getTime() - new Date(startedAtIso).getTime();
  return Math.max(0, Math.round(diffMs / 60000));
}

/* ═══════════════════════════════════════════════════════════════════
 * labourStart — PM/Admin/Owner starts a work session for a Karigar on a Piece.
 * Snapshots the Karigar's current hourlyRate onto the session. Creates LS-XXXX.
 * REWORK pieces get a type=REWORK session (reworkOf = previous session id).
 * Input : { pieceId, karigarId }
 * ═══════════════════════════════════════════════════════════════════ */
export const labourStart = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, LABOUR_ROLES)) {
    throw new HttpsError("permission-denied", "PM/Admin/Owner access required.");
  }
  const { pieceId, karigarId } = (request.data || {}) as { pieceId?: string; karigarId?: string };
  if (!pieceId || !karigarId) throw new HttpsError("invalid-argument", "pieceId and karigarId are required.");
  const { ref, data } = await assertLabourPiece(pieceId);
  const karigar = await assertActiveKarigar(karigarId);

  // Rate snapshot at start time — historical cost must not change later.
  const hourlyRate = Number(karigar.hourlyRate) || 0;
  const startedAt = new Date().toISOString();
  const isRework = String(data.stage || "OPEN") === "REWORK" || data.status === "in_rework";

  // For rework, reference the piece's most recent prior session.
  let reworkOf: string | null = null;
  if (isRework) {
    const prev = await db.collection("pieceWorkSessions")
      .where("pieceId", "==", pieceId)
      .orderBy("startedAt", "desc")
      .limit(1)
      .get();
    if (!prev.empty) reworkOf = prev.docs[0].id;
  }

  const sessionId = await generateId("labourSession");
  const now = startedAt;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data()!;
    const fromStage = String(cur.stage || "OPEN");

    // F3 — a piece may only start labour from OPEN or REWORK, per the same
    // canonical NEXT_STAGES graph recordPieceMovement() enforces (pieces.ts).
    // fromStage === "IN_WORK" is also allowed as a no-op: a second/additional
    // Karigar starting on an already-IN_WORK piece doesn't change its stage
    // (see the applyPrQuantityDelta comment below) — NEXT_STAGES doesn't list
    // a stage as its own successor, so that case is checked separately here,
    // matching the same fromStage !== toStage short-circuit
    // recordPieceMovement() uses for identical treatment. Every other stage
    // (QC_PENDING, DISPATCH_READY, STORE, etc.) is rejected, so labourStart
    // can never silently force a piece backward out of a later stage.
    if (fromStage !== "IN_WORK" && !(NEXT_STAGES[fromStage] || []).includes("IN_WORK")) {
      throw new HttpsError(
        "failed-precondition",
        `Piece ${pieceId} cannot start work from stage ${fromStage}.`
      );
    }

    // F2 — reject if this Karigar already has an open (unstopped) session on
    // this Piece. Running the query INSIDE the transaction (not only before
    // it) makes this race-safe: Firestore includes the query's result set in
    // the transaction's read set, so a concurrent labourStart that would
    // create a conflicting open session forces this transaction to retry and
    // see it, instead of both racing past a pre-transaction-only check.
    const openSessionSnap = await tx.get(
      db.collection("pieceWorkSessions")
        .where("pieceId", "==", pieceId)
        .where("karigarId", "==", karigarId)
        .where("endedAt", "==", null)
        .limit(1)
    );
    if (!openSessionSnap.empty) {
      throw new HttpsError(
        "already-exists",
        `Karigar ${karigarId} already has an open work session on piece ${pieceId}.`
      );
    }

    const nowIso = new Date().toISOString();
    tx.update(ref, {
      stage: "IN_WORK",
      status: "active",
      firstWorkAt: cur.firstWorkAt || nowIso,
      lastWorkAt: nowIso,
      lastKarigarIds: [...(Array.isArray(cur.lastKarigarIds) ? cur.lastKarigarIds : []).filter((x: string) => x !== karigarId).slice(-9), karigarId],
      updatedAt: nowIso,
    });
    // A second Karigar starting on an already-IN_WORK piece is a no-op
    // transition (fromStage === "IN_WORK") — applyPrQuantityDelta no-ops in
    // that case, so concurrent/multi-karigar sessions never double-count.
    applyPrQuantityDelta(tx, cur.prId || null, fromStage, "IN_WORK");

    tx.set(db.doc(`pieceWorkSessions/${sessionId}`), {
      id: sessionId,
      pieceId,
      karigarId,
      karigarName: String(karigar.name || karigarId),
      designId: cur.designId || null,
      prId: cur.prId || null,
      startedAt,
      endedAt: null,
      minutes: 0,
      hourlyRate, // SNAPSHOT
      labourCost: 0,
      type: isRework ? "REWORK" : "FIRST",
      reworkOf,
      startedBy: actor.uid,
      startedByName: actor.name,
      stoppedBy: null,
      stoppedByName: null,
      createdAt: now,
      updatedAt: now,
    });
  });

  await recordMovement({
    pieceId, fromStage: String(data.stage || "OPEN"), toStage: "IN_WORK",
    direction: "FORWARD", action: "WORK_START", actor,
    reason: `Work started by ${karigar.name}${isRework ? " (rework)" : ""}`, relatedRequestId: data.prId || null,
    snapshot: { pieceStage: "IN_WORK", totalLabourMinutes: data.totalLabourMinutes || 0, totalLabourCost: data.totalLabourCost || 0 },
  });
  await writeAudit("LABOUR_START", "pieceWorkSessions", sessionId, actor,
    { pieceId, karigarId, stage: data.stage, hourlyRate }, { sessionId, type: isRework ? "REWORK" : "FIRST", hourlyRate, startedAt });

  await syncPrStatus(data.prId || null);
  return { ok: true, sessionId, pieceId, karigarId, hourlyRate };
});

/* ═══════════════════════════════════════════════════════════════════
 * labourStop — PM/Admin/Owner stops an in-progress work session.
 * Computes duration (minutes) and cost = (minutes/60) × snapshotted rate.
 * Applies labour totals to the Piece. Session is finalised (never edited).
 * Input : { sessionId }
 * ═══════════════════════════════════════════════════════════════════ */
export const labourStop = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, LABOUR_ROLES)) {
    throw new HttpsError("permission-denied", "PM/Admin/Owner access required.");
  }
  const { sessionId } = (request.data || {}) as { sessionId?: string };
  if (!sessionId) throw new HttpsError("invalid-argument", "sessionId is required.");

  const sessionRef = db.doc(`pieceWorkSessions/${sessionId}`);
  const snap = await sessionRef.get();
  if (!snap.exists) throw new HttpsError("not-found", `Work session ${sessionId} not found.`);
  const session = snap.data()!;
  if (session.endedAt) {
    throw new HttpsError("failed-precondition", `Session ${sessionId} is already closed.`);
  }
  const pieceId = String(session.pieceId || "");
  if (!pieceId) throw new HttpsError("failed-precondition", `Session ${sessionId} has no pieceId.`);

  const endedAt = new Date().toISOString();
  const minutes = toMinutes(String(session.startedAt), endedAt);
  const hourlyRate = Number(session.hourlyRate) || 0;
  const labourCost = Math.round((minutes / 60) * hourlyRate * 100) / 100;

  const pieceRef = db.doc(`pieces/${pieceId}`);
  const pieceSnap = await pieceRef.get();
  if (!pieceSnap.exists) throw new HttpsError("not-found", `Piece ${pieceId} not found.`);
  const piece = pieceSnap.data()!;

  // totalLabourMinutes/totalLabourCost are computed from a fresh in-transaction
  // read of pieceRef (never the pre-transaction snapshot above) so concurrent
  // labourStop calls on different sessions of the same piece can never blind-
  // write stale totals over one another (each retries against the other's
  // committed result instead of clobbering it).
  let newMinutes = 0;
  let newCost = 0;

  await db.runTransaction(async (tx) => {
    const sSnap = await tx.get(sessionRef);
    const s = sSnap.data()!;
    if (s.endedAt) throw new HttpsError("failed-precondition", `Session ${sessionId} is already closed.`);

    const pSnap = await tx.get(pieceRef);
    const p = pSnap.data()!;
    const prevMinutes = Number(p.totalLabourMinutes) || 0;
    const prevCost = Number(p.totalLabourCost) || 0;
    newMinutes = prevMinutes + minutes;
    newCost = Math.round((prevCost + labourCost) * 100) / 100;

    const nowIso = new Date().toISOString();
    tx.update(sessionRef, {
      endedAt,
      minutes,
      labourCost,
      stoppedBy: actor.uid,
      stoppedByName: actor.name,
      updatedAt: nowIso,
    });
    tx.update(pieceRef, {
      totalLabourMinutes: newMinutes,
      totalLabourCost: newCost,
      lastWorkAt: nowIso,
      updatedAt: nowIso,
    });
  });

  await recordMovement({
    pieceId, fromStage: String(piece.stage || "IN_WORK"), toStage: String(piece.stage || "IN_WORK"),
    direction: "FORWARD", action: "WORK_STOP", actor,
    reason: `Session ${sessionId} stopped (${minutes} min)`, relatedRequestId: piece.prId || null,
    snapshot: { pieceStage: String(piece.stage || "IN_WORK"), totalLabourMinutes: newMinutes, totalLabourCost: newCost },
  });
  await writeAudit("LABOUR_STOP", "pieceWorkSessions", sessionId, actor,
    { pieceId, karigarId: session.karigarId, startedAt: session.startedAt },
    { endedAt, minutes, hourlyRate, labourCost });

  return { ok: true, sessionId, pieceId, minutes, labourCost, hourlyRate };
});