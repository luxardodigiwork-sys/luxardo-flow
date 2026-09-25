/**
 * A keyed, single-producer/multi-consumer async resolution channel.
 *
 * Built to fix the LUXARDO FLOW (Loom) staff-login race: AuthContext's
 * onAuthStateChanged listener is the one authoritative resolver of Loom
 * staff identity for a signed-in Firebase uid. RoleLoginPage's login
 * handlers need to know that SAME result before navigating, without ever
 * performing their own second, independent read (which — historically —
 * could disagree with, and unilaterally sign out, a session the
 * authoritative resolver had already approved).
 *
 * `settle(key, result)` is called exactly once by the authoritative
 * producer. `wait(key)` may be called before OR after settle() — a caller
 * that starts waiting first is queued and resolved when settle() runs; a
 * caller that starts waiting after settle() already ran for that key gets
 * the cached result immediately. Framework-free and dependency-free so it
 * can be unit-tested directly (see src/__tests__/resolutionChannel.test.ts).
 */
export class ResolutionChannel<T> {
  private lastSettled: { key: string; result: T } | null = null;
  private waiters = new Map<string, Array<(result: T) => void>>();

  /** Authoritative producer: resolve `key` to `result`, waking any waiters. */
  settle(key: string, result: T): void {
    this.lastSettled = { key, result };
    const list = this.waiters.get(key);
    if (list) {
      list.forEach((resolve) => resolve(result));
      this.waiters.delete(key);
    }
  }

  /**
   * Await the (single) resolution for `key`. Resolves immediately if
   * settle(key, ...) already ran; otherwise queues and resolves when it
   * does. Rejects if neither happens within `timeoutMs`.
   */
  wait(key: string, timeoutMs = 12000): Promise<T> {
    if (this.lastSettled && this.lastSettled.key === key) {
      return Promise.resolve(this.lastSettled.result);
    }
    return new Promise<T>((resolve, reject) => {
      const settle = (result: T) => {
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        const list = this.waiters.get(key);
        if (list) {
          const idx = list.indexOf(settle);
          if (idx !== -1) list.splice(idx, 1);
        }
        reject(new Error('Sign-in verification timed out. Please try again.'));
      }, timeoutMs);
      const list = this.waiters.get(key) || [];
      list.push(settle);
      this.waiters.set(key, list);
    });
  }

  /** Wake any still-pending waiters (e.g. on provider unmount) so they don't hang until their own timeout. */
  dispose(fallback: T): void {
    this.waiters.forEach((list) => list.forEach((resolve) => resolve(fallback)));
    this.waiters.clear();
  }
}
