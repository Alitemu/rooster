/**
 * The new layout of the period page of the achterwacht (1.9.0, the planner's wish; the accordion stays
 * the default until 2.0.0): the sections as a list on the left in four groups, one shown at a time on
 * the right, the status on top as now. Each section has its own address, so the browser's back button
 * steps back and a link can point to one. On a phone the list comes first and a tap opens the section.
 *
 * Since 2.0.0 the new layout is the layout, for every planner and beheerder; the accordion is out of
 * sight (nieuweIndeling). Below 1100 px the list is a menu behind a button (1.10.0, the planner's wish),
 * where two columns left the tables too little room.
 *
 * 1.12.0 (the planner's wish, after sketches on the real page): what stood above the sections (the
 * period's dates, deadline, streefbereik, status and its buttons, the notices) is a section of its own,
 * "Periode", on top of the list. On a laptop that block took the whole first screen and on a phone more.
 * The blue bar names the period and its status, the list stands all the way left under that bar, and on
 * a narrow screen its button is in the bar. Only Volgende stap stays above the section. The accordion
 * is as it was: there the block stays where it is and "Periode" is no section.
 *
 * Pure: components/PlannerDashboard.tsx renders it.
 */
import type { StapDoel } from './volgendeStap';

export type OnderdeelSleutel =
  | 'periode'
  | 'importcorrecties'
  | 'overloop'
  | 'vooraf'
  | 'personeel'
  | 'personeelbeheren'
  | 'export'
  | 'links'
  | 'voorstellen'
  | 'rooster';

/** On top of the list, under no heading: the period itself (the new layout only, 1.12.0). */
export const BOVENAAN: OnderdeelSleutel = 'periode';

/** The groups of the list, in the order of the work. */
export const GROEPEN: ReadonlyArray<{ naam: string; onderdelen: readonly OnderdeelSleutel[] }> = [
  { naam: 'Voorbereiden', onderdelen: ['importcorrecties', 'overloop', 'vooraf'] },
  { naam: 'Deelnemers', onderdelen: ['personeel', 'personeelbeheren', 'links'] },
  { naam: 'Communicatie', onderdelen: ['export'] },
  { naam: 'Rooster', onderdelen: ['rooster', 'voorstellen'] },
];

/** The address of each section (?onderdeel=...), in Dutch words. */
export const ADRES: Record<OnderdeelSleutel, string> = {
  periode: 'periode',
  importcorrecties: 'import-en-correcties',
  overloop: 'eerdere-toewijzingen',
  vooraf: 'vooraf-invullen',
  personeel: 'status-voorkeuren',
  personeelbeheren: 'personeel-beheren',
  export: 'exporteren',
  links: 'persoonlijke-links',
  voorstellen: 'herverdeling',
  rooster: 'dienstrooster',
};

export function sleutelUitAdres(adres: string | null): OnderdeelSleutel | null {
  if (!adres) return null;
  const gevonden = (Object.keys(ADRES) as OnderdeelSleutel[]).find((k) => ADRES[k] === adres);
  return gevonden ?? null;
}

/**
 * Whether the page shows the new layout. Since 2.0.0 (the planner's wish, after comparing both layouts
 * section by section in every status: nothing was missing) it is the layout, with no switch. The accordion
 * stays in the code, out of sight: only `?indeling=oud` in the address, for that page, or the hidden flag
 * of lib/indelingOnthouden.ts shows it. `?indeling=nieuw` wins over that flag.
 */
export function nieuweIndeling(indeling: string | null, oudeIndeling: string | null = null): boolean {
  if (indeling === 'nieuw') return true;
  if (indeling === 'oud') return false;
  return oudeIndeling !== 'ja';
}

/**
 * The section shown when none is chosen: where Volgende stap points (lib/volgendeStap.ts), so the page
 * opens where the work is. A step whose button changes the status (sluiten, genereren, publiceren,
 * definitief) shows what it is about: the preferences before closing, the roster after. Its button is in
 * the section "Periode" (1.12.0), one click away through Volgende stap: the planner looks before deciding.
 */
export function startOnderdeel(doel: StapDoel | null | undefined, status: string): OnderdeelSleutel {
  switch (doel) {
    case 'uitnodigingen':
    case 'herinneringen':
      return 'export';
    case 'lege-diensten':
      return 'vooraf';
    case 'sluiten':
      return 'personeel';
    case 'genereren':
    case 'publiceren':
    case 'definitief':
      return 'rooster';
    default:
      return status === 'GEGENEREERD' || status === 'GEPUBLICEERD' ? 'rooster' : 'personeel';
  }
}

/**
 * The section of a next step's button in the new layout: its own, or "Periode" for a button that changes
 * the status (those stood in the header and the action row above the sections until 1.12.0).
 */
export function onderdeelVanStap(eigen: OnderdeelSleutel | undefined): OnderdeelSleutel {
  return eigen ?? BOVENAAN;
}

/** The section on screen: the chosen one when it is there, else the start, else the first there is. */
export function actiefOnderdeel(gekozen: OnderdeelSleutel | null, start: OnderdeelSleutel, zichtbaar: ReadonlySet<OnderdeelSleutel>): OnderdeelSleutel {
  if (gekozen && zichtbaar.has(gekozen)) return gekozen;
  if (zichtbaar.has(start)) return start;
  for (const groep of GROEPEN) for (const k of groep.onderdelen) if (zichtbaar.has(k)) return k;
  return start;
}
