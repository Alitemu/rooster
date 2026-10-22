/**
 * The AIOS planner's two downloads of a quarter's preferences, asked for in
 * October 2026 ("inclusief de voorkeuren wat betreft een blok van 4 dagen"):
 *
 * - Voorkeuren per dienst: first the requests (4 avonden, 4 nachten, twee
 *   dagdiensten, inwerken, onderbreking: VERZOEK_RIJEN) and the part-time
 *   days (Parttime 1, Parttime 2 ...), then one row per dienst (date, day, ISO week, the
 *   dienst, its block, the feestdag), one column per AIOS with what they
 *   marked there in words, and why when it is not their own (parttime,
 *   afwezig). A block's mark stands on each of its diensten. A mark the
 *   AIOS made by hand shows their own toelichting of that day after a colon
 *   ("geblokkeerd: ziek kind"), on each dienst of the day, the planner's
 *   alone (lib/aiosReden.ts).
 * - Verzoeken per AIOS: one row per AIOS, with where their hand-in stands,
 *   what they asked besides (4 avonden, 4 nachten, twee dagdiensten,
 *   inwerken, onderbreking), their part-time days and absences
 *   in the quarter, how much they marked and the 50% counters with the part
 *   above half (lib/aiosVoorkeur.ts).
 *
 * The AIOS's own, next to the achterwacht's exports (app/api/exports),
 * which stay as they are (docs/development/diensten.md, "Copied, not
 * changed"). Everyone the invitations go to gets a row or a column, also
 * who marked nothing. Read straight from the database, not from the
 * backup files (lib/aiosVoorkeurBackup.ts).
 */

import { db } from '@/db/client';
import { BLOK_VORM_LABELS } from '@/lib/aiosDiensten';
import { aiosDeelnemers, type AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { loadAlleAiosRedenen } from '@/lib/aiosReden';
import {
  blokkadeTellers,
  loadAiosVoorkeurDagen,
  loadAiosWens,
  telMarkeringen,
  TELLER_LABELS,
  type AiosVoorkeurDienst,
} from '@/lib/aiosPreferences';
import type { XlsxCell, XlsxSheet } from '@/lib/xlsxWrite';

const KEUZE: Record<string, string> = {
  ABSOLUUT: 'geblokkeerd',
  LIEVER_NIET: 'liever niet',
  VOORKEUR: 'voorkeur',
};

const DAG = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const WEEKDAG: Record<string, string> = { MA: 'maandag', DI: 'dinsdag', WO: 'woensdag', DO: 'donderdag', VR: 'vrijdag' };
const FREQUENTIE: Record<string, string> = { ELKE_WEEK: 'elke week', EVEN_WEKEN: 'even weken', ONEVEN_WEKEN: 'oneven weken' };
const AFWEZIG: Record<string, string> = { VAKANTIE: 'vakantie', CONGRES: 'congres/cursus', ONDERWIJS: 'onderwijs', OVERIG: 'overig' };

// Noon UTC: the weekday of a plain date, whatever the server's timezone.
const weekdag = (datum: string) => DAG[new Date(`${datum}T12:00:00Z`).getUTCDay()];
const kort = (datum: string) =>
  new Date(`${datum}T12:00:00Z`).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * The mark in words, with why it is there when the AIOS did not set it, and
 * with their own toelichting of the day when they did and gave one.
 */
function markering(d: Pick<AiosVoorkeurDienst, 'level' | 'bron'>, toelichting?: string, afwezigSoort?: string): string | null {
  if (!d.level) return null;
  const keuze = KEUZE[d.level];
  if (d.bron === 'PARTTIME') return `${keuze} (parttime)`;
  // Since 0.109.0 with the soort of the absence; the import still skips a file with "(afwezig)" alone.
  if (d.bron === 'ABSENCE') return afwezigSoort ? `${keuze} (afwezig: ${afwezigSoort})` : `${keuze} (afwezig)`;
  return toelichting ? `${keuze}: ${toelichting}` : keuze;
}

function blokTekst(d: AiosVoorkeurDienst): string | null {
  if (!d.blok) return null;
  return `${d.blok.soort === 'AVOND' ? 'avondblok' : 'nachtblok'} ${BLOK_VORM_LABELS[d.blok.vorm]}`;
}

/**
 * What the AIOS asks besides their marks, as rows at the top of
 * "Voorkeuren per dienst": the file is also the back-up, and the import
 * (lib/aiosVoorkeurImport.ts) reads these rows back. "ja" or empty for a
 * request, "dd-mm-jjjj t/m dd-mm-jjjj" for a period.
 */
export const VERZOEK_RIJEN = [
  { label: 'Verzoek: 4 avonden (wo t/m za)', veld: 'vier_avonden', soort: 'ja' },
  { label: 'Verzoek: 4 nachten (wo t/m za)', veld: 'vier_nachten', soort: 'ja' },
  { label: 'Verzoek: twee dagdiensten (za en zo)', veld: 'twee_dagdiensten', soort: 'ja' },
  { label: 'Verzoek: inwerken', veld: 'inwerken', soort: 'periode' },
  { label: 'Verzoek: onderbreking van de opleiding', veld: 'onderbreking', soort: 'periode' },
] as const;

/**
 * The part-time days of an AIOS in the quarter, as rows "Parttime 1",
 * "Parttime 2" (more when someone has more) under the requests: the file is
 * the back-up, and the import (lib/aiosVoorkeurImport.ts) creates them again.
 * A cell reads "maandag", "dinsdag, even weken" or "dinsdag, oneven weken", with
 * ", dd-mm-jjjj t/m dd-mm-jjjj" after it when the pattern holds for only
 * part of the quarter. The marks they make stay "(parttime)" cells.
 */
export const DEELTIJD_DAGEN: Record<string, string> = { MA: 'maandag', DI: 'dinsdag', WO: 'woensdag', DO: 'donderdag', VR: 'vrijdag' };
const DEELTIJD_FREQUENTIE: Record<string, string> = { ELKE_WEEK: '', EVEN_WEKEN: ', even weken', ONEVEN_WEKEN: ', oneven weken' };
const DEELTIJD_VOLGORDE = ['MA', 'DI', 'WO', 'DO', 'VR'];

export interface DeeltijdPatroonRij {
  weekdag: string;
  frequentie: string;
  geldig_vanaf: string;
  geldig_tot: string;
}

/** The patterns of a person that touch the quarter, in the order of the rows. */
export function laadDeeltijdVoorKwartaal(personId: string, start: string, eind: string): DeeltijdPatroonRij[] {
  const rijen = db
    .prepare(
      `SELECT weekdag, frequentie, geldig_vanaf, geldig_tot FROM dienstrooster_parttime_pattern
       WHERE person_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?`
    )
    .all(personId, eind, start) as DeeltijdPatroonRij[];
  const freq = ['ELKE_WEEK', 'EVEN_WEKEN', 'ONEVEN_WEKEN'];
  return rijen.sort(
    (a, b) =>
      DEELTIJD_VOLGORDE.indexOf(a.weekdag) - DEELTIJD_VOLGORDE.indexOf(b.weekdag) ||
      freq.indexOf(a.frequentie) - freq.indexOf(b.frequentie) ||
      a.geldig_vanaf.localeCompare(b.geldig_vanaf)
  );
}

export function deeltijdCel(p: DeeltijdPatroonRij, start: string, eind: string): string {
  const van = p.geldig_vanaf > start ? p.geldig_vanaf : start;
  const tot = p.geldig_tot < eind ? p.geldig_tot : eind;
  const deel = van > start || tot < eind ? `, ${nlDatum(van)} t/m ${nlDatum(tot)}` : '';
  return `${DEELTIJD_DAGEN[p.weekdag]}${DEELTIJD_FREQUENTIE[p.frequentie]}${deel}`;
}

const DEELTIJD_CEL = /^(maandag|dinsdag|woensdag|donderdag|vrijdag)(?:,\s*(elke week|even weken|oneven weken))?(?:,\s*(\d{2})-(\d{2})-(\d{4}) t\/m (\d{2})-(\d{2})-(\d{4}))?$/i;

/** A cell back into a pattern (the whole quarter when no dates are given), or null when it cannot be read. */
export function leesDeeltijdCel(tekst: string, start: string, eind: string): DeeltijdPatroonRij | null {
  const m = DEELTIJD_CEL.exec(tekst.trim());
  if (!m) return null;
  const weekdag = Object.entries(DEELTIJD_DAGEN).find(([, naam]) => naam === m[1].toLowerCase())![0];
  const woord = (m[2] ?? 'elke week').toLowerCase();
  const frequentie = woord === 'even weken' ? 'EVEN_WEKEN' : woord === 'oneven weken' ? 'ONEVEN_WEKEN' : 'ELKE_WEEK';
  return {
    weekdag,
    frequentie,
    geldig_vanaf: m[3] ? `${m[5]}-${m[4]}-${m[3]}` : start,
    geldig_tot: m[6] ? `${m[8]}-${m[7]}-${m[6]}` : eind,
  };
}

const nlDatum = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
export const verzoekPeriode = (van: string | null, tot: string | null) => (van && tot ? `${nlDatum(van)} t/m ${nlDatum(tot)}` : null);

/**
 * Voorkeuren per dienst: the AIOS's requests, then a row per dienst, a column per AIOS.
 *
 * `metToelichting`: the beheerder's file, the back-up, which holds every
 * toelichting (after each mark of its day) and which the import reads back.
 * The planner's file has none: the planner sees a toelichting only while
 * correcting or filling in the roster by hand (lib/aiosReden.ts).
 */
export function aiosVoorkeurenPerDienst(period: AiosUitnodigPeriode, opties: { metToelichting?: boolean } = {}): XlsxSheet {
  const deelnemers = aiosDeelnemers(period);
  const redenen = opties.metToelichting ? loadAlleAiosRedenen(period.id) : new Map<string, string>();
  const afwezigheden = db.prepare(
    `SELECT van_datum, tot_datum, soort FROM dienstrooster_absence
     WHERE person_id = ? AND van_datum <= ? AND tot_datum >= ? ORDER BY van_datum`
  );
  const perPersoon = deelnemers.map((p) => {
    const marks = new Map<string, string | null>();
    const verlof = afwezigheden.all(p.id, period.eind_datum, period.start_datum) as Array<{ van_datum: string; tot_datum: string; soort: string }>;
    // The soort of the absence(s) on a day: "vakantie", or "vakantie en onderwijs" when two overlap.
    const soortOp = (datum: string) =>
      [...new Set(verlof.filter((a) => a.van_datum <= datum && a.tot_datum >= datum).map((a) => AFWEZIG[a.soort] ?? a.soort))].join(' en ');
    for (const dag of loadAiosVoorkeurDagen(p.id, period.id)) {
      for (const d of dag.diensten) marks.set(d.slot_id, markering(d, redenen.get(`${p.id}|${dag.datum}`), soortOp(dag.datum)));
    }
    return marks;
  });
  // The diensten themselves, read once with nobody's marks.
  const dagen = loadAiosVoorkeurDagen('', period.id);
  const wensen = deelnemers.map((p) => loadAiosWens(p.id, period.id));
  const deeltijd = deelnemers.map((p) => laadDeeltijdVoorKwartaal(p.id, period.start_datum, period.eind_datum));
  // At least two rows, more when someone has more patterns.
  const deeltijdRijen = Math.max(2, ...deeltijd.map((d) => d.length));
  const rows: XlsxCell[][] = VERZOEK_RIJEN.map((rij) => [
    null,
    null,
    null,
    rij.label,
    null,
    null,
    null,
    ...wensen.map((w) => {
      if (rij.veld === 'inwerken') return verzoekPeriode(w.inwerken_van, w.inwerken_tot);
      if (rij.veld === 'onderbreking') return verzoekPeriode(w.onderbreking_van, w.onderbreking_tot);
      return w[rij.veld] ? 'ja' : null;
    }),
  ]);
  for (let i = 0; i < deeltijdRijen; i++) {
    rows.push([null, null, null, `Parttime ${i + 1}`, null, null, null, ...deeltijd.map((d) => (d[i] ? deeltijdCel(d[i], period.start_datum, period.eind_datum) : null))]);
  }
  for (const dag of dagen) {
    for (const d of dag.diensten) {
      rows.push([
        { date: dag.datum },
        weekdag(dag.datum),
        dag.iso_week,
        `${d.code} ${d.naam.toLowerCase()}`,
        `${d.start_tijd}-${d.eind_tijd}`,
        blokTekst(d),
        dag.feestdag_naam,
        ...perPersoon.map((marks) => marks.get(d.slot_id) ?? null),
      ]);
    }
  }
  return {
    name: 'Voorkeuren per dienst',
    columns: [
      { header: 'Datum' },
      { header: 'Dag' },
      { header: 'Week' },
      { header: 'Dienst' },
      { header: 'Tijd' },
      { header: 'Blok' },
      { header: 'Feestdag' },
      ...deelnemers.map((p) => ({ header: p.codenaam })),
    ],
    rows,
    frozenColumns: 4,
    printGrid: true,
  };
}

const STATUS: Record<string, string> = { BEVESTIGD: 'Ingediend', BEZIG: 'Bezig, nog niet ingediend' };

const periode = (van: string | null, tot: string | null) => (van && tot ? `${kort(van)} t/m ${kort(tot)}` : null);

/** Verzoeken per AIOS: a row per AIOS, with all they asked and the counters. */
export function aiosVerzoekenPerAios(period: AiosUitnodigPeriode): XlsxSheet {
  const deelnemers = aiosDeelnemers(period);
  const ingediend = db.prepare(
    'SELECT status, ingediend_op FROM dienstrooster_submission WHERE person_id = ? AND schedule_period_id = ?'
  );
  const deeltijd = db.prepare(
    `SELECT weekdag, frequentie FROM dienstrooster_parttime_pattern
     WHERE person_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ? ORDER BY weekdag`
  );
  const afwezig = db.prepare(
    `SELECT van_datum, tot_datum, soort FROM dienstrooster_absence
     WHERE person_id = ? AND van_datum <= ? AND tot_datum >= ? ORDER BY van_datum`
  );
  const ja = (b: boolean) => (b ? 'ja' : null);

  const rows: XlsxCell[][] = deelnemers.map((p) => {
    const dagen = loadAiosVoorkeurDagen(p.id, period.id);
    const wens = loadAiosWens(p.id, period.id);
    const marks = telMarkeringen(dagen);
    const sub = ingediend.get(p.id, period.id) as { status: string; ingediend_op: string | null } | undefined;
    const patronen = deeltijd.all(p.id, period.eind_datum, period.start_datum) as Array<{ weekdag: string; frequentie: string }>;
    const afwezigheid = afwezig.all(p.id, period.eind_datum, period.start_datum) as Array<{
      van_datum: string;
      tot_datum: string;
      soort: string;
    }>;
    const tellers = blokkadeTellers(dagen).flatMap((t) => [
      `${t.geblokkeerd} van de ${t.totaal}`,
      t.erboven > 0 ? `meer dan de helft, hoogstens ${t.erboven} alsnog in te plannen` : null,
    ]);
    return [
      p.codenaam,
      STATUS[sub?.status ?? ''] ?? 'Nog niets ingevuld',
      sub?.status === 'BEVESTIGD' && sub.ingediend_op ? { moment: sub.ingediend_op } : null,
      ja(wens.vier_avonden),
      ja(wens.vier_nachten),
      ja(wens.twee_dagdiensten),
      periode(wens.inwerken_van, wens.inwerken_tot),
      periode(wens.onderbreking_van, wens.onderbreking_tot),
      patronen.map((pt) => `${WEEKDAG[pt.weekdag] ?? pt.weekdag} (${FREQUENTIE[pt.frequentie] ?? pt.frequentie})`).join(', ') || null,
      afwezigheid.map((a) => `${AFWEZIG[a.soort] ?? a.soort} ${kort(a.van_datum)} t/m ${kort(a.tot_datum)}`).join(', ') || null,
      marks.ABSOLUUT,
      marks.LIEVER_NIET,
      marks.VOORKEUR,
      ...tellers,
    ];
  });

  const tellerKoppen = blokkadeTellers([]).flatMap((t) => [
    { header: `Geblokkeerd: ${TELLER_LABELS[t.groep]}` },
    { header: `Boven de helft: ${TELLER_LABELS[t.groep]}` },
  ]);
  return {
    name: 'Verzoeken per AIOS',
    columns: [
      { header: 'AIOS' },
      { header: 'Status' },
      { header: 'Ingediend op' },
      { header: '4 avonden (wo t/m za)' },
      { header: '4 nachten (wo t/m za)' },
      { header: 'Twee dagdiensten (za en zo)' },
      { header: 'Inwerken' },
      { header: 'Onderbreking van de opleiding' },
      { header: 'Parttimedagen' },
      { header: 'Afwezigheid' },
      { header: 'Geblokkeerd (vakken)' },
      { header: 'Liever niet (vakken)' },
      { header: 'Voorkeur (vakken)' },
      ...tellerKoppen,
    ],
    rows,
    frozenColumns: 1,
  };
}
