'use client';

/**
 * The voortgangstoets of an AIOS quarter, on the period's page
 * (lib/aiosVoortgangstoets.ts): its date, and what that means for the night
 * before it. FellowVak is that night in the week tables and the roster.
 */

import { useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import { AiosSectie } from '@/components/AiosSectie';

const kort = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });

const lang = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** The night that came back in a roster already made (lib/aiosVoortgangstoets.ts). */
interface Teruggezet {
  nacht: string;
  aios_id: string | null;
  reden: 'GEBLOKKEERD' | 'NIET_EEN_AIOS' | null;
}

function opgeslagen(status: string, terug: Teruggezet | null): string {
  if (status !== 'GEGENEREERD') return 'Opgeslagen.';
  if (!terug) return 'Opgeslagen. Het rooster was al gemaakt. Maak het opnieuw of pas die nachten met de hand aan.';
  const nacht = `Opgeslagen. De nacht van ${lang(terug.nacht)} staat weer in het rooster`;
  if (terug.aios_id) return `${nacht}, bij de AIOS die de rest van dat blok heeft.`;
  const waarom =
    terug.reden === 'GEBLOKKEERD' ? 'De AIOS van dat blok heeft die nacht geblokkeerd of is dan afwezig.' : 'De rest van dat blok ligt niet bij één AIOS.';
  return `${nacht}, maar nog zonder AIOS. ${waarom} Vul hem met de hand in.`;
}

/** The night before the voortgangstoets: no AIOS, a fellow. */
export function FellowVak() {
  return (
    <span
      className="block truncate rounded border border-dashed border-neutral-500 py-0.5 text-center italic"
      title="Nacht voor de voortgangstoets: een fellow"
    >
      Fellow
    </span>
  );
}

interface Toets {
  datum: string | null;
  nacht: string | null;
  mag_wijzigen: boolean;
}

async function json(res: Response, fallback: string) {
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error?.message || fallback);
  return data.data;
}

export function AiosVoortgangstoets({ periodId, status, onChanged }: { periodId: string; status: string; onChanged: () => void }) {
  const [toets, setToets] = useState<Toets | null>(null);
  const [aan, setAan] = useState(false);
  const [datum, setDatum] = useState('');
  const [bezig, setBezig] = useState(false);
  const [melding, setMelding] = useState<{ fout: boolean; tekst: string } | null>(null);

  const neem = (t: Toets) => {
    setToets(t);
    setAan(t.datum !== null);
    setDatum(t.datum ?? '');
  };

  useEffect(() => {
    fetch(withBasePath(`/api/aios/periode/${periodId}/voortgangstoets`))
      .then((res) => json(res, 'Laden van de voortgangstoets is mislukt.'))
      .then(neem)
      .catch((err) => setMelding({ fout: true, tekst: err instanceof Error ? err.message : 'Laden is mislukt.' }));
  }, [periodId, status]);

  const bewaar = async () => {
    setBezig(true);
    setMelding(null);
    try {
      const res = await fetch(withBasePath(`/api/aios/periode/${periodId}/voortgangstoets`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datum: aan ? datum : null }),
      });
      const nieuw = (await json(res, 'Opslaan is mislukt.')) as Toets & { teruggezet: Teruggezet | null };
      neem(nieuw);
      setMelding({ fout: false, tekst: opgeslagen(status, nieuw.teruggezet) });
      onChanged();
    } catch (err) {
      setMelding({ fout: true, tekst: err instanceof Error ? err.message : 'Opslaan is mislukt.' });
    } finally {
      setBezig(false);
    }
  };

  const veranderd = toets !== null && (aan !== (toets.datum !== null) || (aan && datum !== (toets.datum ?? '')));
  const hint = toets && (toets.datum ? `Op ${kort(toets.datum)}` : 'Geen toets ingevuld');

  return (
    // Kept loaded while closed: the hint says when the toets is.
    <AiosSectie sleutel="toets" titel="Voortgangstoets" testId="aios-voortgangstoets" hint={hint || undefined} blijfGeladen>
      {toets && (toets.datum && toets.nacht ? (
        <p className="text-sm text-neutral-800">
          De voortgangstoets is op <strong>{lang(toets.datum)}</strong>. In de nacht ervoor ({lang(toets.nacht)}) heeft geen AIOS
          dienst. Een fellow doet die nacht. Wie dat is, regel je buiten de app. De andere nachten van dat blok doet één AIOS. De
          compensatiedagen zijn dan de twee dagen na de laatste van die nachten.
        </p>
      ) : (
        <p className="text-sm text-neutral-700">
          Is er in dit kwartaal een voortgangstoets? Vul dan de datum in. In de nacht ervoor heeft geen AIOS dienst. Een fellow doet
          die nacht. In het rooster staat dan Fellow.
        </p>
      ))}
      {toets && (toets.mag_wijzigen ? (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={aan} onChange={(e) => setAan(e.target.checked)} disabled={bezig} />
            Er is een voortgangstoets in dit kwartaal
          </label>
          {aan && (
            <label className="block text-sm">
              <span className="block text-xs text-neutral-600">Datum van de voortgangstoets</span>
              <input type="date" value={datum} onChange={(e) => setDatum(e.target.value)} disabled={bezig} className="px-2 py-1 border rounded text-sm" />
            </label>
          )}
          <button type="button" className="btn-primary" disabled={bezig || !veranderd || (aan && !datum)} onClick={bewaar}>
            Opslaan
          </button>
        </div>
      ) : (
        <p className="text-sm text-neutral-600">Het rooster is gepubliceerd. De voortgangstoets ligt nu vast.</p>
      ))}
      {melding && (
        <p role={melding.fout ? 'alert' : 'status'} className={`text-sm ${melding.fout ? 'text-red-700' : 'text-neutral-800'}`}>
          {melding.tekst}
        </p>
      )}
    </AiosSectie>
  );
}
