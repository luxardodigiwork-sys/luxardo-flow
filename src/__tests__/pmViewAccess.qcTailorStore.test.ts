/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — PM view-access fix for Guard QC / Tailor / Store
 * workspaces, PLUS the store-role regression fix, per the Final V1 Role
 * Matrix (rolePermissions.ts MATRIX).
 *
 * Confirms:
 *  1. pm now has READ/VIEW access to the 3 modules the matrix always listed
 *     it under (production.qc / production.tailor / production.store) —
 *     this is the page-level gate GuardQcWorkspacePage / TailorWorkspacePage
 *     / StoreWorkspacePage now check, instead of the strict perform-only
 *     permission they used to gate the whole page on.
 *  2. pm is STILL denied every actual perform-action permission for those
 *     3 areas (qc.perform, tailor.startComplete, store.out, store.out.issue)
 *     — this fix only ever widens VIEW access, never a write/action grant.
 *  3. Dispatch and Tailor Requests are completely untouched — pm has no
 *     view or action access to either, exactly as before this fix.
 *  4. The roles that DO perform each action are unaffected (guard/tailor/
 *     store/dispatch still work exactly as before).
 *  5. REGRESSION FIX: the actual 'store' role — omitted from the original
 *     production.store VIEW list, which locked it out of its own
 *     StoreWorkspacePage once the page gate switched from
 *     store.out/store.out.issue to the broader view permission — now has
 *     production.store view access too, alongside pm, with zero change to
 *     its own store.out/store.out.issue action permissions.
 *
 * can()/MATRIX are pure, dependency-free functions — runs directly via tsx,
 * same convention as rolePermissions.med5.test.ts.
 *
 * Run (from repo root):
 *   npx tsx src/__tests__/pmViewAccess.qcTailorStore.test.ts
 */
import { can } from "../utils/rolePermissions";

let pass = true;
const fail = (msg: string) => {
  console.error(`FAIL: ${msg}`);
  pass = false;
};
const check = (label: string, actual: boolean, expected: boolean) => {
  if (actual !== expected) {
    fail(`${label}: expected ${expected}, got ${actual}`);
  } else {
    console.log(`OK  ${label} -> ${actual}`);
  }
};

// ── 1. pm now has VIEW access to the 3 fixed modules ───────────────────────
check('pm can VIEW "production.qc"', can("pm", "production.qc" as any), true);
check('pm can VIEW "production.tailor"', can("pm", "production.tailor" as any), true);
check('pm can VIEW "production.store"', can("pm", "production.store" as any), true);

// ── 2. pm is STILL denied every actual perform/action permission ──────────
check('pm still denied "production.qc.perform"', can("pm", "production.qc.perform" as any), false);
check('pm still denied "production.tailor.startComplete"', can("pm", "production.tailor.startComplete" as any), false);
check('pm still denied "production.store.out"', can("pm", "production.store.out" as any), false);
check('pm still denied "production.store.out.issue"', can("pm", "production.store.out.issue" as any), false);

// ── 3. Dispatch and Tailor Requests completely untouched for pm ───────────
check('pm still denied "production.dispatch.assignTailor" (untouched)', can("pm", "production.dispatch.assignTailor" as any), false);
check('pm still denied "production.dispatch.sendToStore" (untouched)', can("pm", "production.dispatch.sendToStore" as any), false);
check('pm still denied "production.tailorRequests" (untouched — no broad view either)', can("pm", "production.tailorRequests" as any), false);
check('pm still denied "production.tailorRequests.raise" (untouched)', can("pm", "production.tailorRequests.raise" as any), false);
check('pm still denied "production.tailorRequests.review" (untouched)', can("pm", "production.tailorRequests.review" as any), false);

// ── 4. The actual performing roles are unaffected by this change ──────────
check('guard still allowed "production.qc.perform" (unaffected)', can("guard", "production.qc.perform" as any), true);
check('tailor still allowed "production.tailor.startComplete" (unaffected)', can("tailor", "production.tailor.startComplete" as any), true);
check('store still allowed "production.store.out" (unaffected)', can("store", "production.store.out" as any), true);
check('store still allowed "production.store.out.issue" (unaffected)', can("store", "production.store.out.issue" as any), true);
check('dispatch still allowed "production.dispatch.assignTailor" (unaffected)', can("dispatch", "production.dispatch.assignTailor" as any), true);
check('dispatch still allowed "production.tailorRequests" (view, unaffected)', can("dispatch", "production.tailorRequests" as any), true);
check('owner still allowed "production.tailorRequests.review" (unaffected)', can("owner", "production.tailorRequests.review" as any), true);

// ── 5. REGRESSION FIX: store role can now view its own workspace ──────────
check('store can now VIEW "production.store" (regression fix)', can("store", "production.store" as any), true);
check('pm can still VIEW "production.store" (unaffected by the fix)', can("pm", "production.store" as any), true);
check('store can perform "production.store.out" (unaffected by the fix)', can("store", "production.store.out" as any), true);
check('store can perform "production.store.out.issue" (unaffected by the fix)', can("store", "production.store.out.issue" as any), true);
check('pm still denied "production.store.out" (view != perform)', can("pm", "production.store.out" as any), false);
check('pm still denied "production.store.out.issue" (view != perform)', can("pm", "production.store.out.issue" as any), false);
// Negative checks — the fix must be surgical: no OTHER role gained
// production.store view access as a side effect.
check('guard still denied "production.store" (no accidental grant)', can("guard", "production.store" as any), false);
check('tailor still denied "production.store" (no accidental grant)', can("tailor", "production.store" as any), false);
check('accounts still denied "production.store" (no accidental grant)', can("accounts", "production.store" as any), false);
check('analysis still denied "production.store" (no accidental grant)', can("analysis", "production.store" as any), false);
check('designer still allowed "production.store" (pre-existing, unaffected)', can("designer", "production.store" as any), true);
check('dispatch still allowed "production.store" (pre-existing, unaffected)', can("dispatch", "production.store" as any), true);

if (!pass) {
  console.error("PM VIEW-ACCESS FIX REGRESSION TEST: FAIL");
  process.exitCode = 1;
} else {
  console.log(
    "PM VIEW-ACCESS FIX REGRESSION TEST: PASS — pm now has read/view access " +
    "to Guard QC, Tailor and Store per the Final V1 Role Matrix, still has " +
    "zero perform/action permission on any of the 3, Dispatch and Tailor " +
    "Requests are completely unchanged, and every performing role's own " +
    "permission is unaffected."
  );
}
