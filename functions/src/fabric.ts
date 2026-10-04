/* eslint-disable */
/**
 * LUXARDO FASHION — FABRIC INVENTORY V1 (production-scoped, Flow-only)
 * ============================================================================
 * Cloud Functions for fabric master data + stock receipt/issue.
 *
 * Scope (locked for V1 — deliberately NOT an enterprise warehouse system):
 *  - fabricMasters: master data for a fabric type (name, gsm, colour, ...)
 *    PLUS its current stock level (stockQtyMeters). Stock is NEVER editable
 *    via fabricMasterUpdate — it only moves through fabricStockReceive /
 *    fabricStockIssue, each inside its own transaction.
 *  - fabricReceipts: one append-only record per stock-in event.
 *  - fabricIssues: one append-only record per stock-out-to-a-Production-
 *    Request event.
 *  - fabricLedger: the single, append-only, combined running ledger for a
 *    fabric's stock (RECEIPT | ISSUE), each entry carrying balanceAfterMeters
 *    — mirrors the pieceMovementHistory pattern (movement.ts) for pieces.
 *
 * Transactional invariant (locked): a fabric's stockQtyMeters is read fresh
 * INSIDE the same transaction that validates and applies a receipt/issue —
 * never from a pre-transaction snapshot — so concurrent issues against the
 * same fabric cannot both pass a negative-stock check (Firestore retries a
 * transaction whose read set was invalidated by a concurrent commit). Stock
 * must NEVER go negative; fabricStockIssue enforces this authoritatively
 * inside the transaction, not just as a pre-check.
 *
 * RBAC mirrors the existing Karigar registry precedent exactly
 * (production.ts karigarCreate/karigarUpdate's intent, but using
 * hasAnyRole/FABRIC_MANAGERS like pieces.ts/labour.ts so PM is genuinely
 * authorized server-side wherever the frontend MATRIX grants it):
 * admin/owner/pm manage; broader roles get read-only access via
 * firestore.loom.rules (clients are read-only on every collection below —
 * all mutation is server-side).
 * ============================================================================
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import { generateId } from "./production";
import { requireStaff, hasAnyRole } from "./staffAuth";
import { writeAudit } from "./audit";

const db = admin.firestore();

const FABRIC_MANAGERS = ["admin", "owner", "pm"];

/** Round to 2 decimal places — meters are tracked with sub-integer precision. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function assertPositiveQty(qtyMeters: unknown): number {
  if (typeof qtyMeters !== "number" || !Number.isFinite(qtyMeters) || qtyMeters <= 0) {
    throw new HttpsError("invalid-argument", "qtyMeters must be a positive number.");
  }
  return round2(qtyMeters);
}

/** Fabric master must exist and not be deactivated. */
async function assertActiveFabric(fabricId: string): Promise<admin.firestore.DocumentData> {
  const snap = await db.doc(`fabricMasters/${fabricId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", `Fabric ${fabricId} not found.`);
  const d = snap.data()!;
  if (d.active === false) throw new HttpsError("failed-precondition", `Fabric ${fabricId} is inactive.`);
  return d;
}

/* ═══════════════════════════════════════════════════════════════════
 * fabricMasterCreate — register a new fabric type. Stock starts at 0;
 * stock only ever moves via fabricStockReceive.
 * Input : { name, gsm, colour, colourCode?, notes? }
 * Output: { id: string }
 * ═══════════════════════════════════════════════════════════════════ */
export const fabricMasterCreate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, FABRIC_MANAGERS)) {
    throw new HttpsError("permission-denied", "PM/Admin/Owner access required.");
  }

  const { name, gsm, colour, colourCode, notes } = (request.data || {}) as {
    name?: string; gsm?: number; colour?: string; colourCode?: string; notes?: string;
  };
  const trimmedName = String(name ?? "").trim();
  const trimmedColour = String(colour ?? "").trim();
  if (!trimmedName || !trimmedColour) {
    throw new HttpsError("invalid-argument", "name and colour are required.");
  }
  if (typeof gsm !== "number" || !Number.isFinite(gsm) || gsm <= 0) {
    throw new HttpsError("invalid-argument", "gsm must be a positive number.");
  }

  const id = await generateId("fabricMaster"); // FM-0001
  const now = new Date().toISOString();
  const doc = {
    id,
    name: trimmedName,
    gsm,
    colour: trimmedColour,
    colourCode: String(colourCode ?? "").trim(),
    notes: String(notes ?? "").trim(),
    unit: "meters",
    stockQtyMeters: 0,
    active: true,
    createdBy: request.auth.uid,
    createdByName: actor.name,
    createdAt: now,
    updatedAt: now,
  };

  await db.doc(`fabricMasters/${id}`).set(doc);
  await writeAudit("FABRIC_MASTER_CREATE", "fabricMasters", id, actor, null, doc);

  return { id };
});

/* ═══════════════════════════════════════════════════════════════════
 * fabricMasterUpdate — update a fabric master's descriptive fields.
 * stockQtyMeters is NEVER accepted here — it only moves through
 * fabricStockReceive / fabricStockIssue.
 * Input : { id, updates: { name?, gsm?, colour?, colourCode?, notes?, active? } }
 * Output: { ok: true }
 * ═══════════════════════════════════════════════════════════════════ */
export const fabricMasterUpdate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, FABRIC_MANAGERS)) {
    throw new HttpsError("permission-denied", "PM/Admin/Owner access required.");
  }

  const { id, updates } = (request.data || {}) as { id?: string; updates?: Record<string, unknown> };
  if (!id || !updates || typeof updates !== "object") {
    throw new HttpsError("invalid-argument", "id and updates object required.");
  }

  const ref = db.doc(`fabricMasters/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", `Fabric ${id} not found.`);
  const before = snap.data()!;

  // Whitelist — deliberately excludes stockQtyMeters (see module header).
  const allowed = ["name", "gsm", "colour", "colourCode", "notes", "active"];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) {
    if (k in updates) patch[k] = updates[k];
  }
  if (Object.keys(patch).length === 0) {
    throw new HttpsError("invalid-argument", "No valid fields to update.");
  }
  if (patch.gsm !== undefined && (typeof patch.gsm !== "number" || !Number.isFinite(patch.gsm) || patch.gsm <= 0)) {
    throw new HttpsError("invalid-argument", "gsm must be a positive number.");
  }
  if (patch.name !== undefined) {
    const n = String(patch.name ?? "").trim();
    if (!n) throw new HttpsError("invalid-argument", "name cannot be empty.");
    patch.name = n;
  }
  if (patch.colour !== undefined) {
    const c = String(patch.colour ?? "").trim();
    if (!c) throw new HttpsError("invalid-argument", "colour cannot be empty.");
    patch.colour = c;
  }

  patch.updatedAt = new Date().toISOString();
  await ref.update(patch);

  const auditAfter: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    if (k !== "updatedAt") auditAfter[k] = patch[k];
  }
  await writeAudit("FABRIC_MASTER_UPDATE", "fabricMasters", id, actor,
    { name: before.name, gsm: before.gsm, colour: before.colour, active: before.active },
    auditAfter);

  if (patch.active === false && before.active !== false) {
    await writeAudit("FABRIC_MASTER_DEACTIVATE", "fabricMasters", id, actor, { active: true }, { active: false });
  }

  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════════
 * fabricStockReceive — record stock coming in. Increments stockQtyMeters,
 * writes ONE fabricReceipts record and ONE fabricLedger entry, all inside
 * one transaction.
 * Input : { fabricId, qtyMeters, supplier?, notes? }
 * Output: { ok: true, id: string, balanceAfterMeters: number }
 * ═══════════════════════════════════════════════════════════════════ */
export const fabricStockReceive = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, FABRIC_MANAGERS)) {
    throw new HttpsError("permission-denied", "PM/Admin/Owner access required.");
  }

  const { fabricId, qtyMeters, supplier, notes } = (request.data || {}) as {
    fabricId?: string; qtyMeters?: number; supplier?: string; notes?: string;
  };
  if (!fabricId) throw new HttpsError("invalid-argument", "fabricId is required.");
  const qty = assertPositiveQty(qtyMeters);

  await assertActiveFabric(fabricId); // fast-fail pre-check; the transaction below re-checks authoritatively

  const receiptId = await generateId("fabricReceipt"); // FR-0001
  const ledgerId = crypto.randomUUID();
  const fabricRef = db.doc(`fabricMasters/${fabricId}`);
  let balanceAfterMeters = 0;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(fabricRef);
    if (!snap.exists) throw new HttpsError("not-found", `Fabric ${fabricId} not found.`);
    const f = snap.data()!;
    if (f.active === false) throw new HttpsError("failed-precondition", `Fabric ${fabricId} is inactive.`);

    const curStock = Number(f.stockQtyMeters) || 0;
    balanceAfterMeters = round2(curStock + qty);
    const now = new Date().toISOString();

    tx.update(fabricRef, { stockQtyMeters: balanceAfterMeters, updatedAt: now });

    tx.set(db.doc(`fabricReceipts/${receiptId}`), {
      id: receiptId,
      fabricId,
      qtyMeters: qty,
      supplier: supplier ? String(supplier).trim() : null,
      notes: notes ? String(notes).trim() : "",
      balanceAfterMeters,
      receivedBy: request.auth!.uid,
      receivedByName: actor.name,
      receivedAt: now,
      createdAt: now,
    });

    tx.set(db.doc(`fabricLedger/${ledgerId}`), {
      id: ledgerId,
      fabricId,
      type: "RECEIPT",
      qtyMeters: qty,
      balanceAfterMeters,
      relatedReceiptId: receiptId,
      relatedIssueId: null,
      relatedPrId: null,
      actorUid: request.auth!.uid,
      actorName: actor.name,
      actorRole: actor.role,
      at: now,
      reason: notes ? String(notes).trim() : null,
    });

    await writeAudit(
      "FABRIC_STOCK_RECEIVE", "fabricMasters", fabricId, actor,
      { stockQtyMeters: curStock },
      { stockQtyMeters: balanceAfterMeters, qtyReceived: qty, receiptId },
      undefined, tx
    );
  });

  return { ok: true, id: receiptId, fabricId, qtyMeters: qty, balanceAfterMeters };
});

/* ═══════════════════════════════════════════════════════════════════
 * fabricStockIssue — issue stock OUT to a Production Request. Decrements
 * stockQtyMeters, writes ONE fabricIssues record and ONE fabricLedger
 * entry, all inside one transaction. Never allows stock to go negative —
 * the check is re-validated against a FRESH in-transaction read (not the
 * pre-transaction snapshot), so two concurrent issues against the same
 * fabric cannot both pass.
 * Input : { fabricId, prId, qtyMeters, reason? }
 * Output: { ok: true, id: string, balanceAfterMeters: number }
 * ═══════════════════════════════════════════════════════════════════ */
export const fabricStockIssue = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, FABRIC_MANAGERS)) {
    throw new HttpsError("permission-denied", "PM/Admin/Owner access required.");
  }

  const { fabricId, prId, qtyMeters, reason } = (request.data || {}) as {
    fabricId?: string; prId?: string; qtyMeters?: number; reason?: string;
  };
  if (!fabricId) throw new HttpsError("invalid-argument", "fabricId is required.");
  if (!prId) throw new HttpsError("invalid-argument", "prId is required.");
  const qty = assertPositiveQty(qtyMeters);

  await assertActiveFabric(fabricId); // fast-fail pre-check; the transaction below re-checks authoritatively

  // Read-only existence check (never mutated here) — same pattern as
  // prReproduce's sourcePrId lookup in productionRequests.ts. Deliberately
  // does NOT restrict by PR status: which statuses may receive fabric is a
  // business decision not specified for V1, so this stays a plain
  // existence check rather than inventing an extra rule.
  const prSnap = await db.doc(`productionRequests/${prId}`).get();
  if (!prSnap.exists) throw new HttpsError("not-found", `Production Request ${prId} not found.`);

  const issueId = await generateId("fabricIssue"); // FI-0001
  const ledgerId = crypto.randomUUID();
  const fabricRef = db.doc(`fabricMasters/${fabricId}`);
  let balanceAfterMeters = 0;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(fabricRef);
    if (!snap.exists) throw new HttpsError("not-found", `Fabric ${fabricId} not found.`);
    const f = snap.data()!;
    if (f.active === false) throw new HttpsError("failed-precondition", `Fabric ${fabricId} is inactive.`);

    const curStock = Number(f.stockQtyMeters) || 0;
    if (qty > curStock) {
      throw new HttpsError(
        "failed-precondition",
        `Insufficient stock for ${fabricId}: requested ${qty}m, available ${curStock}m.`
      );
    }
    balanceAfterMeters = round2(curStock - qty);
    const now = new Date().toISOString();

    tx.update(fabricRef, { stockQtyMeters: balanceAfterMeters, updatedAt: now });

    tx.set(db.doc(`fabricIssues/${issueId}`), {
      id: issueId,
      fabricId,
      prId,
      qtyMeters: qty,
      reason: reason ? String(reason).trim() : "",
      balanceAfterMeters,
      issuedBy: request.auth!.uid,
      issuedByName: actor.name,
      issuedAt: now,
      createdAt: now,
    });

    tx.set(db.doc(`fabricLedger/${ledgerId}`), {
      id: ledgerId,
      fabricId,
      type: "ISSUE",
      qtyMeters: qty,
      balanceAfterMeters,
      relatedReceiptId: null,
      relatedIssueId: issueId,
      relatedPrId: prId,
      actorUid: request.auth!.uid,
      actorName: actor.name,
      actorRole: actor.role,
      at: now,
      reason: reason ? String(reason).trim() : null,
    });

    await writeAudit(
      "FABRIC_STOCK_ISSUE", "fabricMasters", fabricId, actor,
      { stockQtyMeters: curStock },
      { stockQtyMeters: balanceAfterMeters, qtyIssued: qty, issueId, prId },
      undefined, tx
    );
  });

  return { ok: true, id: issueId, fabricId, prId, qtyMeters: qty, balanceAfterMeters };
});
