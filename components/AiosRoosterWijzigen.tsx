'use client';

/**
 * Changing the AIOS roster by hand (docs/aios-rooster.md, step 4c;
 * lib/aiosHandmatig.ts): for the dienst or block the planner tapped, who
 * could do it, with per AIOS the warnings it would bring (F8: allowed, with
 * a warning) and the dienstpercentage after it. A block goes whole, or one
 * day of it. Someone not in the pool that day can't be chosen. "Leeg
 * laten" empties it.
 */

import { useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import type { Kandidaat, Waarschuwing, Wijziging } from '@/lib/aiosHandmatig';

export interface Keuze {
  naam: string; // "Nachtblok zo t/m di" or "Dagdienst"
  blok: boolean; // a whole block: all of it, or one day
  dagen: Array<{ slot_id: string; datum: string }>;
}

export interface Gewijzigd {
  tekst: string;
  waarschuwingen: Waarschuwing[];
  terug: Wijziging[];
}

/** On a published roster a change needs a reason (lib/aiosHandmatig.ts). */
export const REDEN_MAX = 200;

const datumKort = (datum: string) =>
  new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
const procent = (x: number | null) => (x === null ? 'geen werkdagen' : `${(x * 100).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}%`);

interface Antwoord {
  diensten: Array<{ dienst_id: string; datum: string; aios_id: string | null }>;
  kandidaten: Kandidaat[];
}

export function AiosRoosterWijzigen({
  periodId,
  keuze,
  metReden,
  onGewijzigd,
  onSluit,
}: {
  periodId: string;
  keuze: Keuze;
  metReden: boolean;
  onGewijzigd: (g: Gewijzigd) => void;
  onSluit: () => void;
}) {
  // null: the whole block; otherwise the one dienst.
  const [dag, setDag] = useState<string | null>(keuze.blok ? null : keuze.dagen[0].slot_id);
  const heel = dag === null;
  const dienst = dag ?? keuze.dagen[0].slot_id;
  const [antwoord, setAntwoord] = useState<Antwoord | null>(null);
  const [zeker, setZeker] = useState<Kandidaat | 'leeg' | null>(null);
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);
  const [reden, setReden] = useState('');
  const zonderReden = metReden && reden.trim() === '';

  useEffect(() => {
    let actief = true;
    setAntwoord(null);
    setZeker(null);
    setFout(null);
    fetch(withBasePath(`/api/aios/periode/${periodId}/rooster/kandidaten?dienst=${encodeURIComponent(dienst)}&heel=${heel ? 1 : 0}`))
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Laden is mislukt');
        if (actief) setAntwoord(data.data);
      })
      .catch((err) => actief && setFout(err instanceof Error ? err.message : 'Laden is mislukt'));
    return () => {
      actief = false;
    };
  }, [periodId, dienst, heel]);

  const zet = async (aiosId: string | null, wie: string) => {
    if (!antwoord) return;
    setBezig(true);
    setFout(null);
    try {
      const res = await fetch(withBasePath(`/api/aios/periode/${periodId}/rooster/wijzigen`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wijzigingen: antwoord.diensten.map((d) => ({ dienst_id: d.dienst_id, aios_id: aiosId, was: d.aios_id })),
          ...(metReden ? { reden: reden.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Wijzigen is mislukt');
      const datum = keuze.dagen.find((d) => d.slot_id === dienst)!.datum;
      const wat = heel ? `${keuze.naam} vanaf ${datumKort(datum)}` : `${keuze.naam} ${datumKort(datum)}`;
      onGewijzigd({ tekst: aiosId ? `${wat}: nu ${wie}.` : `${wat}: nu leeg.`, waarschuwingen: data.data.waarschuwingen, terug: data.data.terug });
    } catch (err) {
      setFout(err instanceof Error ? err.message : 'Wijzigen is mislukt');
    } finally {
      setBezig(false);
    }
  };

  const nu = antwoord?.kandidaten.find((k) => k.nu);
  const leeg = antwoord ? antwoord.diensten.every((d) => d.aios_id === null) : true;
  const knop = 'px-3 py-1 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50';

  return (
    <div className="rounded border-2 border-neutral-800 p-3 space-y-3" data-testid="aios-wijzigen">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">Wie doet dit?</h3>
          <p className="text-sm text-neutral-700">
            {keuze.naam}, {datumKort(keuze.dagen[0].datum)}
            {keuze.dagen.length > 1 ? ` t/m ${datumKort(keuze.dagen[keuze.dagen.length - 1].datum)}` : ''}
            {nu ? `. Nu: ${nu.codenaam}.` : leeg ? '. Nu leeg.' : ''}
          </p>
        </div>
        <button type="button" className={knop} onClick={onSluit}>
          Sluiten
        </button>
      </div>
      {keuze.blok && (
        <fieldset className="text-sm">
          <legend className="sr-only">Hoeveel</legend>
          <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-4">
            <label className="flex items-center gap-2">
              <input type="radio" name="hoeveel" checked={heel} disabled={bezig} onChange={() => setDag(null)} />
              Het hele blok
            </label>
            {keuze.dagen.map((d) => (
              <label key={d.slot_id} className="flex items-center gap-2">
                <input type="radio" name="hoeveel" checked={dag === d.slot_id} disabled={bezig} onChange={() => setDag(d.slot_id)} />
                Alleen {datumKort(d.datum)}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {metReden && (
        <label className="block text-sm">
          <span className="block text-xs font-medium text-neutral-700 mb-1">Reden (verplicht: het rooster is gepubliceerd)</span>
          <input
            type="text"
            value={reden}
            maxLength={REDEN_MAX}
            disabled={bezig}
            onChange={(e) => setReden(e.target.value)}
            className="w-full px-2 py-1 border rounded text-sm"
          />
        </label>
      )}
      {fout && (
        <p role="alert" className="text-sm text-red-700">
          {fout}
        </p>
      )}
      {!antwoord && !fout && <p className="text-sm text-neutral-600">Laden...</p>}
      {zeker && (
        <div className="rounded border border-neutral-400 p-2 text-sm space-y-2" role="status">
          {zeker === 'leeg' ? (
            <p>{heel && keuze.blok ? 'Deze diensten worden' : 'Deze dienst wordt'} leeg. Een lege dienst houdt het publiceren tegen.</p>
          ) : (
            <>
              <p className="font-medium">Let op bij {zeker.codenaam}:</p>
              <ul className="list-disc pl-5">
                {zeker.waarschuwingen.map((w) => (
                  <li key={w.tekst}>{w.tekst}</li>
                ))}
              </ul>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={bezig || zonderReden}
              onClick={() => (zeker === 'leeg' ? zet(null, '') : zet(zeker.person_id, zeker.codenaam))}
            >
              {zeker === 'leeg' ? 'Ja, leeg laten' : 'Ja, toch indelen'}
            </button>
            <button type="button" className={knop} disabled={bezig} onClick={() => setZeker(null)}>
              Annuleren
            </button>
          </div>
        </div>
      )}
      {antwoord && !zeker && (
        <ul className="divide-y text-sm" aria-label="AIOS">
          {antwoord.kandidaten.map((k) => (
            <li key={k.person_id} className="flex items-start justify-between gap-2 py-1.5">
              <div className="min-w-0">
                <span className="font-medium">{k.codenaam}</span>
                {k.nu && <span className="ml-1 text-neutral-600">(nu)</span>}
                {k.voorkeur && <span className="ml-1">+ voorkeur</span>}
                <span className="block text-xs text-neutral-600">daarna {procent(k.percentage_na)}</span>
                {k.reden && <span className="block text-xs text-neutral-800">{k.reden}</span>}
                {k.waarschuwingen.length > 0 && (
                  <ul className="text-xs text-neutral-900">
                    {k.waarschuwingen.map((w) => (
                      <li key={w.tekst}>⚠ {w.tekst}</li>
                    ))}
                  </ul>
                )}
              </div>
              {!k.nu && (
                <button
                  type="button"
                  className={knop}
                  disabled={bezig || !k.kan || zonderReden}
                  aria-label={`Kies ${k.codenaam}`}
                  onClick={() => (k.waarschuwingen.length > 0 ? setZeker(k) : zet(k.person_id, k.codenaam))}
                >
                  Kies
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {antwoord && !zeker && !leeg && (
        <button type="button" className={knop} disabled={bezig || zonderReden} onClick={() => setZeker('leeg')}>
          Leeg laten
        </button>
      )}
    </div>
  );
}
