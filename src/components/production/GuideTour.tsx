import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Joyride, STATUS, type Step, type EventData } from 'react-joyride';
import { GUIDE_TOUR_CONFIG, type GuideTourRole } from '../../constants/guideTourSteps';
import { buildGuideTourSteps, getTourStorageKey, hasTourBeenSeen, markTourSeen } from '../../utils/guideTour';

/** Breakpoint matching Tailwind's `md:` (ProductionLayout switches between
 *  its desktop sidebar and mobile drawer at this width). */
const MOBILE_BREAKPOINT_PX = 768;

/** Data attribute holding the nav path, written per-item in ProductionLayout
 *  — one set for the desktop sidebar, one for the mobile drawer, since only
 *  one of the two is ever actually visible/measurable at a time. */
function navAttrFor(isMobile: boolean): string {
  return isMobile ? 'data-tour-nav-mobile' : 'data-tour-nav-desktop';
}

export interface GuideTourProps {
  /** Canonical staff role, e.g. 'owner' | 'guard' | ... */
  role: string;
  /** The nav paths ProductionLayout is ACTUALLY rendering for this role right
   *  now (its own live can()-filtered list) — the authoritative RBAC guard;
   *  see buildGuideTourSteps's doc comment. */
  visibleNavPaths: string[];
  /** Whether the mobile drawer is currently open. */
  mobileMenuOpen: boolean;
  /** Ask ProductionLayout to open/close the mobile drawer (needed so the
   *  tour can measure/highlight mobile nav items, which only exist in the
   *  DOM while the drawer is open). */
  onRequestMobileMenu: (open: boolean) => void;
  /** Bump this (e.g. ++count) to force-replay the tour regardless of
   *  first-run "seen" state — wired to the sidebar/mobile "Help" button. */
  replaySignal: number;
}

/**
 * ONE reusable guide-tour system for all 11 Loom staff roles — role-specific
 * content lives in src/constants/guideTourSteps.ts; this component only
 * knows how to run react-joyride against whatever that config + the live
 * nav produce. No per-role component, no duplicated tour logic.
 *
 * Auto-starts once per role (localStorage-tracked, dismissible via
 * react-joyride's own Skip/Close), and can be replayed anytime via
 * `replaySignal`. Every step either targets a real, currently-visible nav
 * item (gated by buildGuideTourSteps's double RBAC+DOM check) or is a
 * centered, targetless welcome/outro card — so a tour step can never expose
 * a control a role is not authorized to see.
 */
export default function GuideTour({
  role,
  visibleNavPaths,
  mobileMenuOpen,
  onRequestMobileMenu,
  replaySignal,
}: GuideTourProps) {
  const [run, setRun] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const prevReplaySignal = useRef(replaySignal);
  const mobileMenuWasOpenedByTour = useRef(false);

  const startTour = useCallback(() => {
    const config = GUIDE_TOUR_CONFIG[role as GuideTourRole];
    if (!config) return;

    const launch = () => {
      const attr = navAttrFor(window.innerWidth < MOBILE_BREAKPOINT_PX);
      const navSteps = buildGuideTourSteps(config, visibleNavPaths, (navPath) =>
        !!document.querySelector(`[${attr}="${navPath}"]`)
      );

      const built: Step[] = [
        {
          target: 'body',
          placement: 'center',
          title: config.welcomeTitle,
          content: config.welcomeBody,
        },
        ...navSteps.map((s) => ({
          target: `[${attr}="${s.navPath}"]`,
          content: s.content,
        })),
        {
          target: 'body',
          placement: 'center',
          content: config.outroBody,
        },
      ];
      setSteps(built);
      setRun(true);
    };

    if (window.innerWidth < MOBILE_BREAKPOINT_PX && !mobileMenuOpen) {
      mobileMenuWasOpenedByTour.current = true;
      onRequestMobileMenu(true);
      // Let the drawer's enter animation mount before measuring targets.
      window.setTimeout(launch, 350);
    } else {
      launch();
    }
  }, [role, visibleNavPaths, mobileMenuOpen, onRequestMobileMenu]);

  // Auto-start once per role, after the layout has settled.
  useEffect(() => {
    if (!role) return;
    if (hasTourBeenSeen(role, window.localStorage)) return;
    const t = window.setTimeout(startTour, 700);
    return () => window.clearTimeout(t);
    // Intentionally role-only: re-checks "seen" only when the signed-in
    // role changes, not on every visibleNavPaths re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  // Manual replay (Help button) — only reacts when the signal actually changes.
  useEffect(() => {
    if (replaySignal !== prevReplaySignal.current) {
      prevReplaySignal.current = replaySignal;
      startTour();
    }
  }, [replaySignal, startTour]);

  const handleEvent = useCallback(
    (data: EventData) => {
      if (data.status === STATUS.FINISHED || data.status === STATUS.SKIPPED) {
        setRun(false);
        markTourSeen(role, window.localStorage);
        if (mobileMenuWasOpenedByTour.current) {
          mobileMenuWasOpenedByTour.current = false;
          onRequestMobileMenu(false);
        }
      }
    },
    [role, onRequestMobileMenu]
  );

  if (!GUIDE_TOUR_CONFIG[role as GuideTourRole]) return null;

  return (
    <Joyride
      key={getTourStorageKey(role)}
      steps={steps}
      run={run}
      continuous
      scrollToFirstStep
      onEvent={handleEvent}
      options={{
        primaryColor: '#000000',
        zIndex: 10000,
        skipBeacon: true,
        showProgress: true,
        buttons: ['back', 'close', 'primary', 'skip'],
      }}
      locale={{ last: 'Done', skip: 'Skip tour' }}
    />
  );
}
