/**
 * Each person's streefbereik for the planner (2.2.0): in "Status voorkeuren" and in the tab "Dienstdoende".
 *
 * The number a person gets was computed for the participant's own page and the invitation
 * (lib/rosterBands.ts computeMemberTargets: the period's band, scaled per person, with the saldo of this
 * period folded in: beginsaldo, carry-over and correcties), but the planner saw it nowhere. To know what
 * someone should get, they had to add up three lists in "Import en correcties" themselves.
 *
 * In words, as everywhere (CLAUDE.md): "2 of 3", "0 of 1", never "2-3" or "-1". Always in numbers since
 * 2.3.0 ("hoogstens 1" became "0 of 1", the planner's choice: the same form under every bar).
 */
import { TELLERS, type MemberTarget, type Teller } from '@/lib/rosterBands';

export interface BereikCel {
  tekst: string;
  /** Why it differs from the band of the period, or null when it does not. */
  toelichting: string | null;
}

export type StreefbereikRij = Record<Teller, BereikCel>;

/** "2 of 3", "0 of 1", "2", "2 tot en met 5": the range without the noun, for a table cell, always in numbers. */
export function bereikKort(min: number, max: number): string {
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

/**
 * Per kind of dienst whether the count fits the range: "goed", "1 te veel", "2 tekort" (2.3.0; 2.2.1 had
 * only the kinds outside it, "1 avonddienst te veel"). The tab "Dienstdoende" shows it next to the bars, the
 * range itself stands under each bar. That difference is what lib/carryOver.ts carries to the next period
 * once this roster is published.
 */
export function uitkomstPerSoort(target: Record<Teller, MemberTarget>, aantallen: Record<Teller, number>): Record<Teller, string> {
  return Object.fromEntries(
    TELLERS.map((t) => {
      const n = aantallen[t] ?? 0;
      if (n > target[t].max) return [t, `${n - target[t].max} te veel`];
      // A fellow's weekend has nothing expected: fewer is no shortfall.
      if (!target[t].fellow && n < target[t].min) return [t, `${target[t].min - n} tekort`];
      return [t, 'goed'];
    })
  ) as Record<Teller, string>;
}
