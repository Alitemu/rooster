'use client';

/**
 * A place elsewhere on the page that a component fills (1.12.0): the two slots in the app's blue bar
 * (app/layout.tsx: kop-links and kop-midden) and the column left of the period page (onderdelen-links,
 * app/planner/period/[id]/page.tsx). In its new layout the period page of the achterwacht puts the menu
 * button, the period's name and the list of sections there (components/PlannerDashboard.tsx). Nothing
 * else uses them, and an empty slot takes no room.
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type Plek = 'kop-links' | 'kop-midden' | 'onderdelen-links';

const nooit = () => () => {};

export function InPlek({ plek, children }: { plek: Plek; children: ReactNode }) {
  // Looked up in the browser only. A slot that comes on the page in the same pass is found right after:
  // React reads the snapshot again once the page is committed.
  const doel = useSyncExternalStore(
    nooit,
    () => document.getElementById(plek),
    () => null
  );
  return doel ? createPortal(children, doel) : null;
}
