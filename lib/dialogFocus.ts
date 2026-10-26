/**
 * Focus in a modal dialog: it takes focus when it opens, Tab and Shift+Tab
 * stay inside it, and the element that opened it gets focus back when it
 * closes. The dialogs said aria-modal="true" and closed on Escape, but Tab
 * walked straight out of them into the page behind (0.804.0).
 *
 * The cycling rule is a plain function (focusSprong) so that it is tested
 * without a browser; useDialogFocus does the DOM work and is covered by
 * tests/e2e/dialog-focus.e2e.ts. Called from useDialogDismiss, so every
 * dialog that closes on Escape gets it. The AIOS has its own copy
 * (lib/aiosDialoog.ts, docs/development/diensten.md "Copied, not changed").
 */

import { useEffect } from 'react';

/** What can take focus inside a dialog. */
export const FOCUSBAAR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab (or Shift+Tab with `terug`) has to go to stay inside:
 * - `undefined`: the browser's own step is fine (focus is inside, not at the edge);
 * - an item: jump there (past the last one to the first, before the first to
 *   the last, or in from outside the list);
 * - `null`: nothing in the dialog can take focus, so keep it on the dialog itself.
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

export function useDialogFocus(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const vorige = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const alle = () => Array.from(document.querySelectorAll<HTMLElement>(DIALOGEN));
    const dialoog = alle().pop();
    if (!dialoog) return;
    // The dialog itself can take focus, for one without anything to tab to.
    if (!dialoog.hasAttribute('tabindex')) dialoog.setAttribute('tabindex', '-1');
    dialoog.style.outline = 'none';
    const focusbaar = () => Array.from(dialoog.querySelectorAll<HTMLElement>(FOCUSBAAR)).filter((el) => el.offsetParent !== null);

    if (!dialoog.contains(document.activeElement)) (focusbaar()[0] ?? dialoog).focus();

    const bijToets = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // Only the dialog on top steers: one opened from within another takes over while it is there.
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
