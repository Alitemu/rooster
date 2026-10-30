'use client';

/**
 * "Dienstrooster (...)" on the AIOS period page, the AIOS's copy of the
 * achterwacht's roster section (docs/development/diensten.md, "Copied, not
 * changed"): the heading says in brackets how the roster stands (not made
 * yet, filled in by the solver, changed by hand, published) and four views
 * show it: Lijst (every dienst and who has it), Kalender (the weeks, with
 * a block as one box), Dienstdoende (per AIOS how many of each soort, with a
 * bar) and Ruilverzoeken. The table of the diensten is the legend on top.
 *
 * Changing by hand (lib/aiosHandmatig.ts) is done here, in the list and in the
 * calendar: a click on a dienst or block opens "Wie doet dit?". Until the
 * roster is made the calendar and the list show the diensten themselves.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { withBasePath } from '@/lib/basePath';
import { AiosSectie } from '@/components/AiosSectie';
import { AiosRoosterWijzigen, type Gewijzigd, type Keuze } from '@/components/AiosRoosterWijzigen';
import { AiosRuilenOverzicht } from '@/components/AiosRuilenOverzicht';
import { FellowVak } from '@/components/AiosVoortgangstoets';
import { BLOK_VORM_LABELS } from '@/lib/aiosDiensten';
import type { AiosCode } from '@/lib/aiosDiensten';
import { aiosDienstroosterStatus } from '@/lib/aiosTeksten';
import type { AiosRooster, AiosRoosterDag, AiosRoosterDienst, AiosRoosterPerAios } from '@/lib/aiosRooster';
import type { AiosDag, AiosDienstenOverzicht, AiosDienstRegel } from '@/lib/aiosSlots';
import { foutTekst } from '@/lib/aiosFoutTekst';
import { telwoord } from '@/lib/aiosTelwoord';

const CODE_NAAM: Record<string, string> = {
  UD: 'Uitloopdienst',
  DD: 'Dagdienst',
  AD: 'Avonddienst',
  ADW: 'Avonddienst weekend',
  ND: 'Nachtdienst',
};

// How long "Ongedaan maken" stays: the acute moment only. The achterwacht's server holds the same two minutes (lib/pendingUndo.ts).
const UNDO_VENSTER_SECONDEN = 120;

const DAG_KOP = ['wo', 'do', 'vr', 'za', 'zo', 'ma', 'di'];

const datumKort = (datum: string) =>
  new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });

const getal = (x: number) => x.toLocaleString('nl-NL', { maximumFractionDigits: 1 });

async function antwoord(res: Response, fallback: string) {
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error?.message || fallback);
  return data.data;
}

// --- The calendar -------------------------------------------------------------------------------

type Rij = { label: string; vind: (d: AiosRoosterDag) => AiosRoosterDienst | undefined };

const RIJEN: Rij[] = [
  { label: 'Uitloop', vind: (d) => d.diensten.find((x) => x.code === 'UD') },
  { label: 'Dag', vind: (d) => d.diensten.find((x) => x.code === 'DD') },
  { label: 'Avond', vind: (d) => d.diensten.find((x) => x.code === 'AD' || x.code === 'ADW') },
  { label: 'Nacht', vind: (d) => d.diensten.find((x) => x.code === 'ND' && x.blok) },
];

// The second AIOS on New Year's Eve: a night without a block, only in the week it falls in.
const NACHT_2: Rij = { label: 'Nacht 2', vind: (d) => d.diensten.find((x) => x.code === 'ND' && !x.blok) };

/** Who has it, with a sign when that is against their mark (not by colour alone). */
function Wie({ dienst }: { dienst: AiosRoosterDienst }) {
  if (!dienst.aios) return <span className="italic">leeg</span>;
  const teken = dienst.markering === 'LIEVER_NIET' ? ' ~' : dienst.markering === 'ABSOLUUT' ? ' ✕' : dienst.markering === 'VOORKEUR' ? ' +' : '';
  return (
    <span>
      {dienst.aios.codenaam}
      {teken}
    </span>
  );
}

interface Wijzigen {
  gekozen: Keuze | null;
  kies: (k: Keuze) => void;
  paneel: ReactNode;
}

/** A box: a button to change it when the roster can change by hand, marked when chosen (not by colour alone). */
function Vak({ dienst, keuze, w, className, title }: { dienst: AiosRoosterDienst; keuze: Keuze; w: Wijzigen | null; className: string; title: string }) {
  if (!w) {
    return (
      <span className={className} title={title}>
        <Wie dienst={dienst} />
      </span>
    );
  }
  const gekozen = w.gekozen?.dagen.some((d) => keuze.dagen.some((k) => k.slot_id === d.slot_id)) ?? false;
  return (
    <button
      type="button"
      className={`${className} w-full hover:bg-neutral-100 ${gekozen ? 'outline outline-2 outline-offset-1 outline-neutral-900' : ''}`}
      title={title}
      aria-pressed={gekozen}
      aria-label={`${title}: ${dienst.aios ? dienst.aios.codenaam : 'leeg'}. Wijzigen`}
      onClick={() => w.kies(keuze)}
    >
      <Wie dienst={dienst} />
    </button>
  );
}

function RoosterWeek({ dagen, w }: { dagen: AiosRoosterDag[]; w: Wijzigen | null }) {
  const weken = [...new Set(dagen.map((d) => d.iso_week))];
  const hierGekozen = !!w?.gekozen && dagen.some((d) => d.diensten.some((x) => x.slot_id === w.gekozen!.dagen[0].slot_id));
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-neutral-800">
        Week {weken.join(' en ')} · {datumKort(dagen[0].datum)} t/m {datumKort(dagen[dagen.length - 1].datum)}
      </p>
      <table className="w-full table-fixed border-collapse text-[10px] sm:text-xs">
        <thead>
          <tr>
            <th className="w-12 p-0.5 text-left font-medium text-neutral-600">Dienst</th>
            {dagen.map((d, i) => (
              <th
                key={d.datum}
                className={`p-0.5 text-center font-medium ${d.dag_soort === 'WERKDAG' ? 'text-neutral-600' : 'bg-neutral-100 text-neutral-900'}`}
                title={d.feestdag_naam ?? undefined}
              >
                {DAG_KOP[i]} {Number(d.datum.slice(8))}
                {d.feestdag_naam ? ' ★' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...RIJEN, ...(dagen.some((d) => NACHT_2.vind(d)) ? [NACHT_2] : [])].map((rij) => {
            const cellen: ReactNode[] = [];
            for (let i = 0; i < dagen.length; i++) {
              const dienst = rij.vind(dagen[i]);
              if (!dienst) {
                cellen.push(
                  <td key={i} className="p-0.5">
                    {rij === RIJEN[3] && dagen[i].fellow_nacht && <FellowVak />}
                  </td>
                );
                continue;
              }
              const leeg = !dienst.aios;
              const rand = leeg ? 'border-dashed border-red-600 text-red-800' : '';
              if (!dienst.blok || dienst.blok.vorm === 'LOS') {
                const naam = dienst.blok ? (dienst.blok.soort === 'AVOND' ? 'Avonddienst' : 'Nachtdienst') : CODE_NAAM[dienst.code];
                cellen.push(
                  <td key={i} className="p-0.5">
                    <Vak
                      dienst={dienst}
                      keuze={{ naam, blok: false, dagen: [{ slot_id: dienst.slot_id, datum: dagen[i].datum }] }}
                      w={w}
                      className={`block truncate rounded border border-neutral-400 py-0.5 text-center ${rand}`}
                      title={`${naam} ${datumKort(dagen[i].datum)}`}
                    />
                  </td>
                );
                continue;
              }
              // A block is one box over its days, with its AIOS once (as long as one AIOS has them all).
              const blok = dienst.blok;
              let j = i;
              while (j < dagen.length && rij.vind(dagen[j])?.blok?.id === blok.id && rij.vind(dagen[j])?.aios?.id === dienst.aios?.id) j++;
              const naam = `${blok.soort === 'AVOND' ? 'Avondblok' : 'Nachtblok'} ${BLOK_VORM_LABELS[blok.vorm]}`;
              // Every day of the block in this week, also those another AIOS has.
              const blokDagen = dagen.flatMap((d) => {
                const x = rij.vind(d);
                return x?.blok?.id === blok.id ? [{ slot_id: x.slot_id, datum: d.datum }] : [];
              });
              cellen.push(
                <td key={i} colSpan={j - i} className="p-0.5">
                  <Vak
                    dienst={dienst}
                    keuze={{ naam, blok: true, dagen: blokDagen }}
                    w={w}
                    className={`block truncate rounded border-2 border-neutral-700 py-0.5 text-center ${rand}`}
                    title={naam}
                  />
                </td>
              );
              i = j - 1;
            }
            return (
              <tr key={rij.label}>
                <td className="p-0.5 text-neutral-600">{rij.label}</td>
                {cellen}
              </tr>
            );
          })}
        </tbody>
      </table>
      {hierGekozen && w!.paneel}
    </div>
  );
}


/** A row of the week: the dienst of one soort on each of its seven days. */
type LegeRij = { label: string; vind: (d: AiosDag) => AiosDienstRegel | undefined };

const LEGE_RIJEN: LegeRij[] = [
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
          {LEGE_RIJEN.map((rij) => {
            const cellen: ReactNode[] = [];
            for (let i = 0; i < dagen.length; i++) {
              const dienst = rij.vind(dagen[i]);
              if (!dienst) {
                cellen.push(
                  <td key={i} className="p-0.5">
                    {rij.label === 'Nacht' && dagen[i].fellow_nacht && <FellowVak />}
                  </td>
                );
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
              // Wednesday a week starts on), broken by the fellow's night.
              const blok = dienst.blok;
              const codes: AiosCode[] = [];
              let j = i;
              while (j < dagen.length && dagen[j].datum <= blok.eind_datum && rij.vind(dagen[j])) {
                codes.push(rij.vind(dagen[j])!.code);
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


// --- The list ----------------------------------------------------------------------------------

/** One dienst as the list shows it: from the roster, or from the diensten of the quarter before there is one. */
interface LijstRij {
  datum: string;
  feestdag: string | null;
  code: AiosCode;
  naam: string;
  tijd: string;
  blok: string | null;
  // Only with a roster:
  dienst?: AiosRoosterDienst;
}

const blokTekst = (soort: 'AVOND' | 'NACHT', vorm: keyof typeof BLOK_VORM_LABELS) => `${soort === 'AVOND' ? 'avondblok' : 'nachtblok'} ${BLOK_VORM_LABELS[vorm]}`;

function rijenUitRooster(dagen: AiosRoosterDag[]): LijstRij[] {
  return dagen.flatMap((d) =>
    d.diensten.map((x) => ({
      datum: d.datum,
      feestdag: d.feestdag_naam,
      code: x.code,
      naam: x.naam,
      tijd: `${x.start_tijd}-${x.eind_tijd}`,
      blok: x.blok ? blokTekst(x.blok.soort, x.blok.vorm) : null,
      dienst: x,
    }))
  );
}

function rijenUitDiensten(dagen: AiosDag[]): LijstRij[] {
  return dagen.flatMap((d) =>
    d.diensten.map((x) => ({
      datum: d.datum,
      feestdag: d.feestdag_naam,
      code: x.code,
      naam: x.naam,
      tijd: `${x.start_tijd}-${x.eind_tijd}`,
      blok: x.blok ? blokTekst(x.blok.soort, x.blok.vorm) : null,
    }))
  );
}

/** What "Wie doet dit?" is asked about: a loose dienst, or a block with all its days. */
function keuzeVoor(dienst: AiosRoosterDienst, datum: string, alle: Array<{ datum: string; dienst: AiosRoosterDienst }>): Keuze {
  if (!dienst.blok || dienst.blok.vorm === 'LOS') {
    const naam = dienst.blok ? (dienst.blok.soort === 'AVOND' ? 'Avonddienst' : 'Nachtdienst') : CODE_NAAM[dienst.code];
    return { naam, blok: false, dagen: [{ slot_id: dienst.slot_id, datum }] };
  }
  const blok = dienst.blok;
  const naam = `${blok.soort === 'AVOND' ? 'Avondblok' : 'Nachtblok'} ${BLOK_VORM_LABELS[blok.vorm]}`;
  return { naam, blok: true, dagen: alle.filter((x) => x.dienst.blok?.id === blok.id).map((x) => ({ slot_id: x.dienst.slot_id, datum: x.datum })) };
}

function DienstenLijst({ rijen, w, alle }: { rijen: LijstRij[]; w: Wijzigen | null; alle: Array<{ datum: string; dienst: AiosRoosterDienst }> }) {
  return (
    <div className="overflow-x-auto" data-testid="aios-dienstrooster-lijst">
      <table className="w-full min-w-[34rem] text-sm">
        <thead>
          <tr className="text-left text-neutral-600">
            <th className="py-1 pr-2 font-medium">Datum</th>
            <th className="py-1 pr-2 font-medium">Dienst</th>
            <th className="py-1 pr-2 font-medium">Tijd</th>
            <th className="py-1 pr-2 font-medium">Blok</th>
            <th className="py-1 pr-2 font-medium">AIOS</th>
            {w && <th className="py-1 font-medium"><span className="sr-only">Wijzigen</span></th>}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rijen.map((r, i) => {
            const keuze = r.dienst && w ? keuzeVoor(r.dienst, r.datum, alle) : null;
            const hierGekozen = !!(keuze && w?.gekozen && w.gekozen.dagen.some((d) => keuze.dagen.some((k) => k.slot_id === d.slot_id)));
            return (
              <FragmentRij key={`${r.datum}|${r.code}|${i}`}>
                <tr className={hierGekozen ? 'bg-neutral-50' : undefined}>
                  <td className="py-1 pr-2 whitespace-nowrap">
                    {datumKort(r.datum)}
                    {r.feestdag ? ' ★' : ''}
                  </td>
                  <td className="py-1 pr-2">{r.naam}</td>
                  <td className="py-1 pr-2 whitespace-nowrap">{r.tijd}</td>
                  <td className="py-1 pr-2">{r.blok ?? ''}</td>
                  <td className="py-1 pr-2">{r.dienst ? <Wie dienst={r.dienst} /> : <span className="text-neutral-500">nog niet ingedeeld</span>}</td>
                  {w && (
                    <td className="py-1 text-right">
                      {keuze && r.dienst && (
                        <button
                          type="button"
                          className="px-2 py-0.5 rounded text-xs font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300"
                          aria-pressed={hierGekozen}
                          aria-label={`${r.naam} ${datumKort(r.datum)}: ${r.dienst.aios ? r.dienst.aios.codenaam : 'leeg'}. Wijzig in de lijst`}
                          onClick={() => w.kies(keuze)}
                        >
                          Wijzigen
                        </button>
                      )}
                    </td>
                  )}
                </tr>
                {hierGekozen && (
                  <tr>
                    <td colSpan={6} className="py-2">
                      {w!.paneel}
                    </td>
                  </tr>
                )}
              </FragmentRij>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRij({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

// --- Dienstdoende ------------------------------------------------------------------------------

type Soort = 'nachten' | 'avonden' | 'dagdiensten' | 'uitloopdiensten' | 'feestdagdiensten';

// One colour per soort. The number always stands next to the bar: colour is never alone (black and white).
const SOORTEN: Array<{ sleutel: Soort; kop: string; kleur: string }> = [
  { sleutel: 'nachten', kop: 'Nachten', kleur: 'bg-indigo-500' },
  { sleutel: 'avonden', kop: 'Avonden', kleur: 'bg-blue-500' },
  { sleutel: 'dagdiensten', kop: 'Dagdiensten', kleur: 'bg-emerald-500' },
  { sleutel: 'uitloopdiensten', kop: 'Uitloopdiensten', kleur: 'bg-amber-500' },
  { sleutel: 'feestdagdiensten', kop: 'Op een feestdag', kleur: 'bg-violet-500' },
];

/** A number plus a bar; full width is the highest number of that column. */
function Telling({ waarde, max, kleur }: { waarde: number; max: number; kleur: string }) {
  const breedte = max > 0 ? Math.round((waarde / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-6 text-right tabular-nums">{waarde}</span>
      <div className="h-2.5 min-w-[3rem] flex-1 overflow-hidden rounded bg-neutral-100" aria-hidden="true">
        <div className={`h-full rounded ${kleur}`} style={{ width: `${breedte}%` }} />
      </div>
    </div>
  );
}

function Dienstdoende({ perAios }: { perAios: AiosRoosterPerAios[] }) {
  const totaal = (a: AiosRoosterPerAios) => a.nachten + a.avonden + a.dagdiensten + a.uitloopdiensten;
  const max = Object.fromEntries(SOORTEN.map((s) => [s.sleutel, Math.max(0, ...perAios.map((a) => a[s.sleutel]))])) as Record<Soort, number>;
  return (
    <div className="space-y-2" data-testid="aios-dienstdoende">
      <p className="text-sm text-neutral-600">
        Iedereen die dit kwartaal meedoet, met hoeveel diensten van elke soort. De balk is naar de hoogste in die kolom. Een feestdagdienst telt ook
        bij zijn soort mee. Eerlijk verdeeld wordt op punten naar fte, niet op het aantal diensten: een uitloopdienst is 0,2 punt en een nacht 1
        punt. Daarom staan de punten en het percentage erbij.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-sm">
          <thead>
            <tr className="text-left text-neutral-600">
              <th className="py-1 pr-2 font-medium">AIOS</th>
              {SOORTEN.map((s) => (
                <th key={s.sleutel} className="py-1 pr-2 font-medium">
                  {s.kop}
                </th>
              ))}
              <th className="py-1 pr-2 font-medium text-right">Diensten</th>
              <th className="py-1 pr-2 font-medium text-right">Punten</th>
              <th className="py-1 font-medium text-right">Percentage</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {perAios.map((a) => (
              <tr key={a.person_id}>
                <td className="py-1 pr-2">{a.codenaam}</td>
                {SOORTEN.map((s) => (
                  <td key={s.sleutel} className="py-1 pr-2">
                    <Telling waarde={a[s.sleutel]} max={max[s.sleutel]} kleur={s.kleur} />
                  </td>
                ))}
                <td className="py-1 pr-2 text-right tabular-nums">{totaal(a)}</td>
                <td className="py-1 pr-2 text-right tabular-nums" data-testid="dienstdoende-punten">{getal(a.punten)}</td>
                <td className="py-1 text-right tabular-nums whitespace-nowrap">
                  {a.dienstpercentage === null ? '-' : `${getal(a.dienstpercentage * 100)}%`}
                  {a.fte < 1 && <span className="block text-xs text-neutral-500">fte {getal(a.fte)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t font-medium">
              <td className="py-1 pr-2">Samen</td>
              {SOORTEN.map((s) => (
                <td key={s.sleutel} className="py-1 pr-2 tabular-nums">
                  {perAios.reduce((som, a) => som + a[s.sleutel], 0)}
                </td>
              ))}
              <td className="py-1 pr-2 text-right tabular-nums">{perAios.reduce((som, a) => som + totaal(a), 0)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{getal(perAios.reduce((som, a) => som + a.punten, 0))}</td>
              <td className="py-1" />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// --- The legend and the section ---------------------------------------------------------------

function Legenda({ overzicht }: { overzicht: AiosDienstenOverzicht }) {
  return (
    <div className="space-y-2" data-testid="aios-dienstrooster-legenda">
      <h3 className="text-sm font-semibold text-neutral-900">Diensten (toelichting)</h3>
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
        Avonden en nachten gaan in blokken van zondag tot en met dinsdag en van woensdag tot en met vrijdag. De zaterdag is een losse dienst. Een blok
        staat in de kalender als één vak met een dikke rand: één AIOS doet het hele blok. Een feestdag (★) heeft de diensten van een weekenddag.
      </p>
    </div>
  );
}

type RoosterData = AiosRooster & { loopt: boolean };

const TABS = [
  { id: 'lijst', label: '📋 Lijst' },
  { id: 'kalender', label: '📅 Kalender' },
  { id: 'dienstdoende', label: '🧑‍⚕️ Dienstdoende' },
  { id: 'ruilverzoeken', label: '🔁 Ruilverzoeken' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export function AiosDienstrooster({
  periodId,
  status,
  overzicht,
  versie,
  onHandmatig,
}: {
  periodId: string;
  status: string;
  overzicht: AiosDienstenOverzicht;
  /** Raised when the roster was made or removed or published: this reads it again, and forgets what it could undo. */
  versie: number;
  /** After a change by hand: the rest of the page reads the roster again. */
  onHandmatig: () => void;
}) {
  const gemaakt = status === 'GEGENEREERD' || status === 'GEPUBLICEERD';
  const gepubliceerd = status === 'GEPUBLICEERD';
  const [rooster, setRooster] = useState<RoosterData | null>(null);
  const [fout, setFout] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('kalender');
  const [gekozen, setGekozen] = useState<Keuze | null>(null);
  const [laatste, setLaatste] = useState<Gewijzigd | null>(null);
  const [terugFout, setTerugFout] = useState<string | null>(null);
  const [bezig, setBezig] = useState(false);

  // Undoing is for the acute moment: the notice and its button go away after two minutes (the same as the
  // achterwacht's, lib/pendingUndo.ts), and a reload never shows them, as the notice lives in this state only.
  useEffect(() => {
    if (!laatste) return;
    const timer = setTimeout(() => setLaatste(null), UNDO_VENSTER_SECONDEN * 1000);
    return () => clearTimeout(timer);
  }, [laatste]);

  // Only the answer of the latest reading counts: a slow answer from before the roster was removed must not bring it back.
  const lezing = useRef(0);
  const laad = useCallback(() => {
    const nr = ++lezing.current;
    if (!gemaakt) {
      setRooster(null);
      return;
    }
    fetch(withBasePath(`/api/aios/periode/${periodId}/rooster`))
      .then((res) => antwoord(res, 'Laden van het rooster is mislukt'))
      .then((data) => {
        if (nr !== lezing.current) return;
        setRooster(data);
        setFout(null);
      })
      .catch((err) => nr === lezing.current && setFout(foutTekst(err, 'Laden van het rooster is mislukt')));
  }, [periodId, gemaakt]);
  useEffect(() => {
    setGekozen(null);
    setLaatste(null);
    laad();
  }, [laad, status, versie]);

  const terugzetten = async () => {
    if (!laatste) return;
    setBezig(true);
    setTerugFout(null);
    try {
      await antwoord(
        await fetch(withBasePath(`/api/aios/periode/${periodId}/rooster/wijzigen`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wijzigingen: laatste.terug, ...(gepubliceerd ? { reden: 'Vorige wijziging ongedaan gemaakt' } : {}) }),
        }),
        'Ongedaan maken is mislukt'
      );
      setLaatste(null);
      laad();
      onHandmatig();
    } catch (err) {
      setTerugFout(foutTekst(err, 'Ongedaan maken is mislukt'));
    } finally {
      setBezig(false);
    }
  };

  const weken = <T extends { datum: string }>(dagen: T[]): T[][] => {
    const uit: T[][] = [];
    for (const dag of dagen) {
      if (uit.length === 0 || uit[uit.length - 1].length === 7) uit.push([]);
      uit[uit.length - 1].push(dag);
    }
    return uit;
  };
  const leegWeken = weken(overzicht.dagen);
  const feestdagen = overzicht.dagen.filter((d) => d.feestdag_naam);

  // The heading waits for the roster before it says "automatisch" or "handmatig".
  const label = status === 'GEGENEREERD' && !rooster ? null : aiosDienstroosterStatus(status, rooster?.handmatig ?? false);
  const titel = label ? `Dienstrooster (${label})` : 'Dienstrooster';
  const hint = rooster ? (rooster.leeg > 0 ? `${rooster.leeg} ${rooster.leeg === 1 ? 'dienst' : 'diensten'} leeg` : 'alle diensten ingedeeld') : telwoord(leegWeken.length, 'week', 'weken');

  const wijzigen: Wijzigen | null =
    !rooster || rooster.loopt || bezig
      ? null
      : {
          gekozen,
          kies: setGekozen,
          paneel: gekozen && (
            <AiosRoosterWijzigen
              key={gekozen.dagen.map((d) => d.slot_id).join()}
              periodId={periodId}
              keuze={gekozen}
              metReden={gepubliceerd}
              onGewijzigd={(g) => {
                setLaatste(g);
                setGekozen(null);
                laad();
                onHandmatig();
              }}
              onSluit={() => setGekozen(null)}
            />
          ),
        };

  const alleDiensten = rooster ? rooster.dagen.flatMap((d) => d.diensten.map((dienst) => ({ datum: d.datum, dienst }))) : [];

  return (
    <AiosSectie sleutel="dienstrooster" titel={titel} hint={hint} testId="aios-dienstrooster">
      <Legenda overzicht={overzicht} />
      {fout && (
        <p role="alert" className="text-sm text-red-700">
          {fout}
        </p>
      )}
      {laatste && (
        <div className="rounded border border-neutral-400 p-3 text-sm space-y-1" role="status" data-testid="aios-laatste-wijziging">
          <p className="font-medium">Gewijzigd. {laatste.tekst}</p>
          {laatste.waarschuwingen.length > 0 && (
            <ul className="list-disc pl-5 text-neutral-800">
              {laatste.waarschuwingen.map((x) => (
                <li key={x.tekst}>{x.tekst}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="px-3 py-1 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50"
            disabled={bezig}
            onClick={terugzetten}
          >
            Ongedaan maken
          </button>
          {terugFout && (
            <p role="alert" className="text-red-700">
              {terugFout}
            </p>
          )}
        </div>
      )}
      {rooster && rooster.overtredingen.length > 0 && (
        <div className="rounded border-2 border-dashed border-neutral-800 p-3 text-sm space-y-1" data-testid="aios-overtredingen">
          <p className="font-medium">
            ⚠ Dit rooster breekt {rooster.overtredingen.length === 1 ? 'een harde regel' : `${rooster.overtredingen.length} keer een harde regel`}:
          </p>
          <ul className="list-disc pl-5 text-neutral-800">
            {rooster.overtredingen.map((o, i) => (
              <li key={i}>
                {o.wie.join(' en ')}: {o.tekst} {o.datums.length > 0 && `(${o.datums.map(datumKort).join(', ')})`}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto">
        <div className="inline-flex overflow-hidden rounded border border-neutral-300" role="tablist" aria-label="Weergave van het dienstrooster">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`aios-dienstrooster-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="aios-dienstrooster-paneel"
              onClick={() => setTab(t.id)}
              className={`px-3 py-1 text-sm font-medium transition-colors ${i > 0 ? 'border-l border-neutral-300' : ''} ${
                tab === t.id ? 'bg-blue-600 text-white' : 'bg-white text-neutral-700 hover:bg-neutral-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div id="aios-dienstrooster-paneel" role="tabpanel" aria-labelledby={`aios-dienstrooster-tab-${tab}`} className="space-y-3">
        {rooster && tab !== 'dienstdoende' && tab !== 'ruilverzoeken' && (
          <p className="text-sm text-neutral-600">
            Tik op een blok of dienst om te kiezen wie die doet. Een blok met een dikke rand doet één AIOS. Een opgeknipt blok rond feestdagen staat per dag. ~ is
            liever niet, ✕ is een geblokkeerde dienst uit het deel boven de helft en + is een voorkeur.{' '}
            {rooster.leeg > 0 ? `${rooster.leeg} ${rooster.leeg === 1 ? 'dienst is' : 'diensten zijn'} leeg.` : ''}
          </p>
        )}
        {!rooster && (tab === 'lijst' || tab === 'kalender') && (
          <p className="text-sm text-neutral-600" data-testid="aios-dienstrooster-nog-niet">
            {gemaakt ? 'Het rooster wordt geladen...' : 'Het rooster is nog niet gegenereerd. Hier staan de diensten van het kwartaal. Na het maken staat erbij wie ze doet.'}
          </p>
        )}

        {tab === 'lijst' && <DienstenLijst rijen={rooster ? rijenUitRooster(rooster.dagen) : rijenUitDiensten(overzicht.dagen)} w={wijzigen} alle={alleDiensten} />}

        {tab === 'kalender' && (
          <>
            {rooster
              ? weken(rooster.dagen).map((week) => <RoosterWeek key={week[0].datum} dagen={week} w={wijzigen} />)
              : leegWeken.map((week) => <WeekTabel key={week[0].datum} dagen={week} />)}
            {!rooster && feestdagen.length > 0 && (
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
          </>
        )}

        {tab === 'dienstdoende' &&
          (rooster ? <Dienstdoende perAios={rooster.per_aios} /> : <p className="text-sm text-neutral-600">Er is nog geen rooster. Na het maken staat hier wie hoeveel diensten doet.</p>)}

        {tab === 'ruilverzoeken' && <AiosRuilenOverzicht periodId={periodId} gepubliceerd={gepubliceerd} />}
      </div>
    </AiosSectie>
  );
}
