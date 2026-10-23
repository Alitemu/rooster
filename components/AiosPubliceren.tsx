'use client';

/**
 * Publishing the AIOS's roster on the planner's page (docs/aios-rooster.md,
 * step 4d; lib/aiosPublicatie.ts): the check (an empty dienst stops it,
 * warnings need a yes), "Voorlopig publiceren", then "Definitief maken"
 * and "Publicatie intrekken", what the mail did, and the roster as Excel
 * for the roosterbureau, the opleider and the ward.
 */

import { useCallback, useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import type { AiosPublicatieControle, AiosPublicatieStand } from '@/lib/aiosPublicatie';
import { foutTekst } from '@/lib/aiosFoutTekst';

const moment = (iso: string) => new Date(iso).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });

type Actie = 'publiceren' | 'definitief' | 'intrekken';
const ROUTE: Record<Actie, string> = { publiceren: 'publiceren', definitief: 'definitief-maken', intrekken: 'publicatie-intrekken' };

export function AiosPubliceren({ periodId, status, onChanged }: { periodId: string; status: string; onChanged: () => void }) {
  const [stand, setStand] = useState<AiosPublicatieStand | null>(null);
  const [zeker, setZeker] = useState<Actie | null>(null);
  const [bezig, setBezig] = useState(false);
  const [melding, setMelding] = useState<{ fout: boolean; tekst: string } | null>(null);
  const [controle, setControle] = useState<AiosPublicatieControle | null>(null);

  const laad = useCallback(() => {
    fetch(withBasePath(`/api/aios/periode/${periodId}/publicatie`))
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Laden is mislukt');
        setStand(data.data);
        setControle(data.data.controle);
      })
      .catch((err) => setMelding({ fout: true, tekst: foutTekst(err, 'Laden is mislukt') }));
  }, [periodId]);
  useEffect(() => laad(), [laad, status]);

  const doe = async (actie: Actie, bevestigd: boolean) => {
    setBezig(true);
    setMelding(null);
    try {
      const res = await fetch(withBasePath(`/api/aios/periode/${periodId}/${ROUTE[actie]}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bevestigd }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        if (data?.error?.controle) setControle(data.error.controle);
        throw new Error(data?.error?.message || 'Dat is mislukt');
      }
      const mail = data.data.mail as { verstuurd: boolean; aantal?: number; melding?: string };
      const wat = actie === 'publiceren' ? 'Voorlopig gepubliceerd.' : actie === 'definitief' ? 'Het rooster is definitief.' : 'De publicatie is ingetrokken.';
      setMelding({
        fout: !mail.verstuurd,
        tekst: actie === 'intrekken' ? wat : mail.verstuurd ? `${wat} De mail aan ${mail.aantal} AIOS is verstuurd.` : `${wat} ${mail.melding}`,
      });
      setZeker(null);
      onChanged();
      laad();
    } catch (err) {
      setMelding({ fout: true, tekst: foutTekst(err, 'Dat is mislukt') });
    } finally {
      setBezig(false);
    }
  };

  if (!stand) return null;
  const knop = 'px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50';
  const gepubliceerd = stand.status === 'GEPUBLICEERD';
  const c = controle ?? stand.controle;
  const kan = c.problemen.length === 0;
  const metWaarschuwing = c.waarschuwingen.length > 0;

  return (
    // A block of the card at the top of the page (components/AiosRoosterMaken.tsx), not a section of its own.
    <div className="border-t pt-3 space-y-3" data-testid="aios-publiceren">
      {!gepubliceerd && (
        <p className="text-sm text-neutral-700">
          Voorlopig publiceren: elke AIOS krijgt een mail met de eigen diensten om na te kijken en ziet ze in de app. Daarna maak je het rooster
          definitief.
        </p>
      )}
      {gepubliceerd && stand.gepubliceerd_op && (
        <p className="text-sm text-neutral-800">
          Voorlopig gepubliceerd op {moment(stand.gepubliceerd_op)}.
          {stand.definitief_op ? ` Definitief sinds ${moment(stand.definitief_op)}.` : ' Nog niet definitief.'}
        </p>
      )}
      {gepubliceerd && !stand.definitief_op && (
        <p className="text-sm text-neutral-700">
          Corrigeer wat de AIOS melden met de hand in het rooster hieronder. Een reden is dan verplicht. Daarna maak je het rooster definitief: iedereen
          krijgt de definitieve diensten met wat er voor hen veranderde.
        </p>
      )}
      {!stand.mail_ingesteld && (
        <p className="text-sm text-neutral-800">De mail voor de AIOS is nog niet ingesteld. Publiceren kan, maar dan gaat er geen mail.</p>
      )}
      {c.problemen.length > 0 && (
        <div className="rounded border-2 border-neutral-900 p-3 text-sm" role="alert">
          <p className="font-medium">Nog niet klaar om te publiceren:</p>
          <ul className="list-disc pl-5">
            {c.problemen.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {metWaarschuwing && (
        <div className="rounded border-2 border-dashed border-neutral-800 p-3 text-sm" data-testid="aios-publicatie-waarschuwingen">
          <p className="font-medium">⚠ Waarschuwingen:</p>
          <ul className="list-disc pl-5">
            {c.waarschuwingen.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {zeker && (
        <div className="rounded border border-neutral-400 p-3 text-sm space-y-2" role="status">
          <p>
            {zeker === 'publiceren' && 'Alle AIOS krijgen nu tegelijk een mail met hun voorlopige diensten.'}
            {zeker === 'definitief' && 'Alle AIOS krijgen nu tegelijk een mail met hun definitieve diensten.'}
            {zeker === 'intrekken' && 'Het rooster gaat terug naar gemaakt. De AIOS zien het niet meer, maar er gaat geen mail. Alle diensten blijven staan.'}
            {zeker !== 'intrekken' && metWaarschuwing && ' Het rooster heeft waarschuwingen.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed" disabled={bezig} onClick={() => doe(zeker, metWaarschuwing)}>
              {zeker === 'publiceren' ? (metWaarschuwing ? 'Ja, toch publiceren' : 'Ja, publiceren') : zeker === 'definitief' ? 'Ja, definitief maken' : 'Ja, intrekken'}
            </button>
            <button type="button" className={knop} disabled={bezig} onClick={() => setZeker(null)}>
              Annuleren
            </button>
          </div>
        </div>
      )}
      {!zeker && (
        <div className="flex flex-wrap gap-2">
          {!gepubliceerd && (
            <button type="button" className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed" disabled={bezig || !kan} onClick={() => setZeker('publiceren')}>
              Voorlopig publiceren
            </button>
          )}
          {gepubliceerd && !stand.definitief_op && (
            <button type="button" className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed" disabled={bezig || !kan} onClick={() => setZeker('definitief')}>
              Definitief maken
            </button>
          )}
          {gepubliceerd && (
            <button type="button" className={knop} disabled={bezig} onClick={() => setZeker('intrekken')}>
              Publicatie intrekken
            </button>
          )}
        </div>
      )}
      {melding && (
        <p role={melding.fout ? 'alert' : 'status'} className={`text-sm ${melding.fout ? 'text-red-700' : 'text-neutral-800'}`}>
          {melding.tekst}
        </p>
      )}
      <div className="border-t pt-3 space-y-2">
        {gepubliceerd && stand.definitief_op ? (
          <>
            <p className="text-sm text-neutral-700">Het rooster als Excel, voor het roosterbureau, de opleider en de afdeling:</p>
            <div className="flex flex-wrap gap-2">
              <a className={knop} href={withBasePath(`/api/aios/periode/${periodId}/download-rooster`)}>
                Rooster per dag
              </a>
              <a className={knop} href={withBasePath(`/api/aios/periode/${periodId}/download-per-aios`)}>
                Per AIOS met compensatiedagen
              </a>
            </div>
          </>
        ) : (
          <p className="text-sm text-neutral-700" data-testid="aios-excel-pas-definitief">
            De Excel voor het roosterbureau, de opleider en de afdeling komt beschikbaar als het rooster definitief is. Een voorlopig rooster gaat nergens
            heen.
          </p>
        )}
      </div>
    </div>
  );
}
