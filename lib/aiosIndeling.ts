/**
 * The new layout of the AIOS's period page (1.13.0, the planner's wish), as the achterwacht's has had since
 * 1.9.0 (lib/periodeIndeling.ts; this is its own copy, docs/development/diensten.md "Copied, not changed").
 * The sections as a list all the way left in groups, one shown at a time, each with its own address; the
 * header of the period and the card that makes the roster are the section "Periode" on top; the blue bar
 * names the period and its status. Below 1100 px the list is a menu behind a button in the blue bar.
 *
 * The accordion stays the default. The choice is the one the achterwacht's page uses
 * (lib/aiosIndelingOnthouden.ts): one choice for both diensten.
 *
 * Pure: components/AiosPeriodOverview.tsx and components/AiosSectie.tsx render it.
 */

export type AiosOnderdeel =
  | 'periode'
  | 'geschiedenis'
  | 'feestdagblokken'
  | 'toets'
  | 'voorkeuren'
  | 'status'
  | 'links'
  | 'export'
  | 'dienstrooster'
  | 'dienstpercentage'
  | 'punten';

/** On top of the list, under no heading. */
export const AIOS_BOVENAAN: AiosOnderdeel = 'periode';

/** The groups of the list, in the order of the work. */
export const AIOS_GROEPEN: ReadonlyArray<{ naam: string; onderdelen: readonly AiosOnderdeel[] }> = [
  { naam: 'Voorbereiden', onderdelen: ['geschiedenis', 'feestdagblokken', 'toets'] },
  { naam: 'Deelnemers', onderdelen: ['voorkeuren', 'status', 'links'] },
  { naam: 'Communicatie', onderdelen: ['export'] },
  { naam: 'Rooster', onderdelen: ['dienstrooster', 'dienstpercentage', 'punten'] },
];

/** The address of each section (?onderdeel=...), in Dutch words. */
export const AIOS_ADRES: Record<AiosOnderdeel, string> = {
  periode: 'periode',
  geschiedenis: 'geschiedenis',
  feestdagblokken: 'feestdagblokken',
  toets: 'voortgangstoets',
  voorkeuren: 'voorkeuren',
  status: 'status-voorkeuren',
  links: 'persoonlijke-links',
  export: 'exporteren',
  dienstrooster: 'dienstrooster',
  dienstpercentage: 'dienstpercentage',
  punten: 'punten',
};

export function aiosOnderdeelUitAdres(adres: string | null): AiosOnderdeel | null {
  if (!adres) return null;
  return (Object.keys(AIOS_ADRES) as AiosOnderdeel[]).find((k) => AIOS_ADRES[k] === adres) ?? null;
}

/** Whether the page shows the new layout: the address when it names one, else the remembered choice. */
export function aiosNieuweIndeling(indeling: string | null, onthouden: string | null = null): boolean {
  if (indeling === 'nieuw') return true;
  if (indeling === 'oud') return false;
  return onthouden === 'nieuw';
}

/** What the address asks to remember: only a choice it names. */
export function aiosKeuzeUitAdres(indeling: string | null): 'nieuw' | 'oud' | null {
  return indeling === 'nieuw' || indeling === 'oud' ? indeling : null;
}

/**
 * The section shown when none is chosen, where the work of this status is: opening the period while it is
 * a concept (its deadline and "Periode openen" are in "Voorkeuren van de AIOS"), the preferences while it
 * is open, making the roster once it is closed (in "Periode"), the roster once there is one.
 */
export function aiosStartOnderdeel(status: string): AiosOnderdeel {
  if (status === 'CONCEPT') return 'voorkeuren';
  if (status === 'OPEN') return 'status';
  if (status === 'GEGENEREERD' || status === 'GEPUBLICEERD') return 'dienstrooster';
  return 'periode';
}

/** The section on screen: the chosen one when it is there, else the start, else the first there is. */
export function aiosActiefOnderdeel(gekozen: AiosOnderdeel | null, start: AiosOnderdeel, er: ReadonlySet<AiosOnderdeel>): AiosOnderdeel {
  if (gekozen && er.has(gekozen)) return gekozen;
  if (er.has(start)) return start;
  if (er.has(AIOS_BOVENAAN)) return AIOS_BOVENAAN;
  for (const groep of AIOS_GROEPEN) for (const k of groep.onderdelen) if (er.has(k)) return k;
  return start;
}

const STATUS: Record<string, string> = {
  CONCEPT: 'Concept',
  OPEN: 'Open',
  GESLOTEN: 'Gesloten',
  GEGENEREERD: 'Gegenereerd',
};

/** The status in the blue bar: a published roster is voorlopig until it is definitief. */
export function aiosStatusTekst(status: string, definitief: boolean): string {
  if (status === 'GEPUBLICEERD') return definitief ? 'Definitief' : 'Voorlopig gepubliceerd';
  return STATUS[status] ?? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}
