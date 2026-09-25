import { useEffect } from 'react';

/**
 * Locks page scroll (document.body) while `active` is true — for modals and
 * drawers that render as a `fixed` overlay, which otherwise leaves the
 * underlying page scrollable behind the dialog. Restores the previous inline
 * overflow value on close/unmount so nested callers don't clobber each other.
 */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}
