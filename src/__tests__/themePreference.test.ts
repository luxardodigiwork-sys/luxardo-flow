/* eslint-disable */
/**
 * FOCUSED REGRESSION TEST — LUXARDO FLOW theme preference resolution (V1
 * Auth + Settings Stabilization): src/utils/theme.ts. Pure, dependency-free
 * logic (no React, no DOM) — ThemeContext.tsx is a thin wrapper around this
 * file and is exercised visually (not here) via the emulator browser check.
 *
 * Run (from repo root): npx tsx src/__tests__/themePreference.test.ts
 */
import { resolveTheme, isThemePreference, readStoredThemePreference, writeStoredThemePreference, THEME_STORAGE_KEY } from "../utils/theme";

let pass = true;
const fail = (msg: string) => {
  console.error(`FAIL: ${msg}`);
  pass = false;
};
const check = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  else console.log(`OK  ${label} -> ${JSON.stringify(actual)}`);
};

// ── resolveTheme: 'light'/'dark' always win outright; 'system' defers ────
check("resolveTheme('light', prefersDark=true) -> 'light'", resolveTheme("light", true), "light");
check("resolveTheme('light', prefersDark=false) -> 'light'", resolveTheme("light", false), "light");
check("resolveTheme('dark', prefersDark=false) -> 'dark'", resolveTheme("dark", false), "dark");
check("resolveTheme('dark', prefersDark=true) -> 'dark'", resolveTheme("dark", true), "dark");
check("resolveTheme('system', prefersDark=true) -> 'dark'", resolveTheme("system", true), "dark");
check("resolveTheme('system', prefersDark=false) -> 'light'", resolveTheme("system", false), "light");

// ── isThemePreference: exact literal match only ───────────────────────────
check("isThemePreference('system') -> true", isThemePreference("system"), true);
check("isThemePreference('light') -> true", isThemePreference("light"), true);
check("isThemePreference('dark') -> true", isThemePreference("dark"), true);
check("isThemePreference('SYSTEM') -> false (no case-folding)", isThemePreference("SYSTEM"), false);
check("isThemePreference(undefined) -> false", isThemePreference(undefined), false);
check("isThemePreference(null) -> false", isThemePreference(null), false);
check("isThemePreference('') -> false", isThemePreference(""), false);
check("isThemePreference('auto') -> false", isThemePreference("auto"), false);

// ── readStoredThemePreference: fails closed to 'system' ──────────────────
{
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null };
  check("readStoredThemePreference: empty storage -> 'system'", readStoredThemePreference(storage), "system");
  store.set(THEME_STORAGE_KEY, "dark");
  check("readStoredThemePreference: stored 'dark' -> 'dark'", readStoredThemePreference(storage), "dark");
  store.set(THEME_STORAGE_KEY, "corrupted-garbage");
  check("readStoredThemePreference: corrupted value -> fails closed to 'system'", readStoredThemePreference(storage), "system");
}
{
  const throwingStorage = { getItem: () => { throw new Error("storage unavailable"); } };
  check("readStoredThemePreference: throwing storage -> fails closed to 'system' (never throws)", readStoredThemePreference(throwingStorage), "system");
}

// ── writeStoredThemePreference: never throws even if storage is dead ─────
{
  let written: string | null = null;
  const storage = { setItem: (k: string, v: string) => { written = v; } };
  writeStoredThemePreference(storage, "light");
  check("writeStoredThemePreference: writes the preference", written, "light");
}
{
  const throwingStorage = { setItem: () => { throw new Error("quota exceeded"); } };
  let threw = false;
  try { writeStoredThemePreference(throwingStorage, "dark"); } catch { threw = true; }
  check("writeStoredThemePreference: throwing storage never propagates", threw, false);
}

if (!pass) {
  console.error("LUXARDO FLOW THEME PREFERENCE REGRESSION TEST: FAIL");
  process.exitCode = 1;
} else {
  console.log(
    "LUXARDO FLOW THEME PREFERENCE REGRESSION TEST: PASS — 'light'/'dark' always win " +
    "outright, 'system' defers exactly to the OS signal, preference parsing accepts only " +
    "the 3 exact literals, and both storage helpers fail closed/silent rather than throw."
  );
}
