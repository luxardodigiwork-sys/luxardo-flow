/* eslint-disable */
/**
 * LUXARDO FASHION — LOOM PRODUCTION SYSTEM (luxardo-flow)
 *
 * Dedicated Cloud Functions entry for the Loom production system.
 * Re-exports ONLY the 36 Loom callables from the SHARED domain modules
 * (functions/src/*) — zero duplication. No B2C / Razorpay functions are
 * referenced here, so deploying to luxardo-flow never binds B2C secrets
 * and never requires Secret Manager access.
 *
 * Deploy:  firebase deploy --config firebase.loom.json --only functions --project luxardo-flow
 */
import { setGlobalOptions } from "firebase-functions/v2";

/* MUST be the first import so the Admin SDK is initialized before the shared
 * Loom modules build their service handles (db, storage, etc.). */
import "./init";

setGlobalOptions({ region: "us-central1", maxInstances: 10 });

/* V1 Production System — master-data CRUD + atomic ID generation */
export {
  nextId,
  staffCreate,
  staffUpdate,
  staffChangePassword,
  staffBackfillCustomerDocs,
  karigarCreate,
  karigarUpdate,
} from "../../functions/src/production";
export { userProfileSelfUpdate, mobileResetLookup, mobileResetSendOtp } from "../../functions/src/production";

/* P0-2 — Privileged (Owner/Admin/Super Admin) Mobile Number + Password
 * login, and (V1 Auth Stabilization) the same mechanism opened to the 8
 * operational staff roles. FLOW-only: deliberately never exported from
 * functions/src/index.ts (the B2C-deployed bundle). */
export { privilegedMobilePasswordLogin, staffMobilePasswordLogin } from "../../functions/src/privilegedAuth";

/* Phase 2 · Block 2.1 — Catalogue Design management + version preservation */
export {
  designCreate,
  designUpdate,
  designSubmit,
  designApprove,
  designSetCatalogueMeta,
  designNewVersion,
} from "../../functions/src/designs";

/* Phase 2 · Block 2.2/2.3 — Sample Design (fabric swatch) + Sample Piece (garment) */
export {
  sampleDesignCreate,
  sampleDesignUpdate,
  sampleDesignSubmit,
  sampleDesignApprove,
  samplePieceCreate,
  samplePieceComplete,
  samplePieceApprove,
} from "../../functions/src/samples";

/* Phase 2 · Block 2.4 — Production Request foundation */
export {
  prCreate,
  prUpdate,
  prSubmit,
  prApprove,
  prReject,
  prEditApproved,
  prReproduce,
  prGeneratePieces,
} from "../../functions/src/productionRequests";

/* Phase 2 · Block 3 — Physical Piece domain */
export {
  pieceAssignKarigar,
  pieceRemoveKarigar,
  recordRework,
  completeRejectPiece,
  createManualReplacementPiece,
  recordPieceMovement,
} from "../../functions/src/pieces";

/* Phase 2 · Block 4 — Karigar + Labour domain */
export {
  labourStart,
  labourStop,
} from "../../functions/src/labour";

/* Phase 3 · Block 5 — Guard QC domain */
export {
  guardQcPerform,
} from "../../functions/src/guardQc";

/* Phase 4 — Dispatch domain (Tailor assignment + Store routing) */
export {
  listActiveTailors,
  dispatchAssignTailor,
  dispatchSendToStore,
} from "../../functions/src/dispatch";

/* Phase 4 — Tailor domain (stitching sessions) */
export {
  tailorStartStitching,
  tailorCompleteStitching,
} from "../../functions/src/tailor";

/* Phase 4 — Store domain (Store-Out + issue log) */
export {
  storeOutCreate,
  storeOutReportIssue,
} from "../../functions/src/store";

/* Phase 4 — New Tailor Request domain (Dispatch raises, Admin/Owner review) */
export {
  raiseNewTailorRequest,
  approveTailorRequest,
  rejectTailorRequest,
} from "../../functions/src/tailorRequests";

/* Fabric Inventory V1 — master CRUD + stock receipt/issue ledger.
 * FLOW-only: deliberately never exported from functions/src/index.ts (the
 * B2C-deployed bundle) — production inventory has no B2C counterpart. */
export {
  fabricMasterCreate,
  fabricMasterUpdate,
  fabricStockReceive,
  fabricStockIssue,
} from "../../functions/src/fabric";

/* V1 Auth Stabilization — TOTP (Google Authenticator) second factor,
 * Admin/Super Admin only. FLOW-only: deliberately never exported from
 * functions/src/index.ts (the B2C-deployed bundle). */
export {
  totpEnrollStart,
  totpEnrollVerify,
  totpDisable,
  totpStatus,
} from "../../functions/src/totp";