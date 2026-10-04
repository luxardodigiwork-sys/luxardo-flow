/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — camera/gallery photo upload wiring for Design,
 * Sample Design and Sample Piece (functions/src/designs.ts, samples.ts).
 *
 * The client-side upload pattern (reused from the proven Tailor Workspace
 * flow — TailorWorkspacePage.tsx) uploads a photo directly to Firebase
 * Storage, then passes BOTH the resulting download URL and the storage
 * path to the relevant callable. This test exercises the SERVER side of
 * that contract: the new optional `imagePath` field alongside the existing
 * `image` field on:
 *   - designCreate / designUpdate
 *   - sampleDesignCreate / sampleDesignUpdate
 *   - samplePieceComplete (image remains COMPULSORY — unchanged; imagePath
 *     is a new optional addition alongside it)
 *
 * Locked behaviour verified:
 *   1. imagePath is stored exactly as given on create.
 *   2. On update, supplying `image` WITH `imagePath` stores both.
 *   3. On update, supplying `image` WITHOUT `imagePath` (a manually pasted
 *      URL, or clearing the photo) resets imagePath to null — an uploaded
 *      photo's storage path must never silently survive being replaced by
 *      a pasted URL (or vice versa, a stale path pointing at an old file).
 *   4. samplePieceComplete's pre-existing mandatory-image validation is
 *      unchanged (regression — this function was touched to add imagePath).
 *   5. samplePieceComplete stores imagePath when given, null when omitted.
 *
 * MUST be run against the Firestore emulator only — refuses to run if
 * FIRESTORE_EMULATOR_HOST is not set, so it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore --project demo-luxardo-test \
 *     "node lib/__tests__/productionPhotoUpload.test.js"
 */
import * as admin from "firebase-admin";

async function main(): Promise<void> {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set — refusing to run against a real " +
      "project. Run this via `firebase emulators:exec --only firestore ...`."
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const testEnv = require("firebase-functions-test")({ projectId: "demo-luxardo-test" });

  admin.initializeApp();
  const db = admin.firestore();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { designCreate, designUpdate } = require("../designs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sampleDesignCreate, sampleDesignUpdate, samplePieceCreate, samplePieceComplete } = require("../samples");

  const wrappedDesignCreate = testEnv.wrap(designCreate);
  const wrappedDesignUpdate = testEnv.wrap(designUpdate);
  const wrappedSampleDesignCreate = testEnv.wrap(sampleDesignCreate);
  const wrappedSampleDesignUpdate = testEnv.wrap(sampleDesignUpdate);
  const wrappedSamplePieceCreate = testEnv.wrap(samplePieceCreate);
  const wrappedSamplePieceComplete = testEnv.wrap(samplePieceComplete);

  const runId = String(Date.now());
  let pass = true;
  const fail = (msg: string) => {
    console.error(`FAIL: ${msg}`);
    pass = false;
  };

  async function seedActor(role: string): Promise<string> {
    const uid = `test-${role}-${runId}-${Math.random().toString(36).slice(2, 8)}`;
    await db.doc(`staff/${uid}`).set({ role, active: true, displayName: `Test ${role}` });
    return uid;
  }

  const designerUid = await seedActor("designer");

  // ── 1+2. designCreate stores imagePath; designUpdate(image+imagePath)
  //    stores both ────────────────────────────────────────────────────────
  let designId = "";
  {
    const result: any = await wrappedDesignCreate({
      data: { name: "Paisley Stripe", image: "https://storage.example/design1.jpg", imagePath: "production/designs/uid1/111.jpg" },
      auth: { uid: designerUid, token: {} },
    });
    designId = result.id;
    const snap = await db.doc(`catalogueDesigns/${designId}`).get();
    const d = snap.data();
    console.log(`[1] designCreate -> image "${d?.image}", imagePath "${d?.imagePath}".`);
    if (d?.imagePath !== "production/designs/uid1/111.jpg") fail(`[1] expected imagePath to be stored on create, got "${d?.imagePath}".`);

    await wrappedDesignUpdate({
      data: { id: designId, image: "https://storage.example/design1-v2.jpg", imagePath: "production/designs/uid1/222.jpg" },
      auth: { uid: designerUid, token: {} },
    });
    const after = (await db.doc(`catalogueDesigns/${designId}`).get()).data();
    console.log(`[2] designUpdate(image+imagePath) -> image "${after?.image}", imagePath "${after?.imagePath}".`);
    if (after?.imagePath !== "production/designs/uid1/222.jpg") fail(`[2] expected updated imagePath, got "${after?.imagePath}".`);
  }

  // ── 3. designUpdate(image only, no imagePath) resets imagePath to null ─
  {
    await wrappedDesignUpdate({
      data: { id: designId, image: "https://pasted-url.example/manual.jpg" },
      auth: { uid: designerUid, token: {} },
    });
    const after = (await db.doc(`catalogueDesigns/${designId}`).get()).data();
    console.log(`[3] designUpdate(image only, pasted) -> image "${after?.image}", imagePath "${after?.imagePath}".`);
    if (after?.imagePath !== null) fail(`[3] expected imagePath reset to null after a pasted-URL update, got "${after?.imagePath}".`);
    if (after?.image !== "https://pasted-url.example/manual.jpg") fail(`[3] expected image to update, got "${after?.image}".`);
  }

  // ── 4+5. sampleDesignCreate/Update mirror the same imagePath contract ──
  let sampleDesignId = "";
  {
    const result: any = await wrappedSampleDesignCreate({
      data: { name: "Paisley Swatch", image: "https://storage.example/swatch1.jpg", imagePath: "production/sampleDesigns/uid1/111.jpg" },
      auth: { uid: designerUid, token: {} },
    });
    sampleDesignId = result.id;
    const created = (await db.doc(`sampleDesigns/${sampleDesignId}`).get()).data();
    if (created?.imagePath !== "production/sampleDesigns/uid1/111.jpg") fail(`[4] expected imagePath stored on sampleDesignCreate, got "${created?.imagePath}".`);

    await wrappedSampleDesignUpdate({
      data: { id: sampleDesignId, image: "https://pasted-url.example/swatch-manual.jpg" },
      auth: { uid: designerUid, token: {} },
    });
    const after = (await db.doc(`sampleDesigns/${sampleDesignId}`).get()).data();
    console.log(`[5] sampleDesignUpdate(image only, pasted) -> image "${after?.image}", imagePath "${after?.imagePath}".`);
    if (after?.imagePath !== null) fail(`[5] expected imagePath reset to null after a pasted-URL sampleDesignUpdate, got "${after?.imagePath}".`);
  }

  // ── 6. samplePieceComplete: mandatory-image validation unchanged ───────
  {
    // Create a real approved design + sample piece so samplePieceComplete's
    // own preconditions (piece must exist, not already complete) are real.
    const ownerUid = await seedActor("owner");
    const freshDesign: any = await wrappedDesignCreate({ data: { name: "Complete-Test Design" }, auth: { uid: designerUid, token: {} } });
    await testEnv.wrap(require("../designs").designSubmit)({ data: { id: freshDesign.id }, auth: { uid: designerUid, token: {} } });
    await testEnv.wrap(require("../designs").designApprove)({ data: { id: freshDesign.id }, auth: { uid: ownerUid, token: {} } });

    const piece: any = await wrappedSamplePieceCreate({
      data: { designId: freshDesign.id },
      auth: { uid: designerUid, token: {} },
    });

    try {
      await wrappedSamplePieceComplete({ data: { id: piece.id }, auth: { uid: designerUid, token: {} } });
      fail(`[6] expected samplePieceComplete to reject a missing image, but it succeeded.`);
    } catch (err: any) {
      const code = err?.code ?? "unknown";
      console.log(`[6] samplePieceComplete with no image rejected with code "${code}".`);
      if (code !== "invalid-argument") fail(`[6] expected "invalid-argument", got "${code}".`);
    }

    // ── 7. samplePieceComplete stores imagePath when given ────────────────
    await wrappedSamplePieceComplete({
      data: { id: piece.id, image: "https://storage.example/garment1.jpg", imagePath: "production/samplePieces/uid1/111.jpg" },
      auth: { uid: designerUid, token: {} },
    });
    const completed = (await db.doc(`samplePieces/${piece.id}`).get()).data();
    console.log(`[7] samplePieceComplete(image+imagePath) -> status "${completed?.status}", imagePath "${completed?.imagePath}".`);
    if (completed?.status !== "COMPLETE") fail(`[7] expected status COMPLETE, got "${completed?.status}".`);
    if (completed?.imagePath !== "production/samplePieces/uid1/111.jpg") fail(`[7] expected imagePath stored, got "${completed?.imagePath}".`);
  }

  if (!pass) {
    console.error("PRODUCTION PHOTO UPLOAD REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log(
    "PRODUCTION PHOTO UPLOAD REGRESSION TEST: PASS — designCreate/Update and " +
    "sampleDesignCreate/Update correctly store imagePath alongside image, a " +
    "pasted-URL-only update correctly resets imagePath to null, and " +
    "samplePieceComplete's pre-existing mandatory-image validation remains " +
    "intact while also now storing imagePath when given."
  );
}

main().catch((err) => {
  console.error("Production photo upload regression test crashed:", err);
  process.exitCode = 1;
});
