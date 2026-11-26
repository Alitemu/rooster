/**
 * Each person's streefbereik for the planner (2.2.0): in "Status voorkeuren" and in the tab "Dienstdoende".
 *
 * The number a person gets was computed for the participant's own page and the invitation
 * (lib/rosterBands.ts computeMemberTargets: the period's band, scaled per person, with the saldo of this
 * period folded in: beginsaldo, carry-over and correcties), but the planner saw it nowhere. To know what
 * someone should get, they had to add up three lists in "Import en correcties" themselves.
 *
 * In words, as everywhere (CLAUDE.md): "2 of 3", "hoogstens 1", never "2-3" or "-1".
 */
import { TELLERS, type MemberTarget, type Teller } from '@/lib/rosterBands';

export interface BereikCel {
  tekst: string;
  /** Why it differs from the band of the period, or null when it does not. */
  toelichting: string | null;
}

export type StreefbereikRij = Record<Teller, BereikCel>;

const SOORT: Record<Teller, string> = { AVOND: 'avond', WEEKEND: 'weekend', FEESTDAG: 'feestdag' };

/** "2 of 3", "hoogstens 1", "geen", "2", "2 tot en met 5": the range without the noun, for a table cell. */
export function bereikKort(min: number, max: number): string {
  if (max <= 0) return 'geen';
  if (min <= 0) return `hoogstens ${max}`;
  if (min === max) return String(max);
  return max - min === 1 ? `${min} of ${max}` : `${min} tot en met ${max}`;
}

export function bereikCel(t: MemberTarget): BereikCel {
  const tekst = bereikKort(t.min, t.max);
  if (t.fellow) return { tekst, toelichting: 'fellow: geen weekenddienst verwacht' };
  const saldo = t.saldo ?? 0;
  if (saldo === 0) return { tekst, toelichting: null };
  const n = Math.abs(saldo);
  const basis = t.basis ? `basis ${bereikKort(t.basis[0], t.basis[1])}, ` : '';
  return { tekst, toelichting: `${basis}${n} ${n === 1 ? 'dienst' : 'diensten'} ${saldo > 0 ? 'extra' : 'minder'} uit het saldo` };
}

export function streefbereikRij(target: Record<Teller, MemberTarget>): StreefbereikRij {
  return Object.fromEntries(TELLERS.map((t) => [t, bereikCel(target[t])])) as StreefbereikRij;
}

/** The kinds of dienst where someone has fewer than the bottom or more than the top of the range. */
export function buitenBereik(target: Record<Teller, MemberTarget>, aantallen: Record<Teller, number>): string[] {
  return TELLERS.filter((t) => {
    const n = aantallen[t] ?? 0;
    // A fellow's weekend has nothing expected: fewer is no shortfall.
    return n > target[t].max || (!target[t].fellow && n < target[t].min);
  }).map((t) => SOORT[t]);
}
