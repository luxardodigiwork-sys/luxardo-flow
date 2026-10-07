/* eslint-disable */
/**
 * LUXARDO FASHION — FINAL PRODUCTION DASHBOARD & ROLE VISIBILITY PHASE
 * ============================================================================
 * Server-side, role-gated aggregation for the Owner/Super Admin labour
 * reports and the cross-role read-only Store Overview.
 *
 * Why these exist as callables instead of client-side Firestore reads:
 *  - pieceWorkSessions carries per-Karigar labour cost/timing. Several roles
 *    that must see a Store Overview (designer, analysis, dispatch, guard)
 *    must NEVER see labour cost/timing or raw karigar data — a client-side
 *    query of pieces/pieceWorkSessions has no way to redact fields per role.
 *    These callables compute only the safe, aggregated shape each caller is
 *    allowed to see, authorizing server-side with the SAME role lists already
 *    used elsewhere in this domain (requireStaff + hasAnyRole), never by
 *    loosening firestore.loom.rules.
 *  - Owner/Super Admin labour reporting needs cross-collection aggregation
 *    (pieceWorkSessions x karigars x pieces) that would otherwise require the
 *    browser to pull entire collections on every dashboard load.
 *
 * Cost/time figures are NEVER recomputed from a Karigar's CURRENT hourlyRate —
 * every figure here is read directly from pieceWorkSessions' own stored
 * `minutes`/`labourCost`/`hourlyRate` (snapshotted at session-start/stop time,
 * per labour.ts), matching the locked historical-accuracy rule.
 *
 * V1 scale note: these scan the full pieceWorkSessions/pieces/
 * productionRequests/catalogueDesigns collections (reasonable at current
 * volume). If/when volume grows, this should move to a scheduled rollup
 * (e.g. a Firestore-triggered aggregation doc updated on each labourStop),
 * not a client-side change — flagged here rather than silently left as a
 * future landmine.
 * ============================================================================
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { requireStaff, hasAnyRole } from "./staffAuth";

const db = admin.firestore();

const REPORTS_ROLES = ["super_admin", "owner"];
const STORE_OVERVIEW_ROLES = ["super_admin", "admin", "owner", "guard", "pm", "designer", "dispatch", "analysis", "store"];

const ACTIVE_NON_STORE_STAGES = new Set([
  "IN_WORK", "QC_PENDING", "REWORK", "QC_PASS", "DISPATCH_READY",
  "TAILOR_ASSIGNED", "STITCHING", "STITCH_COMPLETE",
]);

function startOfDayIso(d: Date): string {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.toISOString();
}
function startOfMonthIso(d: Date): string {
  const x = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  return x.toISOString();
}

/* ═══════════════════════════════════════════════════════════════════
 * storeOverviewReport — read-only, per-design production/Store summary.
 * Available to every role that legitimately needs visibility into where
 * designs stand (super_admin/admin/owner/guard/pm/designer/dispatch/
 * analysis/store) WITHOUT granting any of them raw `pieces`/labour read
 * access they don't already have. Returns NO labour cost, NO karigar data,
 * NO per-piece detail — only design-level counts.
 * Output: { ok, designs: [...], topDemand: [...] }
 * ═══════════════════════════════════════════════════════════════════ */
export const storeOverviewReport = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, STORE_OVERVIEW_ROLES)) {
    throw new HttpsError("permission-denied", "Not permitted to view the Store Overview.");
  }

  const [designsSnap, piecesSnap, storeOutsSnap, prsSnap] = await Promise.all([
    db.collection("catalogueDesigns").get(),
    db.collection("pieces").get(),
    db.collection("storeOuts").get(),
    db.collection("productionRequests").get(),
  ]);

  const designNames = new Map<string, { name: string; shortName: string | null }>();
  for (const d of designsSnap.docs) {
    const v = d.data();
    designNames.set(d.id, { name: String(v.name || d.id), shortName: v.catalogueShortName || null });
  }

  type Agg = {
    atStore: number; totalProduced: number; inProduction: number;
    completed: number; stored: number; storeOutCount: number;
  };
  const byDesign = new Map<string, Agg>();
  const pieceDesignOf = new Map<string, string>();
  const ensure = (designId: string): Agg => {
    let a = byDesign.get(designId);
    if (!a) { a = { atStore: 0, totalProduced: 0, inProduction: 0, completed: 0, stored: 0, storeOutCount: 0 }; byDesign.set(designId, a); }
    return a;
  };

  for (const p of piecesSnap.docs) {
    const v = p.data();
    const designId = String(v.designId || "");
    if (!designId) continue;
    pieceDesignOf.set(p.id, designId);
    const a = ensure(designId);
    a.totalProduced += 1;
    const stage = String(v.stage || "OPEN");
    if (stage === "STORE") { a.atStore += 1; a.stored += 1; }
    else if (stage === "STORE_OUT") { a.completed += 1; a.stored += 1; }
    else if (ACTIVE_NON_STORE_STAGES.has(stage)) { a.inProduction += 1; }
  }

  for (const so of storeOutsSnap.docs) {
    const v = so.data();
    const touchedDesigns = new Set<string>();
    for (const pieceId of (Array.isArray(v.pieceIds) ? v.pieceIds : [])) {
      const designId = pieceDesignOf.get(String(pieceId));
      if (designId) touchedDesigns.add(designId);
    }
    for (const designId of touchedDesigns) ensure(designId).storeOutCount += 1;
  }

  const designs = Array.from(byDesign.entries())
    .map(([designId, a]) => ({
      designId,
      name: designNames.get(designId)?.name || designId,
      catalogueShortName: designNames.get(designId)?.shortName || null,
      ...a,
    }))
    .sort((x, y) => y.atStore - x.atStore);

  // "Top Demand / Highest Production" — PRODUCTION demand (ordered +
  // generated piece quantities), explicitly NOT sales data (none exists in
  // this system yet).
  const demandByDesign = new Map<string, { orderedQty: number; generatedQty: number }>();
  for (const pr of prsSnap.docs) {
    const v = pr.data();
    const designId = String(v.designId || "");
    if (!designId) continue;
    const cur = demandByDesign.get(designId) || { orderedQty: 0, generatedQty: 0 };
    cur.orderedQty += Number(v.originalOrderedQty) || 0;
    cur.generatedQty += Number(v.piecesGeneratedCount) || 0;
    demandByDesign.set(designId, cur);
  }
  const topDemand = Array.from(demandByDesign.entries())
    .map(([designId, d]) => ({
      designId,
      name: designNames.get(designId)?.name || designId,
      catalogueShortName: designNames.get(designId)?.shortName || null,
      ...d,
    }))
    .sort((x, y) => y.orderedQty - x.orderedQty)
    .slice(0, 10);

  return { ok: true, designs, topDemand, basis: "PRODUCTION_DEMAND" };
});

/* ═══════════════════════════════════════════════════════════════════
 * ownerLabourSummary — Owner/Super Admin executive labour reporting.
 * Period cards (today/yesterday/last 7 days/current month), per-Karigar
 * summary, and production performance — all computed from the stored,
 * snapshotted pieceWorkSessions fields (never recalculated from a
 * Karigar's current hourlyRate).
 * Output: { ok, periods: {...}, karigars: [...], performance: {...} }
 * ═══════════════════════════════════════════════════════════════════ */
export const ownerLabourSummary = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, REPORTS_ROLES)) {
    throw new HttpsError("permission-denied", "Owner/Super Admin access required.");
  }

  const now = new Date();
  const todayStart = startOfDayIso(now);
  const yesterdayDate = new Date(now); yesterdayDate.setDate(now.getDate() - 1);
  const yesterdayStart = startOfDayIso(yesterdayDate);
  const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(now.getDate() - 6); // inclusive of today = 7 days
  const sevenDaysStart = startOfDayIso(sevenDaysAgo);
  const monthStart = startOfMonthIso(now);

  // One bounded scan of completed sessions since the start of EITHER window
  // needed (month start is always <= the other three), then bucket in
  // memory — avoids 4 separate collection scans.
  const earliestNeeded = monthStart < sevenDaysStart ? monthStart : sevenDaysStart;
  const sessionsSnap = await db.collection("pieceWorkSessions")
    .where("endedAt", ">=", earliestNeeded)
    .get();

  type PeriodAcc = { minutes: number; cost: number; sessions: number; pieces: Set<string> };
  const mk = (): PeriodAcc => ({ minutes: 0, cost: 0, sessions: 0, pieces: new Set() });
  const todayAcc = mk(), yesterdayAcc = mk(), sevenDayAcc = mk(), monthAcc = mk();

  const bump = (acc: PeriodAcc, minutes: number, cost: number, pieceId: string) => {
    acc.minutes += minutes; acc.cost += cost; acc.sessions += 1;
    if (pieceId) acc.pieces.add(pieceId);
  };
  const toCard = (acc: PeriodAcc) => ({
    totalLabourMinutes: acc.minutes,
    totalLabourCost: Math.round(acc.cost * 100) / 100,
    completedSessions: acc.sessions,
    piecesWorked: acc.pieces.size,
  });

  for (const s of sessionsSnap.docs) {
    const v = s.data();
    const endedAt = String(v.endedAt || "");
    if (!endedAt) continue;
    const minutes = Number(v.minutes) || 0;
    const cost = Number(v.labourCost) || 0;
    const pieceId = String(v.pieceId || "");
    if (endedAt >= todayStart) bump(todayAcc, minutes, cost, pieceId);
    else if (endedAt >= yesterdayStart) bump(yesterdayAcc, minutes, cost, pieceId);
    if (endedAt >= sevenDaysStart) bump(sevenDayAcc, minutes, cost, pieceId);
    if (endedAt >= monthStart) bump(monthAcc, minutes, cost, pieceId);
  }

  // Karigar summary is ALL-TIME (not period-scoped), per spec — needs its
  // own full scan since the window above only covers the current month.
  const allSessionsSnap = await db.collection("pieceWorkSessions").get();
  type KarigarAcc = {
    karigarId: string; name: string; minutes: number; cost: number;
    pieces: Set<string>; reworkPieces: Set<string>; firstStart: string | null; lastEnd: string | null;
  };
  const karigarAcc = new Map<string, KarigarAcc>();
  for (const s of allSessionsSnap.docs) {
    const v = s.data();
    const karigarId = String(v.karigarId || "");
    if (!karigarId) continue;
    let k = karigarAcc.get(karigarId);
    if (!k) {
      k = { karigarId, name: String(v.karigarName || karigarId), minutes: 0, cost: 0, pieces: new Set(), reworkPieces: new Set(), firstStart: null, lastEnd: null };
      karigarAcc.set(karigarId, k);
    }
    const pieceId = String(v.pieceId || "");
    if (pieceId) {
      k.pieces.add(pieceId);
      if (String(v.type || "FIRST") === "REWORK") k.reworkPieces.add(pieceId);
    }
    const startedAt = String(v.startedAt || "");
    const endedAt = String(v.endedAt || "");
    if (endedAt) {
      k.minutes += Number(v.minutes) || 0;
      k.cost += Number(v.labourCost) || 0;
      if (!k.lastEnd || endedAt > k.lastEnd) k.lastEnd = endedAt;
    }
    if (startedAt && (!k.firstStart || startedAt < k.firstStart)) k.firstStart = startedAt;
  }
  const karigars = Array.from(karigarAcc.values())
    .map((k) => ({
      karigarId: k.karigarId,
      name: k.name,
      piecesWorked: k.pieces.size,
      totalMinutes: k.minutes,
      totalLabourCost: Math.round(k.cost * 100) / 100,
      firstStartAt: k.firstStart,
      lastEndAt: k.lastEnd,
      avgMinutesPerPiece: k.pieces.size > 0 ? Math.round((k.minutes / k.pieces.size) * 10) / 10 : 0,
      reworkPieces: k.reworkPieces.size,
    }))
    .sort((a, b) => b.totalLabourCost - a.totalLabourCost);

  // Production performance — "completed" = STORE_OUT (genuinely delivered,
  // matching maybeCompletePr's own definition of completion).
  const piecesSnap = await db.collection("pieces").get();
  let completedToday = 0, completedYesterday = 0, completedSevenDay = 0, completedMonth = 0;
  let reworkCount = 0, rejectCount = 0, totalCostForAvg = 0, piecesWithCost = 0;
  for (const p of piecesSnap.docs) {
    const v = p.data();
    const stage = String(v.stage || "OPEN");
    if (stage === "REJECTED") rejectCount += 1;
    if ((Number(v.reworkCount) || 0) > 0) reworkCount += 1;
    const cost = Number(v.totalLabourCost) || 0;
    if (cost > 0) { totalCostForAvg += cost; piecesWithCost += 1; }
    if (stage === "STORE_OUT") {
      const storeOutAt = String(v.storeOutAt || "");
      if (storeOutAt) {
        if (storeOutAt >= todayStart) completedToday += 1;
        else if (storeOutAt >= yesterdayStart) completedYesterday += 1;
        if (storeOutAt >= sevenDaysStart) completedSevenDay += 1;
        if (storeOutAt >= monthStart) completedMonth += 1;
      }
    }
  }

  return {
    ok: true,
    periods: {
      today: toCard(todayAcc),
      yesterday: toCard(yesterdayAcc),
      last7Days: toCard(sevenDayAcc),
      currentMonth: toCard(monthAcc),
    },
    karigars,
    performance: {
      piecesCompletedToday: completedToday,
      piecesCompletedYesterday: completedYesterday,
      piecesCompletedLast7Days: completedSevenDay,
      piecesCompletedCurrentMonth: completedMonth,
      reworkCount,
      rejectCount,
      averageLabourCostPerPiece: piecesWithCost > 0 ? Math.round((totalCostForAvg / piecesWithCost) * 100) / 100 : 0,
    },
  };
});

/* ═══════════════════════════════════════════════════════════════════
 * karigarProductionReport — detailed, per-session rows for the Karigar
 * Production Report (date range + optional single-Karigar filter).
 * Input : { karigarId?: string, startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD" }
 * Output: { ok, rows: [...], totals: {...} }
 * ═══════════════════════════════════════════════════════════════════ */
export const karigarProductionReport = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const actor = await requireStaff(request.auth.uid);
  if (!hasAnyRole(actor, REPORTS_ROLES)) {
    throw new HttpsError("permission-denied", "Owner/Super Admin access required.");
  }
  const { karigarId, startDate, endDate } = (request.data || {}) as {
    karigarId?: string; startDate?: string; endDate?: string;
  };
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!startDate || !endDate || !DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw new HttpsError("invalid-argument", "startDate and endDate (YYYY-MM-DD) are required.");
  }
  const rangeStart = `${startDate}T00:00:00.000Z`;
  const rangeEndExclusive = new Date(new Date(`${endDate}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000).toISOString();

  let q = db.collection("pieceWorkSessions")
    .where("startedAt", ">=", rangeStart)
    .where("startedAt", "<", rangeEndExclusive)
    .orderBy("startedAt", "asc");
  if (karigarId) {
    // Matches the EXISTING pieceWorkSessions(karigarId ASC, startedAt ASC)
    // composite index already in firestore.indexes.loom.json — no new index
    // required for the filtered (single-Karigar) path.
    q = db.collection("pieceWorkSessions")
      .where("karigarId", "==", karigarId)
      .where("startedAt", ">=", rangeStart)
      .where("startedAt", "<", rangeEndExclusive)
      .orderBy("startedAt", "asc");
  }
  const snap = await q.get();

  const designIds = new Set<string>();
  const rows = snap.docs.map((d) => {
    const v = d.data();
    if (v.designId) designIds.add(String(v.designId));
    return {
      sessionId: d.id,
      karigarId: String(v.karigarId || ""),
      karigarName: String(v.karigarName || ""),
      pieceId: String(v.pieceId || ""),
      designId: v.designId ? String(v.designId) : null,
      type: String(v.type || "FIRST"),
      startedAt: String(v.startedAt || ""),
      endedAt: v.endedAt ? String(v.endedAt) : null,
      minutes: Number(v.minutes) || 0,
      hourlyRate: Number(v.hourlyRate) || 0,
      labourCost: Number(v.labourCost) || 0,
    };
  }).filter((r) => r.endedAt); // only completed sessions belong in a cost report

  // Small, bounded lookup for design display names (only the designIds that
  // actually appear in this result set — never a full collection scan).
  const designNames = new Map<string, string>();
  await Promise.all(Array.from(designIds).map(async (id) => {
    const s = await db.doc(`catalogueDesigns/${id}`).get();
    if (s.exists) designNames.set(id, String(s.data()!.name || id));
  }));
  const rowsWithDesignName = rows.map((r) => ({ ...r, designName: r.designId ? (designNames.get(r.designId) || r.designId) : null }));

  const totalPieces = new Set(rows.map((r) => r.pieceId)).size;
  const totalMinutes = rows.reduce((s, r) => s + r.minutes, 0);
  const totalLabourCost = Math.round(rows.reduce((s, r) => s + r.labourCost, 0) * 100) / 100;
  const reworkPieces = new Set(rows.filter((r) => r.type === "REWORK").map((r) => r.pieceId)).size;

  const byDate = new Map<string, { minutes: number; cost: number; pieces: Set<string> }>();
  for (const r of rows) {
    const date = r.startedAt.slice(0, 10);
    const d = byDate.get(date) || { minutes: 0, cost: 0, pieces: new Set<string>() };
    d.minutes += r.minutes; d.cost += r.labourCost; if (r.pieceId) d.pieces.add(r.pieceId);
    byDate.set(date, d);
  }
  const dailyTotals = Array.from(byDate.entries())
    .map(([date, d]) => ({ date, totalMinutes: d.minutes, totalLabourCost: Math.round(d.cost * 100) / 100, pieceCount: d.pieces.size }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    ok: true,
    rows: rowsWithDesignName,
    dailyTotals,
    totals: {
      totalPieces,
      totalMinutes,
      totalLabourCost,
      reworkPieces,
      averageMinutesPerPiece: totalPieces > 0 ? Math.round((totalMinutes / totalPieces) * 10) / 10 : 0,
    },
  };
});
