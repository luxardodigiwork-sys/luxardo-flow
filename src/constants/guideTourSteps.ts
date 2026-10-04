/**
 * Loom Guide Tour — role-specific step configuration.
 *
 * ONE reusable tour system (GuideTour.tsx) is driven by this DATA — there is
 * no per-role component or duplicated tour logic. Each entry below lists the
 * sidebar nav paths (exactly as defined in ProductionLayout.tsx's navGroups)
 * that role's tour should walk through, in order, with role-appropriate copy.
 *
 * Safety invariant (enforced at runtime by GuideTour.tsx / buildGuideTourSteps,
 * not by this file): a step here is only ever actually shown if the role's
 * LIVE, rendered nav (ProductionLayout's own can()-filtered list) still
 * contains that navPath. This config can drift and never cause an
 * unauthorized link to be highlighted — it can only under-show, never over-show.
 *
 * Keep navPath values in sync with ProductionLayout.tsx's item.path values;
 * see src/__tests__/guideTourConfig.test.ts for the static cross-check
 * against rolePermissions.ts's can() for every (role, navPath) pair below.
 */

export interface GuideTourStepConfig {
  navPath: string;
  content: string;
}

export interface GuideTourRoleConfig {
  welcomeTitle: string;
  welcomeBody: string;
  steps: GuideTourStepConfig[];
  outroBody: string;
}

export const GUIDE_TOUR_ROLES = [
  'owner',
  'admin',
  'super_admin',
  'designer',
  'pm',
  'dispatch',
  'guard',
  'tailor',
  'store',
  'accounts',
  'analysis',
] as const;

export type GuideTourRole = (typeof GUIDE_TOUR_ROLES)[number];

export const GUIDE_TOUR_CONFIG: Record<GuideTourRole, GuideTourRoleConfig> = {
  owner: {
    welcomeTitle: 'Welcome, Owner',
    welcomeBody:
      "You have full oversight of LUXARDO FLOW — every design, request, and piece, plus final approval authority. Here's a quick tour of where everything lives.",
    steps: [
      { navPath: '/production/staff', content: 'Create and manage every staff account and role from here.' },
      { navPath: '/production/karigars', content: 'The Karigar registry — your skilled labour database.' },
      { navPath: '/production/designs', content: 'Catalogue Designs you approve move the whole production chain forward.' },
      { navPath: '/production/sample-designs', content: 'Sample Designs (fabric swatches) awaiting your review.' },
      { navPath: '/production/sample-pieces', content: 'Sample Pieces — complete garments made for your final catalogue approval.' },
      { navPath: '/production/requests', content: 'Production Requests need your approval before PM can start work.' },
      { navPath: '/production/pieces', content: 'Every physical piece in production, end to end.' },
      { navPath: '/production/qc', content: "Guard QC verdicts — what's passed, reworked, or rejected." },
      { navPath: '/production/tailor', content: "The Tailor Workspace pipeline, for visibility into stitching progress." },
      { navPath: '/production/store', content: "Store — completed garments ready for store-out." },
      { navPath: '/production/tailor-requests', content: 'New Tailor Requests raised by Dispatch wait for your review here.' },
    ],
    outroBody: "That's the full picture. You can replay this tour anytime from the Help button.",
  },

  admin: {
    welcomeTitle: 'Welcome, Admin',
    welcomeBody:
      'You manage day-to-day production administration — staff, master data, and approvals alongside Owner. Here is where everything lives.',
    steps: [
      { navPath: '/production/staff', content: 'Create and manage staff accounts and roles.' },
      { navPath: '/production/karigars', content: 'The Karigar registry — your skilled labour database.' },
      { navPath: '/production/designs', content: 'Catalogue Designs move through Draft → Approval here.' },
      { navPath: '/production/sample-designs', content: 'Sample Designs (fabric swatches) in progress.' },
      { navPath: '/production/sample-pieces', content: 'Sample Pieces — complete garments for catalogue approval.' },
      { navPath: '/production/requests', content: 'Production Requests awaiting approval.' },
      { navPath: '/production/pieces', content: 'Every physical piece in production.' },
      { navPath: '/production/qc', content: 'Guard QC verdicts across all pieces.' },
      { navPath: '/production/tailor', content: 'The Tailor Workspace pipeline.' },
      { navPath: '/production/store', content: 'Store — completed garments ready for store-out.' },
      { navPath: '/production/tailor-requests', content: 'New Tailor Requests raised by Dispatch.' },
    ],
    outroBody: "That's the full picture. You can replay this tour anytime from the Help button.",
  },

  super_admin: {
    welcomeTitle: 'Welcome, Super Admin',
    welcomeBody:
      'You have unrestricted access across the entire Loom production system. A quick orientation of the main areas:',
    steps: [
      { navPath: '/production/staff', content: 'Staff accounts and roles — the full identity system.' },
      { navPath: '/production/karigars', content: 'The Karigar registry.' },
      { navPath: '/production/designs', content: 'Catalogue Designs.' },
      { navPath: '/production/sample-designs', content: 'Sample Designs (fabric swatches).' },
      { navPath: '/production/sample-pieces', content: 'Sample Pieces for catalogue approval.' },
      { navPath: '/production/requests', content: 'Production Requests.' },
      { navPath: '/production/pieces', content: 'Every physical piece in production.' },
      { navPath: '/production/qc', content: 'Guard QC verdicts.' },
      { navPath: '/production/tailor', content: 'The Tailor Workspace pipeline.' },
      { navPath: '/production/store', content: 'Store — completed garments ready for store-out.' },
      { navPath: '/production/tailor-requests', content: 'New Tailor Requests.' },
    ],
    outroBody: "That's everything. You can replay this tour anytime from the Help button.",
  },

  designer: {
    welcomeTitle: 'Welcome, Designer',
    welcomeBody:
      'You create and submit Catalogue Designs, Sample Designs, and Sample Pieces for Owner approval. Here is your workflow:',
    steps: [
      { navPath: '/production/designs', content: 'Create a Catalogue Design, then submit it for approval.' },
      { navPath: '/production/sample-designs', content: 'Create a Sample Design — a fabric swatch linked to an approved design.' },
      { navPath: '/production/sample-pieces', content: 'Create a Sample Piece and mark it complete with a garment photo.' },
    ],
    outroBody: 'That covers your workflow. Replay this tour anytime from the Help button.',
  },

  pm: {
    welcomeTitle: 'Welcome, Production Manager',
    welcomeBody:
      'You run day-to-day production — generating pieces, assigning Karigars, tracking labour, and moving pieces through their lifecycle. Here is your workspace:',
    steps: [
      { navPath: '/production/karigars', content: 'The Karigar registry — assign skilled labour to pieces from here.' },
      { navPath: '/production/designs', content: 'Catalogue Designs — read-only reference for approved designs.' },
      { navPath: '/production/sample-designs', content: 'Sample Designs in progress.' },
      { navPath: '/production/sample-pieces', content: 'Sample Pieces awaiting completion.' },
      { navPath: '/production/requests', content: 'Approved Production Requests — generate physical pieces from here.' },
      { navPath: '/production/pieces', content: 'Every piece you manage: assign Karigars, start/stop labour, move stages.' },
      { navPath: '/production/qc', content: 'Guard QC verdicts — view-only, Guard performs the actual QC.' },
      { navPath: '/production/tailor', content: 'The Tailor Workspace pipeline — view-only visibility into stitching.' },
      { navPath: '/production/store', content: 'Store pipeline — view-only visibility into store-out.' },
    ],
    outroBody: 'That covers your daily workflow. Replay this tour anytime from the Help button.',
  },

  dispatch: {
    welcomeTitle: 'Welcome, Dispatch',
    welcomeBody:
      'You create Production Requests, assign Tailors, and route pieces to Store. Here is where your work happens:',
    steps: [
      { navPath: '/production/karigars', content: 'The Karigar registry — view-only reference.' },
      { navPath: '/production/designs', content: 'Catalogue Designs — reference for creating Production Requests.' },
      { navPath: '/production/sample-designs', content: 'Sample Designs — view-only reference.' },
      { navPath: '/production/sample-pieces', content: 'Sample Pieces — view-only reference.' },
      { navPath: '/production/requests', content: 'Create and submit new Production Requests here.' },
      { navPath: '/production/pieces', content: 'Pieces pipeline — view-only visibility.' },
      { navPath: '/production/qc', content: 'Guard QC verdicts — view-only visibility.' },
      { navPath: '/production/dispatch', content: 'Your Dispatch Workspace — assign Tailors and send pieces to Store.' },
      { navPath: '/production/tailor', content: 'The Tailor Workspace pipeline — view-only visibility.' },
      { navPath: '/production/store', content: 'Store pipeline — view-only visibility.' },
    ],
    outroBody: 'That covers your daily workflow. Replay this tour anytime from the Help button.',
  },

  guard: {
    welcomeTitle: 'Welcome, Guard',
    welcomeBody:
      'You perform Quality Control on pieces ready for inspection — PASS, REWORK, or REJECT. Here is your workflow:',
    steps: [
      { navPath: '/production/pieces', content: 'See every piece, including which ones are QC_PENDING.' },
      { navPath: '/production/qc', content: 'Your Guard QC workspace — record a PASS, REWORK, or REJECT verdict here.' },
    ],
    outroBody: 'That covers your workflow. Replay this tour anytime from the Help button.',
  },

  tailor: {
    welcomeTitle: 'Welcome, Tailor',
    welcomeBody:
      'You stitch pieces assigned to you and upload the completed garment photo. Here is your workflow:',
    steps: [
      { navPath: '/production/designs', content: 'Catalogue Designs — view-only reference for what you are stitching.' },
      { navPath: '/production/pieces', content: 'See the pieces pipeline, including which are assigned to you.' },
      { navPath: '/production/tailor', content: 'Your Tailor Workspace — start stitching, then take or choose a garment photo to complete it.' },
    ],
    outroBody: 'That covers your workflow. Replay this tour anytime from the Help button.',
  },

  store: {
    welcomeTitle: 'Welcome, Store',
    welcomeBody:
      'You receive completed garments and issue them out with a bill number. Here is your workflow:',
    steps: [
      { navPath: '/production/designs', content: 'Catalogue Designs — view-only reference.' },
      { navPath: '/production/pieces', content: 'See the pieces pipeline, including which have reached Store.' },
      { navPath: '/production/store', content: 'Your Store Workspace — issue a Store-Out with a bill number, or report an issue.' },
    ],
    outroBody: 'That covers your workflow. Replay this tour anytime from the Help button.',
  },

  accounts: {
    welcomeTitle: 'Welcome, Accounts',
    welcomeBody:
      "Your Loom access is a read-only Dashboard view. Billing, invoices, and payment tooling live in the main E-Commerce Admin Portal, not here.",
    steps: [],
    outroBody: 'Use the Dashboard here for a production overview. Replay this tour anytime from the Help button.',
  },

  analysis: {
    welcomeTitle: 'Welcome, Analytics',
    welcomeBody:
      'Your Loom access is a read-only Dashboard view, giving you a snapshot of production activity. Deeper reporting tools live in the main E-Commerce Admin Portal.',
    steps: [],
    outroBody: 'Use the Dashboard here for a production overview. Replay this tour anytime from the Help button.',
  },
};
