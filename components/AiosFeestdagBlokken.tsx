'use client';

/**
 * The questions about the blocks around feestdagen and New Year's Eve
 * (docs/aios-rooster.md, "Blokken rond feestdagen"; lib/aiosFeestdagBlokken.ts),
 * above "Rooster maken": per block in feestdagen in a row whole or cut up,
 * which the planner must answer first; blocks with a single feestdag,
 * whole unless cut up; and one or two AIOS on New Year's Eve. The parent
 * keeps "Rooster maken" off while a required question is open or a change
 * is not saved yet.
 */

import { useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import { BLOK_VORM_LABELS } from '@/lib/aiosDiensten';
import type { BlokKeuze, BlokVraag, FeestdagVragen } from '@/lib/aiosFeestdagBlokken';
import { foutTekst } from '@/lib/aiosFoutTekst';

export interface FeestdagStaat {
  open: number;
  gewijzigd: boolean;
}

const datumKort = (datum: string) =>
  new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });

/** "A", "A en B", "A, B en C": no comma before en. */
const opsomming = (namen: string[]) => (namen.length < 2 ? namen.join('') : `${namen.slice(0, -1).join(', ')} en ${namen[namen.length - 1]}`);

function BlokKeuzeVeld({
  vraag,
  keuze,
  disabled,
  onKies,
}: {
  vraag: BlokVraag;
  keuze: BlokKeuze | null;
  disabled: boolean;
  onKies: (k: BlokKeuze) => void;
}) {
  const naam = `${vraag.soort === 'AVOND' ? 'Avondblok' : 'Nachtblok'} ${BLOK_VORM_LABELS[vraag.vorm]}`;
  return (
    <fieldset className={`rounded border p-2 ${keuze === null ? 'border-2 border-dashed border-neutral-800' : 'border-neutral-300'}`}>
      <legend className="px-1 text-sm font-medium text-neutral-900">
        {naam}, {datumKort(vraag.start_datum)} t/m {datumKort(vraag.eind_datum)}
        {keuze === null && <span className="ml-1 font-semibold">(nog kiezen)</span>}
      </legend>
      <p className="text-xs text-neutral-600">Met {opsomming(vraag.feestdagen)}.</p>
      <div className="mt-1 flex flex-col gap-1 text-sm sm:flex-row sm:gap-4">
        <label className="flex items-center gap-2">
          <input type="radio" name={`blok-${vraag.blok_id}`} checked={keuze === 'HEEL'} disabled={disabled} onChange={() => onKies('HEEL')} />
          Heel laten: één AIOS doet het hele blok
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`blok-${vraag.blok_id}`}
            checked={keuze === 'OPKNIPPEN'}
            disabled={disabled}
            onChange={() => onKies('OPKNIPPEN')}
          />
          Opknippen: elke dag een losse dienst
        </label>
      </div>
    </fieldset>
  );
}

export function AiosFeestdagBlokken({
  periodId,
  status,
  disabled,
  onStaat,
}: {
  periodId: string;
  status: string;
  disabled: boolean;
  onStaat: (s: FeestdagStaat) => void;
}) {
  const [vragen, setVragen] = useState<FeestdagVragen | null>(null);
  const [keuzes, setKeuzes] = useState<Record<string, BlokKeuze | null>>({});
  const [oudjaar, setOudjaar] = useState<1 | 2>(2);
  const [bezig, setBezig] = useState(false);
  const [melding, setMelding] = useState<{ fout: boolean; tekst: string } | null>(null);

  const neem = (v: FeestdagVragen) => {
    setVragen(v);
    setKeuzes(Object.fromEntries([...v.groepen.flatMap((g) => g.blokken), ...v.losse].map((b) => [b.blok_id, b.keuze])));
    setOudjaar(v.oudjaar?.aantal ?? 2);
  };

  useEffect(() => {
    let actief = true;
    fetch(withBasePath(`/api/aios/periode/${periodId}/feestdagblokken`))
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Laden van de blokken rond feestdagen is mislukt');
        if (actief) neem(data.data);
      })
      .catch((err) => actief && setMelding({ fout: true, tekst: foutTekst(err, 'Laden is mislukt') }));
    return () => {
      actief = false;
    };
  }, [periodId, status]);

  const alle = vragen ? [...vragen.groepen.flatMap((g) => g.blokken), ...vragen.losse] : [];
  const gewijzigd = !!vragen && (alle.some((b) => keuzes[b.blok_id] !== b.keuze) || (!!vragen.oudjaar && oudjaar !== vragen.oudjaar.aantal));
  // What is still to choose on the screen; gewijzigd says it is not saved yet.
  const open = alle.filter((b) => b.verplicht && !keuzes[b.blok_id]).length;
  useEffect(() => onStaat({ open, gewijzigd }), [open, gewijzigd, onStaat]);

  if (!vragen || (alle.length === 0 && !vragen.oudjaar)) {
    return melding ? (
      <p role="alert" className="text-sm text-red-700">
        {melding.tekst}
      </p>
    ) : null;
  }

  const bewaren = async () => {
    setBezig(true);
    setMelding(null);
    try {
      const res = await fetch(withBasePath(`/api/aios/periode/${periodId}/feestdagblokken`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keuzes: alle.filter((b) => keuzes[b.blok_id]).map((b) => ({ blok_id: b.blok_id, keuze: keuzes[b.blok_id] })),
          ...(vragen.oudjaar ? { oudjaar_aantal: oudjaar } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Bewaren is mislukt');
      neem(data.data);
      setMelding({ fout: false, tekst: 'Bewaard.' });
    } catch (err) {
      setMelding({ fout: true, tekst: foutTekst(err, 'Bewaren is mislukt') });
    } finally {
      setBezig(false);
    }
  };
  const uit = disabled || bezig;
  const kies = (id: string) => (k: BlokKeuze) => {
    setKeuzes((oud) => ({ ...oud, [id]: k }));
    setMelding(null);
  };

  return (
    <div className="rounded border border-neutral-300 p-3 space-y-3" data-testid="aios-feestdagblokken">
      <h3 className="font-semibold">★ Blokken rond feestdagen</h3>
      {vragen.groepen.map((g) => (
        <div key={g.datums[0]} className="space-y-2">
          <p className="text-sm text-neutral-800">
            <span className="font-medium">{opsomming(g.namen)}</span> ({g.datums.map(datumKort).join(', ')}): feestdagen achter elkaar.
            Kies per blok of één AIOS het hele blok doet of dat elke dag een losse dienst wordt. Het rooster kan pas gemaakt worden als
            elk blok een keuze heeft.
          </p>
          {g.blokken.map((b) => (
            <BlokKeuzeVeld key={b.blok_id} vraag={b} keuze={keuzes[b.blok_id] ?? null} disabled={uit} onKies={kies(b.blok_id)} />
          ))}
        </div>
      ))}
      {vragen.losse.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-neutral-800">Een blok met één feestdag erin blijft heel. Je kunt het hier ook opknippen.</p>
          {vragen.losse.map((b) => (
            <BlokKeuzeVeld key={b.blok_id} vraag={b} keuze={keuzes[b.blok_id] ?? 'HEEL'} disabled={uit} onKies={kies(b.blok_id)} />
          ))}
        </div>
      )}
      {vragen.oudjaar && (
        <fieldset className="rounded border border-neutral-300 p-2">
          <legend className="px-1 text-sm font-medium text-neutral-900">Oudjaarsnacht ({datumKort(vragen.oudjaar.datum)})</legend>
          <p className="text-xs text-neutral-600">
            Bij twee AIOS doet de ene de nacht in het blok en de andere een losse nacht. Beide tellen voor 1 punt.
          </p>
          <div className="mt-1 flex flex-col gap-1 text-sm sm:flex-row sm:gap-4">
            <label className="flex items-center gap-2">
              <input type="radio" name="oudjaar" checked={oudjaar === 2} disabled={uit} onChange={() => setOudjaar(2)} />
              Twee AIOS
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="oudjaar" checked={oudjaar === 1} disabled={uit} onChange={() => setOudjaar(1)} />
              Eén AIOS
            </label>
          </div>
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed" disabled={uit || !gewijzigd} onClick={bewaren}>
          {bezig ? 'Bezig met bewaren...' : 'Keuzes bewaren'}
        </button>
        {status === 'GEGENEREERD' && <span className="text-xs text-neutral-600">Een andere keuze geldt als je het rooster opnieuw maakt.</span>}
      </div>
      {melding && (
        <p role={melding.fout ? 'alert' : 'status'} className={`text-sm ${melding.fout ? 'text-red-700' : 'text-neutral-800'}`}>
          {melding.tekst}
        </p>
      )}
    </div>
  );
}
