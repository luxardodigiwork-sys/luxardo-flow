/**
 * LUXARDO FLOW — theme preference resolution (V1 Auth + Settings
 * Stabilization).
 *
 * Kept as pure, dependency-free functions (no React, no DOM) so the
 * resolution logic is unit-testable without a renderer — ThemeContext.tsx
 * is a thin React wrapper around this file.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'loom_theme_preference';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * Resolve a stored preference + the OS's current color-scheme signal into
 * the actual theme to render. 'system' defers entirely to `prefersDark`;
 * 'light'/'dark' always win outright regardless of the OS signal.
 */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'light') return 'light';
  if (preference === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

/** Fails closed to 'system' for anything missing/unrecognised/corrupted. */
export function readStoredThemePreference(storage: Pick<Storage, 'getItem'>): ThemePreference {
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

/** Never throws — storage can be unavailable (private mode, quota, etc.). */
export function writeStoredThemePreference(storage: Pick<Storage, 'setItem'>, pref: ThemePreference): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Best-effort only — the in-memory React state still reflects the
    // choice for the rest of this session.
  }
}
