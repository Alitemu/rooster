'use client';

/**
 * The swaps of an AIOS period for the planner (lib/aiosRuilen.ts): who
 * asked whom, what for what, and how it stands. The AIOS swap without the
 * planner (L1, L2); the planner and the roosterbureau are mailed when one
 * goes through. The tab Ruilverzoeken of the section Dienstrooster
 * (components/AiosDienstrooster.tsx); before the roster is published it is
 * there and empty.
 */

import { useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import type { EenheidUit, RuilStatus, RuilUit } from '@/lib/aiosRuilen';

const kort = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
const wat = (e: EenheidUit) => (e.van === e.tot ? `${e.naam}, ${kort(e.van)}` : `${e.naam}, ${kort(e.van)} t/m ${kort(e.tot)}`);
const STATUS: Record<RuilStatus, string> = {
  IN_BEHANDELING: 'in behandeling',
  GOEDGEKEURD: 'goedgekeurd',
  AFGEWEZEN: 'afgewezen',
  INGETROKKEN: 'ingetrokken',
  VERVALLEN: 'vervallen',
};

export function AiosRuilenOverzicht({ periodId, gepubliceerd }: { periodId: string; gepubliceerd: boolean }) {
  const [ruilen, setRuilen] = useState<RuilUit[] | null>(null);
  const [fout, setFout] = useState<string | null>(null);

  useEffect(() => {
    fetch(withBasePath(`/api/aios/periode/${periodId}/ruilen`))
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Laden is mislukt');
        setRuilen(data.data);
      })
      .catch((err) => setFout(err instanceof Error ? err.message : 'Laden is mislukt'));
  }, [periodId]);

  return (
    <div className="space-y-2" data-testid="aios-ruilen-overzicht">
      <p className="text-sm text-neutral-700">
        De AIOS ruilen onderling, zonder jou. Gaat een ruil door, dan krijg jij een bericht via de stroom van de AIOS. Het roosterbureau krijgt alleen een bericht over ruilen in een definitief rooster.
      </p>
      {!gepubliceerd && <p className="text-sm text-neutral-600">Ruilen kan pas als het rooster gepubliceerd is.</p>}
      {fout && (
        <p role="alert" className="text-sm text-red-700">
          {fout}
        </p>
      )}
      {ruilen && ruilen.length === 0 && <p className="text-sm text-neutral-600">Nog geen ruilverzoeken.</p>}
      {ruilen && ruilen.length > 0 && (
        <ul className="divide-y text-sm">
          {ruilen.map((r) => (
            <li key={r.id} className="py-1.5">
              <span className="font-medium">{r.aanvrager}</span> geeft {wat(r.aangeboden)} aan <span className="font-medium">{r.respondent}</span> voor{' '}
              {wat(r.gevraagd)}: {STATUS[r.status]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
