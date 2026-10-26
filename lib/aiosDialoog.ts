/**
 * What the AIOS's dialogs need to behave like a dialog: the page behind
 * stays still, Escape or a click outside closes it, and focus stays in it
 * (0.804.0). A copy of lib/useBodyScrollLock.ts, lib/useDialogDismiss.ts and
 * lib/dialogFocus.ts, not an import of them (docs/development/diensten.md, "Copied, not changed").
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

/** What can take focus inside a dialog. */
export const FOCUSBAAR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab (or Shift+Tab with `terug`) has to go to stay inside:
 * `undefined` when the browser's own step is fine, an item to jump to (past
 * the last one to the first, before the first to the last, or in from
 * outside the list), `null` when nothing can take focus: keep it on the dialog.
 */
export function focusSprong<T>(items: readonly T[], actief: T | null, terug: boolean): T | null | undefined {
  if (items.length === 0) return null;
  const plek = actief === null ? -1 : items.indexOf(actief);
  if (plek === -1) return terug ? items[items.length - 1] : items[0];
  if (!terug && plek === items.length - 1) return items[0];
  if (terug && plek === 0) return items[items.length - 1];
  return undefined;
}

const DIALOGEN = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';

/**
 * The dialog takes focus when it opens, Tab stays inside it, and the element
 * that opened it gets focus back when it closes. Called by
 * useAiosDialoogSluiten, so every AIOS dialog that closes on Escape has it.
 */
export function useAiosDialoogFocus(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const vorige = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const alle = () => Array.from(document.querySelectorAll<HTMLElement>(DIALOGEN));
    const dialoog = alle().pop();
    if (!dialoog) return;
    if (!dialoog.hasAttribute('tabindex')) dialoog.setAttribute('tabindex', '-1');
    dialoog.style.outline = 'none';
    const focusbaar = () => Array.from(dialoog.querySelectorAll<HTMLElement>(FOCUSBAAR)).filter((el) => el.offsetParent !== null);

    if (!dialoog.contains(document.activeElement)) (focusbaar()[0] ?? dialoog).focus();

    const bijToets = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // Only the dialog on top steers.
      if (alle().pop() !== dialoog) return;
      const actief = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const sprong = focusSprong(focusbaar(), actief, e.shiftKey);
      if (sprong === undefined) return;
      e.preventDefault();
      (sprong ?? dialoog).focus();
    };
    document.addEventListener('keydown', bijToets, true);

    // Focus that falls out of the dialog (the button that had it was replaced when the content loaded, or a
    // click landed on text) goes back to the dialog, or the dialog would be a place to tab out of again.
    const herstel = () => {
      if (!dialoog.isConnected || alle().pop() !== dialoog) return;
      if (!dialoog.contains(document.activeElement)) (focusbaar()[0] ?? dialoog).focus();
    };
    const waarnemer = new MutationObserver(herstel);
    waarnemer.observe(dialoog, { childList: true, subtree: true });
    document.addEventListener('focusout', herstelStraks, true);
    function herstelStraks() {
      setTimeout(herstel, 0);
    }
    return () => {
      waarnemer.disconnect();
      document.removeEventListener('focusout', herstelStraks, true);
      document.removeEventListener('keydown', bijToets, true);
      if (vorige && vorige.isConnected) vorige.focus();
    };
  }, [open]);
}

/**
 * Escape and a click outside close a dialog. `magSluiten` mirrors "not busy",
 * so neither cuts across something that is running. Returns the backdrop's
 * onClick: wire it onto the overlay itself, not the card inside it.
 */
export function useAiosDialoogSluiten(open: boolean, sluit: () => void, magSluiten: boolean = true): (e: MouseEvent<HTMLElement>) => void {
  useAiosDialoogFocus(open);
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
