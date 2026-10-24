/**
 * An AIOS period's page (docs/aios-rooster.md), in this order: the history
 * from before the app, the steps up to the preferences (open, invite,
 * remind, deadline, close), the voortgangstoets, "Status voorkeuren" per
 * AIOS with the 50% warnings, communication, making the roster and
 * publishing it, the dienstpercentage and saldo, the points the quarter holds
 * (how many fte the AIOS need together to stay under 25% on average) and,
 * last, the Dienstrooster with its list, calendar, dienstdoende and swaps.
 *
 * Generating, the roster per block and publishing come in the next steps;
 * until then the achterwacht's steps after closing refuse an AIOS period
 * (lib/aiosPeriod.ts).
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { withBasePath } from '@/lib/basePath';
import { AiosExporteren } from '@/components/AiosExporteren';
import { AiosToegangslinksSectie } from '@/components/AiosToegangslinks';
import { AiosDienstpercentage, AiosRoosterMaken } from '@/components/AiosRoosterMaken';
import { AiosGeschiedenis } from '@/components/AiosGeschiedenis';
import { AiosDienstrooster } from '@/components/AiosDienstrooster';
import { AiosVoortgangstoets } from '@/components/AiosVoortgangstoets';
import { AiosPeriodeStatus } from '@/components/AiosPeriodeStatus';
import { AiosHarmonica, AiosSectie } from '@/components/AiosSectie';
import { deadlineTekst } from '@/lib/aiosVerzendlijst';
import { periodStatusLabel } from '@/lib/aiosTeksten';
import { benodigdeFte, SOORT_LABELS } from '@/lib/aiosDiensten';
import type { AiosDienstenOverzicht } from '@/lib/aiosSlots';
import { bovenHelftPlanner, type AiosWens, type BlokkadeTeller, type MarkeringTelling } from '@/lib/aiosVoorkeur';
import { foutTekst } from '@/lib/aiosFoutTekst';

interface Period {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
}

const getal = (x: number) => x.toLocaleString('nl-NL', { maximumFractionDigits: 1 });

const datumLang = (datum: string) =>
  new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

const datumKort = (datum: string) =>
  new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });

/** A datetime-local value for the input, from a stored deadline. */
function alsInvoer(deadline: string): string {
  return deadline.length >= 16 ? deadline.slice(0, 16) : deadline;
}

async function antwoord(res: Response, fallback: string) {
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error?.message || fallback);
  return data.data;
}

interface AiosStand {
  uitgenodigd_op: string | null;
  mail_ingesteld: boolean;
  aantal_deelnemers: number;
  definitief: boolean;
}

/** Open, invite, remind, close: the steps up to the preferences, on the AIOS's own routes. */
function Stappen({ period, stand, onChanged }: { period: Period; stand: AiosStand | null; onChanged: () => void }) {
  const [deadline, setDeadline] = useState(alsInvoer(period.deadline));
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);

  useEffect(() => {
    setDeadline(alsInvoer(period.deadline));
  }, [period.deadline]);

  const doe = async (url: string, method: string, body: unknown, fallback: string, klaar?: (data: { aantal?: number; overgeslagen?: number }) => string) => {
    setBezig(true);
    setFout(null);
    setMelding(null);
    try {
      const data = await antwoord(
        await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        fallback
      );
      if (klaar) setMelding(klaar(data));
      onChanged();
    } catch (err) {
      setFout(foutTekst(err, fallback));
    } finally {
      setBezig(false);
    }
  };

  const hint =
    period.status === 'OPEN' ? `Open tot ${deadlineTekst(period.deadline)}` : `Status: ${periodStatusLabel(period.status)}`;

  return (
    <AiosSectie sleutel="voorkeuren" titel="Voorkeuren van de AIOS" hint={hint}>
      {period.status === 'CONCEPT' && (
        <div className="space-y-3">
          <p className="text-sm text-neutral-700">
            Open de periode om de AIOS uit te nodigen voor hun voorkeuren. Verlof en parttimedagen die ze al hebben
            opgegeven, staan dan meteen in hun voorkeuren.
          </p>
          <div>
            <label htmlFor="aios-deadline" className="block text-sm font-medium text-neutral-800 mb-1">
              Deadline voor de voorkeuren
            </label>
            <input
              id="aios-deadline"
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="px-2 py-1 border rounded text-sm"
            />
            <p className="text-xs text-neutral-500 mt-1">Standaard 8 weken voor de start van het kwartaal, om 17:00.</p>
          </div>
          <button
            type="button"
            onClick={() => doe(withBasePath(`/api/aios/periode/${period.id}/openen`), 'POST', { deadline }, 'Openen van de periode is mislukt')}
            disabled={bezig || !deadline}
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {bezig ? 'Bezig...' : 'Periode openen'}
          </button>
        </div>
      )}

      {period.status === 'OPEN' && (
        <div className="space-y-3">
          <p className="text-sm text-neutral-700">
            De periode staat open. De AIOS kunnen hun voorkeuren opgeven tot {deadlineTekst(period.deadline)}.
            {stand?.uitgenodigd_op && ` De uitnodigingen zijn verstuurd op ${deadlineTekst(stand.uitgenodigd_op)}.`} Uitnodigingen en
            herinneringen verstuur je bij Exporteren &amp; communicatie.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="aios-deadline-wijzigen" className="block text-xs font-medium text-neutral-600 mb-1">
                Deadline verschuiven
              </label>
              <input
                id="aios-deadline-wijzigen"
                type="datetime-local"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="px-2 py-1 border rounded text-sm"
              />
            </div>
            <button
              type="button"
              disabled={bezig || !deadline || deadline === alsInvoer(period.deadline)}
              onClick={() => doe(withBasePath(`/api/aios/periode/${period.id}/deadline`), 'PATCH', { deadline }, 'Aanpassen van de deadline is mislukt', () => 'De deadline is aangepast.')}
              className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50"
            >
              Opslaan
            </button>
          </div>
        </div>
      )}

      {period.status === 'GESLOTEN' && (
        <div className="space-y-3">
          <p className="text-sm text-neutral-700">
            De periode is gesloten: de AIOS kunnen hun voorkeuren niet meer wijzigen. Maak bovenaan het rooster. De periode kan terug naar open met de knop in de kop van de pagina.
          </p>
        </div>
      )}

      {period.status === 'GEGENEREERD' && (
        <p className="text-sm text-neutral-700">
          De periode is gesloten en het rooster is gemaakt. Moet de periode terug naar open, verwijder dan eerst het rooster
          bovenaan.
        </p>
      )}

      {period.status === 'GEPUBLICEERD' && (
        <p className="text-sm text-neutral-700">
          Het rooster is gepubliceerd. De AIOS zien hun diensten op hun eigen pagina. Bovenaan maak je het definitief of trek je de
          publicatie in.
        </p>
      )}

      {melding && <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-900">{melding}</div>}
      {fout && (
        <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {fout}
        </div>
      )}
    </AiosSectie>
  );
}

interface Deelnemer {
  person_id: string;
  codenaam: string;
  status: 'NIET_BEGONNEN' | 'BEZIG' | 'INGEDIEND';
  ingediend_op: string | null;
  markeringen: MarkeringTelling;
  tellers: BlokkadeTeller[];
  wens: AiosWens;
}

const STATUS_LABEL: Record<Deelnemer['status'], string> = {
  NIET_BEGONNEN: 'Nog niets ingevuld',
  BEZIG: 'Bezig, nog niet ingediend',
  INGEDIEND: 'Ingediend',
};

function wensTekst(w: AiosWens): string[] {
  return [
    w.vier_avonden && '4 avonden',
    w.vier_nachten && '4 nachten',
    w.twee_dagdiensten && 'twee dagdiensten',
    w.inwerken_van && w.inwerken_tot && `inwerken ${datumKort(w.inwerken_van)} t/m ${datumKort(w.inwerken_tot)}`,
    w.onderbreking_van &&
      w.onderbreking_tot &&
      `onderbreking ${datumKort(w.onderbreking_van)} t/m ${datumKort(w.onderbreking_tot)}`,
  ].filter((x): x is string => Boolean(x));
}

/** "Status voorkeuren": per AIOS, with the 50% warnings. */
function StatusVoorkeuren({ periodId, refreshKey }: { periodId: string; refreshKey: string }) {
  const [deelnemers, setDeelnemers] = useState<Deelnemer[] | null>(null);
  const [fout, setFout] = useState<string | null>(null);

  const laad = useCallback(() => {
    fetch(withBasePath(`/api/aios/periode/${periodId}/voorkeuren`))
      .then((res) => antwoord(res, 'Laden van de voorkeuren is mislukt'))
      .then((data) => setDeelnemers(data.deelnemers))
      .catch((err) => setFout(foutTekst(err, 'Laden van de voorkeuren is mislukt')));
  }, [periodId]);
  useEffect(() => {
    laad();
  }, [laad, refreshKey]);

  const ingediend = (deelnemers ?? []).filter((d) => d.status === 'INGEDIEND').length;

  return (
    // Kept loaded while closed: the hint says how many handed in.
    <AiosSectie sleutel="status" titel="Status voorkeuren" hint={deelnemers ? `${ingediend} van de ${deelnemers.length} ingediend` : undefined} blijfGeladen>
      {fout && <p className="text-sm text-red-700">{fout}</p>}
      {deelnemers && (
        <StatusLijst deelnemers={deelnemers} ingediend={ingediend} laad={laad} />
      )}
    </AiosSectie>
  );
}

function StatusLijst({ deelnemers, ingediend, laad }: { deelnemers: Deelnemer[]; ingediend: number; laad: () => void }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-neutral-700">
          {ingediend} van de {deelnemers.length} AIOS {ingediend === 1 ? 'heeft' : 'hebben'} ingediend.
        </p>
        <button type="button" onClick={laad} className="text-sm text-blue-600 hover:text-blue-700">
          Vernieuwen
        </button>
      </div>
      {deelnemers.length === 0 && (
        <p className="text-sm text-neutral-600">Er doet nog geen AIOS mee in dit kwartaal. Voeg ze toe bij Personeel.</p>
      )}
      <ul className="divide-y">
        {deelnemers.map((d) => {
          const wens = wensTekst(d.wens);
          const teVeel = d.tellers.filter((t) => t.boven_helft);
          return (
            <li key={d.person_id} className="py-2 space-y-1 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-neutral-900">{d.codenaam}</span>
                <span className={d.status === 'INGEDIEND' ? 'text-green-800' : 'text-neutral-600'}>
                  {d.status === 'INGEDIEND' ? '✓ ' : ''}
                  {STATUS_LABEL[d.status]}
                </span>
              </div>
              <p className="text-neutral-600">
                {d.markeringen.ABSOLUUT} geblokkeerd · {d.markeringen.LIEVER_NIET} liever niet · {d.markeringen.VOORKEUR}{' '}
                voorkeur
                {wens.length > 0 && ` · ${wens.join(', ')}`}
              </p>
              {teVeel.map((t) => (
                <p key={t.groep} className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-950">
                  ⚠ {bovenHelftPlanner(t)}
                </p>
              ))}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// Every part folds, as on the achterwacht's period page (components/AiosSectie.tsx).
export function AiosPeriodOverview({ period }: { period: Period }) {
  return (
    <AiosHarmonica>
      <Pagina period={period} />
    </AiosHarmonica>
  );
}

function Pagina({ period: begin }: { period: Period }) {
  const [overzicht, setOverzicht] = useState<AiosDienstenOverzicht | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The page reloads the period from the AIOS's own route after each step:
  // the achterwacht's period page that renders this is not changed for it.
  const [period, setPeriod] = useState<Period>(begin);
  const [stand, setStand] = useState<AiosStand | null>(null);
  // Raised when the voortgangstoets changed: its night left the diensten (or came back).
  const [toetsVersie, setToetsVersie] = useState(0);
  // Raised when the roster was made, removed or published (the section Dienstrooster reads it again), and when it was changed by hand (the numbers of Rooster read it again).
  const [roosterVersie, setRoosterVersie] = useState(0);
  const [handmatigVersie, setHandmatigVersie] = useState(0);
  const herlaad = useCallback(() => {
    fetch(withBasePath(`/api/aios/periode/${begin.id}`))
      .then((res) => antwoord(res, 'Laden van de periode is mislukt'))
      .then((data) => {
        setPeriod((p) => ({ ...p, ...data.period }));
        setStand({ uitgenodigd_op: data.uitgenodigd_op, mail_ingesteld: data.mail_ingesteld, aantal_deelnemers: data.aantal_deelnemers, definitief: data.definitief === true });
      })
      .catch((err) => setError(foutTekst(err, 'Laden van de periode is mislukt')));
  }, [begin.id]);
  useEffect(() => {
    herlaad();
  }, [herlaad]);

  useEffect(() => {
    fetch(withBasePath(`/api/planner/period/${period.id}/aios-diensten`))
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Laden van de diensten mislukt');
        setOverzicht(data.data);
      })
      .catch((err) => setError(foutTekst(err, 'Laden van de diensten mislukt')));
  }, [period.id, toetsVersie]);

  return (
    <div className="container-main py-8 space-y-6">
      <div className="card p-6">
        {/* Stacked on a phone, side by side from sm up, as the achterwacht's header. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <Link href="/planner" className="text-sm text-blue-600 hover:text-blue-700">
              ← Periodes
            </Link>
            <h1 className="text-3xl font-bold text-neutral-900 break-words">{period.naam}</h1>
            <p className="text-neutral-600">
              AIOS · {datumLang(period.start_datum)} t/m {datumLang(period.eind_datum)}
              {overzicht && overzicht.dagen.length > 0 && ` · ${Math.ceil(overzicht.dagen.length / 7)} weken`}
            </p>
            <p className="text-sm text-neutral-600">Deadline voorkeuren: {deadlineTekst(period.deadline)}</p>
          </div>
          <AiosPeriodeStatus period={period} definitief={stand?.definitief === true} onChanged={herlaad} />
        </div>
      </div>

      {/* Making, publishing and withdrawing the roster come first, as on the achterwacht's page: a card, not a section. */}
      {period.status !== 'CONCEPT' && (
        <AiosRoosterMaken
          key={toetsVersie}
          periodId={period.id}
          status={period.status}
          versie={handmatigVersie}
          onChanged={() => {
            herlaad();
            setRoosterVersie((v) => v + 1);
          }}
        />
      )}

      {/* The history from before the app is the first section (the planner's wish): the quarter starts from it. */}
      <AiosGeschiedenis periodId={period.id} />
      <Stappen period={period} stand={stand} onChanged={herlaad} />
      <AiosVoortgangstoets periodId={period.id} status={period.status} onChanged={() => setToetsVersie((v) => v + 1)} />
      {period.status !== 'CONCEPT' && (
        <StatusVoorkeuren periodId={period.id} refreshKey={`${period.status}|${period.deadline}`} />
      )}
      {period.status !== 'CONCEPT' && <AiosExporteren period={period} stand={stand} onChanged={herlaad} />}
      {period.status !== 'CONCEPT' && <AiosToegangslinksSectie periodId={period.id} />}
      <AiosDienstpercentage periodId={period.id} status={period.status} versie={roosterVersie + handmatigVersie + toetsVersie} />

      {error && <div className="card p-4 bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}
      {!overzicht && !error && <div className="card p-8 text-center text-neutral-600">Diensten laden...</div>}

      {overzicht && (
        <>
          <AiosSectie sleutel="punten" titel="Punten in dit kwartaal" hint={`${getal(overzicht.punten.totaal_punten)} punten`}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-neutral-600">
                  <th className="py-1 font-medium">Soort</th>
                  <th className="py-1 font-medium text-right">Diensten</th>
                  <th className="py-1 font-medium text-right">Punten</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {overzicht.punten.per_soort.map((t) => (
                  <tr key={t.soort}>
                    <td className="py-1 capitalize">{SOORT_LABELS[t.soort]}</td>
                    <td className="py-1 text-right">{t.aantal}</td>
                    <td className="py-1 text-right">{getal(t.punten)}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-1">Samen</td>
                  <td className="py-1 text-right">
                    {overzicht.punten.per_soort.reduce((som, t) => som + t.aantal, 0)}
                  </td>
                  <td className="py-1 text-right">{getal(overzicht.punten.totaal_punten)}</td>
                </tr>
              </tbody>
            </table>
            <p className="text-sm text-neutral-700">
              Het kwartaal heeft {overzicht.punten.werkdagen} werkdagen (maandag tot en met vrijdag, zonder de
              feestdagen). Om gemiddeld onder 25% te blijven, hebben de AIOS samen minstens{' '}
              <strong>{getal(benodigdeFte(overzicht.punten, 0.25))} fte</strong> nodig. Voor gemiddeld 20% is dat{' '}
              {getal(benodigdeFte(overzicht.punten, 0.2))} fte.
            </p>
          </AiosSectie>

          <AiosDienstrooster
            periodId={period.id}
            status={period.status}
            overzicht={overzicht}
            versie={roosterVersie + toetsVersie}
            onHandmatig={() => {
              setHandmatigVersie((v) => v + 1);
              herlaad();
            }}
          />
        </>
      )}
    </div>
  );
}
