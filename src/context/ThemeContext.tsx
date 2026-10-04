import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import {
  ThemePreference,
  ResolvedTheme,
  resolveTheme,
  readStoredThemePreference,
  writeStoredThemePreference,
} from '../utils/theme';

interface ThemeContextValue {
  /** The User's stored choice: 'system' | 'light' | 'dark'. */
  preference: ThemePreference;
  /** The actual theme to render right now (preference resolved against the OS). */
  resolvedTheme: ResolvedTheme;
  setPreference: (pref: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * LUXARDO FLOW theme preference (V1 Auth + Settings Stabilization).
 *
 * Scoped to the Loom production app only — mounted once, inside
 * ProductionLayout.tsx, so it never affects the separate B2C storefront
 * (which has its own, unrelated, light-only design and is never rendered
 * under this provider). Persists to localStorage; 'system' tracks the OS's
 * prefers-color-scheme live via a matchMedia listener.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readStoredThemePreference(window.localStorage)
  );
  const [prefersDark, setPrefersDark] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
    writeStoredThemePreference(window.localStorage, pref);
  }, []);

  const resolvedTheme = resolveTheme(preference, prefersDark);

  const value = useMemo(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Safe outside a ThemeProvider too (e.g. a component rendered in both Loom
 * and B2C contexts) — falls back to 'light', never throws.
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx) return ctx;
  return { preference: 'system', resolvedTheme: 'light', setPreference: () => {} };
}
