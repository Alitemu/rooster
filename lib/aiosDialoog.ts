/**
 * What the AIOS's dialogs need to behave like a dialog: the page behind
 * stays still, and Escape or a click outside closes it. A copy of
 * lib/useBodyScrollLock.ts and lib/useDialogDismiss.ts, not an import of
 * them (docs/development/diensten.md, "Copied, not changed").
 */

import { useEffect } from 'react';
import type { MouseEvent } from 'react';

/** Without this, a modal open on a small screen lets scroll gestures reach the page behind it. */
export function useAiosScrollSlot(actief: boolean): void {
  useEffect(() => {
    if (!actief) return;
    const eerder = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = eerder;
    };
  }, [actief]);
}

/**
 * Escape and a click outside close a dialog. `magSluiten` mirrors "not busy",
 * so neither cuts across something that is running. Returns the backdrop's
 * onClick: wire it onto the overlay itself, not the card inside it.
 */
export function useAiosDialoogSluiten(open: boolean, sluit: () => void, magSluiten: boolean = true): (e: MouseEvent<HTMLElement>) => void {
  useEffect(() => {
    if (!open || !magSluiten) return;
    const bijToets = (e: KeyboardEvent) => {
      if (e.key === 'Escape') sluit();
    };
    window.addEventListener('keydown', bijToets);
    return () => window.removeEventListener('keydown', bijToets);
  }, [open, sluit, magSluiten]);

  return (e: MouseEvent<HTMLElement>) => {
    if (magSluiten && e.target === e.currentTarget) sluit();
  };
}
