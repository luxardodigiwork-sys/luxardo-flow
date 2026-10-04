/**
 * Pure helpers for the Loom Guide Tour system (src/components/production/
 * GuideTour.tsx). Kept dependency-free (no react-joyride, no DOM access by
 * default) so the role-config -> rendered-steps logic is unit-testable
 * without a browser/DOM test runner — consistent with this repo's existing
 * test style (src/__tests__/*.test.ts, run via `npx tsx`, no jsdom).
 */
import type { GuideTourRoleConfig, GuideTourStepConfig } from '../constants/guideTourSteps';

export interface BuiltTourStep {
  navPath: string;
  content: string;
}

/**
 * Build the final, safe step list for one tour run.
 *
 * Locked safety rule: a step is included ONLY if its navPath is in
 * `visibleNavPaths` (the role's ACTUAL currently-rendered nav items, passed
 * in by ProductionLayout from its own live `can()`-filtered nav list — not
 * re-derived here) AND `hasElement(navPath)` confirms the corresponding DOM
 * node genuinely exists right now. Two independent guards:
 *   1. visibleNavPaths — authoritative RBAC filter (never show a step for
 *      something this role cannot access, even if the static config drifts).
 *   2. hasElement — defensive DOM-existence check (never hand Joyride a
 *      target that isn't actually mounted, e.g. a responsive layout gap).
 * Order from `config.steps` is preserved; nothing is added or reordered.
 */
export function buildGuideTourSteps(
  config: Pick<GuideTourRoleConfig, 'steps'>,
  visibleNavPaths: readonly string[],
  hasElement: (navPath: string) => boolean
): BuiltTourStep[] {
  return config.steps.filter(
    (step: GuideTourStepConfig) => visibleNavPaths.includes(step.navPath) && hasElement(step.navPath)
  );
}

/** localStorage key for "has this role's uid already seen the tour" — versioned
 *  so a future content revision can force everyone to see it again by bumping it. */
export function getTourStorageKey(role: string): string {
  return `loom_guide_tour_seen_v1_${role}`;
}

/** Minimal storage shape — satisfied by window.localStorage, and easily faked in tests. */
export interface TourStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function hasTourBeenSeen(role: string, storage: TourStorageLike): boolean {
  try {
    return storage.getItem(getTourStorageKey(role)) === '1';
  } catch {
    return false;
  }
}

export function markTourSeen(role: string, storage: TourStorageLike): void {
  try {
    storage.setItem(getTourStorageKey(role), '1');
  } catch {
    // Storage unavailable (private mode, quota) — the tour simply replays
    // next visit. Never let this throw into the caller.
  }
}
