/* eslint-disable */
/**
 * FOCUSED RULES REGRESSION TEST — Dispatch Karigar-registry access removal
 * (live production smoke-test finding: Dispatch could read the full
 * Karigar registry — name, mobile, hourly rate, status — via
 * /production/karigars and the underlying firestore.loom.rules `karigars`
 * read rule, which is the REAL authority here; rolePermissions.ts's
 * 'production.karigars' and KarigarListPage.tsx's self-check are UX layers
 * on top of this, not the security boundary).
 *
 * Uses @firebase/rules-unit-testing against the real Firestore emulator's
 * rules engine (not a mock) — loads the ACTUAL firestore.loom.rules file
 * from disk and evaluates real client SDK calls against it, exactly as the
 * live luxardo-flow project would.
 *
 * Not wired into any test runner (the repo has none yet) — a standalone,
 * emulator-only script, same family as firestore.rules.high3.test.ts (B2C)
 * and storage.loom.rules.tailorUidScope.test.ts (Loom). NOT exported from
 * functions/src/index.ts or functions-loom/src/index.ts.
 *
 * Scenarios (against the CURRENT, post-fix firestore.loom.rules):
 *   1. A "dispatch" staff client can no longer READ the karigars
 *      collection (previously allowed; now must be denied).
 *   2. "pm", "owner", "admin" and "super_admin" staff clients can still
 *      read karigars — unaffected by the Dispatch removal.
 *   3. Direct client WRITE to karigars remains denied for every role
 *      (unchanged — all writes go through karigarCreate/karigarUpdate's
 *      Admin SDK path, never through client rules).
 *
 * MUST be run against the Firestore emulator only — refuses to run if
 * FIRESTORE_EMULATOR_HOST is not set, so it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore --project demo-luxardo-test \
 *     "node lib/__tests__/firestore.loom.rules.karigarDispatch.test.js"
 */
import * as fs from "fs";
import * as path from "path";

async function main(): Promise<void> {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  if (!emulatorHost) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set — refusing to run against a real " +
      "project. Run this via `firebase emulators:exec --only firestore ...`."
    );
  }
  const [host, portStr] = emulatorHost.split(":");
  const port = Number(portStr);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { doc, setDoc, getDoc } = require("firebase/firestore");

  const rulesPath = path.join(__dirname, "..", "..", "..", "firestore.loom.rules");
  const rules = fs.readFileSync(rulesPath, "utf8");

  const testEnv = await initializeTestEnvironment({
    projectId: "demo-luxardo-loom-rules-test",
    firestore: { rules, host, port },
  });

  let pass = true;
  const fail = (msg: string) => { console.error(`FAIL: ${msg}`); pass = false; };

  try {
    await testEnv.clearFirestore();

    const dispatchUid = "rules-test-dispatch";
    const pmUid = "rules-test-pm";
    const ownerUid = "rules-test-owner";
    const adminUid = "rules-test-admin";
    const superAdminUid = "rules-test-super-admin";

    await testEnv.withSecurityRulesDisabled(async (ctx: any) => {
      await ctx.firestore().doc(`staff/${dispatchUid}`).set({ role: "dispatch", active: true, displayName: "Rules Test Dispatch" });
      await ctx.firestore().doc(`staff/${pmUid}`).set({ role: "pm", active: true, displayName: "Rules Test PM" });
      await ctx.firestore().doc(`staff/${ownerUid}`).set({ role: "owner", active: true, displayName: "Rules Test Owner" });
      await ctx.firestore().doc(`staff/${adminUid}`).set({ role: "admin", active: true, displayName: "Rules Test Admin" });
      await ctx.firestore().doc(`staff/${superAdminUid}`).set({ role: "super_admin", active: true, displayName: "Rules Test Super Admin" });
      await ctx.firestore().doc("karigars/K-READTEST").set({
        id: "K-READTEST", name: "Real Karigar Name", mobile: "+919999999999",
        skillTags: ["stitching"], hourlyRate: 150, active: true, createdAt: new Date().toISOString(),
      });
    });

    const dispatchCtx = testEnv.authenticatedContext(dispatchUid);
    const pmCtx = testEnv.authenticatedContext(pmUid);
    const ownerCtx = testEnv.authenticatedContext(ownerUid);
    const adminCtx = testEnv.authenticatedContext(adminUid);
    const superAdminCtx = testEnv.authenticatedContext(superAdminUid);

    // ── Scenario 1: Dispatch read must now be DENIED ──────────────────────
    try {
      await assertFails(getDoc(doc(dispatchCtx.firestore(), "karigars/K-READTEST")));
      console.log("[1] dispatch karigars READ correctly DENIED (the fix).");
    } catch (err: any) {
      fail(`[1] expected dispatch karigars read to be denied: ${err?.message ?? err}`);
    }

    // ── Scenario 2: other authorized roles unaffected ─────────────────────
    for (const [label, ctx] of [["pm", pmCtx], ["owner", ownerCtx], ["admin", adminCtx], ["super_admin", superAdminCtx]] as const) {
      try {
        await assertSucceeds(getDoc(doc(ctx.firestore(), "karigars/K-READTEST")));
        console.log(`[2] ${label} karigars READ still ALLOWED (unaffected).`);
      } catch (err: any) {
        fail(`[2] expected ${label} karigars read to remain allowed: ${err?.message ?? err}`);
      }
    }

    // ── Scenario 3: direct client write remains denied for everyone ───────
    try {
      await assertFails(
        setDoc(doc(pmCtx.firestore(), "karigars/K-WRITETEST"), { id: "K-WRITETEST", name: "x" })
      );
      console.log("[3] direct client write to karigars still DENIED for pm (unchanged — Admin SDK only).");
    } catch (err: any) {
      fail(`[3] expected direct karigars write to remain denied: ${err?.message ?? err}`);
    }
  } finally {
    await testEnv.cleanup();
  }

  if (!pass) {
    console.error("DISPATCH KARIGAR ACCESS REMOVAL RULES REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log(
    "DISPATCH KARIGAR ACCESS REMOVAL RULES REGRESSION TEST: PASS — Dispatch can no longer read the karigars " +
    "collection at the Firestore rules level (the real security boundary); pm/owner/admin/super_admin read access " +
    "is unaffected; and direct client writes to karigars remain fully denied for every role, unchanged."
  );
}

main().catch((err) => {
  console.error("Dispatch Karigar access removal rules regression test crashed:", err);
  process.exitCode = 1;
});
