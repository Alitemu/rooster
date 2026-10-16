'use client';

/**
 * Swapping on an AIOS's own page (docs/aios-rooster.md, "Ruilen";
 * lib/aiosRuilen.ts): one of their diensten or blocks still to come, the
 * colleagues' equal ones they could swap it for (only those that break no
 * hard rule for either), a request with a note; the requests to them, to
 * approve or reject; their own, to take back. Without the planner.
 */

import { useCallback, useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import type { EenheidUit, Kandidaat, RuilStatus, RuilUit } from '@/lib/aiosRuilen';

const kort = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
const wat = (e: EenheidUit) => (e.van === e.tot ? `${e.naam}, ${kort(e.van)}` : `${e.naam}, ${kort(e.van)} t/m ${kort(e.tot)}`);
const STATUS: Record<RuilStatus, string> = {
  IN_BEHANDELING: 'in behandeling',
  GOEDGEKEURD: 'goedgekeurd',
  AFGEWEZEN: 'afgewezen',
  INGETROKKEN: 'ingetrokken',
  VERVALLEN: 'vervallen: een van de diensten is intussen bij iemand anders',
};

interface Overzicht {
  eenheden: EenheidUit[];
  uit: RuilUit[];
  in: RuilUit[];
}

async function json(res: Response, fallback: string) {
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error?.message || fallback);
  return data.data;
}

export function AiosRuilen({ personId, periodId, onGeruild }: { personId: string; periodId: string; onGeruild: () => void }) {

  const [overzicht, setOverzicht] = useState<Overzicht | null>(null);
  const [gekozen, setGekozen] = useState<EenheidUit | null>(null);
  const [kandidaten, setKandidaten] = useState<Kandidaat[] | null>(null);
  const [toelichting, setToelichting] = useState('');
  const [reden, setReden] = useState<Record<string, string>>({});
  const [bezig, setBezig] = useState(false);
  const [melding, setMelding] = useState<{ fout: boolean; tekst: string } | null>(null);

  const laad = useCallback(() => {
    fetch(withBasePath(`/api/aios/deelnemer/${personId}/periode/${periodId}/ruilen`))
      .then((res) => json(res, 'Laden van het ruilen is mislukt.'))
      .then(setOverzicht)
      .catch((err) => setMelding({ fout: true, tekst: err instanceof Error ? err.message : 'Laden is mislukt.' }));
  }, [personId, periodId]);
  useEffect(() => laad(), [laad]);

  const kies = async (e: EenheidUit) => {
    setGekozen(e);
    setKandidaten(null);
    setMelding(null);
    try {
      const res = await fetch(withBasePath(`/api/aios/deelnemer/${personId}/periode/${periodId}/ruilen/kandidaten?eenheid=${encodeURIComponent(e.id)}`));
      setKandidaten(await json(res, 'Laden is mislukt.'));
    } catch (err) {
      setMelding({ fout: true, tekst: err instanceof Error ? err.message : 'Laden is mislukt.' });
    }
  };

  const doe = async (rest: string, body: unknown, gelukt: string, geruild = false) => {
    setBezig(true);
    setMelding(null);
    try {
      const data = await json(
        await fetch(withBasePath(`/api/aios/deelnemer/${personId}/periode/${periodId}/ruilen${rest}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        'Dat is mislukt.'
      );
      setMelding({ fout: false, tekst: data.mail ? gelukt : `${gelukt} Er ging geen mail: de mail voor de AIOS is nog niet ingesteld.` });
      setGekozen(null);
      setKandidaten(null);
      setToelichting('');
      laad();
      if (geruild) onGeruild();
    } catch (err) {
      setMelding({ fout: true, tekst: err instanceof Error ? err.message : 'Dat is mislukt.' });
    } finally {
      setBezig(false);
    }
  };

  if (!overzicht) return null;
  const knop = 'px-3 py-1 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50';
  const openIn = overzicht.in.filter((r) => r.status === 'IN_BEHANDELING');

  return (
    <div className="card p-4 space-y-4" data-testid="aios-ruilen">
      <h2 className="text-xl font-semibold">Ruilen</h2>
      <p className="text-sm text-neutral-700">
        Ruil een blok tegen een blok van dezelfde soort. Een losse dienst ruil je tegen een gelijkwaardige: een dagdienst en een avonddienst in
        het weekend zijn gelijkwaardig. Je collega keurt het goed of wijst het af. De app laat alleen ruilen zien die voor jullie allebei binnen de
        regels blijven.
      </p>

      {openIn.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold">Verzoeken aan jou</h3>
          {openIn.map((r) => (
            <div key={r.id} className="rounded border-2 border-neutral-800 p-3 text-sm space-y-2" data-testid="aios-ruil-aan-mij">
              <p>
                <span className="font-medium">{r.aanvrager}</span> vraagt je om te ruilen.
              </p>
              <p>Jij geeft: {wat(r.gevraagd)}</p>
              <p>Jij krijgt: {wat(r.aangeboden)}</p>
              {r.toelichting && <p className="text-neutral-700">Toelichting: {r.toelichting}</p>}
              <label className="block">
                <span className="block text-xs text-neutral-600">Reden als je afwijst (mag leeg)</span>
                <input
                  type="text"
                  maxLength={200}
                  value={reden[r.id] ?? ''}
                  onChange={(e) => setReden({ ...reden, [r.id]: e.target.value })}
                  className="w-full px-2 py-1 border rounded text-sm"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-primary" disabled={bezig} onClick={() => doe(`/${r.id}/goedkeuren`, {}, 'Goedgekeurd. Je rooster is aangepast.', true)}>
                  Goedkeuren
                </button>
                <button type="button" className={knop} disabled={bezig} onClick={() => doe(`/${r.id}/afwijzen`, { reden: reden[r.id] ?? '' }, 'Afgewezen.')}>
                  Afwijzen
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <h3 className="font-semibold">Een dienst ruilen</h3>
        {overzicht.eenheden.length === 0 ? (
          <p className="text-sm text-neutral-700">Je hebt geen diensten meer om te ruilen.</p>
        ) : (
          <ul className="divide-y text-sm">
            {overzicht.eenheden.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2 py-1.5">
                <span>{wat(e)}</span>
                <button type="button" className={knop} disabled={bezig} aria-pressed={gekozen?.id === e.id} onClick={() => kies(e)} aria-label={`Ruilen: ${wat(e)}`}>
                  Ruilen
                </button>
              </li>
            ))}
          </ul>
        )}
        {gekozen && (
          <div className="rounded border border-neutral-400 p-3 text-sm space-y-2" data-testid="aios-ruil-kandidaten">
            <p className="font-medium">Ruilen: {wat(gekozen)}</p>
            {kandidaten === null ? (
              <p className="text-neutral-600">Laden...</p>
            ) : kandidaten.length === 0 ? (
              <p>Er is geen collega met een gelijkwaardige dienst waarmee deze ruil binnen de regels blijft.</p>
            ) : (
              <>
                <label className="block">
                  <span className="block text-xs text-neutral-600">Toelichting voor je collega (mag leeg)</span>
                  <input type="text" maxLength={200} value={toelichting} onChange={(e) => setToelichting(e.target.value)} className="w-full px-2 py-1 border rounded text-sm" />
                </label>
                <ul className="divide-y">
                  {kandidaten.map((k) => (
                    <li key={k.eenheid.id} className="flex items-center justify-between gap-2 py-1.5">
                      <span>
                        <span className="font-medium">{k.collega.codenaam}</span>: {wat(k.eenheid)}
                      </span>
                      <button
                        type="button"
                        className={knop}
                        disabled={bezig}
                        aria-label={`Vraag ${k.collega.codenaam}: ${wat(k.eenheid)}`}
                        onClick={() => doe('', { aangeboden: gekozen.id, gevraagd: k.eenheid.id, toelichting }, 'Je ruilverzoek is verstuurd.')}
                      >
                        Vraag aan
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <button type="button" className={knop} onClick={() => setGekozen(null)}>
              Annuleren
            </button>
          </div>
        )}
      </div>

      {(overzicht.uit.length > 0 || overzicht.in.some((r) => r.status !== 'IN_BEHANDELING')) && (
        <div className="space-y-2">
          <h3 className="font-semibold">Eerdere en lopende verzoeken</h3>
          <ul className="divide-y text-sm">
            {overzicht.uit.map((r) => (
              <li key={r.id} className="py-1.5 space-y-1">
                <p>
                  Aan {r.respondent}: jij geeft {wat(r.aangeboden)}, jij krijgt {wat(r.gevraagd)}. <span className="font-medium">{STATUS[r.status]}</span>
                  {r.reden_afwijzing ? `. Reden: ${r.reden_afwijzing}` : ''}
                </p>
                {r.status === 'IN_BEHANDELING' && (
                  <button type="button" className={knop} disabled={bezig} onClick={() => doe(`/${r.id}/intrekken`, {}, 'Ingetrokken.')}>
                    Intrekken
                  </button>
                )}
              </li>
            ))}
            {overzicht.in
              .filter((r) => r.status !== 'IN_BEHANDELING')
              .map((r) => (
                <li key={r.id} className="py-1.5">
                  Van {r.aanvrager}: jij geeft {wat(r.gevraagd)}, jij krijgt {wat(r.aangeboden)}. <span className="font-medium">{STATUS[r.status]}</span>
                </li>
              ))}
          </ul>
        </div>
      )}

      {melding && (
        <p role={melding.fout ? 'alert' : 'status'} className={`text-sm ${melding.fout ? 'text-red-700' : 'text-neutral-800'}`}>
          {melding.tekst}
        </p>
      )}
    </div>
  );
}
