'use client';

/**
 * A place elsewhere on the page that the AIOS's period page fills in its new layout (1.13.0): the two
 * slots in the app's blue bar (app/layout.tsx: kop-links and kop-midden, shared by every page and empty
 * on most) and places of the page's own. A copy of components/InPlek.tsx (docs/development/diensten.md
 * "Copied, not changed").
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type AiosPlek = 'kop-links' | 'kop-midden' | 'aios-onderdelen-links' | 'aios-feestdagblokken';

const nooit = () => () => {};

export function AiosInPlek({ plek, children }: { plek: AiosPlek; children: ReactNode }) {
  // Looked up in the browser only. A slot that comes on the page in the same pass is found right after:
  // React reads the snapshot again once the page is committed.
  const doel = useSyncExternalStore(
    nooit,
    () => document.getElementById(plek),
    () => null
  );
  return doel ? createPortal(children, doel) : null;
}
