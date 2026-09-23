'use client';

import { useEffect, type RefObject } from 'react';

// How far the page has to move before a menu pinned at a fixed pixel
// position counts as "scrolled out from under" and closes.
const SCROLL_TOLERANCE_PX = 40;

/**
 * Closing rules shared by the right-click menus (roster calendar and
 * preferences calendar): an outside click, another right-click, Escape,
 * or scrolling the page away from where the menu was opened.
 *
 * Both menus used to close on ANY scroll event. The last bit of a
 * trackpad's or mouse wheel's momentum, or the browser bringing the
 * clicked day into view, still fires scroll events right after the
 * right-click - so the menu flashed open and shut again, and only a second
 * right-click kept it. Now scrolling only closes it once the page has
 * really moved (more than SCROLL_TOLERANCE_PX). A scroll inside the menu
 * itself (its own long list of names) never closes it.
 */
export function useContextMenuDismiss(
  /** The open menu's state, or null. A new value (reopened elsewhere) resets the scroll start. */
  openMenu: object | null,
  onClose: () => void,
  menuRef?: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!openMenu) return;
    const startX = window.scrollX;
    const startY = window.scrollY;

    const close = () => onClose();
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Capture phase: native scroll events don't bubble.
    const closeOnRealScroll = (e: Event) => {
      if (menuRef?.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      if (
        Math.abs(window.scrollY - startY) > SCROLL_TOLERANCE_PX ||
        Math.abs(window.scrollX - startX) > SCROLL_TOLERANCE_PX
      ) {
        onClose();
      }
    };

    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('scroll', closeOnRealScroll, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('scroll', closeOnRealScroll, true);
    };
    // onClose is a stable state setter wrapper at both call sites.
  }, [openMenu, onClose, menuRef]);
}
