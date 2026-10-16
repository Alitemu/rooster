/**
 * An AIOS's fte and dienstpercentage (docs/aios-rooster.md, "Eerlijkheid").
 * Pure: no database.
 *
 * - The fte follows from the part-time days the AIOS gives up themselves:
 *   one day every week is 0,8, one day every other week 0,9, none 1,0. A
 *   pattern that holds for part of the quarter counts pro rata.
 * - Dienstpercentage = punten / (werkdagen x fte). Werkdagen are Monday to
 *   Friday without the feestdagen, within Geldig vanaf/tot and outside an
 *   onderbreking; leave counts as an ordinary werkdag (G5). The AIOS's
 *   solver counts the same (aios-solver/model.py werkdagen); the
 *   achterwacht has no percentage.
 */

import { addDays, parseISO } from '@/lib/holidays';

export interface FtePatroon {
  frequentie: 'ELKE_WEEK' | 'EVEN_WEKEN' | 'ONEVEN_WEKEN';
  geldig_vanaf: string;
  geldig_tot: string;
}

const MINDER: Record<FtePatroon['frequentie'], number> = { ELKE_WEEK: 0.2, EVEN_WEKEN: 0.1, ONEVEN_WEKEN: 0.1 };

/** The grens of the opleidingsplan: above 25% a warning, never a refusal (G6). */
export const PERCENTAGE_GRENS = 0.25;

function dagenTussen(van: string, tot: string): number {
  return Math.round((parseISO(tot).getTime() - parseISO(van).getTime()) / 86_400_000) + 1;
}

/** The fte over the quarter `van` to `tot`, from the part-time patterns, to two decimals. */
export function aiosFte(patronen: readonly FtePatroon[], van: string, tot: string): number {
  const totaal = dagenTussen(van, tot);
  let fte = 1;
  for (const p of patronen) {
    const begin = p.geldig_vanaf > van ? p.geldig_vanaf : van;
    const eind = p.geldig_tot < tot ? p.geldig_tot : tot;
    if (eind < begin) continue;
    fte -= MINDER[p.frequentie] * (dagenTussen(begin, eind) / totaal);
  }
  // Four part-time days a week is not an AIOS's; never zero or below.
  return Math.max(0.2, Math.round(fte * 100) / 100);
}

export interface Werkdagen {
  beschikbaar: ReadonlyArray<{ van: string; tot: string }>;
  onderbreking: { van: string; tot: string } | null;
}

/** The werkdagen of the quarter the AIOS can do diensten on. */
export function aiosWerkdagen(w: Werkdagen, van: string, tot: string, feestdagen: ReadonlySet<string>): number {
  let n = 0;
  for (let d = van; d <= tot; d = addDays(d, 1)) {
    const dag = parseISO(d).getDay();
    if (dag === 0 || dag === 6 || feestdagen.has(d)) continue;
    if (!w.beschikbaar.some((b) => b.van <= d && d <= b.tot)) continue;
    if (w.onderbreking && w.onderbreking.van <= d && d <= w.onderbreking.tot) continue;
    n++;
  }
  return n;
}

/** Punten / (werkdagen x fte), a fraction (0,2 is 20%); null without werkdagen. */
export function dienstpercentage(punten: number, werkdagen: number, fte: number): number | null {
  return werkdagen > 0 && fte > 0 ? punten / (werkdagen * fte) : null;
}
