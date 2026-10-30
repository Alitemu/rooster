/**
 * The fair range per soort in Dienstdoende (0.903.0): what an AIOS got of each soort beside what was fair for them.
 *
 * "Fair" is the solver's own share (aios-solver per_aios, stored in aios_doel): their fte and werkdagen, the
 * inwerkperiode and, for nights, dagdiensten and avonddiensten in the weekend, the saldo of the quarters before. A
 * share is seldom whole (4,6 nights) and nobody does 0,6 of a night, so the fair range is the whole numbers on
 * either side: 4 or 5. A share below none (a debt from before) is a range of none. The planner reads the range as
 * a band behind the bar, the summary above the table names who is outside it.
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

export interface EerlijkRij {
  codenaam: string;
  aantallen: Record<EerlijkSoort, number>;
  eerlijk: Record<EerlijkSoort, Bereik | null>;
}

export interface Buiten {
  codenaam: string;
  verschillen: string[];
}

/** Who got more or fewer of a soort than fair, with each difference in words, in the order of the rows. */
export function buitenBereik(rijen: EerlijkRij[]): Buiten[] {
  return rijen.flatMap((r) => {
    const verschillen = EERLIJK_SOORTEN.flatMap(({ soort }) => {
      const bereik = r.eerlijk[soort];
      const af = bereik ? afwijkingWoorden(soort, r.aantallen[soort], bereik) : null;
      return af ? [`${af} (eerlijk is ${bereikWoorden(bereik!)})`] : [];
    });
    return verschillen.length > 0 ? [{ codenaam: r.codenaam, verschillen }] : [];
  });
}
