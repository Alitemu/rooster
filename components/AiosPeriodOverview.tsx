/**
 * An AIOS period's page (docs/aios-rooster.md): its steps up to the
 * preferences (open, invite, remind, deadline, close), "Status voorkeuren"
 * per AIOS with the 50% warnings, and the quarter's diensten per week with
 * the blocks as one box, and the points it holds, so the planner sees how
 * many fte the AIOS need together to stay under 25% on average.
 *
 * Generating, the roster per block and publishing come in the next steps;
 * until then the achterwacht's steps after closing refuse an AIOS period
 * (lib/aiosPeriod.ts).
 */

'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { withBasePath } from '@/lib/basePath';
import { AiosAutoHerinneringen } from '@/components/AiosAutoHerinneringen';
import { deadlineTekst } from '@/lib/verzendlijst';
import { benodigdeFte, SOORT_LABELS, BLOK_VORM_LABELS } from '@/lib/aiosDiensten';
import type { AiosCode } from '@/lib/aiosDiensten';
import type { AiosDag, AiosDienstenOverzicht, AiosDienstRegel } from '@/lib/aiosSlots';
import { bovenHelftPlanner, type AiosWens, type BlokkadeTeller, type MarkeringTelling } from '@/lib/aiosVoorkeur';

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

const DAG_KOP = ['wo', 'do', 'vr', 'za', 'zo', 'ma', 'di'];

/** A row of the week: the dienst of one soort on each of its seven days. */
type Rij = { label: string; vind: (d: AiosDag) => AiosDienstRegel | undefined };

const RIJEN: Rij[] = [
  { label: 'Uitloop', vind: (d) => d.diensten.find((x) => x.code === 'UD') },
  { label: 'Dag', vind: (d) => d.diensten.find((x) => x.code === 'DD') },
  { label: 'Avond', vind: (d) => d.diensten.find((x) => x.code === 'AD' || x.code === 'ADW') },
  { label: 'Nacht', vind: (d) => d.diensten.find((x) => x.code === 'ND') },
];

function WeekTabel({ dagen }: { dagen: AiosDag[] }) {
  const weken = [...new Set(dagen.map((d) => d.iso_week))];
  const eerste = dagen[0];
  const laatste = dagen[dagen.length - 1];
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-neutral-800">
        Week {weken.join(' en ')} · {datumKort(eerste.datum)} t/m {datumKort(laatste.datum)}
      </p>
      <table className="w-full table-fixed border-collapse text-xs">
        <thead>
          <tr>
            <th className="w-14 p-1 text-left font-medium text-neutral-600">Dienst</th>
            {dagen.map((d, i) => (
              <th
                key={d.datum}
                className={`p-1 text-center font-medium ${d.dag_soort === 'WERKDAG' ? 'text-neutral-600' : 'bg-neutral-100 text-neutral-900'}`}
                title={d.feestdag_naam ?? undefined}
              >
                {DAG_KOP[i]} {Number(d.datum.slice(8))}
                {d.feestdag_naam ? ' ★' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {RIJEN.map((rij) => {
            const cellen: ReactNode[] = [];
            for (let i = 0; i < dagen.length; i++) {
              const dienst = rij.vind(dagen[i]);
              if (!dienst) {
                cellen.push(<td key={i} className="p-0.5" />);
                continue;
              }
              if (!dienst.blok) {
                cellen.push(
                  <td key={i} className="p-0.5">
                    <span className="block rounded border border-neutral-400 py-0.5 text-center">{dienst.code}</span>
                  </td>
                );
                continue;
              }
              // A block is one box over its days (it never crosses the
              // Wednesday a week starts on).
              const blok = dienst.blok;
              const codes: AiosCode[] = [];
              let j = i;
              while (j < dagen.length && dagen[j].datum <= blok.eind_datum) {
                const d = rij.vind(dagen[j]);
                if (d) codes.push(d.code);
                j++;
              }
              cellen.push(
                <td key={i} colSpan={j - i} className="p-0.5">
                  <span
                    className="flex justify-around rounded border-2 border-neutral-700 py-0.5"
                    title={`Blok ${BLOK_VORM_LABELS[blok.vorm]}: één AIOS doet het hele blok`}
                  >
                    {codes.map((c, k) => (
                      <span key={k}>{c}</span>
                    ))}
                  </span>
                </td>
              );
              i = j - 1;
            }
            return (
              <tr key={rij.label}>
                <td className="p-1 text-neutral-600">{rij.label}</td>
                {cellen}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A datetime-local value for the input, from a stored deadline. */
function alsInvoer(deadline: string): string {
  return deadline.length >= 16 ? deadline.slice(0, 16) : deadline;
}

async function antwoord(res: Response, fallback: string) {
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error?.message || fallback);
  return data.data;
}

/** The AIOS's mail: whether it can go, and for the beheerder the AIOS's flow mailbox. */
function MailPaneel({ beheerder, onChanged }: { beheerder: boolean; onChanged: () => void }) {
  const [status, setStatus] = useState<{ ingesteld: boolean; account: boolean; uitgeschakeld: boolean; verzendlijst_aan: string | null; laatste_fout: { melding: string } | null } | null>(null);
  const [adres, setAdres] = useState('');
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);

  const laad = useCallback(() => {
    fetch(withBasePath('/api/aios/mail-instellingen'))
      .then((res) => antwoord(res, 'Laden van de mailinstellingen is mislukt'))
      .then((data) => {
        setStatus(data);
        setAdres(data.verzendlijst_aan ?? '');
      })
      .catch((err) => setFout(err instanceof Error ? err.message : 'Laden van de mailinstellingen is mislukt'));
  }, []);
  useEffect(() => {
    laad();
  }, [laad]);

  const opslaan = async () => {
    setBezig(true);
    setFout(null);
    try {
      await antwoord(
        await fetch(withBasePath('/api/aios/mail-instellingen'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ verzendlijst_aan: adres }),
        }),
        'Opslaan is mislukt'
      );
      laad();
      onChanged();
    } catch (err) {
      setFout(err instanceof Error ? err.message : 'Opslaan is mislukt');
    } finally {
      setBezig(false);
    }
  };

  if (!status) return fout ? <p className="text-sm text-red-700">{fout}</p> : null;
  return (
    <div className="space-y-2 rounded border border-neutral-200 p-3 text-sm">
      <p className="font-medium text-neutral-900">Mail naar de AIOS</p>
      {status.uitgeschakeld && <p className="text-red-800">Versturen staat uit op deze installatie (MAIL_UITGESCHAKELD).</p>}
      {!status.account && (
        <p className="text-amber-900">
          Het Gmail-account is nog niet ingesteld. Dat doet de beheerder bij Mailinstellingen op de pagina van een periode van
          de achterwacht. Hetzelfde account verstuurt de mail van de AIOS.
        </p>
      )}
      <p className="text-neutral-700">
        De AIOS hebben een eigen Power Automate-stroom met een eigen adressenlijst. Hun verzendlijst gaat naar:{' '}
        <strong>{status.verzendlijst_aan ?? 'nog niet ingesteld'}</strong>
      </p>
      {status.laatste_fout && <p className="text-red-800">Laatste keer mislukt: {status.laatste_fout.melding}</p>}
      {beheerder && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="aios-stroom" className="block text-xs font-medium text-neutral-600 mb-1">
              Verzendlijst van de AIOS sturen naar
            </label>
            <input
              id="aios-stroom"
              type="email"
              autoComplete="off"
              value={adres}
              onChange={(e) => setAdres(e.target.value)}
              placeholder="het adres waar de stroom van de AIOS op let"
              className="w-full px-2 py-1 border rounded text-sm"
            />
          </div>
          <button type="button" onClick={opslaan} disabled={bezig} className="btn-primary">
            {bezig ? 'Bezig...' : 'Opslaan'}
          </button>
        </div>
      )}
      {!beheerder && <p className="text-neutral-600">Alleen de beheerder kan dit adres wijzigen.</p>}
      {fout && <p className="text-red-700">{fout}</p>}
    </div>
  );
}

interface AiosStand {
  uitgenodigd_op: string | null;
  mail_ingesteld: boolean;
  aantal_deelnemers: number;
}

/** Open, invite, remind, close: the steps up to the preferences, on the AIOS's own routes. */
function Stappen({ period, stand, onChanged }: { period: Period; stand: AiosStand | null; onChanged: () => void }) {
  const [deadline, setDeadline] = useState(alsInvoer(period.deadline));
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);
  const [zeker, setZeker] = useState(false);
  const [beheerder, setBeheerder] = useState(false);

  useEffect(() => {
    setDeadline(alsInvoer(period.deadline));
  }, [period.deadline]);
  useEffect(() => {
    fetch(withBasePath('/api/auth/me'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setBeheerder(data?.data?.role === 'ADMIN'))
      .catch(() => setBeheerder(false));
  }, []);

  const doe = async (url: string, method: string, body: unknown, fallback: string, klaar?: (data: { aantal?: number; overgeslagen?: number }) => string) => {
    setBezig(true);
    setFout(null);
    setMelding(null);
    try {
      const data = await antwoord(
        await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        fallback
      );
      setZeker(false);
      if (klaar) setMelding(klaar(data));
      onChanged();
    } catch (err) {
      setFout(err instanceof Error ? err.message : fallback);
    } finally {
      setBezig(false);
    }
  };

  const linksDownloaden = async () => {
    setBezig(true);
    setFout(null);
    try {
      const res = await fetch(withBasePath(`/api/aios/periode/${period.id}/links`), { method: 'POST' });
      if (!res.ok) await antwoord(res, 'Downloaden is mislukt');
      const url = window.URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `links-aios-${period.naam}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setFout(err instanceof Error ? err.message : 'Downloaden is mislukt');
    } finally {
      setBezig(false);
    }
  };

  const aantal = (n = 0, wat: string) => `${n} ${wat}`;

  return (
    <div className="card card-padding space-y-4">
      <h2 className="text-lg font-semibold">Voorkeuren van de AIOS</h2>

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
            className="btn-primary"
          >
            {bezig ? 'Bezig...' : 'Periode openen'}
          </button>
        </div>
      )}

      {period.status === 'OPEN' && (
        <div className="space-y-3">
          <p className="text-sm text-neutral-700">
            De periode staat open. De AIOS kunnen hun voorkeuren opgeven tot {deadlineTekst(period.deadline)}.
            {stand?.uitgenodigd_op && ` De uitnodigingen zijn verstuurd op ${deadlineTekst(stand.uitgenodigd_op)}.`}
          </p>
          <MailPaneel beheerder={beheerder} onChanged={onChanged} />
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={bezig || !stand?.mail_ingesteld}
              onClick={() =>
                doe(withBasePath(`/api/aios/periode/${period.id}/uitnodigingen`), 'POST', {}, 'Versturen is mislukt', (d) => `Verstuurd: ${aantal(d.aantal, 'uitnodigingen')}.`)
              }
              className="btn-primary"
            >
              {stand?.uitgenodigd_op ? 'Uitnodigingen opnieuw versturen' : 'Uitnodigingen versturen'}
            </button>
            <button
              type="button"
              disabled={bezig || !stand?.mail_ingesteld}
              onClick={() =>
                doe(withBasePath(`/api/aios/periode/${period.id}/herinneringen`), 'POST', {}, 'Versturen is mislukt', (d) =>
                  d.aantal
                    ? `Verstuurd: ${aantal(d.aantal, 'herinneringen')}.`
                    : 'Er ging geen herinnering uit. Wie nog niet heeft ingediend, kreeg er de afgelopen dag al een.'
                )
              }
              className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50"
            >
              Herinnering versturen
            </button>
            <button
              type="button"
              disabled={bezig}
              onClick={linksDownloaden}
              className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50"
            >
              Links downloaden
            </button>
          </div>
          <AiosAutoHerinneringen
            periodId={period.id}
            refreshKey={`${period.deadline}|${stand?.uitgenodigd_op}|${stand?.mail_ingesteld}`}
          />
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
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => (zeker ? doe(withBasePath(`/api/aios/periode/${period.id}/sluiten`), 'POST', {}, 'Sluiten van de periode is mislukt') : setZeker(true))}
              disabled={bezig}
              className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:bg-neutral-100 transition-colors"
            >
              {bezig ? 'Bezig...' : zeker ? 'Zeker weten? Nogmaals klikken' : 'Periode sluiten'}
            </button>
            {zeker && (
              <button type="button" onClick={() => setZeker(false)} className="px-4 py-2 rounded font-medium text-neutral-600">
                Annuleren
              </button>
            )}
          </div>
          {zeker && (
            <p className="text-sm text-neutral-700">
              Na het sluiten kunnen de AIOS hun voorkeuren niet meer wijzigen. Terug naar open kan daarna nog.
            </p>
          )}
        </div>
      )}

      {period.status === 'GESLOTEN' && (
        <div className="space-y-3">
          <p className="text-sm text-neutral-700">
            De periode is gesloten: de AIOS kunnen hun voorkeuren niet meer wijzigen. Het maken van het rooster komt in
            een volgende versie.
          </p>
          <button
            type="button"
            onClick={() => (zeker ? doe(withBasePath(`/api/aios/periode/${period.id}/heropenen`), 'POST', {}, 'Terug naar open is mislukt') : setZeker(true))}
            disabled={bezig}
            className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
          >
            {bezig ? 'Bezig...' : zeker ? 'Zeker weten? Nogmaals klikken' : 'Terug naar open'}
          </button>
          {zeker && (
            <p className="text-sm text-neutral-700">
              De AIOS kunnen hun voorkeuren weer wijzigen tot de deadline. Verschuif die zo nodig daarna.
            </p>
          )}
        </div>
      )}

      {melding && <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-900">{melding}</div>}
      {fout && (
        <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {fout}
        </div>
      )}
    </div>
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

/** The two workbooks of the quarter's preferences (lib/aiosDownloads.ts). */
function Downloads({ periodId, periodNaam }: { periodId: string; periodNaam: string }) {
  const [bezig, setBezig] = useState<string | null>(null);
  const [fout, setFout] = useState<string | null>(null);
  const download = async (pad: string, naam: string) => {
    setBezig(pad);
    setFout(null);
    try {
      const res = await fetch(withBasePath(`/api/aios/periode/${periodId}/${pad}`));
      if (!res.ok) await antwoord(res, 'Downloaden is mislukt');
      const url = window.URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${naam}-${periodNaam}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setFout(err instanceof Error ? err.message : 'Downloaden is mislukt');
    } finally {
      setBezig(null);
    }
  };
  const knop = 'px-3 py-1.5 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50';
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={knop} disabled={bezig !== null} onClick={() => download('download-voorkeuren', 'voorkeuren-aios')}>
          {bezig === 'download-voorkeuren' ? 'Bezig...' : '⬇ Voorkeuren per dienst'}
        </button>
        <button type="button" className={knop} disabled={bezig !== null} onClick={() => download('download-verzoeken', 'verzoeken-aios')}>
          {bezig === 'download-verzoeken' ? 'Bezig...' : '⬇ Verzoeken per AIOS'}
        </button>
      </div>
      <p className="text-xs text-neutral-500">
        Twee Excel-bestanden. Het eerste toont per dienst wat elke AIOS heeft aangegeven. Het tweede toont per AIOS de
        verzoeken (4 avonden, 4 nachten, twee dagdiensten, inwerken en onderbreking), de parttimedagen, de afwezigheid
        en de tellers.
      </p>
      {fout && <p className="text-sm text-red-700">{fout}</p>}
    </div>
  );
}

/** "Status voorkeuren": per AIOS, with the 50% warnings. */
function StatusVoorkeuren({ periodId, periodNaam, refreshKey }: { periodId: string; periodNaam: string; refreshKey: string }) {
  const [deelnemers, setDeelnemers] = useState<Deelnemer[] | null>(null);
  const [fout, setFout] = useState<string | null>(null);

  const laad = useCallback(() => {
    fetch(withBasePath(`/api/aios/periode/${periodId}/voorkeuren`))
      .then((res) => antwoord(res, 'Laden van de voorkeuren is mislukt'))
      .then((data) => setDeelnemers(data.deelnemers))
      .catch((err) => setFout(err instanceof Error ? err.message : 'Laden van de voorkeuren is mislukt'));
  }, [periodId]);
  useEffect(() => {
    laad();
  }, [laad, refreshKey]);

  if (fout) return <div className="card p-4 bg-red-50 border border-red-200 text-sm text-red-700">{fout}</div>;
  if (!deelnemers) return null;
  const ingediend = deelnemers.filter((d) => d.status === 'INGEDIEND').length;

  return (
    <div className="card card-padding space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Status voorkeuren</h2>
        <button type="button" onClick={laad} className="text-sm text-blue-600 hover:text-blue-700">
          Vernieuwen
        </button>
      </div>
      <p className="text-sm text-neutral-700">
        {ingediend} van de {deelnemers.length} AIOS {ingediend === 1 ? 'heeft' : 'hebben'} ingediend.
      </p>
      <Downloads periodId={periodId} periodNaam={periodNaam} />
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
              {d.wens.opmerking && <p className="text-neutral-700">&ldquo;{d.wens.opmerking}&rdquo;</p>}
              {teVeel.map((t) => (
                <p key={t.groep} className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-950">
                  ⚠ {bovenHelftPlanner(t)}
                </p>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AiosPeriodOverview({ period: begin }: { period: Period }) {
  const [overzicht, setOverzicht] = useState<AiosDienstenOverzicht | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The page reloads the period from the AIOS's own route after each step:
  // the achterwacht's period page that renders this is not changed for it.
  const [period, setPeriod] = useState<Period>(begin);
  const [stand, setStand] = useState<AiosStand | null>(null);
  const herlaad = useCallback(() => {
    fetch(withBasePath(`/api/aios/periode/${begin.id}`))
      .then((res) => antwoord(res, 'Laden van de periode is mislukt'))
      .then((data) => {
        setPeriod((p) => ({ ...p, ...data.period }));
        setStand({ uitgenodigd_op: data.uitgenodigd_op, mail_ingesteld: data.mail_ingesteld, aantal_deelnemers: data.aantal_deelnemers });
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Laden van de periode is mislukt'));
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
      .catch((err) => setError(err instanceof Error ? err.message : 'Laden van de diensten mislukt'));
  }, [period.id]);

  const weken: AiosDag[][] = [];
  for (const dag of overzicht?.dagen ?? []) {
    if (weken.length === 0 || weken[weken.length - 1].length === 7) weken.push([]);
    weken[weken.length - 1].push(dag);
  }
  const feestdagen = (overzicht?.dagen ?? []).filter((d) => d.feestdag_naam);

  return (
    <div className="container-main py-8 space-y-6">
      <div className="card p-6 space-y-2">
        <Link href="/planner" className="text-sm text-blue-600 hover:text-blue-700">
          ← Periodes
        </Link>
        <h1 className="text-3xl font-bold text-neutral-900 break-words">{period.naam}</h1>
        <p className="text-neutral-600">
          AIOS · {datumLang(period.start_datum)} t/m {datumLang(period.eind_datum)}
          {weken.length > 0 && ` · ${weken.length} weken`}
        </p>
        <p className="text-sm text-neutral-600">Deadline voorkeuren: {deadlineTekst(period.deadline)}</p>
      </div>

      <Stappen period={period} stand={stand} onChanged={herlaad} />
      {period.status !== 'CONCEPT' && (
        <StatusVoorkeuren periodId={period.id} periodNaam={period.naam} refreshKey={`${period.status}|${period.deadline}`} />
      )}

      <div className="card p-4 bg-amber-50 border border-amber-200 text-sm text-amber-900">
        Het maken van het rooster voor de AIOS en het publiceren komen in een volgende versie.
      </div>

      {error && <div className="card p-4 bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}
      {!overzicht && !error && <div className="card p-8 text-center text-neutral-600">Diensten laden...</div>}

      {overzicht && (
        <>
          <div className="card card-padding space-y-3">
            <h2 className="text-lg font-semibold">Punten in dit kwartaal</h2>
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
          </div>

          <div className="card card-padding space-y-3">
            <h2 className="text-lg font-semibold">Diensten</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-neutral-600">
                  <th className="py-1 font-medium">Code</th>
                  <th className="py-1 font-medium">Dienst</th>
                  <th className="py-1 font-medium">Tijd</th>
                  <th className="py-1 font-medium text-right">Punten</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {overzicht.dienst_types.map((t) => (
                  <tr key={t.code}>
                    <td className="py-1 font-medium">{t.code}</td>
                    <td className="py-1">{t.naam}</td>
                    <td className="py-1 whitespace-nowrap">
                      {t.start_tijd}-{t.eind_tijd}
                    </td>
                    <td className="py-1 text-right">{getal(t.punten)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-sm text-neutral-700">
              Avonden en nachten gaan in blokken van zondag tot en met dinsdag en van woensdag tot en met vrijdag. De
              zaterdag is een losse dienst. Een blok staat hieronder als één vak met een dikke rand: één AIOS doet
              het hele blok. Een feestdag (★) heeft de diensten van een weekenddag.
            </p>
          </div>

          <div className="card card-padding space-y-5">
            <h2 className="text-lg font-semibold">Per week</h2>
            {weken.map((week) => (
              <WeekTabel key={week[0].datum} dagen={week} />
            ))}
            {feestdagen.length > 0 && (
              <div className="text-sm text-neutral-700">
                <p className="font-medium">Feestdagen in dit kwartaal</p>
                <ul className="list-disc pl-5">
                  {feestdagen.map((d) => (
                    <li key={d.datum}>
                      {d.feestdag_naam} ({datumKort(d.datum)})
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
