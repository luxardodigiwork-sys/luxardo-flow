/* eslint-disable */
/**
 * REGRESSION TEST — LUXARDO FLOW (Loom) staff-login race condition.
 *
 * Root cause (fixed in this change): RoleLoginPage.verifyRole() used to do
 * its OWN independent getDoc(staff/{uid}) read after sign-in, redundant with
 * the read AuthContext's onAuthStateChanged listener also performs. Because
 * AuthContext's copy could resolve first and navigate the user into
 * /production (via RoleLoginPage's `useEffect([user, isAuthReady])`) while
 * the second, redundant read was still in flight, a transient failure in
 * that SECOND read would call signOut(auth) and destroy the session the
 * first read had already approved — bouncing the user straight back to
 * /login with no Firebase session at all.
 *
 * The fix (src/utils/resolutionChannel.ts + src/context/AuthContext.tsx +
 * src/components/auth/RoleLoginPage.tsx) makes AuthContext's read the ONE
 * authoritative resolution, and has the login page await that SAME result
 * via ResolutionChannel instead of re-reading staff/{uid} itself. This test
 * exercises ResolutionChannel directly — the exact primitive that closes the
 * race — covering both possible orderings (waiter registers before the
 * authoritative settle(), and after) plus the timeout fail-closed path.
 * Pure, dependency-free logic (no React, no Firebase), matching the
 * `rolePermissions.med5.test.ts` convention: not wired into a test runner
 * (the repo has none yet) — runs directly via tsx.
 *
 * Run (from repo root):
 *   npx tsx src/__tests__/resolutionChannel.authRace.test.ts
 */
import { ResolutionChannel } from '../utils/resolutionChannel';

let pass = true;
const fail = (msg: string) => {
  console.error(`FAIL: ${msg}`);
  pass = false;
};
const check = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`OK  ${label} -> ${JSON.stringify(actual)}`);
  }
};

async function main() {
  // ── Case 1: waiter registers BEFORE the authoritative settle() ──────────
  // Mirrors RoleLoginPage calling waitForResolution(uid) while
  // onAuthStateChanged's getDoc() read is still in flight.
  {
    const ch = new ResolutionChannel<{ role: string } | null>();
    const waitPromise = ch.wait('uid-1');
    // authoritative producer resolves afterwards, exactly once
    ch.settle('uid-1', { role: 'owner' });
    const result = await waitPromise;
    check('waiter-before-settle resolves with the authoritative result', result?.role, 'owner');
  }

  // ── Case 2: waiter registers AFTER settle() already ran ──────────────────
  // Mirrors a login handler reaching the await slightly later than
  // onAuthStateChanged already finished (the common real-world ordering).
  {
    const ch = new ResolutionChannel<{ role: string } | null>();
    ch.settle('uid-2', { role: 'guard' });
    const result = await ch.wait('uid-2');
    check('waiter-after-settle resolves immediately with the cached result', result?.role, 'guard');
  }

  // ── Case 3: THE RACE — two "callers" for the same uid must see the SAME
  // single resolution, never two independent, possibly-disagreeing answers.
  // This is the direct regression check for the original bug: there must be
  // exactly one producer decision, not two.
  {
    const ch = new ResolutionChannel<{ role: string } | null>();
    const callerA = ch.wait('uid-3'); // e.g. AuthContext's own internal consumer
    const callerB = ch.wait('uid-3'); // e.g. RoleLoginPage awaiting the same login
    ch.settle('uid-3', { role: 'dispatch' });
    const [a, b] = await Promise.all([callerA, callerB]);
    check('both waiters observe the identical resolved value (a)', a?.role, 'dispatch');
    check('both waiters observe the identical resolved value (b)', b?.role, 'dispatch');
    check('settle() was the single source of truth for both', a, b);
  }

  // ── Case 4: fail-closed identity (null) propagates correctly, not just
  // "truthy" results — this is the "not a recognised staff member" path. ──
  {
    const ch = new ResolutionChannel<{ role: string } | null>();
    const waitPromise = ch.wait('uid-4');
    ch.settle('uid-4', null);
    const result = await waitPromise;
    check('unrecognised-identity resolution propagates as null (fail closed)', result, null);
  }

  // ── Case 5: timeout path — if the authoritative resolver never settles,
  // the waiter must reject (so the caller can fail closed), not hang forever
  // and not silently resolve as if authorised. ──────────────────────────────
  {
    const ch = new ResolutionChannel<{ role: string } | null>();
    let threw = false;
    try {
      await ch.wait('uid-never', 50);
    } catch (e: any) {
      threw = true;
      check('timeout rejects with a descriptive error', typeof e?.message === 'string' && e.message.length > 0, true);
    }
    check('unresolved key times out (rejects) rather than hanging or auto-approving', threw, true);
  }

  // ── Case 6: dispose() wakes pending waiters with the given fallback
  // instead of leaving them hanging (provider-unmount safety net). ─────────
  {
    const ch = new ResolutionChannel<{ role: string } | null>();
    const waitPromise = ch.wait('uid-dispose', 5000);
    ch.dispose(null);
    const result = await waitPromise;
    check('dispose() resolves pending waiters with the fallback value', result, null);
  }

  // ── Case 7: settle() for a DIFFERENT key must not resolve an unrelated
  // waiter — the channel is keyed per-uid, not global. ──────────────────────
  {
    const ch = new ResolutionChannel<{ role: string } | null>();
    let resolvedTooEarly = false;
    // Short timeout + caught rejection: we only care that it did NOT resolve
    // (via the .then) before settle('uid-B', ...) below; its eventual timeout
    // rejection is expected and swallowed so it doesn't surface as an
    // unhandled rejection after this test process exits.
    ch.wait('uid-A', 100).then(() => { resolvedTooEarly = true; }).catch(() => {});
    ch.settle('uid-B', { role: 'tailor' });
    await new Promise((r) => setTimeout(r, 20));
    check('settle() for a different key does not resolve an unrelated waiter', resolvedTooEarly, false);
    await new Promise((r) => setTimeout(r, 100)); // let uid-A's own timeout settle/be caught before exit
  }

  if (!pass) {
    console.error('AUTH RACE REGRESSION TEST: FAIL');
    process.exitCode = 1;
  } else {
    console.log(
      'AUTH RACE REGRESSION TEST: PASS — a single authoritative settle() per uid ' +
      'is observed identically by every waiter (no more independent, ' +
      'possibly-disagreeing second read), fail-closed (null) results propagate ' +
      'correctly, and an unresolved key times out / disposes safely instead of ' +
      'hanging or silently authorising.'
    );
  }
}

main();
