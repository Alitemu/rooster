import { useEffect } from 'react';

// Without this, a modal open on a small screen lets scroll gestures reach
// the page behind it instead of the modal's own scrollable content.
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [active]);
}
