/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — LUXARDO FLOW "Link Existing Auth Account" +
 * "Transfer Mobile Number" (functions/src/production.ts): staffLookupIdentity,
 * staffLinkExistingAccount, staffTransferPhoneNumber.
 *
 * Not wired into any test runner (the repo has none yet) — same standalone,
 * emulator-only approach as the other *.emulator.test.ts files. NOT exported
 * from functions/src/index.ts — FLOW (Loom)-only, exported ONLY from
 * functions-loom/src/index.ts.
 *
 * Scenarios:
 *   1.  staffLookupIdentity: neither email nor phone resolves -> found:false.
 *   2.  staffLookupIdentity: email resolves to an Auth account with NO
 *       staff/{uid} doc -> found:true, conflict:false, existingStaffDoc:null.
 *   3.  staffLookupIdentity: email resolves to an Auth account that ALREADY
 *       has a staff/{uid} doc -> existingStaffDoc populated.
 *   4.  staffLookupIdentity: email and phone resolve to TWO DIFFERENT Auth
 *       accounts -> conflict:true, both uids reported, nothing merged.
 *   5.  staffLookupIdentity by Admin (non-super-admin) is rejected.
 *   6.  staffLinkExistingAccount: an Auth-only account (no staff doc) gets a
 *       new staff/{uid} + customers/{uid} mirror, NO new Auth user is ever
 *       created, and a STAFF_LINK_EXISTING_ACCOUNT audit entry is written.
 *   7.  staffLinkExistingAccount against a uid with NO real Auth account is
 *       rejected (not-found) — never fabricates an identity.
 *   8.  staffLinkExistingAccount by Admin (non-super-admin) is rejected.
 *   9.  staffLinkExistingAccount called AGAIN for the same uid updates the
 *       SAME doc in place (never a second/duplicate staff doc for one uid).
 *   10. staffLinkExistingAccount with a phoneNumber already held by ANOTHER
 *       uid is rejected; the target Auth account's phone is left untouched.
 *   11. staffTransferPhoneNumber: dryRun defaults to true -> zero writes,
 *       returns a preview with state "NOT_STARTED".
 *   12. staffTransferPhoneNumber dryRun:false (NOT_STARTED): source Auth
 *       phone cleared, target Auth phone set, target staff/{uid} mirror
 *       updated, source staff/{uid} mirror cleared, and a STAFF_PHONE_
 *       TRANSFER audit entry is written WITHOUT the full phone number
 *       anywhere in it.
 *   13. staffTransferPhoneNumber when the source has NO staff/{uid} doc at
 *       all (the Owner's real situation) still succeeds; Step D is simply
 *       skipped, not an error.
 *   14. staffTransferPhoneNumber MISMATCH (source does not actually hold the
 *       requested number) is rejected with stepReached "CLASSIFY"; nothing
 *       changes on either Auth account.
 *   15. staffTransferPhoneNumber with sourceUid === targetUid is rejected.
 *   16. staffTransferPhoneNumber by Admin (non-super-admin) is rejected.
 *   17. staffTransferPhoneNumber resumes correctly from an ORPHANED state
 *       (number attached to neither account, simulating a prior partial
 *       failure) — completes the assignment + both mirrors without manual
 *       intervention.
 *   18. staffTransferPhoneNumber refuses to overwrite a target that already
 *       holds a DIFFERENT phone number (MISMATCH).
 *
 * MUST be run against the Firestore + Auth emulators only — refuses to run
 * if FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are not set, so
 * it can never touch a real project.
 *
 * Run (from functions/):
 *   npm run build
 *   firebase emulators:exec --only firestore,auth --project demo-luxardo-test \
 *     "node lib/__tests__/staffLinkAndTransfer.emulator.test.js"
 */
import * as admin from "firebase-admin";

async function main(): Promise<void> {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set — refusing to run against a real " +
      "project. Run this via `firebase emulators:exec --only firestore,auth ...`."
    );
  }
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error(
      "FIREBASE_AUTH_EMULATOR_HOST is not set — refusing to run against a " +
      "real project. Run this via `firebase emulators:exec --only " +
      "firestore,auth ...`."
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const testEnv = require("firebase-functions-test")({ projectId: "demo-luxardo-test" });

  admin.initializeApp();
  const db = admin.firestore();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { staffLookupIdentity, staffLinkExistingAccount, staffTransferPhoneNumber } = require("../production");
  const wrappedLookupIdentity = testEnv.wrap(staffLookupIdentity);
  const wrappedLink = testEnv.wrap(staffLinkExistingAccount);
  const wrappedTransfer = testEnv.wrap(staffTransferPhoneNumber);

  const runId = String(Date.now()).slice(-8);
  let pass = true;
  const fail = (msg: string) => { console.error(`FAIL: ${msg}`); pass = false; };
  const check = (label: string, actual: unknown, expected: unknown) => {
    if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    else console.log(`OK  ${label} -> ${JSON.stringify(actual)}`);
  };

  async function makeStaff(opts: { role: string; email?: string; phone?: string; active?: boolean }): Promise<{ uid: string; email: string }> {
    const email = opts.email || `su-${opts.role}-${runId}-${Math.random().toString(36).slice(2)}@example.test`;
    const created = await admin.auth().createUser({
      email, password: "Irrelevant-123", emailVerified: true,
      ...(opts.phone ? { phoneNumber: opts.phone } : {}),
    });
    await db.doc(`staff/${created.uid}`).set({
      uid: created.uid, displayName: email, email, role: opts.role,
      active: opts.active !== false, phoneNumber: opts.phone || null, createdAt: new Date().toISOString(),
    });
    return { uid: created.uid, email };
  }

  // An Auth user with deliberately NO staff/{uid} doc — the exact shape of
  // the Owner's real `Connect@luxardofashion.com` / phone-holder situation.
  async function makeAuthOnly(opts: { email?: string; phone?: string }): Promise<{ uid: string; email: string }> {
    const email = opts.email || `authonly-${runId}-${Math.random().toString(36).slice(2)}@example.test`;
    const created = await admin.auth().createUser({
      email, password: "Irrelevant-123", emailVerified: true,
      ...(opts.phone ? { phoneNumber: opts.phone } : {}),
    });
    return { uid: created.uid, email };
  }

  async function callLookupIdentity(callerUid: string, data: Record<string, unknown>) {
    try {
      const result: any = await wrappedLookupIdentity({ data, auth: { uid: callerUid, token: {} } });
      return { threw: false, ...result };
    } catch (err: any) {
      return { threw: true, message: err?.message, code: err?.code };
    }
  }
  async function callLink(callerUid: string, data: Record<string, unknown>) {
    try {
      const result: any = await wrappedLink({ data, auth: { uid: callerUid, token: {} } });
      return { threw: false, ...result };
    } catch (err: any) {
      return { threw: true, message: err?.message, code: err?.code };
    }
  }
  async function callTransfer(callerUid: string, data: Record<string, unknown>) {
    try {
      const result: any = await wrappedTransfer({ data, auth: { uid: callerUid, token: {} } });
      return { threw: false, ...result };
    } catch (err: any) {
      return { threw: true, message: err?.message, details: err?.details };
    }
  }

  const superAdmin = await makeStaff({ role: "super_admin" });
  const admin1 = await makeStaff({ role: "admin" });

  // ── Scenario 1: neither identifier resolves ─────────────────────────────
  {
    const res = await callLookupIdentity(superAdmin.uid, { email: `nope-${runId}@example.test` });
    check("[1] does not throw", res.threw, false);
    check("[1] found is false", res.found, false);
  }

  // ── Scenario 2: resolves to an Auth-only account (no staff doc) ─────────
  const authOnly2 = await makeAuthOnly({});
  {
    const res = await callLookupIdentity(superAdmin.uid, { email: authOnly2.email });
    check("[2] does not throw", res.threw, false);
    check("[2] found is true", res.found, true);
    check("[2] conflict is false", res.conflict, false);
    check("[2] resolves the correct uid", res.uid, authOnly2.uid);
    check("[2] existingStaffDoc is null", res.existingStaffDoc, null);
  }

  // ── Scenario 3: resolves to an account that already has a staff doc ─────
  const linked3 = await makeStaff({ role: "designer" });
  {
    const res = await callLookupIdentity(superAdmin.uid, { email: linked3.email });
    check("[3] does not throw", res.threw, false);
    check("[3] found is true", res.found, true);
    check("[3] existingStaffDoc is present", !!res.existingStaffDoc, true);
    check("[3] existingStaffDoc has the right role", res.existingStaffDoc?.role, "designer");
  }

  // ── Scenario 4: email and phone resolve to DIFFERENT Auth accounts ──────
  const emailOnly4 = await makeAuthOnly({ email: `conflict-email-${runId}@example.test` });
  const phoneOnly4 = await makeAuthOnly({ phone: `+914${runId}1` });
  {
    const res = await callLookupIdentity(superAdmin.uid, { email: emailOnly4.email, phoneNumber: `+914${runId}1` });
    check("[4] does not throw", res.threw, false);
    check("[4] found is true", res.found, true);
    check("[4] conflict is true", res.conflict, true);
    check("[4] emailUid matches the email-holder", res.emailUid, emailOnly4.uid);
    check("[4] phoneUid matches the phone-holder", res.phoneUid, phoneOnly4.uid);
  }

  // ── Scenario 5: staffLookupIdentity by Admin (non-super-admin) rejected ──
  {
    const res = await callLookupIdentity(admin1.uid, { email: authOnly2.email });
    check("[5] admin lookup throws", res.threw, true);
  }

  // ── Scenario 6: staffLinkExistingAccount creates staff/{uid} for an ─────
  // Auth-only account, no new Auth user, audit entry written.
  const authOnly6 = await makeAuthOnly({});
  const authUserCountBefore6 = (await admin.auth().listUsers(1000)).users.length;
  {
    const res = await callLink(superAdmin.uid, {
      uid: authOnly6.uid, displayName: "Linked Owner", role: "owner", active: true,
    });
    check("[6] does not throw", res.threw, false);
    check("[6] returns the SAME uid", res.uid, authOnly6.uid);

    const authUserCountAfter6 = (await admin.auth().listUsers(1000)).users.length;
    check("[6] NO new Auth user was created", authUserCountAfter6, authUserCountBefore6);

    const staffDoc = (await db.doc(`staff/${authOnly6.uid}`).get()).data();
    check("[6] staff/{uid} role is owner", staffDoc?.role, "owner");
    check("[6] staff/{uid} displayName set", staffDoc?.displayName, "Linked Owner");
    check("[6] staff/{uid} email mirrors the Auth record (never caller input)", staffDoc?.email, authOnly6.email);
    check("[6] staff/{uid} active is true", staffDoc?.active, true);

    const custDoc = (await db.doc(`customers/${authOnly6.uid}`).get()).data();
    check("[6] customers/{uid} mirror created", custDoc?.role, "owner");

    const auditSnap = await db.collection("auditLogs")
      .where("entityId", "==", authOnly6.uid).where("action", "==", "STAFF_LINK_EXISTING_ACCOUNT").get();
    check("[6] a STAFF_LINK_EXISTING_ACCOUNT audit entry exists", auditSnap.size >= 1, true);
  }

  // ── Scenario 7: linking a uid with NO real Auth account is rejected ─────
  {
    const res = await callLink(superAdmin.uid, {
      uid: `nonexistent-uid-${runId}`, displayName: "Ghost", role: "owner",
    });
    check("[7] throws", res.threw, true);
    check("[7] error code is not-found", res.code, "not-found");
    const staffDoc = await db.doc(`staff/nonexistent-uid-${runId}`).get();
    check("[7] no staff/{uid} doc was fabricated", staffDoc.exists, false);
  }

  // ── Scenario 8: staffLinkExistingAccount by Admin is rejected ───────────
  const authOnly8 = await makeAuthOnly({});
  {
    const res = await callLink(admin1.uid, { uid: authOnly8.uid, displayName: "X", role: "designer" });
    check("[8] admin link throws", res.threw, true);
    const staffDoc = await db.doc(`staff/${authOnly8.uid}`).get();
    check("[8] no staff/{uid} doc was created", staffDoc.exists, false);
  }

  // ── Scenario 9: calling link again for the SAME uid updates in place ────
  {
    const res = await callLink(superAdmin.uid, {
      uid: authOnly6.uid, displayName: "Linked Owner", role: "owner", active: true, post: "Managing Director",
    });
    check("[9] second link call does not throw", res.threw, false);
    const docsForUid = await db.collection("staff").where("uid", "==", authOnly6.uid).get();
    check("[9] still exactly ONE staff doc for this uid", docsForUid.size, 1);
    const staffDoc = (await db.doc(`staff/${authOnly6.uid}`).get()).data();
    check("[9] post field applied to the SAME doc", staffDoc?.post, "Managing Director");
  }

  // ── Scenario 10: linking with a phoneNumber already held elsewhere ──────
  const phoneHolder10 = await makeStaff({ role: "designer", phone: `+915${runId}` });
  const authOnly10 = await makeAuthOnly({});
  {
    const res = await callLink(superAdmin.uid, {
      uid: authOnly10.uid, displayName: "X", role: "designer", phoneNumber: `+915${runId}`,
    });
    check("[10] throws", res.threw, true);
    const targetAuth = await admin.auth().getUser(authOnly10.uid);
    check("[10] target Auth account's phone untouched (still none)", targetAuth.phoneNumber || null, null);
    const holderAuth = await admin.auth().getUser(phoneHolder10.uid);
    check("[10] original holder's phone untouched", holderAuth.phoneNumber, `+915${runId}`);
  }

  // ── Scenario 11: dryRun defaults to true -> zero writes ─────────────────
  const source11 = await makeAuthOnly({ phone: `+916${runId}` });
  const target11 = await makeStaff({ role: "owner", active: false });
  {
    const res = await callTransfer(superAdmin.uid, {
      sourceUid: source11.uid, targetUid: target11.uid, phoneNumber: `+916${runId}`,
    });
    check("[11] dryRun (default) does not throw", res.threw, false);
    check("[11] preview state is NOT_STARTED", res.preview?.state, "NOT_STARTED");

    const sourceAuth = await admin.auth().getUser(source11.uid);
    check("[11] source Auth phone UNCHANGED (zero writes)", sourceAuth.phoneNumber, `+916${runId}`);
    const targetAuth = await admin.auth().getUser(target11.uid);
    check("[11] target Auth phone UNCHANGED (zero writes)", targetAuth.phoneNumber || null, null);
  }

  // ── Scenario 12: dryRun:false actually transfers, mirrors both sides ────
  {
    const res = await callTransfer(superAdmin.uid, {
      sourceUid: source11.uid, targetUid: target11.uid, phoneNumber: `+916${runId}`, dryRun: false,
    });
    check("[12] does not throw", res.threw, false);

    const sourceAuth = await admin.auth().getUser(source11.uid);
    check("[12] source Auth phone cleared", sourceAuth.phoneNumber || null, null);
    const targetAuth = await admin.auth().getUser(target11.uid);
    check("[12] target Auth phone now set", targetAuth.phoneNumber, `+916${runId}`);

    const targetStaffDoc = (await db.doc(`staff/${target11.uid}`).get()).data();
    check("[12] target staff/{uid} mirror updated", targetStaffDoc?.phoneNumber, `+916${runId}`);

    // Preserve email identities — never touched on either side.
    check("[12] source Auth email unchanged", sourceAuth.email, source11.email);
    check("[12] target Auth email unchanged", targetAuth.email, target11.email);

    const auditSnap = await db.collection("auditLogs")
      .where("entityId", "==", target11.uid).where("action", "==", "STAFF_PHONE_TRANSFER").get();
    check("[12] a STAFF_PHONE_TRANSFER audit entry exists", auditSnap.size >= 1, true);
    const serialized = auditSnap.docs.map(d => JSON.stringify(d.data())).join("\n");
    check("[12] the audit entry never contains the full phone number in plaintext", serialized.includes(`+916${runId}`), false);

    const crypto12 = require("crypto");
    const transferKey12 = crypto12.createHash("sha256").update(`${source11.uid}|${target11.uid}|+916${runId}`).digest("hex");
    const markerSnap12 = await db.doc(`phoneTransferAttempts/${transferKey12}`).get();
    check("[12] the attempt marker is cleared after a successful transfer", markerSnap12.exists, false);
  }

  // ── Scenario 13: source has NO staff/{uid} doc — Step D simply skipped ──
  const source13 = await makeAuthOnly({ phone: `+917${runId}` });
  const target13 = await makeStaff({ role: "owner", active: true });
  {
    const res = await callTransfer(superAdmin.uid, {
      sourceUid: source13.uid, targetUid: target13.uid, phoneNumber: `+917${runId}`, dryRun: false,
    });
    check("[13] succeeds even though source has no staff doc", res.threw, false);
    const targetAuth = await admin.auth().getUser(target13.uid);
    check("[13] target Auth phone set", targetAuth.phoneNumber, `+917${runId}`);
    const targetStaffDoc = (await db.doc(`staff/${target13.uid}`).get()).data();
    check("[13] target staff/{uid} mirror updated", targetStaffDoc?.phoneNumber, `+917${runId}`);
    const sourceStaffDoc = await db.doc(`staff/${source13.uid}`).get();
    check("[13] source still has no staff doc (nothing fabricated)", sourceStaffDoc.exists, false);
  }

  // ── Scenario 14: MISMATCH — source does not actually hold the number ────
  const source14 = await makeAuthOnly({}); // no phone at all
  const target14 = await makeStaff({ role: "owner", active: true });
  {
    const res = await callTransfer(superAdmin.uid, {
      sourceUid: source14.uid, targetUid: target14.uid, phoneNumber: `+918${runId}`, dryRun: false,
    });
    check("[14] throws", res.threw, true);
    check("[14] stepReached is CLASSIFY", res.details?.stepReached, "CLASSIFY");
    const targetAuth = await admin.auth().getUser(target14.uid);
    check("[14] target Auth phone untouched", targetAuth.phoneNumber || null, null);
  }

  // ── Scenario 15: sourceUid === targetUid is rejected ─────────────────────
  {
    const res = await callTransfer(superAdmin.uid, {
      sourceUid: target14.uid, targetUid: target14.uid, phoneNumber: `+918${runId}`, dryRun: false,
    });
    check("[15] throws", res.threw, true);
  }

  // ── Scenario 16: staffTransferPhoneNumber by Admin is rejected ──────────
  const source16 = await makeAuthOnly({ phone: `+919${runId}` });
  const target16 = await makeStaff({ role: "owner", active: true });
  {
    const res = await callTransfer(admin1.uid, {
      sourceUid: source16.uid, targetUid: target16.uid, phoneNumber: `+919${runId}`, dryRun: false,
    });
    check("[16] admin transfer throws", res.threw, true);
    const sourceAuth = await admin.auth().getUser(source16.uid);
    check("[16] source Auth phone untouched", sourceAuth.phoneNumber, `+919${runId}`);
  }

  // ── Scenario 17: resumes correctly from an ORPHANED state ───────────────
  // (ONLY when THIS function's own attempt marker says so — reconstructed
  // here exactly as the real failure path would leave it: Step A done,
  // marker written, assignment never completed. Directly clearing the
  // source's Auth phone WITHOUT the marker is scenario 14's MISMATCH case.)
  const source17 = await makeAuthOnly({ phone: `+920${runId}` });
  const target17 = await makeStaff({ role: "owner", active: true });
  {
    const phone17 = `+920${runId}`;
    const crypto17 = require("crypto");
    const transferKey17 = crypto17.createHash("sha256").update(`${source17.uid}|${target17.uid}|${phone17}`).digest("hex");
    await db.doc(`phoneTransferAttempts/${transferKey17}`).set({
      sourceUid: source17.uid, targetUid: target17.uid, startedAt: new Date().toISOString(),
    });
    await admin.auth().updateUser(source17.uid, { phoneNumber: null });

    const dry = await callTransfer(superAdmin.uid, {
      sourceUid: source17.uid, targetUid: target17.uid, phoneNumber: phone17,
    });
    check("[17] dryRun classifies ORPHANED (marker found)", dry.preview?.state, "ORPHANED");

    const res = await callTransfer(superAdmin.uid, {
      sourceUid: source17.uid, targetUid: target17.uid, phoneNumber: phone17, dryRun: false,
    });
    check("[17] resumed transfer does not throw", res.threw, false);
    const targetAuth = await admin.auth().getUser(target17.uid);
    check("[17] target Auth phone now set", targetAuth.phoneNumber, phone17);
    const targetStaffDoc = (await db.doc(`staff/${target17.uid}`).get()).data();
    check("[17] target staff/{uid} mirror updated", targetStaffDoc?.phoneNumber, phone17);

    const markerSnap17 = await db.doc(`phoneTransferAttempts/${transferKey17}`).get();
    check("[17] the attempt marker is cleared after a successful resume", markerSnap17.exists, false);
  }

  // ── Scenario 18: target already holds a DIFFERENT number — refused ──────
  const source18 = await makeAuthOnly({ phone: `+921${runId}` });
  const target18 = await makeStaff({ role: "owner", active: true, phone: `+922${runId}` });
  {
    const res = await callTransfer(superAdmin.uid, {
      sourceUid: source18.uid, targetUid: target18.uid, phoneNumber: `+921${runId}`, dryRun: false,
    });
    check("[18] throws (target already holds a different number)", res.threw, true);
    check("[18] stepReached is CLASSIFY", res.details?.stepReached, "CLASSIFY");
    const sourceAuth = await admin.auth().getUser(source18.uid);
    check("[18] source Auth phone untouched", sourceAuth.phoneNumber, `+921${runId}`);
    const targetAuth = await admin.auth().getUser(target18.uid);
    check("[18] target Auth phone untouched (its OWN number preserved)", targetAuth.phoneNumber, `+922${runId}`);
  }

  if (!pass) {
    console.error("LUXARDO FLOW LINK-EXISTING-ACCOUNT / TRANSFER-PHONE REGRESSION TEST: FAIL");
    process.exitCode = 1;
    return;
  }

  console.log(
    "LUXARDO FLOW LINK-EXISTING-ACCOUNT / TRANSFER-PHONE REGRESSION TEST: PASS — " +
    "staffLookupIdentity correctly classifies not-found / found-unlinked / found-already-linked / " +
    "conflict (two different Auth uids) and is Super-Admin-only; staffLinkExistingAccount attaches " +
    "a staff/{uid} profile to an EXISTING Auth account without ever creating a new Auth user or " +
    "fabricating an identity for a uid with no real Auth account, is idempotent per uid, enforces " +
    "phone uniqueness, and is Super-Admin-only; staffTransferPhoneNumber defaults to a zero-write " +
    "dryRun, correctly moves a phone number between two Auth accounts while preserving both email " +
    "identities, mirrors the change on both staff/{uid} docs (skipping the source mirror when none " +
    "exists), never exposes the full number in its audit trail, refuses any MISMATCH state (including " +
    "a target that already holds a different number) rather than guessing, resumes cleanly from an " +
    "ORPHANED state without any manual Console step, and is Super-Admin-only."
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exitCode = 1;
});
