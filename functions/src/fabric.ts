/* eslint-disable */
/**
 * LUXARDO FLOW — Fabric Inventory (V1, Owner-confirmed 3 Oct 2026)
 * ============================================================================
 * Business rules (from the Owner):
 *  - Fabric is measured in METERS.
 *  - Dispatch adds stock when new fabric arrives (stock-in) and issues fabric.
 *  - Each design has a fixed fabric requirement per piece (design fabric
 *    guide). When Dispatch issues fabric for an approved Production Request
 *    to a Guard, the required meters (per-piece meters x ordered qty) are
 *    calculated and deducted from stock automatically.
 *  - The Guard confirms receipt of the issued fabric.
 *  - When a fabric's stock falls to/below its low-stock level, Dispatch and
 *    Owner are alerted (fabric.lowStock flag + fabricAlerts record).
 *
 * Collections:
 *   fabricMasters/{FAB-XXXX}     stockMeters, lowStockMeters, lowStock, active
 *   fabricLedger/{auto}          append-only stock movements (IN / ISSUE)
 *   designFabricGuides/{designId} lines: [{ fabricId, fabricName, metersPerPiece }]
 *   fabricIssues/{FI-XXXX}       one per Production Request
 *   fabricAlerts/{auto}          low-stock alerts for Dispatch + Owner
 *
 * All writes go through these callables (clients are read-only in rules).
 * Stock changes happen inside Firestore transactions, so two concurrent
 * issues can never take the same meters twice.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { requireStaff, hasAnyRole, StaffIdentity } from "./staffAuth";
import { writeAudit } from "./audit";
import { generateId } from "./production";

const db = admin.firestore();

/** Create fabrics, stock-in, issue fabric. */
export const FABRIC_MANAGERS = ["dispatch", "admin", "owner"];
/** Set a design's fabric-per-piece guide. */
export const FABRIC_GUIDE_EDITORS = ["designer", "dispatch", "admin", "owner"];
/** Production Request states in which fabric may be issued. */
const PR_ISSUE_STATUSES = ["APPROVED", "IN_PRODUCTION"];

/** Round to 2 decimals (centimetre precision) to avoid float drift. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function positiveMeters(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new HttpsError("invalid-argument", `${field} must be a positive number of meters.`);
  return round2(n);
}

function nonNegativeMeters(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpsError("invalid-argument", `${field} must be zero or more meters.`);
  return round2(n);
}

/**
 * Pure: compute the fabric requirement of a Production Request from its
 * design guide. Exported for unit tests.
 */
export function computeFabricRequirement(
  lines: Array<{ fabricId: string; fabricName?: string; metersPerPiece: number }>,
  qty: number
): Array<{ fabricId: string; fabricName: string; metersPerPiece: number; qty: number; meters: number }> {
  return lines.map((l) => ({
    fabricId: l.fabricId,
    fabricName: String(l.fabricName || ""),
    metersPerPiece: round2(Number(l.metersPerPiece)),
    qty,
    meters: round2(Number(l.metersPerPiece) * qty),
  }));
}

function lowStockAlert(
  tx: admin.firestore.Transaction,
  fabric: Record<string, any>,
  fabricId: string,
  balance: number,
  actor: StaffIdentity,
  now: string
) {
  const ref = db.collection("fabricAlerts").doc();
  tx.set(ref, {
    id: ref.id,
    type: "LOW_STOCK",
    fabricId,
    fabricName: String(fabric.name || ""),
    stockMeters: balance,
    lowStockMeters: Number(fabric.lowStockMeters) || 0,
    forRoles: ["dispatch", "owner"],
    message: `${fabric.name || fabricId} is low: ${balance} m left (alert level ${Number(fabric.lowStockMeters) || 0} m).`,
    triggeredBy: actor.uid,
    triggeredByName: actor.name,
    createdAt: now,
    resolved: false,
  });
}

/* ═══════════════════════════════════════════════════════════════════
 * fabricCreate — add a fabric to the master list.
 * Input: { name, colour?, gsm?, lowStockMeters, openingMeters?, notes? }
 * ═══════════════════════════════════════════════════════════════════ */
export const fabricCreate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, FABRIC_MANAGERS)) throw new HttpsError("permission-denied", "Dispatch/Admin/Owner access required.");
  const { name, colour, gsm, lowStockMeters, openingMeters, notes } = (request.data || {}) as Record<string, any>;
  const nameText = String(name ?? "").trim();
  if (!nameText) throw new HttpsError("invalid-argument", "Fabric name is required.");
  const low = nonNegativeMeters(lowStockMeters ?? 0, "Low-stock level");
  const opening = nonNegativeMeters(openingMeters ?? 0, "Opening stock");

  const dup = await db.collection("fabricMasters").where("nameKey", "==", nameText.toLowerCase()).limit(1).get();
  if (!dup.empty) throw new HttpsError("already-exists", `A fabric named "${nameText}" already exists.`);

  const id = await generateId("fabric");
  const now = new Date().toISOString();
  const doc = {
    id,
    name: nameText,
    nameKey: nameText.toLowerCase(),
    colour: String(colour ?? "").trim(),
    gsm: Number(gsm) > 0 ? Number(gsm) : null,
    unit: "meter",
    stockMeters: opening,
    lowStockMeters: low,
    lowStock: opening <= low,
    notes: String(notes ?? "").trim(),
    active: true,
    createdBy: actor.uid,
    createdByName: actor.name,
    createdAt: now,
    updatedAt: now,
  };
  await db.runTransaction(async (tx) => {
    tx.set(db.doc(`fabricMasters/${id}`), doc);
    if (opening > 0) {
      const l = db.collection("fabricLedger").doc();
      tx.set(l, {
        id: l.id, fabricId: id, fabricName: nameText, type: "IN", meters: opening, balanceAfter: opening,
        refType: "OPENING", refId: null, note: "Opening stock", actor: actor.uid, actorName: actor.name, createdAt: now,
      });
    }
    if (doc.lowStock) lowStockAlert(tx, doc, id, opening, actor, now);
  });
  await writeAudit("FABRIC_CREATE", "fabricMasters", id, actor, null, doc);
  return { ok: true, id, fabric: doc };
});

/* ═══════════════════════════════════════════════════════════════════
 * fabricUpdate — edit name/colour/gsm/notes/low-stock level/active.
 * Stock is NEVER edited here (only stock-in / issue move stock).
 * ═══════════════════════════════════════════════════════════════════ */
export const fabricUpdate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, FABRIC_MANAGERS)) throw new HttpsError("permission-denied", "Dispatch/Admin/Owner access required.");
  const { id, updates } = (request.data || {}) as { id?: string; updates?: Record<string, any> };
  if (!id || !updates) throw new HttpsError("invalid-argument", "id and updates are required.");
  const ref = db.doc(`fabricMasters/${id}`);
  let before: Record<string, any> = {};
  let after: Record<string, any> = {};
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `Fabric ${id} not found.`);
    before = snap.data()!;
    const patch: Record<string, any> = { updatedAt: new Date().toISOString() };
    if (updates.name !== undefined) {
      const n = String(updates.name).trim();
      if (!n) throw new HttpsError("invalid-argument", "Fabric name cannot be empty.");
      const nameKey = n.toLowerCase();
      if (nameKey !== before.nameKey) {
        const dup = await tx.get(db.collection("fabricMasters").where("nameKey", "==", nameKey).limit(1));
        if (!dup.empty) throw new HttpsError("already-exists", `A fabric named "${n}" already exists.`);
      }
      patch.name = n; patch.nameKey = nameKey;
    }
    if (updates.colour !== undefined) patch.colour = String(updates.colour).trim();
    if (updates.gsm !== undefined) patch.gsm = Number(updates.gsm) > 0 ? Number(updates.gsm) : null;
    if (updates.notes !== undefined) patch.notes = String(updates.notes).trim();
    if (updates.active !== undefined) patch.active = updates.active === true;
    if (updates.lowStockMeters !== undefined) {
      patch.lowStockMeters = nonNegativeMeters(updates.lowStockMeters, "Low-stock level");
      patch.lowStock = (Number(before.stockMeters) || 0) <= patch.lowStockMeters;
    }
    after = { ...before, ...patch };
    tx.update(ref, patch);
  });
  await writeAudit("FABRIC_UPDATE", "fabricMasters", id, actor, before, after);
  return { ok: true, id };
});

/* ═══════════════════════════════════════════════════════════════════
 * fabricStockIn — new fabric arrived. Adds meters to stock.
 * Input: { fabricId, meters, supplier?, billNumber?, note? }
 * ═══════════════════════════════════════════════════════════════════ */
export const fabricStockIn = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, FABRIC_MANAGERS)) throw new HttpsError("permission-denied", "Dispatch/Admin/Owner access required.");
  const { fabricId, meters, supplier, billNumber, note } = (request.data || {}) as Record<string, any>;
  if (!fabricId) throw new HttpsError("invalid-argument", "fabricId is required.");
  const m = positiveMeters(meters, "Meters");
  const ref = db.doc(`fabricMasters/${fabricId}`);
  const now = new Date().toISOString();
  let balance = 0;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `Fabric ${fabricId} not found.`);
    const f = snap.data()!;
    if (f.active === false) throw new HttpsError("failed-precondition", `Fabric ${fabricId} is inactive.`);
    balance = round2((Number(f.stockMeters) || 0) + m);
    const low = balance <= (Number(f.lowStockMeters) || 0);
    tx.update(ref, { stockMeters: balance, lowStock: low, updatedAt: now });
    const l = db.collection("fabricLedger").doc();
    tx.set(l, {
      id: l.id, fabricId, fabricName: String(f.name || ""), type: "IN", meters: m, balanceAfter: balance,
      refType: "STOCK_IN", refId: null,
      supplier: String(supplier ?? "").trim(), billNumber: String(billNumber ?? "").trim(),
      note: String(note ?? "").trim(), actor: actor.uid, actorName: actor.name, createdAt: now,
    });
  });
  await writeAudit("FABRIC_STOCK_IN", "fabricMasters", fabricId, actor, null, { meters: m, balanceAfter: balance });
  return { ok: true, fabricId, stockMeters: balance };
});

/* ═══════════════════════════════════════════════════════════════════
 * designFabricGuideSet — fixed fabric requirement per piece for a design.
 * Input: { designId, lines: [{ fabricId, metersPerPiece }] }
 * ═══════════════════════════════════════════════════════════════════ */
export const designFabricGuideSet = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, FABRIC_GUIDE_EDITORS)) throw new HttpsError("permission-denied", "Designer/Dispatch/Admin/Owner access required.");
  const { designId, lines } = (request.data || {}) as { designId?: string; lines?: any[] };
  if (!designId) throw new HttpsError("invalid-argument", "designId is required.");
  if (!Array.isArray(lines) || lines.length === 0) throw new HttpsError("invalid-argument", "At least one fabric line is required.");
  if (lines.length > 10) throw new HttpsError("invalid-argument", "At most 10 fabrics per design.");
  const designSnap = await db.doc(`catalogueDesigns/${designId}`).get();
  if (!designSnap.exists) throw new HttpsError("not-found", `Design ${designId} not found.`);

  const seen = new Set<string>();
  const clean: Array<{ fabricId: string; fabricName: string; metersPerPiece: number }> = [];
  for (const l of lines) {
    const fid = String(l?.fabricId || "");
    if (!fid) throw new HttpsError("invalid-argument", "Every line needs a fabric.");
    if (seen.has(fid)) throw new HttpsError("invalid-argument", `Fabric ${fid} is listed twice.`);
    seen.add(fid);
    const f = await db.doc(`fabricMasters/${fid}`).get();
    if (!f.exists) throw new HttpsError("not-found", `Fabric ${fid} not found.`);
    clean.push({ fabricId: fid, fabricName: String(f.data()!.name || ""), metersPerPiece: positiveMeters(l.metersPerPiece, "Meters per piece") });
  }
  const now = new Date().toISOString();
  const ref = db.doc(`designFabricGuides/${designId}`);
  const before = (await ref.get()).data() || null;
  const doc = { designId, designName: String(designSnap.data()!.name || ""), lines: clean, updatedBy: actor.uid, updatedByName: actor.name, updatedAt: now };
  await ref.set(doc);
  await writeAudit("DESIGN_FABRIC_GUIDE_SET", "designFabricGuides", designId, actor, before, doc);
  return { ok: true, designId, lines: clean };
});

/* ═══════════════════════════════════════════════════════════════════
 * listActiveGuards — Dispatch picker for "issue fabric to Guard".
 * ═══════════════════════════════════════════════════════════════════ */
export const listActiveGuards = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, FABRIC_MANAGERS)) throw new HttpsError("permission-denied", "Dispatch/Admin/Owner access required.");
  const snap = await db.collection("staff").where("role", "==", "guard").where("active", "==", true).get();
  return { ok: true, guards: snap.docs.map((d) => ({ uid: d.id, name: String(d.data().displayName || "") })) };
});

/* ═══════════════════════════════════════════════════════════════════
 * fabricIssueCreate — Dispatch issues the fabric for an approved PR to a
 * Guard. Required meters come from the design's fabric guide x the
 * Owner-frozen ordered quantity, and are deducted from stock atomically.
 * One issue per Production Request.
 * Input: { prId, guardUid, note? }
 * ═══════════════════════════════════════════════════════════════════ */
export const fabricIssueCreate = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, FABRIC_MANAGERS)) throw new HttpsError("permission-denied", "Dispatch/Admin/Owner access required.");
  const { prId, guardUid, note } = (request.data || {}) as { prId?: string; guardUid?: string; note?: string };
  if (!prId || !guardUid) throw new HttpsError("invalid-argument", "prId and guardUid are required.");

  const guardSnap = await db.doc(`staff/${guardUid}`).get();
  const g = guardSnap.data();
  if (!guardSnap.exists || String(g?.role) !== "guard" || g?.active === false) {
    throw new HttpsError("failed-precondition", "Fabric can only be issued to an active Guard.");
  }

  const issueId = await generateId("fabricIssue");
  const now = new Date().toISOString();
  const prRef = db.doc(`productionRequests/${prId}`);
  let issueDoc: Record<string, any> = {};
  let alerts: string[] = [];

  await db.runTransaction(async (tx) => {
    const prSnap = await tx.get(prRef);
    if (!prSnap.exists) throw new HttpsError("not-found", `PR ${prId} not found.`);
    const pr = prSnap.data()!;
    if (!pr.originalQtyFrozen || !PR_ISSUE_STATUSES.includes(String(pr.status))) {
      throw new HttpsError("failed-precondition", "Fabric can only be issued for an Owner-approved production request.");
    }
    if (pr.fabricIssueId) throw new HttpsError("already-exists", `Fabric for ${prId} was already issued (${pr.fabricIssueId}).`);

    const guideSnap = await tx.get(db.doc(`designFabricGuides/${pr.designId}`));
    const lines = guideSnap.exists ? (guideSnap.data()!.lines || []) : [];
    if (!lines.length) {
      throw new HttpsError("failed-precondition", `Design ${pr.designId} has no fabric guide yet. Set meters per piece on the design first.`);
    }
    const qty = Number(pr.originalOrderedQty) || 0;
    if (qty <= 0) throw new HttpsError("failed-precondition", "PR has no ordered quantity.");
    const req = computeFabricRequirement(lines, qty);

    // Reads first (all fabric docs), then writes — Firestore transaction rule.
    const fabricRefs = req.map((r) => db.doc(`fabricMasters/${r.fabricId}`));
    const fabricSnaps = await Promise.all(fabricRefs.map((r) => tx.get(r)));
    const short: string[] = [];
    fabricSnaps.forEach((s, i) => {
      if (!s.exists) { short.push(`${req[i].fabricId} (missing)`); return; }
      const f = s.data()!;
      if (f.active === false) short.push(`${f.name} (inactive)`);
      const have = Number(f.stockMeters) || 0;
      if (have < req[i].meters) short.push(`${f.name}: need ${req[i].meters} m, have ${round2(have)} m`);
    });
    if (short.length) throw new HttpsError("failed-precondition", `Not enough fabric — ${short.join("; ")}.`);

    fabricSnaps.forEach((s, i) => {
      const f = s.data()!;
      const balance = round2((Number(f.stockMeters) || 0) - req[i].meters);
      const low = balance <= (Number(f.lowStockMeters) || 0);
      tx.update(fabricRefs[i], { stockMeters: balance, lowStock: low, updatedAt: now });
      const l = db.collection("fabricLedger").doc();
      tx.set(l, {
        id: l.id, fabricId: req[i].fabricId, fabricName: String(f.name || ""), type: "ISSUE",
        meters: -req[i].meters, balanceAfter: balance, refType: "FABRIC_ISSUE", refId: issueId, prId,
        note: `Issued for ${prId} to ${g?.displayName || guardUid}`, actor: actor.uid, actorName: actor.name, createdAt: now,
      });
      if (low && !f.lowStock) { lowStockAlert(tx, f, req[i].fabricId, balance, actor, now); alerts.push(String(f.name)); }
      req[i].fabricName = String(f.name || req[i].fabricName);
    });

    issueDoc = {
      id: issueId, prId, designId: pr.designId, designVersionId: pr.designVersionId || null,
      qty, lines: req, totalMeters: round2(req.reduce((s, r) => s + r.meters, 0)),
      issuedTo: guardUid, issuedToName: String(g?.displayName || ""),
      issuedBy: actor.uid, issuedByName: actor.name, issuedAt: now,
      status: "ISSUED", receivedAt: null, receivedBy: null, receivedByName: null,
      note: String(note ?? "").trim(), createdAt: now, updatedAt: now,
    };
    tx.set(db.doc(`fabricIssues/${issueId}`), issueDoc);
    tx.update(prRef, { fabricIssueId: issueId, fabricIssuedAt: now, updatedAt: now });
  });

  await writeAudit("FABRIC_ISSUE", "fabricIssues", issueId, actor, null, issueDoc);
  return { ok: true, id: issueId, issue: issueDoc, lowStockAlerts: alerts };
});

/* ═══════════════════════════════════════════════════════════════════
 * fabricIssueReceive — the Guard confirms the fabric was received.
 * Input: { issueId, note? }
 * ═══════════════════════════════════════════════════════════════════ */
export const fabricIssueReceive = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, ["guard", "admin", "owner"])) throw new HttpsError("permission-denied", "Guard access required.");
  const { issueId, note } = (request.data || {}) as { issueId?: string; note?: string };
  if (!issueId) throw new HttpsError("invalid-argument", "issueId is required.");
  const ref = db.doc(`fabricIssues/${issueId}`);
  const now = new Date().toISOString();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", `Fabric issue ${issueId} not found.`);
    const d = snap.data()!;
    if (d.status !== "ISSUED") throw new HttpsError("failed-precondition", `Fabric issue ${issueId} is already ${d.status}.`);
    if (actor.role === "guard" && d.issuedTo !== actor.uid) {
      throw new HttpsError("permission-denied", "This fabric was issued to a different Guard.");
    }
    tx.update(ref, {
      status: "RECEIVED", receivedAt: now, receivedBy: actor.uid, receivedByName: actor.name,
      receiveNote: String(note ?? "").trim(), updatedAt: now,
    });
  });
  await writeAudit("FABRIC_RECEIVE", "fabricIssues", issueId, actor, { status: "ISSUED" }, { status: "RECEIVED" });
  return { ok: true, id: issueId };
});

/* ═══════════════════════════════════════════════════════════════════
 * fabricAlertResolve — Dispatch/Owner marks a low-stock alert as seen.
 * ═══════════════════════════════════════════════════════════════════ */
export const fabricAlertResolve = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, FABRIC_MANAGERS)) throw new HttpsError("permission-denied", "Dispatch/Admin/Owner access required.");
  const { alertId } = (request.data || {}) as { alertId?: string };
  if (!alertId) throw new HttpsError("invalid-argument", "alertId is required.");
  const ref = db.doc(`fabricAlerts/${alertId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Alert not found.");
  await ref.update({ resolved: true, resolvedBy: actor.uid, resolvedByName: actor.name, resolvedAt: new Date().toISOString() });
  return { ok: true };
});
