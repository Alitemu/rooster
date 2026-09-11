import { useEffect } from 'react';
import type { MouseEvent } from 'react';

/**
 * Escape-to-close and click-outside-to-close for a modal dialog.
 *
 * None of this app's popups had either - the only way out was one of the
 * dialog's own buttons. Every dialog already tracks whether it's mid-action
 * (generating, submitting, publishing, ...) and disables its own Annuleren/
 * Sluiten button for that reason; `canDismiss` should mirror that same
 * condition so Escape/backdrop-click can't cut across it, e.g. leaving a
 * roster generation running with no dialog left open to show the result.
 *
 * Call unconditionally, like any hook - it's a no-op while `open` is false.
 * Returns the backdrop's onClick handler; wire it onto the same element
 * that has `role="dialog"` (the full-screen overlay, not the white card
 * inside it) so a click lands here only when it's genuinely on the
 * backdrop, not bubbled up from something inside the dialog.
 */
export function useDialogDismiss(
  open: boolean,
  onClose: () => void,
  canDismiss: boolean = true
): (e: MouseEvent<HTMLElement>) => void {
  useEffect(() => {
    if (!open || !canDismiss) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, canDismiss]);

  return (e: MouseEvent<HTMLElement>) => {
    if (canDismiss && e.target === e.currentTarget) onClose();
  };
}
