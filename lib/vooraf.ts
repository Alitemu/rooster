/**
 * Rooster vooraf invullen (components/FillGapsPanel.tsx): the picks of one round checked against each
 * other, and the candidates in a group ordered by room (audit 1.2.2). Without the database, for the
 * browser.
 *
 * The categories of a candidate (Beschikbaar, Dienst valt in vensterblok, ...) are worked out by the
 * server from what is already in the roster. Picks still waiting for "Alle toewijzingen toepassen"
 * are not in it: one round could put the same person on 14 and 15 January, both shown as
 * Beschikbaar, and the warning came only after applying. And within a group the candidates stood in
 * alphabetical order, someone already "vol" on top.
 */
import { requiredGapWeeks, tooClose } from './windowGap';
import type { WindowWeeksConfig } from './rosterBands';

export interface RondeDienst {
  slot_id: string;
  datum: string;
  teller: string;
}

/**
 * For a candidate on one slot: the other slots of this round where the same person is already picked,
 * on the same day or within the window. Their dates, earliest first.
 */
export function botsingenInRonde(
  slot: RondeDienst,
  personId: string,
  selection: Record<string, string>,
  slots: RondeDienst[],
  venster: WindowWeeksConfig
): string[] {
  const perId = new Map(slots.map((s) => [s.slot_id, s]));
  const datums: string[] = [];
  for (const [slotId, gekozen] of Object.entries(selection)) {
    if (slotId === slot.slot_id || gekozen !== personId) continue;
    const ander = perId.get(slotId);
    if (!ander) continue;
    if (ander.datum === slot.datum || tooClose(ander.datum, slot.datum, requiredGapWeeks(slot.teller, ander.teller, venster))) {
      datums.push(ander.datum);
    }
  }
  return datums.sort();
}

export interface MetRuimte {
  codenaam: string;
  band_count: number;
  band_max: number;
}

/** Most room first: not yet at the top of their bereik, then the fewest of it used, then by name. */
export function sorteerOpRuimte<T extends MetRuimte>(mensen: T[]): T[] {
  const vol = (p: T) => (p.band_count >= p.band_max ? 1 : 0);
  const deel = (p: T) => (p.band_max > 0 ? p.band_count / p.band_max : 1);
  return [...mensen].sort((a, b) => vol(a) - vol(b) || deel(a) - deel(b) || a.codenaam.localeCompare(b.codenaam));
}

/**
 * What the screen for filling diensten by hand is called (functional audit F-05, 1.7.0). Before the
 * roster is made it fills in advance: "Rooster vooraf invullen". Once made, it fills what stayed empty,
 * and "vooraf" no longer fits: "Lege diensten aanvullen". The section, its button, the page and the
 * warning before generating all take it from here.
 */
export function voorafNaam(status: string | null | undefined): string {
  return status === 'GEGENEREERD' || status === 'GEPUBLICEERD' ? 'Lege diensten aanvullen' : 'Rooster vooraf invullen';
}
