'use client';

/**
 * One person's streefbereik in a table cell (2.2.0): per kind of dienst the range in words and why it
 * differs from the band of the period when a saldo counts. Used by "Status voorkeuren"; the tab
 * "Dienstdoende" has its own since 2.3.0, with the range under each bar (lib/streefbereikPerPersoon.ts).
 */

import type { StreefbereikRij } from '@/lib/streefbereikPerPersoon';

const SOORTEN = [
  ['AVOND', 'Avond'],
  ['WEEKEND', 'Weekend'],
  ['FEESTDAG', 'Feestdag'],
] as const;

export function StreefbereikCel({ rij }: { rij: StreefbereikRij | null | undefined }) {
  if (!rij) return <span className="text-neutral-400">−</span>;
  return (
    <div className="text-xs leading-5 min-w-[10rem]" data-testid="streefbereik-cel">
      {SOORTEN.map(([sleutel, label]) => (
        <div key={sleutel}>
          {label}: <span className="font-medium text-neutral-900">{rij[sleutel].tekst}</span>
          {rij[sleutel].toelichting && <span className="block text-neutral-500">({rij[sleutel].toelichting})</span>}
        </div>
      ))}
    </div>
  );
}
