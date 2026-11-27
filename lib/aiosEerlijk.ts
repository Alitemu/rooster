/**
 * The fair range per soort in Dienstdoende (0.903.0): what an AIOS got of each soort beside what was fair for them.
 *
 * "Fair" is the solver's own share (aios-solver per_aios, stored in aios_doel): their fte and werkdagen, the
 * inwerkperiode and, for nights, dagdiensten and avonddiensten in the weekend, the saldo of the quarters before. A
 * share is seldom whole (4,6 nights) and nobody does 0,6 of a night, so the fair range is the whole numbers on
 * either side: 4 or 5. A share below none (a debt from before) is a range of none. The planner reads the range in
 * brackets under the bar and as a dashed box over it (2.4.0, the achterwacht's look of 2.3.0, copied), and the last
 * column names per AIOS what is outside it ("4 nachten tekort").
 *
 * No database here: components/AiosDienstrooster.tsx uses it in the browser.
 */

import { telwoord } from '@/lib/aiosTelwoord';

export type EerlijkSoort = 'nachten' | 'dagdiensten' | 'weekendavonden' | 'weekavonden' | 'uitloopdiensten' | 'feestdagdiensten';

export interface Bereik {
  van: number;
  tot: number;
}

/** The planner's order of what must be shared fairly (aios-solver/model.py W_SOORT), the feestdagen last. */
export const EERLIJK_SOORTEN: Array<{ soort: EerlijkSoort; enkelvoud: string; meervoud: string }> = [
  { soort: 'nachten', enkelvoud: 'nacht', meervoud: 'nachten' },
  { soort: 'dagdiensten', enkelvoud: 'dagdienst', meervoud: 'dagdiensten' },
  { soort: 'weekendavonden', enkelvoud: 'avonddienst in het weekend', meervoud: 'avonddiensten in het weekend' },
  { soort: 'weekavonden', enkelvoud: 'avonddienst door de week', meervoud: 'avonddiensten door de week' },
  { soort: 'uitloopdiensten', enkelvoud: 'uitloopdienst', meervoud: 'uitloopdiensten' },
  { soort: 'feestdagdiensten', enkelvoud: 'feestdagdienst', meervoud: 'feestdagdiensten' },
];

/** The whole numbers either side of the share; the share is rounded to hundredths first (as it is stored). */
export function eerlijkBereik(doel: number): Bereik {
  const d = Math.round(doel * 100) / 100;
  return { van: Math.max(0, Math.floor(d)), tot: Math.max(0, Math.ceil(d)) };
}

/** How far outside the range: below none is fewer, above none is more, none is within it. */
export function afwijking(aantal: number, bereik: Bereik): number {
  if (aantal < bereik.van) return aantal - bereik.van;
  if (aantal > bereik.tot) return aantal - bereik.tot;
  return 0;
}

/** "4 of 5", or "4" when the share is whole. */
export function bereikWoorden(bereik: Bereik): string {
  return bereik.van === bereik.tot ? String(bereik.van) : `${bereik.van} of ${bereik.tot}`;
}

function woorden(soort: EerlijkSoort) {
  return EERLIJK_SOORTEN.find((s) => s.soort === soort)!;
}

/** "2 nachten minder dan eerlijk", "1 nacht meer dan eerlijk"; null within the range. */
export function afwijkingWoorden(soort: EerlijkSoort, aantal: number, bereik: Bereik): string | null {
  const af = afwijking(aantal, bereik);
  if (af === 0) return null;
  const w = woorden(soort);
  return `${telwoord(Math.abs(af), w.enkelvoud, w.meervoud)} ${af > 0 ? 'meer' : 'minder'} dan eerlijk`;
}

/** The whole cell for a screen reader: "5 nachten, eerlijk is 4 of 5." plus the difference when there is one. */
export function celWoorden(soort: EerlijkSoort, aantal: number, bereik: Bereik | null): string {
  const w = woorden(soort);
  const basis = telwoord(aantal, w.enkelvoud, w.meervoud);
  if (!bereik) return `${basis}.`;
  const af = afwijkingWoorden(soort, aantal, bereik);
  return `${basis}, eerlijk is ${bereikWoorden(bereik)}.${af ? ` Dat is ${af}.` : ''}`;
}

/**
 * The dashed box over the bar (2.4.0): half a dienst wider than the range on either side, so a bar that ends on
 * either end of the range ends inside the box, and never left of none. Copied from the achterwacht's
 * lib/bereikVak.ts, not imported (docs/development/diensten.md, "Copied, not changed").
 */
export function eerlijkVak(bereik: Bereik | null): Bereik | null {
  return bereik ? { van: Math.max(0, bereik.van - 0.5), tot: bereik.tot + 0.5 } : null;
}

/** Whether a soort's bar gets the box and the arrow: all but the feestdagen, as at the achterwacht (2.4.0, the planner's choice). */
export function metVak(soort: EerlijkSoort): boolean {
  return soort !== 'feestdagdiensten';
}

/** The short words of the last column: "weekavond" there, where the screen reader hears "avonddienst door de week". */
const KORT: Record<EerlijkSoort, [string, string]> = {
  nachten: ['nacht', 'nachten'],
  dagdiensten: ['dagdienst', 'dagdiensten'],
  weekendavonden: ['weekendavond', 'weekendavonden'],
  weekavonden: ['weekavond', 'weekavonden'],
  uitloopdiensten: ['uitloopdienst', 'uitloopdiensten'],
  feestdagdiensten: ['feestdagdienst', 'feestdagdiensten'],
};

export interface EerlijkRij {
  aantallen: Record<EerlijkSoort, number>;
  eerlijk: Record<EerlijkSoort, Bereik | null>;
}

/**
 * The last column of Dienstdoende (2.4.0): every soort an AIOS is outside the fair range of, in the planner's
 * order, as "4 nachten tekort" or "3 weekavonden te veel". Empty is "goed". A soort without a share is left out.
 */
export function verschillen(rij: EerlijkRij): string[] {
  return EERLIJK_SOORTEN.flatMap(({ soort }) => {
    const bereik = rij.eerlijk[soort];
    const af = bereik ? afwijking(rij.aantallen[soort], bereik) : 0;
    if (af === 0) return [];
    const [enkelvoud, meervoud] = KORT[soort];
    return [`${telwoord(Math.abs(af), enkelvoud, meervoud)} ${af > 0 ? 'te veel' : 'tekort'}`];
  });
}
