/**
 * An AIOS period's page, for now (docs/aios-rooster.md, step 1): the
 * quarter's diensten per week with the blocks as one box, and the points
 * the quarter holds, so the planner sees before anything else how many fte
 * the AIOS need together to stay under 25% on average.
 *
 * Opening, preferences and the roster come in the next steps; until then
 * the achterwacht's steps refuse an AIOS period (lib/aiosPeriod.ts).
 */

'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { withBasePath } from '@/lib/basePath';
import { deadlineTekst } from '@/lib/verzendlijst';
import { benodigdeFte, SOORT_LABELS, BLOK_VORM_LABELS } from '@/lib/aiosDiensten';
import type { AiosCode } from '@/lib/aiosDiensten';
import type { AiosDag, AiosDienstenOverzicht, AiosDienstRegel } from '@/lib/aiosSlots';

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

export function AiosPeriodOverview({ period }: { period: Period }) {
  const [overzicht, setOverzicht] = useState<AiosDienstenOverzicht | null>(null);
  const [error, setError] = useState<string | null>(null);

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

      <div className="card p-4 bg-amber-50 border border-amber-200 text-sm text-amber-900">
        Dit is de eerste stap van het rooster voor de AIOS: de diensten, de blokken en de punten van het kwartaal.
        Het voorkeurenscherm, het maken van het rooster en het publiceren komen in een volgende versie. Tot dan kan
        deze periode nog niet geopend worden.
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
