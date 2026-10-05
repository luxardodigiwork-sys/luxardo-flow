/**
 * LUXARDO FASHION — V1 PRODUCTION SYSTEM
 * ============================================================================
 * Type definitions for the production-management workflow.
 *
 * This module is the FOUNDATION / DATA MODEL for the production system.
 * It is purely additive: it does not modify any existing type in `../types`.
 *
 * Collection names (Firestore):
 *   catalogueDesigns, sampleDesigns, samplePieces, pieces,
 *   productionRequests, karigars, pieceWorkSessions,
 *   pieceMovementHistory, idCounters
 *
 * ID families:
 *   Catalogue Design  KL-XXXX
 *   Sample Design     SAMPLE-DESIGN-XXXX
 *   Sample Piece      SAMPLE-PIECE-XXXX
 *   Physical Piece    PIECE-XXXX
 *   Production Request PR-XXXX
 *   Karigar           K-XXXX
 *   Store-Out         SO-XXXX
 *   Store-Out Issue   SOI-XXXX
 *   Guard QC Record   QC-XXXX
 *   Work Session      LS-XXXX
 *
 * Immutability principles:
 *   - Original ordered quantity frozen after Owner approval
 *   - Approved design version frozen (isFrozen = true)
 *   - Every rejection must preserve: actor, timestamp, reason, rejectionType
 *   - Piece history is append-only (never deleted)
 *   - No Piece hard-deleted
 *   - No approved Design Version hard-deleted
 *   - No approved Production Request hard-deleted
 *   - Rejection type: REWORK (same piece, new work session) or COMPLETE_REJECT (close piece)
 */

/* ────────────────────────────── ENUMS ────────────────────────────── */

export type StaffRole =
  | "owner"
  | "admin"
  | "designer"
  | "pm"
  | "dispatch"
  | "guard"
  | "tailor"
  | "store"
  | "accounts"
  | "analysis";

export type DesignStatus = "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "FROZEN";
export type SampleDesignStatus = "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "FROZEN";
export type SamplePieceStatus = "IN_WORK" | "COMPLETE" | "APPROVED";
export type PieceKind = "PHYSICAL" | "SAMPLE";

/** Physical piece lifecycle stage (atomic tracking unit). */
export type PieceStage =
  | "OPEN"
  | "IN_WORK"
  | "QC_PENDING"
  | "REWORK"
  | "QC_PASS"
  | "DISPATCH_READY"
  | "TAILOR_ASSIGNED"
  | "STITCHING"
  | "STITCH_COMPLETE"
  | "STORE"
  | "STORE_OUT"
  | "REJECTED";

/** High-level piece status (supplementary to stage). */
export type PieceStatus = "active" | "in_rework" | "closed" | "replaced";

export type PRStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "IN_PRODUCTION"
  | "COMPLETED"
  | "REJECTED_BY_OWNER"
  | "CANCELLED";

export type UrgencyLevel = "HIGH" | "MEDIUM" | "LOW";

export type StoreOutReason =
  | "DAMAGE_IN_TRANSIT"
  | "SIZE_MISMATCH"
  | "QUALITY_REJECT"
  | "BILLING_DISPUTE"
  | "OTHER";

export type MovementDirection = "FORWARD" | "REVERSE";
export type MovementSource = "MANUAL" | "SYSTEM";

export type RejectionType = "REWORK" | "COMPLETE_REJECT";

/* ─────────────────────── CATALOGUE DESIGN ─────────────────────── */

/**
 * Collection: catalogueDesigns
 * ID: KL-XXXX (transaction-safe sequential)
 * A design pattern on fabric in the collection.
 *
 * Lifecycle: DRAFT → PENDING_APPROVAL → APPROVED (isFrozen = true).
 * Owner approval freezes the design for production.
 * After approval, Designer assigns catalogueShortName + designNumber.
 * V2 = new version, not modification (version is incremented) — the frozen
 * version stays archived in designVersions and existing production never
 * switches to the newer version silently.
 */
export interface DesignDoc {
  id: string; // "KL-0001"
  designType: "catalogue";
  name: string;
  description: string;
  image: string;
  imagePath: string | null; // storage path backing `image` when uploaded (camera/gallery), null when pasted
  images: string[];
  status: DesignStatus; // DRAFT → APPROVED → FROZEN
  currentVersion: number;
  isFrozen: boolean; // true once Owner approves
  catalogueShortName: string | null; // Designer assigns AFTER Owner approval
  designNumber: string | null; // Designer assigns AFTER Owner approval
  designerUid: string; // who created this design
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Collection: designVersions (top-level, append-only; written by Cloud Function)
 * ID: {designId}-v{versionNo}  e.g. "KL-0001-v1"
 * Immutable snapshot written on Owner approval. Never overwritten;
 * existing production always references the approved frozen version.
 */
export interface DesignVersionDoc {
  id: string; // "KL-0001-v1"
  designId: string;
  versionNo: number;
  snapshot: DesignDoc;
  frozen: boolean;
  approvedBy: string;
  approvedByName: string;
  approvedAt: string;
  note: string;
  createdAt: string;
}

/* ───────────────────────── SAMPLE DESIGN ───────────────────────── */

/**
 * Collection: sampleDesigns
 * ID: SAMPLE-DESIGN-XXXX
 * Small fabric piece showing a portion of a design, used by salesmen.
 * Independent entity; optionally linked to a Catalogue Design via `catalogDesignId`.
 */
export interface SampleDesignDoc {
  id: string; // "SAMPLE-DESIGN-0001"
  originalSampleId: string | null; // legacy: original SAMPLE-10021 format (preserve for backward-compat)
  catalogDesignId: string | null; // FK → catalogueDesigns/{id}
  designVersionId: string | null; // FK → designVersions/{id} (approved design version)
  name: string;
  description: string;
  image: string;
  imagePath: string | null; // storage path backing `image` when uploaded (camera/gallery), null when pasted
  images: string[];
  status: SampleDesignStatus; // DRAFT → PENDING_APPROVAL → APPROVED (frozen)
  currentVersion: number;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

export interface SampleDesignVersionDoc {
  id: string;
  versionNo: number;
  snapshot: SampleDesignDoc;
  frozen: boolean;
  approvedBy: string;
  approvedByName: string;
  approvedAt: string;
  note: string;
  createdAt: string;
}

/* ────────────────────────── SAMPLE PIECE ───────────────────────── */

/**
 * Collection: samplePieces
 * ID: SAMPLE-PIECE-XXXX
 * One complete garment made for catalogue approval. Normally only one per design.
 * After Owner approves the Sample Piece, it becomes the catalogue reference.
 */
export interface SamplePieceDoc {
  id: string; // "SAMPLE-PIECE-0001"
  designId: string; // FK → catalogueDesigns/{id}
  designVersionId: string | null; // FK → designVersions/{id} (approved design version)
  sampleDesignId: string | null; // FK → sampleDesigns/{id} (swatch it is based on)
  status: SamplePieceStatus; // IN_WORK → COMPLETE (garment photo) → APPROVED (owner)
  notes: string;
  image: string; // Photo of completed garment (compulsory on COMPLETE)
  imagePath: string | null; // storage path backing `image` when uploaded (camera/gallery), null when pasted
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

/* ─────────────────────── PRODUCTION REQUEST ────────────────────── */

/**
 * Collection: productionRequests
 * ID: PR-XXXX
 * Dispatch creates reproduction/production requests.
 * Quantity defaults to 0; PR cannot be submitted when quantity = 0.
 * After Owner approval, originalOrderedQty is immutable.
 * Additional quantity always requires a new PR.
 *
 * Post-approval edits: Owner/Admin may modify urgency & requiredDate only,
 * with audit history (PRAuditDoc).
 */
export interface ProductionRequestDoc {
  id: string; // "PR-0001"
  requestedBy: string;
  requestedByName: string;
  requestedByRole: string; // "dispatch" | "admin" | "owner"
  createdAt: string;
  updatedAt: string;

  /** The catalogue design this request reproduces. */
  designId: string | null;
  /** FK → designVersions/{id} — the Owner-approved (frozen) version to produce. */
  designVersionId: string | null;
  garmentType: string | null;

  // Quantity tracking (6 fields)
  originalOrderedQty: number; // Immutable after Owner approval (frozen)
  currentActiveQty: number;   // pieces currently in production/rework
  completedQty: number;       // pieces that passed QC & dispatched
  reworkQty: number;          // pieces currently in rework
  rejectedQty: number;        // permanently rejected pieces
  pendingQty: number;         // pieces not yet started
  totalPieceCount: number;    // sum = originalOrderedQty

  /** Physical pieces generated so far from this approved PR (atomic counter). */
  piecesGeneratedCount: number;

  /** True after Owner approval; rules enforce originalOrderedQty immutability. */
  originalQtyFrozen: boolean;

  status: PRStatus;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;

  // Rejection tracking
  rejectedBy: string | null;
  rejectedByName: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;

  urgency: UrgencyLevel;
  requiredDate: string; // ISO date — production deadline

  cancelledBy: string | null;
  cancelledAt: string | null;

  createdBy: string;
  createdByName: string;
}

/** Post-approval edit history (urgency / requiredDate only). */
export interface PRAuditDoc {
  id: string;
  field: "urgency" | "requiredDate";
  oldValue: string | number;
  newValue: string | number;
  editedBy: string;
  editedByName: string;
  editedByRole: string;
  at: string;
}

/* ────────────────────────── PHYSICAL PIECE ─────────────────────── */

/**
 * Collection: pieces
 * ID: PIECE-XXXX (global sequential, not per-design)
 * The atomic unit of production. Every physical piece gets its own Piece ID.
 * Piece IDs are NEVER reused after deletion/closure.
 *
 * REWORK: keeps same Piece ID, returns to work stage, new work session created.
 * COMPLETE_REJECT: permanently closes Piece, manual replacement with NEW Piece ID
 *   linked to the rejected piece via ReplacementLinkDoc.
 *
 * Replacement: new PIECE doc gets replacesPieceId → the rejected piece.
 * Rejected piece gets replacedByPieceId → the new piece.
 * Original quantity frozen; additional quantity = new PR.
 */
export interface PieceDoc {
  id: string; // "PIECE-0001"
  designId: string; // FK → catalogueDesigns/{id}
  prId: string | null; // FK → productionRequests/{id}
  designVersionId: string | null; // FK → designVersions/{id} (approved design version)
  kind: PieceKind; // "PHYSICAL" | "SAMPLE"
  stage: PieceStage;
  status: PieceStatus; // active | in_rework | closed | replaced

  assignedKarigars: string[];
  lastKarigarIds: string[];
  totalLabourMinutes: number;
  totalLabourCost: number;
  firstWorkAt: string | null;
  lastWorkAt: string | null;

  // QC / Rejection tracking
  qcVerdict: "PASS" | "REWORK" | "COMPLETE_REJECT" | null;
  rejectionReason: string | null;
  rejectionType: RejectionType | null; // "REWORK" | "COMPLETE_REJECT" | null
  rejectedAt: string | null;
  rejectedBy: string | null; // guard uid
  rejectedByName: string | null;
  reworkCount: number;
  lastGuardQcId: string | null;

  // Tailor tracking
  assignedTailorUid: string | null;
  assignedTailorName: string | null;
  tailorSessionId: string | null;
  tailorStartAt: string | null;
  tailorEndAt: string | null;

  // Store tracking
  storeInAt: string | null;
  storeOutAt: string | null;
  storeOutId: string | null;
  billNumber: string | null;

  // Replacement link
  replacesPieceId: string | null; // this piece replaces rejectedPieceId
  replacedByPieceId: string | null; // this piece was replaced by newPieceId

  notes: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Collection: pieceMovementHistory
 * Every stage transition — forward or reverse — appends one record. NEVER deleted.
 *
 * action: the movement action, e.g. "WORK_START", "QC_PASS", "REWORK",
 *   "COMPLETE_REJECT", "TAILOR_START", "STORE_IN", "STORE_OUT", "REPLACE"
 *
 * Reverse movement = another forward record (preserves full audit trail).
 */
export interface MovementDoc {
  id: string;
  pieceId: string;
  fromStage: PieceStage | null; // null for a piece's initial creation record
  toStage: PieceStage;
  direction: MovementDirection;
  action: string; // e.g. "WORK_START" | "QC_PASS" | "REWORK" | "COMPLETE_REJECT" | "STORE_IN"
  at: string;
  actorUid: string;
  actorName: string;
  actorRole: string;
  source: MovementSource;
  reason: string | null;
  relatedRequestId: string | null; // FK → productionRequests (PR context)
  relatedPieceId: string | null; // related piece (e.g. replacement / QC / tailor link)
  revertsMvId: string | null; // reversal reference
  snapshot: {
    pieceStage: PieceStage;
    totalLabourMinutes: number;
    totalLabourCost: number;
  };
  // True when this movement was a PM/Admin/Owner emergency override of a
  // transition that now has a dedicated specialist function (Dispatch/
  // Tailor/Store), performed via the generic recordPieceMovement instead.
  isOverride: boolean;
}

/* ──────────────────────────── KARIGAR ──────────────────────────── */

/**
 * Collection: karigars
 * ID: K-XXXX
 * Karigar master data — NOT a login user.
 * Required: karigarId, name, mobile, hourlyRate, active, createdAt, updatedAt.
 * Additional fields preserved for existing Admin UI compatibility.
 */
export interface KarigarDoc {
  id: string; // "K-0001"
  name: string;
  mobile: string;
  skillTags: string[];
  hourlyRate: number; // ₹/hour
  active: boolean;
  badgeId: string | null;
  aadhaar?: string; // optional master-data field (Admin)
  notes: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

/* ───────────────────────── WORK SESSION ───────────────────────── */

/**
 * Collection: pieceWorkSessions
 * ID: LS-XXXX
 * PM selects any Karigar to start/stop work on a Piece.
 * Multiple Karigars can work on the same Piece.
 * Labour = Piece + Karigar combination. Hourly rate calculates cost.
 * Type: FIRST or REWORK (rework session has reworkOf = previous session id).
 */
export interface LabourSessionDoc {
  id: string;
  pieceId: string;
  karigarId: string;
  karigarName: string;
  designId: string;
  prId: string | null;
  startedAt: string;
  endedAt: string | null; // null while in progress
  minutes: number; // 0 while in progress
  hourlyRate: number; // SNAPSHOT of karigar rate at session start
  labourCost: number; // (minutes / 60) × hourlyRate, computed once on stop
  type: "FIRST" | "REWORK";
  reworkOf: string | null;
  startedBy: string;
  startedByName: string;
  stoppedBy: string | null;
  stoppedByName: string | null;
  note: string;
}

/* ─────────────────────────── GUARD QC ──────────────────────────── */

export interface QCAction {
  label: string;
  ok: boolean;
  note: string;
}

/**
 * Collection: guardQCRecords
 * Guard performs QC, records detailed actions.
 * REJECT requires reason + rejectionType (REWORK | COMPLETE_REJECT).
 * After PASS → piece moves to Dispatch.
 */
export interface GuardQCRecordDoc {
  id: string;
  pieceId: string;
  verdict: "PASS" | "REWORK" | "COMPLETE_REJECT";
  reason: string; // MANDATORY for REWORK / COMPLETE_REJECT
  checkedActions: QCAction[];
  guardUid: string;
  guardName: string;
  at: string;
  photos: string[];
}

/* ────────────────────────── TAILOR SESSION ─────────────────────── */

/**
 * Collection: tailorSessions
 * Dispatch assigns stitching to Tailor.
 * Tailor records start time and complete time.
 * Stitched Piece goes directly to Store (never Grading).
 * Garment image is compulsory on completion.
 */
export interface TailorSessionDoc {
  id: string;
  pieceId: string;
  tailorUid: string;
  tailorName: string;
  startedAt: string;
  completedAt: string | null; // null while in progress
  garmentImageUrl: string | null; // COMPULSORY on completion
  garmentImagePath: string | null;
  note: string;
}

/* ─────────────────────────── STORE / SO ────────────────────────── */

/**
 * Collection: storeOuts
 * Store-Out requires selected Pieces and bill number (mandatory).
 */
export interface StoreOutDoc {
  id: string; // "SO-0001"
  storeOutNumber: string;
  pieceIds: string[];
  billNumber: string; // MANDATORY
  party: string | null;
  totalPieces: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

/**
 * Collection: storeOutIssues
 * Store-Out problem requires controlled reason + Other.
 * 5 standard reasons: DAMAGE_IN_TRANSIT, SIZE_MISMATCH, QUALITY_REJECT,
 *   BILLING_DISPUTE, OTHER.
 * When reason = OTHER, otherText is mandatory.
 */
export interface StoreOutIssueDoc {
  id: string;
  storeOutId: string;
  pieceId: string;
  reason: StoreOutReason;
  otherText: string | null; // required when reason === "OTHER"
  reportedBy: string;
  reportedByName: string;
  at: string;
}

/* ──────────────────────── NEW TAILOR REQUEST ───────────────────── */

export type TailorRequestStatus = "PENDING" | "APPROVED" | "REJECTED";

/**
 * Collection: tailorRequests
 * ID: TR-XXXX
 * Dispatch raises a request (name, email, reason); Admin/Owner approve or
 * reject. Approval automatically provisions the Tailor's Firebase Auth
 * account + staff/{uid} (role "tailor") via the same path staffCreate uses.
 * APPROVED and REJECTED are both terminal — never reopened, never deleted.
 */
export interface TailorRequestDoc {
  id: string; // "TR-0001"
  name: string;
  email: string;
  reason: string;
  status: TailorRequestStatus;
  requestedByUid: string;
  requestedByName: string;
  requestedAt: string;
  reviewedByUid: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdTailorUid: string | null; // set on APPROVED
  createdTailorName: string | null;
  rejectionReason: string | null; // set on REJECTED
}

/* ─────────────────────── REPLACEMENT LINK ──────────────────────── */

/**
 * Collection: replacementLinks
 * Replacement is manual: PM creates new Piece ID linked to rejected Piece.
 */
export interface ReplacementLinkDoc {
  id: string;
  rejectedPieceId: string;
  replacementPieceId: string;
  reason: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

/* ──────────────────────────── STAFF ────────────────────────────── */

/**
 * Controlled department list for the User Profile "department" field.
 * Purely descriptive/organisational — department is NEVER consulted by any
 * authorization check (can()/hasAnyRole()/isAdmin()). Role is the only
 * concept authorization decisions are based on. Keep in sync with
 * functions/src/staffAuth.ts CANONICAL_DEPARTMENTS (server source of truth)
 * and src/constants/businessConfig.ts (the actual list used by the UI).
 */
export type Department =
  | "Management"
  | "Design"
  | "Production"
  | "Planning"
  | "Dispatch"
  | "Quality Control"
  | "Tailoring"
  | "Store"
  | "Accounts"
  | "Analysis";

export interface WorkingHours {
  start: string; // "HH:MM", 24-hour
  end: string;   // "HH:MM", 24-hour
  totalHours: number; // computed server-side from start/end on every write
}

/**
 * Collection: staff
 * Staff identity doc — admin-only CRUD, own read.
 * Role: owner | admin | designer | pm | dispatch | guard | tailor | store
 *   (accounts/analysis are e-commerce roles, preserved).
 *
 * This is also the authoritative User Profile for LUXARDO FLOW — "User" is
 * the general authenticated-account concept (Owner/Admin/Super Admin
 * included, not just operational Staff); the collection itself stays named
 * `staff` for backend/rule compatibility. The profile fields below
 * (department onward) are additive and optional: a User created before
 * this model existed simply has them unset until an administrator (or the
 * User themself, for the small self-editable subset — see
 * userProfileSelfUpdate) provides them. Nothing here is ever guessed or
 * auto-populated.
 */
export interface StaffDoc {
  uid: string; // Firebase Auth uid
  displayName: string;
  email: string;
  role: StaffRole;
  active: boolean;
  /** True until the User completes a mandatory first-login password change
   *  (set on creation, and by the default-password migration script). Set
   *  server-side ONLY, by provisionStaffAccount (create) and by
   *  staffChangePassword (cleared on success) / staffUpdate (admin can set
   *  it back true after manually resetting someone's password). Never
   *  writable via userProfileSelfUpdate. */
  mustChangePassword?: boolean;
  /** Display mirror of the Firebase Auth record's phone number (E.164). The
   *  Auth record is the actual phone-sign-in credential AND the sole
   *  authoritative source for mobile-OTP password recovery; this field is
   *  only for admin-UI display/lookup. */
  phoneNumber?: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;

  // ── User Profile fields (additive, optional, admin-provisioned unless
  // noted as self-editable) ──────────────────────────────────────────
  /** https URL into Storage `production/profiles/{uid}/...`. Self-editable. */
  profilePhotoUrl?: string | null;
  /** One of Department above. Admin-only — never grants permissions. */
  department?: Department | null;
  /** ₹/day. Admin-only (business-sensitive). */
  ratePerDay?: number | null;
  /** Admin-only. */
  workingHours?: WorkingHours | null;
  /** ISO date (YYYY-MM-DD). Admin-only. */
  joiningDate?: string | null;
  /** Free-form internal ID, distinct from the Firebase uid. Admin-only. */
  employeeId?: string | null;
  /** Admin-only field AND admin-only visibility — never rendered to the
   *  User themself, only to admin/super_admin/owner viewing the profile. */
  notes?: string | null;
  lastActiveAt?: string | null;
}

/* ────────────────────────── AUDIT LOG ──────────────────────────── */

/**
 * Collection: auditLogs
 * Append-only. Admin read only. Never deleted.
 */

export type AuditAction =
  | "DESIGN_CREATE"
  | "DESIGN_UPDATE"
  | "DESIGN_SUBMIT" // designer submits for owner review
  | "DESIGN_APPROVE"
  | "DESIGN_FREEZE"
  | "DESIGN_NEW_VERSION" // V2 revision started from a frozen design
  | "DESIGN_SET_CATALOGUE_META" // Designer assigns catalogueShortName + designNumber
  | "SAMPLE_DESIGN_CREATE"
  | "SAMPLE_DESIGN_UPDATE"
  | "SAMPLE_DESIGN_SUBMIT"
  | "SAMPLE_DESIGN_APPROVE"
  | "SAMPLE_DESIGN_FREEZE"
  | "SAMPLE_PIECE_CREATE"
  | "SAMPLE_PIECE_COMPLETE"
  | "SAMPLE_PIECE_APPROVE"
  | "PR_CREATE"
  | "PR_SUBMIT"
  | "PR_APPROVE"
  | "PR_REJECT"
  | "PR_CANCEL"
  | "PR_EDIT_URGENCY"
  | "PR_EDIT_REQUIREDDATE"
  | "PR_EDIT_QTY" // post-approval qty adjustment (immutable after approval; only pre-approval)
  | "PR_REPRODUCE" // Dispatch created a NEW PR reproducing an approved request/design
  | "PR_GENERATE_PIECES" // physical PIECE-XXXX docs generated for an approved PR
  | "PIECE_CREATE"
  | "PIECE_STAGE_MOVE"
  | "PIECE_REVERSE_MOVE"
  | "PIECE_ASSIGN_KARIGAR"
  | "PIECE_REMOVE_KARIGAR"
  | "PIECE_REWORK" // PM moves a piece back to work (same Piece ID, new work session)
  | "PIECE_COMPLETE_REJECT" // permanent close of a physical piece (mandatory reason)
  | "LABOUR_START"
  | "LABOUR_STOP"
  | "GUARD_QC_PASS"
  | "GUARD_QC_REWORK"
  | "GUARD_QC_REJECT"
  | "REPLACEMENT_CREATE"
  | "TAILOR_START"
  | "TAILOR_COMPLETE"
  | "STORE_OUT"
  | "STORE_OUT_ISSUE"
  | "KARIGAR_CREATE"
  | "KARIGAR_UPDATE"
  | "KARIGAR_DEACTIVATE"
  | "STAFF_CREATE"
  | "STAFF_UPDATE"
  | "STAFF_ROLE_CHANGE"
  | "STAFF_EMAIL_CHANGE" // Super-Admin-only, via staffUpdate (syncs the real Auth email, not just the Firestore mirror)
  | "STAFF_PHONE_CHANGE"
  | "STAFF_PASSWORD_CHANGED" // self-service (mandatory first-login change, or voluntary) via staffChangePassword
  | "STAFF_PASSWORD_RESET" // Super-Admin-initiated, via staffResetPassword (never logs the generated password)
  | "STAFF_FORCE_PASSWORD_CHANGE" // Super-Admin sets mustChangePassword=true on another User, via staffUpdate
  | "STAFF_PROVISION_ORPHAN" // Auth user created but its staff/customers write AND the compensating delete both failed — needs manual review.
  | "STAFF_BACKFILL"
  | "REPORT_EXPORT";

export interface AuditLogDoc {
  id: string; // UUID (crypto.randomUUID)
  ts: string;
  actorUid: string;
  actorName: string;
  actorRole: string;
  action: AuditAction;
  entity: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  ip: string | null;
}

/* ────────────────────────── ID COUNTER ─────────────────────────── */

/**
 * Collection: idCounters (server-managed, deny-all at client).
 * Domain key → prefix → sequential ID.
 * IDs are never reused after deletion/closure.
 */
export interface IdCounterDoc {
  domain: string;
  prefix: string;
  next: number;
  updatedAt: string;
}

/* ────────────────────────── FABRIC INVENTORY V1 ───────────────────────── *
 * Production-scoped inventory, not an enterprise warehouse system. Stock
 * lives on fabricMasters.stockQtyMeters and ONLY ever moves via
 * fabricStockReceive / fabricStockIssue (functions/src/fabric.ts) — never
 * editable through fabricMasterUpdate. Every receipt/issue appends one
 * fabricLedger entry (append-only, carries the resulting balance), mirroring
 * the pieceMovementHistory pattern for pieces.
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Collection: fabricMasters
 * ID: FM-XXXX
 * Master data + live stock for a fabric type.
 */
export interface FabricMasterDoc {
  id: string;
  name: string;
  gsm: number;
  colour: string;
  colourCode: string;
  notes: string;
  unit: 'meters';
  stockQtyMeters: number;
  active: boolean;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Collection: designVersionFabricGuides
 * ID: {designVersionId}-fabric-guide
 * Link between a design version and its fabric requirements.
 * NOT part of Fabric Inventory V1 — reserved for a future phase.
 */
export interface DesignVersionFabricGuideDoc {
  fabricId: string;
  metersPerDesign: number;
}

/**
 * Collection: fabricReceipts
 * ID: FR-XXXX
 * One append-only record per stock-in event.
 */
export interface FabricReceiptDoc {
  id: string;
  fabricId: string;
  qtyMeters: number;
  supplier: string | null;
  notes: string;
  balanceAfterMeters: number;
  receivedBy: string;
  receivedByName: string;
  receivedAt: string;
  createdAt: string;
}

/**
 * Collection: fabricIssues
 * ID: FI-XXXX
 * One append-only record per stock-out-to-a-Production-Request event.
 */
export interface FabricIssueDoc {
  id: string;
  fabricId: string;
  prId: string;
  qtyMeters: number;
  reason: string;
  balanceAfterMeters: number;
  issuedBy: string;
  issuedByName: string;
  issuedAt: string;
  createdAt: string;
}

/**
 * Collection: fabricLedger
 * ID: random (crypto.randomUUID(), matching pieceMovementHistory's style)
 * The single, append-only, combined running ledger for a fabric's stock.
 */
export interface FabricLedgerEntryDoc {
  id: string;
  fabricId: string;
  type: 'RECEIPT' | 'ISSUE';
  qtyMeters: number;
  balanceAfterMeters: number;
  relatedReceiptId: string | null;
  relatedIssueId: string | null;
  relatedPrId: string | null;
  actorUid: string;
  actorName: string;
  actorRole: string;
  at: string;
  reason: string | null;
}
