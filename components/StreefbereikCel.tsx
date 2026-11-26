'use client';

/**
 * One person's streefbereik in a table cell (2.2.0): per kind of dienst the range in words, why it differs
 * from the band of the period when a saldo counts, and where someone falls outside it. Used by "Status
 * voorkeuren" and by the tab "Dienstdoende" (lib/streefbereikPerPersoon.ts).
 */

import type { StreefbereikRij } from '@/lib/streefbereikPerPersoon';

const SOORTEN = [
  ['AVOND', 'Avond'],
  ['WEEKEND', 'Weekend'],
  ['FEESTDAG', 'Feestdag'],
] as const;

export function StreefbereikCel({ rij, buiten = [] }: { rij: StreefbereikRij | null | undefined; buiten?: string[] }) {
  if (!rij) return <span className="text-neutral-400">−</span>;
  return (
    <div className="text-xs leading-5 min-w-[10rem]" data-testid="streefbereik-cel">
      {SOORTEN.map(([sleutel, label]) => (
        <div key={sleutel}>
          {label}: <span className="font-medium text-neutral-900">{rij[sleutel].tekst}</span>
          {rij[sleutel].toelichting && <span className="block text-neutral-500">({rij[sleutel].toelichting})</span>}
        </div>
      ))}
      {buiten.length > 0 && (
        <div
          className="mt-1 font-medium text-amber-800"
          data-testid="buiten-bereik"
          title="Buiten het eigen bereik. Is het rooster gepubliceerd, dan telt dit verschil mee in de volgende periode."
        >
          ⚠ {buiten.join(' en ')}
        </div>
      )}
    </div>
  );
}
