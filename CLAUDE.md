# LUXARDO FLOW — project guide for developers and AI agents

Read this first. It replaces re-explaining the project in every chat.

## What this is
LUXARDO FLOW (code name "Loom") is LUXARDO FASHION's internal production
system: it tracks every garment piece from design approval to store-out, the
karigar labour time and cost on each piece, QC, tailoring and store bills.
It is a separate app from the B2C website (repo `luxardo-website`).

- Live app: https://luxardo-flow.web.app  (Firebase project `luxardo-flow`)
- Frontend: React 19 + Vite + Tailwind, built with `--mode loom` into `dist-loom/`
- Backend: Firebase Cloud Functions in `functions/src/*` (shared domain code),
  bundled for Flow by `functions-loom/` (only Flow callables are exported there)
- Security: `firestore.loom.rules`, `storage.loom.rules` — clients are read-only;
  every write goes through a callable that re-checks role server-side.

## The production chain (what must always keep working)
Design (Designer) → Owner approves → Production Request (Dispatch) → Owner
approves → PM generates Pieces → PM assigns Karigar + starts/stops labour →
PM moves to QC_PENDING → Guard QC (PASS → DISPATCH_READY / REWORK / REJECT) →
Dispatch assigns Tailor (or sends straight to Store) → Tailor stitches (photo
mandatory) → Dispatch sends to Store → Store issues Store-Out with bill number.

Roles: owner, admin, super_admin (privileged, `/admin/login`); designer, pm,
dispatch, guard, tailor, store, accounts, analysis (`/login`).
Permissions live in `src/utils/rolePermissions.ts` (UI) and must match the
callable gates in `functions/src/*` and `firestore.loom.rules`.

## Working rules
1. One bug or feature = one branch = one small commit. Never mix B2C work here.
2. Every UI action must be checked in a real browser before it is called done:
   run the kit in `qa-e2e/` (emulators + Playwright). `npm run navcheck` must
   print `BROKEN: none` for every role.
3. Before pushing: `npx tsc --noEmit`, the frontend tests
   (`for f in src/__tests__/*.ts; do npx tsx $f; done`) and the backend
   emulator tests (see the header of each file in `functions/src/__tests__/`).
4. Never run scripts against the live `luxardo-flow` project without the owner
   saying so. Use the emulators (`firebase.e2e.json`).
5. Business rules come from the agreed Flow plan. If code and plan disagree,
   ask — do not silently change a rule.

## Deploy (owner-approved only)
```bash
npm run build -- --mode loom                       # needs real .env.loom
(cd functions-loom && npm ci && npm run build)
firebase deploy --config firebase.loom.json --project luxardo-flow
```
