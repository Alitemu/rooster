/**
 * The new layout of the period page of the achterwacht (1.9.0, the planner's wish; the accordion stays
 * the default until 2.0.0): the sections as a list on the left in four groups, one shown at a time on
 * the right, the status on top as now. Each section has its own address, so the browser's back button
 * steps back and a link can point to one. On a phone the list comes first and a tap opens the section.
 *
 * Opt-in with ?indeling=nieuw while both exist. Pure: components/PlannerDashboard.tsx renders it.
 */
import type { StapDoel } from './volgendeStap';

export type OnderdeelSleutel =
  | 'importcorrecties'
  | 'overloop'
  | 'vooraf'
  | 'personeel'
  | 'personeelbeheren'
  | 'export'
  | 'links'
  | 'voorstellen'
  | 'rooster';

/** The groups of the list, in the order of the work. */
export const GROEPEN: ReadonlyArray<{ naam: string; onderdelen: readonly OnderdeelSleutel[] }> = [
  { naam: 'Voorbereiden', onderdelen: ['importcorrecties', 'overloop', 'vooraf'] },
  { naam: 'Deelnemers', onderdelen: ['personeel', 'personeelbeheren', 'links'] },
  { naam: 'Communicatie', onderdelen: ['export'] },
  { naam: 'Rooster', onderdelen: ['rooster', 'voorstellen'] },
];

/** The address of each section (?onderdeel=...), in Dutch words. */
export const ADRES: Record<OnderdeelSleutel, string> = {
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

/** Whether the address asks for the new layout. */
export function nieuweIndeling(indeling: string | null): boolean {
  return indeling === 'nieuw';
}

/**
 * The section shown when none is chosen: where Volgende stap points (lib/volgendeStap.ts), so the page
 * opens where the work is. A step in the header (sluiten) or the action row (genereren, publiceren,
 * definitief) shows what it is about: the preferences before closing, the roster after.
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

/** The section on screen: the chosen one when it is there, else the start, else the first there is. */
export function actiefOnderdeel(gekozen: OnderdeelSleutel | null, start: OnderdeelSleutel, zichtbaar: ReadonlySet<OnderdeelSleutel>): OnderdeelSleutel {
  if (gekozen && zichtbaar.has(gekozen)) return gekozen;
  if (zichtbaar.has(start)) return start;
  for (const groep of GROEPEN) for (const k of groep.onderdelen) if (zichtbaar.has(k)) return k;
  return start;
}
