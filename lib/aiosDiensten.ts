/**
 * The AIOS roster's diensten, blocks and points (docs/aios-rooster.md,
 * "Diensten" and "Blokken"): which diensten a day has, which of them go
 * together in a block, and how many points the quarter holds.
 *
 * Pure: no database. lib/aiosSlots.ts stores what this computes, and the
 * period page counts with it in the browser.
 *
 * A werkdag has UD, AD and ND; a Saturday, Sunday or feestdag has DD, ADW
 * and ND (a feestdag counts as a weekend day). Kerstavond and oudjaarsdag
 * are ordinary werkdagen. The evenings (AD and ADW) and the nights go in
 * blocks: Sunday to Tuesday, Wednesday to Friday, and Saturday on its own.
 * One AIOS does a whole block; the "4 avonden" and "4 nachten" option puts
 * a Wednesday-to-Friday block and that Saturday with one AIOS, which is the
 * solver's choice, not a block of its own.
 */

import { addDays, getHolidaysInRange, getISOWeek, parseISO } from './holidays';
import type { HolidayGroup } from './holidays';

export type AiosCode = 'UD' | 'DD' | 'AD' | 'ADW' | 'ND';
export type AiosSoort = 'UITLOOP' | 'DAG' | 'AVOND' | 'NACHT';
export type DagSoort = 'WERKDAG' | 'WEEKEND' | 'FEESTDAG';
export type BlokSoort = 'AVOND' | 'NACHT';
/**
 * ZO_DI and WO_VR are the three-day blocks, ZA the Saturday on its own.
 * LOS is for later: a day of a block the planner cut up around feestdagen,
 * and the second AIOS on the New Year's Eve night.
 */
export type BlokVorm = 'ZO_DI' | 'WO_VR' | 'ZA' | 'LOS';

export interface AiosDienstType {
  code: AiosCode;
  naam: string;
  soort: AiosSoort;
  start_tijd: string; // HH:MM
  eind_tijd: string; // HH:MM, the next morning for the night
  punten: number;
  // On which days it is there.
  dagen: 'WERKDAG' | 'WEEKEND_EN_FEESTDAG' | 'ELKE_DAG';
  // shift_type.teller is the achterwacht's counter and NOT NULL; an AIOS
  // shift type counts by soort and punten and never reads it.
  teller: 'AVOND' | 'WEEKEND';
}

/**
 * In the order of a day, by starting time. The times are the planner's
 * (the questionnaire, C1), changed last year; the points are fractions of
 * a working day (C4).
 */
export const AIOS_DIENSTTYPES: readonly AiosDienstType[] = [
  { code: 'DD', naam: 'Dagdienst', soort: 'DAG', start_tijd: '08:30', eind_tijd: '18:12', punten: 1, dagen: 'WEEKEND_EN_FEESTDAG', teller: 'WEEKEND' },
  { code: 'ADW', naam: 'Avonddienst weekend', soort: 'AVOND', start_tijd: '13:30', eind_tijd: '23:12', punten: 1, dagen: 'WEEKEND_EN_FEESTDAG', teller: 'WEEKEND' },
  { code: 'UD', naam: 'Uitloopdienst', soort: 'UITLOOP', start_tijd: '17:36', eind_tijd: '20:00', punten: 0.2, dagen: 'WERKDAG', teller: 'AVOND' },
  { code: 'AD', naam: 'Avonddienst', soort: 'AVOND', start_tijd: '17:36', eind_tijd: '23:12', punten: 0.6, dagen: 'WERKDAG', teller: 'AVOND' },
  { code: 'ND', naam: 'Nachtdienst', soort: 'NACHT', start_tijd: '22:30', eind_tijd: '08:30', punten: 1, dagen: 'ELKE_DAG', teller: 'AVOND' },
];

export const AIOS_CODES: readonly AiosCode[] = AIOS_DIENSTTYPES.map((t) => t.code);

export function aiosDienstType(code: AiosCode): AiosDienstType {
  return AIOS_DIENSTTYPES.find((t) => t.code === code)!;
}

export const SOORT_LABELS: Record<AiosSoort, string> = {
  NACHT: 'nachtdiensten',
  AVOND: 'avonddiensten',
  DAG: 'dagdiensten',
  UITLOOP: 'uitloopdiensten',
};

export const BLOK_VORM_LABELS: Record<BlokVorm, string> = {
  ZO_DI: 'zo t/m di',
  WO_VR: 'wo t/m vr',
  ZA: 'zaterdag',
  LOS: 'losse dienst',
};

const WEEKDAG = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'] as const;

/** "wo", "do" ... for a date. */
export function weekdagKort(datum: string): string {
  return WEEKDAG[parseISO(datum).getDay()];
}

export function dagSoort(datum: string, feestdagen: ReadonlySet<string>): DagSoort {
  if (feestdagen.has(datum)) return 'FEESTDAG';
  const dag = parseISO(datum).getDay();
  return dag === 0 || dag === 6 ? 'WEEKEND' : 'WERKDAG';
}

/** The diensten on a day of this kind, in the order of the day. */
export function dienstenOpDag(soort: DagSoort): AiosCode[] {
  return AIOS_DIENSTTYPES.filter((t) =>
    t.dagen === 'ELKE_DAG' || (t.dagen === 'WERKDAG' ? soort === 'WERKDAG' : soort !== 'WERKDAG')
  ).map((t) => t.code);
}

export interface AiosBlok {
  soort: BlokSoort;
  vorm: BlokVorm;
  start_datum: string;
  eind_datum: string;
}

export interface AiosSlot {
  datum: string;
  code: AiosCode;
  dag_soort: DagSoort;
  iso_jaar: number;
  iso_week: number;
  weekend_id: string | null; // "2027-W01-SAT", as the achterwacht's slots
  feestdag_naam: string | null;
  feestdag_groep: HolidayGroup | null;
  // Index into AiosRooster.blokken; null for UD and DD.
  blok: number | null;
}

export interface AiosRooster {
  slots: AiosSlot[];
  blokken: AiosBlok[];
}

export class AiosPeriodeError extends Error {}

/**
 * Every dienst and block from `start` (a Wednesday) to `eind` (a Tuesday).
 * Blocks follow from the weekdays alone, so a period that starts on a
 * Wednesday and ends on a Tuesday is cut into whole blocks.
 */
export function aiosRooster(start: string, eind: string): AiosRooster {
  if (parseISO(start).getDay() !== 3 || parseISO(eind).getDay() !== 2 || eind < start) {
    throw new AiosPeriodeError('Een periode van de AIOS loopt van een woensdag tot en met een dinsdag');
  }
  const feestdagen = new Map(getHolidaysInRange(start, eind).map((h) => [h.date, h]));
  const feestdagSet = new Set(feestdagen.keys());

  const blokken: AiosBlok[] = [];
  // Per block soort, the block index of each date.
  const blokVan: Record<BlokSoort, Map<string, number>> = { AVOND: new Map(), NACHT: new Map() };
  for (let wo = start; wo <= eind; wo = addDays(wo, 7)) {
    const delen: Array<[BlokVorm, string, string]> = [
      ['WO_VR', wo, addDays(wo, 2)],
      ['ZA', addDays(wo, 3), addDays(wo, 3)],
      ['ZO_DI', addDays(wo, 4), addDays(wo, 6)],
    ];
    for (const soort of ['AVOND', 'NACHT'] as const) {
      for (const [vorm, van, tot] of delen) {
        const index = blokken.push({ soort, vorm, start_datum: van, eind_datum: tot }) - 1;
        for (let d = van; d <= tot; d = addDays(d, 1)) blokVan[soort].set(d, index);
      }
    }
  }

  const slots: AiosSlot[] = [];
  for (let datum = start; datum <= eind; datum = addDays(datum, 1)) {
    const soort = dagSoort(datum, feestdagSet);
    const [isoJaar, isoWeek] = getISOWeek(parseISO(datum));
    const weekdag = parseISO(datum).getDay();
    const weekendId =
      weekdag === 6 || weekdag === 0 ? `${isoJaar}-W${String(isoWeek).padStart(2, '0')}-${weekdag === 6 ? 'SAT' : 'SUN'}` : null;
    const feestdag = feestdagen.get(datum) ?? null;
    for (const code of dienstenOpDag(soort)) {
      const typeSoort = aiosDienstType(code).soort;
      slots.push({
        datum,
        code,
        dag_soort: soort,
        iso_jaar: isoJaar,
        iso_week: isoWeek,
        weekend_id: weekendId,
        feestdag_naam: feestdag?.name ?? null,
        feestdag_groep: feestdag?.group ?? null,
        blok: typeSoort === 'AVOND' || typeSoort === 'NACHT' ? blokVan[typeSoort].get(datum)! : null,
      });
    }
  }
  return { slots, blokken };
}

/** Monday to Friday, without the feestdagen: the werkdagen of the dienstpercentage. */
export function werkdagenIn(start: string, eind: string): number {
  const feestdagen = new Set(getHolidaysInRange(start, eind).map((h) => h.date));
  let n = 0;
  for (let d = start; d <= eind; d = addDays(d, 1)) {
    if (dagSoort(d, feestdagen) === 'WERKDAG') n++;
  }
  return n;
}

export interface SoortTotaal {
  soort: AiosSoort;
  aantal: number;
  punten: number;
}

export interface AiosPuntenOverzicht {
  per_soort: SoortTotaal[]; // nachten, avonden, dagdiensten, uitloopdiensten
  totaal_punten: number;
  werkdagen: number;
}

/**
 * Points per soort and in all. `punten` per code comes from the pool's
 * shift types; the sums are rounded to a tenth, as 0,2 and 0,6 do not add
 * up exactly in floating point.
 */
export function aiosPunten(
  slots: ReadonlyArray<Pick<AiosSlot, 'code'>>,
  punten: Readonly<Record<AiosCode, number>>,
  werkdagen: number
): AiosPuntenOverzicht {
  const volgorde: AiosSoort[] = ['NACHT', 'AVOND', 'DAG', 'UITLOOP'];
  const per = new Map<AiosSoort, SoortTotaal>(volgorde.map((s) => [s, { soort: s, aantal: 0, punten: 0 }]));
  for (const slot of slots) {
    const t = per.get(aiosDienstType(slot.code).soort)!;
    t.aantal++;
    t.punten += punten[slot.code];
  }
  const tiende = (x: number) => Math.round(x * 10) / 10;
  const per_soort = volgorde.map((s) => ({ ...per.get(s)!, punten: tiende(per.get(s)!.punten) }));
  return {
    per_soort,
    totaal_punten: tiende(per_soort.reduce((som, t) => som + t.punten, 0)),
    werkdagen,
  };
}

/**
 * The fte the AIOS need together for the quarter's points to come to
 * `grens` (0,25 for 25%) on average: punten / (werkdagen x grens).
 */
export function benodigdeFte(overzicht: Pick<AiosPuntenOverzicht, 'totaal_punten' | 'werkdagen'>, grens: number): number {
  return overzicht.totaal_punten / (overzicht.werkdagen * grens);
}
