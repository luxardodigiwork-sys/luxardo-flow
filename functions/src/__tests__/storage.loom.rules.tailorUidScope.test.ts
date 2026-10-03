/* eslint-disable */
/**
 * FOCUSED RULES REGRESSION TEST — SEC-1 (storage.loom.rules: a broad
 * `/production/tailor/{p=**}` write grant to any 'tailor'-role staff member
 * bypassed the narrower uid-scoped `/production/tailor/{uid}/{p=**}` rule
 * beneath it, since Storage security rules are evaluated as a union across
 * every matching `match` block — any ONE matching block that allows the
 * request is enough, regardless of how restrictive sibling blocks are).
 *
 * Concretely: Tailor A (staffRole 'tailor') could upload into Tailor B's own
 * uid folder (production/tailor/<tailorB_uid>/...) because the broad block
 * only checked staffRole() in ['tailor'], never the uid segment. Fixed by
 * making the broad block admin-only (matching storage.rules:38's existing
 * B2C precedent); plain tailor-role writes now succeed ONLY through the
 * uid-scoped block.
 *
 * Uses @firebase/rules-unit-testing against the REAL Firestore + Storage
 * emulators together (not a mock) — storage.loom.rules' isStaffInRoles()
 * depends on a cross-service `firestore.get(/databases/(default)/documents/
 * staff/$(uid))` lookup, so both emulators must be seeded and running for
 * this to exercise the actual rules engine, not an approximation of it.
 *
 * Not wired into any test runner (the repo has none yet) — a standalone,
 * emulator-only script, same family as storage.rules.med4.test.ts and
 * firestore.rules.high3.test.ts. NOT exported from functions/src/index.ts.
 *
 * Scenarios (against the CURRENT, post-SEC-1-fix storage.loom.rules):
 *   1. Tailor A uploads a valid image into THEIR OWN uid folder -> succeeds
 *      (legitimate Tailor Workspace flow must keep working).
 *   2. Tailor A uploads into Tailor B's uid folder -> DENIED (the core fix —
 *      previously this succeeded via the broad rule's role-only check).
 *   3. Tailor A uploads directly under production/tailor/ with NO uid
 *      segment (the broad path with no sub-folder) -> DENIED (tailors have
 *      no grant on the broad path anymore; admin-only).
 *   4. Admin uploads under production/tailor/ with no uid segment -> still
 *      succeeds (admin's broad-path access is unchanged by this fix).
 *   5. Tailor A reads Tailor B's uid folder -> still succeeds (read access
 *      for any signed-in staff is unchanged — this fix is write-only).
 *
 * MUST be run against the Firestore + Storage emulators only — refuses to
 * run if either FIRESTORE_EMULATOR_HOST or FIREBASE_STORAGE_EMULATOR_HOST is
 * not set, so it can never touch a real project.
 *
 * Run (from repo root, both emulators via firebase.e2e.json which already
 * wires firestore.loom.rules + storage.loom.rules together):
 *   (cd functions && npm run build)
 *   firebase emulators:exec --config firebase.e2e.json \
 *     --only firestore,storage,auth --project demo-luxardo-test \
 *     "node functions/lib/__tests__/storage.loom.rules.tailorUidScope.test.js"
 */
import * as fs from "fs";
import * as path from "path";

async function main(): Promise<void> {
  const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
  const storageHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  if (!firestoreHost) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set — refusing to run against a real " +
      "project. Run via `firebase emulators:exec --only firestore,storage,auth ...`."
    );
  }
  if (!storageHost) {
    throw new Error(
      "FIREBASE_STORAGE_EMULATOR_HOST is not set — refusing to run against a " +
      "real project. Run via `firebase emulators:exec --only firestore,storage,auth ...`."
    );
  }
  const [fsHost, fsPortStr] = firestoreHost.split(":");
  const fsPort = Number(fsPortStr);
  const [stHost, stPortStr] = storageHost.split(":");
  const stPort = Number(stPortStr);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ref, uploadBytes, getBytes } = require("firebase/storage");

  const storageRulesPath = path.join(__dirname, "..", "..", "..", "storage.loom.rules");
  const storageRules = fs.readFileSync(storageRulesPath, "utf8");
  const firestoreRulesPath = path.join(__dirname, "..", "..", "..", "firestore.loom.rules");
  const firestoreRules = fs.readFileSync(firestoreRulesPath, "utf8");

  const testEnv = await initializeTestEnvironment({
    projectId: "demo-luxardo-sec1-test",
    firestore: { rules: firestoreRules, host: fsHost, port: fsPort },
    storage: { rules: storageRules, host: stHost, port: stPort },
  });

  let pass = true;
  const fail = (msg: string) => {
    console.error(`FAIL: ${msg}`);
    pass = false;
  };

  const tailorAUid = "sec1-tailor-a";
  const tailorBUid = "sec1-tailor-b";
  const adminUid = "sec1-admin";
  const smallImage = new Uint8Array([1, 2, 3, 4, 5]);

  try {
    await testEnv.clearFirestore();

    // Seed staff identity docs (bypassing rules — fixture setup).
    await testEnv.withSecurityRulesDisabled(async (ctx: any) => {
      await ctx.firestore().doc(`staff/${tailorAUid}`).set({ role: "tailor", active: true, displayName: "Tailor A" });
      await ctx.firestore().doc(`staff/${tailorBUid}`).set({ role: "tailor", active: true, displayName: "Tailor B" });
      await ctx.firestore().doc(`staff/${adminUid}`).set({ role: "admin", active: true, displayName: "Admin" });
    });

    const tailorACtx = testEnv.authenticatedContext(tailorAUid);
    // Admin via the custom-claim path (request.auth.token.admin), the same
    // convention storage.rules.med4.test.ts already uses — isAdmin() in
    // storage.loom.rules accepts either this OR the staff-doc role lookup,
    // and this test only needs to exercise the broad path's admin grant,
    // not re-verify the cross-service Firestore lookup covered by the
    // tailor-role scenarios above.
    const adminCtx = testEnv.authenticatedContext(adminUid, { admin: true });

    // ── Scenario 1: Tailor A -> own uid folder succeeds ───────────────────
    try {
      await assertSucceeds(
        uploadBytes(ref(tailorACtx.storage(), `production/tailor/${tailorAUid}/piece-1/photo.jpg`), smallImage, { contentType: "image/jpeg" })
      );
      console.log("[1] Tailor A upload into OWN uid folder correctly ALLOWED.");
    } catch (err: any) {
      fail(`[1] expected Tailor A's own-folder upload to succeed: ${err?.message ?? err}`);
    }

    // ── Scenario 2: Tailor A -> Tailor B's uid folder DENIED (the fix) ────
    try {
      await assertFails(
        uploadBytes(ref(tailorACtx.storage(), `production/tailor/${tailorBUid}/piece-2/photo.jpg`), smallImage, { contentType: "image/jpeg" })
      );
      console.log("[2] Tailor A upload into Tailor B's uid folder correctly DENIED (previously allowed by the broad rule).");
    } catch (err: any) {
      fail(`[2] expected Tailor A writing into Tailor B's folder to be denied: ${err?.message ?? err}`);
    }

    // ── Scenario 3: Tailor A -> no-uid broad path DENIED ──────────────────
    try {
      await assertFails(
        uploadBytes(ref(tailorACtx.storage(), "production/tailor/loose-file.jpg"), smallImage, { contentType: "image/jpeg" })
      );
      console.log("[3] Tailor A upload directly under production/tailor/ (no uid segment) correctly DENIED.");
    } catch (err: any) {
      fail(`[3] expected a tailor's no-uid-segment upload to be denied: ${err?.message ?? err}`);
    }

    // ── Scenario 4: Admin -> no-uid broad path still succeeds ─────────────
    try {
      await assertSucceeds(
        uploadBytes(ref(adminCtx.storage(), "production/tailor/admin-file.jpg"), smallImage, { contentType: "image/jpeg" })
      );
      console.log("[4] Admin upload directly under production/tailor/ correctly still ALLOWED.");
    } catch (err: any) {
      fail(`[4] expected admin's broad-path upload to remain allowed: ${err?.message ?? err}`);
    }

    // ── Scenario 5: Tailor A can still READ Tailor B's folder (unchanged) ──
    try {
      await testEnv.withSecurityRulesDisabled(async (ctx: any) => {
        const { uploadBytes: adminUpload, ref: adminRef } = require("firebase/storage");
        await adminUpload(adminRef(ctx.storage(), `production/tailor/${tailorBUid}/piece-2/seed.jpg`), smallImage, { contentType: "image/jpeg" });
      });
      await assertSucceeds(getBytes(ref(tailorACtx.storage(), `production/tailor/${tailorBUid}/piece-2/seed.jpg`)));
      console.log("[5] Tailor A read of Tailor B's folder correctly still ALLOWED (read access unchanged by this write-only fix).");
    } catch (err: any) {
      fail(`[5] expected read access to remain unchanged: ${err?.message ?? err}`);
    }
  } finally {
    await testEnv.cleanup();
  }

  if (!pass) {
    console.error("SEC-1 RULES REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log(
    "SEC-1 RULES REGRESSION TEST: PASS — a tailor can no longer write into " +
    "another tailor's uid-scoped storage folder or the no-uid broad path; " +
    "own-folder writes, admin's broad-path access, and read access are all " +
    "unchanged."
  );
}

main().catch((err) => {
  console.error("SEC-1 rules regression test crashed:", err);
  process.exitCode = 1;
});
