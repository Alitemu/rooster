'use client';

/**
 * Swapping on an AIOS's own page (docs/aios-rooster.md, "Ruilen";
 * lib/aiosRuilen.ts): one of their diensten or blocks still to come, the
 * colleagues' equal ones they could swap it for (only those that break no
 * hard rule for either), a request with a note. Then their requests in two
 * categories, "Jouw ruilverzoeken" (to take back or remind the colleague
 * of) and "Ontvangen ruilverzoeken" (to approve or reject), each with a
 * filter on status and the number behind every option. Without the
 * planner, and only on a definitief roster: on a voorlopig one the page
 * says why not.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { withBasePath } from '@/lib/basePath';
import { AiosRuilHerinnering } from '@/components/AiosRuilHerinnering';
import type { EenheidUit, Kandidaat, RuilStatus, RuilUit } from '@/lib/aiosRuilen';

const kort = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
const wat = (e: EenheidUit) => (e.van === e.tot ? `${e.naam}, ${kort(e.van)}` : `${e.naam}, ${kort(e.van)} t/m ${kort(e.tot)}`);
const STATUSSEN: Array<[RuilStatus, string]> = [
  ['IN_BEHANDELING', 'In afwachting'],
  ['GOEDGEKEURD', 'Goedgekeurd'],
  ['AFGEWEZEN', 'Afgewezen'],
  ['INGETROKKEN', 'Ingetrokken'],
];
const STATUS_LABEL = Object.fromEntries(STATUSSEN) as Record<RuilStatus, string>;
const STATUS_STIJL: Record<RuilStatus, string> = {
  IN_BEHANDELING: 'bg-amber-100 text-amber-800',
  GOEDGEKEURD: 'bg-green-100 text-green-800',
  AFGEWEZEN: 'bg-red-100 text-red-800',
  INGETROKKEN: 'bg-neutral-100 text-neutral-700',
};

interface Overzicht {
  ruilen_kan: boolean;
  /** The planner's address for what is wrong in a voorlopig roster; null when the beheerder has not set one. */
  contact_planner: string | null;
  eenheden: EenheidUit[];
  uit: RuilUit[];
  in: RuilUit[];
}

async function json(res: Response, fallback: string) {
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error?.message || fallback);
  return data.data;
}

/** One category with its own filter on status. */
function Categorie({
  titel,
  testid,
  alle,
  filter,
  setFilter,
  kaart,
  leeg,
}: {
  titel: string;
  testid: string;
  alle: RuilUit[];
  filter: string;
  setFilter: (waarde: string) => void;
  kaart: (r: RuilUit) => ReactNode;
  leeg: string;
}) {
  const zichtbaar = filter ? alle.filter((r) => r.status === filter) : alle;
  return (
    <div className="space-y-2" data-testid={testid}>
      <h3 className="font-semibold">{titel}</h3>
      <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={`Filter op status: ${titel}`} className="px-3 py-2 border rounded text-sm">
        <option value="">Alle statussen ({alle.length})</option>
        {STATUSSEN.map(([waarde, label]) => (
          <option key={waarde} value={waarde}>
            {label} ({alle.filter((r) => r.status === waarde).length})
          </option>
        ))}
      </select>
      {zichtbaar.length === 0 ? (
        <p className="text-sm text-neutral-700">{alle.length === 0 ? leeg : 'Geen ruilverzoeken met deze status.'}</p>
      ) : (
        <div className="space-y-2">{zichtbaar.map((r) => kaart(r))}</div>
      )}
    </div>
  );
}

/** `inSectie`: on the page's foldable section, which has the title and the frame (0.110.0). */
export function AiosRuilen({
  personId,
  periodId,
  onGeruild,
  inSectie = false,
}: {
  personId: string;
  periodId: string;
  onGeruild: () => void;
  inSectie?: boolean;
}) {
  const [overzicht, setOverzicht] = useState<Overzicht | null>(null);
  const [gekozen, setGekozen] = useState<EenheidUit | null>(null);
  const [kandidaten, setKandidaten] = useState<Kandidaat[] | null>(null);
  const [toelichting, setToelichting] = useState('');
  const [reden, setReden] = useState<Record<string, string>>({});
  const [bezig, setBezig] = useState(false);
  const [melding, setMelding] = useState<{ fout: boolean; tekst: string } | null>(null);
  const [filterUit, setFilterUit] = useState('IN_BEHANDELING');
  const [filterIn, setFilterIn] = useState('IN_BEHANDELING');

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

  const stempel = (r: RuilUit) => (
    <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${STATUS_STIJL[r.status]}`}>{STATUS_LABEL[r.status]}</span>
  );

  const verzonden = (r: RuilUit) => (
    <div key={r.id} className="rounded border p-3 text-sm space-y-1" data-testid="aios-ruil-verzonden" data-status={r.status}>
      <p className="flex items-center gap-2 flex-wrap">
        {stempel(r)}
        <span>
          Aan <span className="font-medium">{r.respondent}</span>
        </span>
        <span className="text-xs text-neutral-500">{new Date(r.aangemaakt_op).toLocaleDateString('nl-NL')}</span>
      </p>
      <p>
        Jij geeft: {wat(r.aangeboden)}. Jij krijgt: {wat(r.gevraagd)}.
      </p>
      {r.toelichting && <p className="text-neutral-700 italic">&ldquo;{r.toelichting}&rdquo;</p>}
      {r.reden_afwijzing && <p className="text-red-700">{r.status === 'AFGEWEZEN' ? 'Reden van afwijzen' : 'Reden'}: {r.reden_afwijzing}</p>}
      {r.status === 'IN_BEHANDELING' && (
        <>
          <button type="button" className={knop} disabled={bezig} onClick={() => doe(`/${r.id}/intrekken`, {}, 'Ingetrokken.')}>
            Intrekken
          </button>
          <AiosRuilHerinnering
            stuur={() => fetch(withBasePath(`/api/aios/deelnemer/${personId}/periode/${periodId}/ruilen/${r.id}/herinneren`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bevestigd: true }) })}
            laatste={r.laatste_herinnering_op}
            door={r.laatste_herinnering_door}
            eigen
            onKlaar={laad}
          />
        </>
      )}
    </div>
  );

  const ontvangen = (r: RuilUit) => (
    <div
      key={r.id}
      className={`rounded p-3 text-sm space-y-2 ${r.status === 'IN_BEHANDELING' ? 'border-2 border-neutral-800' : 'border'}`}
      data-testid={r.status === 'IN_BEHANDELING' ? 'aios-ruil-aan-mij' : 'aios-ruil-ontvangen'}
      data-status={r.status}
    >
      <p className="flex items-center gap-2 flex-wrap">
        {stempel(r)}
        <span>
          Van <span className="font-medium">{r.aanvrager}</span>
        </span>
        <span className="text-xs text-neutral-500">{new Date(r.aangemaakt_op).toLocaleDateString('nl-NL')}</span>
      </p>
      <p>Jij geeft: {wat(r.gevraagd)}</p>
      <p>Jij krijgt: {wat(r.aangeboden)}</p>
      {r.toelichting && <p className="text-neutral-700">Toelichting: {r.toelichting}</p>}
      {r.status === 'IN_BEHANDELING' && (
        <>
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
            <button type="button" className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed" disabled={bezig} onClick={() => doe(`/${r.id}/goedkeuren`, {}, 'Goedgekeurd. Je rooster is aangepast.', true)}>
              Goedkeuren
            </button>
            <button type="button" className={knop} disabled={bezig} onClick={() => doe(`/${r.id}/afwijzen`, { reden: reden[r.id] ?? '' }, 'Afgewezen.')}>
              Afwijzen
            </button>
          </div>
        </>
      )}
      {r.reden_afwijzing && <p className="text-red-700">{r.status === 'AFGEWEZEN' ? 'Reden van afwijzen' : 'Reden'}: {r.reden_afwijzing}</p>}
    </div>
  );

  return (
    <div className={inSectie ? 'space-y-4' : 'card p-4 space-y-4'} data-testid="aios-ruilen">
      {!inSectie && <h2 className="text-xl font-semibold">Ruilen</h2>}
      {!overzicht.ruilen_kan ? (
        <p className="text-sm text-neutral-800" data-testid="aios-ruilen-voorlopig">
          Ruilen kan pas als het rooster definitief is. Klopt er iets niet in je voorlopige rooster? Meld dat bij de planner
          {overzicht.contact_planner ? (
            <>
              : mail naar <span className="font-medium">{overzicht.contact_planner}</span>.
            </>
          ) : (
            '.'
          )}
        </p>
      ) : (
        <>
          <p className="text-sm text-neutral-700">
            Ruil een blok tegen een blok van dezelfde soort. Een losse dienst ruil je tegen een gelijkwaardige: een dagdienst en een avonddienst in
            het weekend zijn gelijkwaardig. Je collega keurt het goed of wijst het af. De app laat alleen ruilen zien die voor jullie allebei binnen de
            regels blijven.
          </p>
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
        </>
      )}

      <Categorie
        titel="Jouw ruilverzoeken"
        testid="aios-ruilen-verzonden"
        alle={overzicht.uit}
        filter={filterUit}
        setFilter={setFilterUit}
        kaart={verzonden}
        leeg="Je hebt geen ruilverzoeken gedaan."
      />
      <Categorie
        titel="Ontvangen ruilverzoeken"
        testid="aios-ruilen-ontvangen"
        alle={overzicht.in}
        filter={filterIn}
        setFilter={setFilterIn}
        kaart={ontvangen}
        leeg="Je hebt geen ruilverzoeken ontvangen."
      />

      {melding && (
        <p role={melding.fout ? 'alert' : 'status'} className={`text-sm ${melding.fout ? 'text-red-700' : 'text-neutral-800'}`}>
          {melding.tekst}
        </p>
      )}
    </div>
  );
}
