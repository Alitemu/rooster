'use client';

/**
 * The AIOS's automatic reminders for one period (lib/aiosAutoHerinneringen.ts):
 * what goes out next and to how many AIOS, what already went out, and a
 * switch to pause them. A copy of components/AutoReminderPanel.tsx on the
 * AIOS's own route (docs/development/diensten.md, "Copied, not changed").
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { withBasePath } from '@/lib/basePath';
import { foutTekst } from '@/lib/aiosFoutTekst';

interface Status {
  aan: boolean;
  mailIngesteld: boolean;
  adresBekend: boolean;
  periodeOpen: boolean;
  volgende: {
    moment: string;
    laatste: boolean;
    nogNietsIngevuld: number;
    nogNietIngediend: number;
  } | null;
  geschiedenis: Array<{
    dagen_voor_deadline: number;
    moment: string;
    uitkomst: 'VERSTUURD' | 'OVERGESLAGEN';
    aantal_niet_begonnen: number;
    aantal_bezig: number;
  }>;
}

function moment(iso: string): string {
  return new Date(iso).toLocaleString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function aios(n: number): string {
  return `${n} AIOS`;
}

export function AiosAutoHerinneringen({ periodId, refreshKey }: { periodId: string; refreshKey?: unknown }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [fout, setFout] = useState<string | null>(null);
  const [bezig, setBezig] = useState(false);

  const laad = useCallback(async () => {
    try {
      const res = await fetch(withBasePath(`/api/aios/periode/${periodId}/auto-herinneringen`));
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message ?? 'Laden mislukt');
      setStatus(data.data);
      setFout(null);
    } catch (err) {
      setFout(foutTekst(err, 'Laden mislukt'));
    }
  }, [periodId]);

  useEffect(() => {
    laad();
  }, [laad, refreshKey]);

  const wissel = async () => {
    if (!status) return;
    setBezig(true);
    try {
      const res = await fetch(withBasePath(`/api/aios/periode/${periodId}/auto-herinneringen`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aan: !status.aan }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message ?? 'Opslaan mislukt');
      setStatus(data.data);
      setFout(null);
    } catch (err) {
      setFout(foutTekst(err, 'Opslaan mislukt'));
    } finally {
      setBezig(false);
    }
  };

  if (!status) {
    return fout ? <p className="text-sm text-red-700">{fout}</p> : null;
  }

  const verstuurd = status.geschiedenis.filter((h) => h.uitkomst === 'VERSTUURD');

  let regel: ReactNode;
  if (!status.mailIngesteld) {
    regel = 'Staan uit, want de mail voor de AIOS is nog niet ingesteld. Zie Mail naar de AIOS hierboven.';
  } else if (!status.periodeOpen) {
    regel = 'Alleen zolang de periode open staat en de deadline nog niet voorbij is.';
  } else if (!status.aan) {
    regel = 'Gepauzeerd voor deze periode. Een herinnering met de hand versturen kan gewoon.';
  } else if (!status.volgende) {
    regel = 'Er staan voor deze deadline geen automatische herinneringen meer gepland.';
  } else {
    const v = status.volgende;
    const totaal = v.nogNietsIngevuld + v.nogNietIngediend;
    regel = (
      <>
        Volgende: {v.laatste ? 'laatste herinnering' : 'herinnering'} op {moment(v.moment)}.{' '}
        {totaal === 0
          ? 'Op dit moment heeft iedere AIOS ingediend.'
          : `Nu zou die naar ${aios(totaal)} gaan: ${v.nogNietsIngevuld} nog niets ingevuld en ${v.nogNietIngediend} nog niet ingediend.`}
      </>
    );
  }

  return (
    <div className="border border-neutral-200 rounded p-4 space-y-2" data-testid="aios-auto-herinneringen">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-neutral-900">⏰ Automatische herinneringen</p>
          <p className="text-sm text-neutral-700 mt-1">
            Een week en een dag voor de deadline, om 9 uur, krijgt iedere AIOS die nog niet heeft ingediend vanzelf
            een herinnering.
          </p>
          <p className="text-sm text-neutral-700 mt-1">{regel}</p>
          {status.mailIngesteld && status.periodeOpen && status.aan && !status.adresBekend && (
            <p className="text-sm text-amber-800 mt-1">
              Verstuur eerst de uitnodigingen. Daarmee weet de server welk adres in de links hoort.
            </p>
          )}
        </div>
        {status.mailIngesteld && status.periodeOpen && (
          <button
            type="button"
            onClick={wissel}
            disabled={bezig}
            className="py-1.5 px-3 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50 whitespace-nowrap"
          >
            {status.aan ? 'Pauzeren' : 'Weer aanzetten'}
          </button>
        )}
      </div>
      {verstuurd.length > 0 && (
        <ul className="text-xs text-neutral-600 space-y-0.5">
          {verstuurd.map((h) => (
            <li key={h.moment}>
              ✓ {moment(h.moment)}: verstuurd aan {aios(h.aantal_niet_begonnen + h.aantal_bezig)}
            </li>
          ))}
        </ul>
      )}
      {fout && <p className="text-sm text-red-700">{fout}</p>}
    </div>
  );
}
