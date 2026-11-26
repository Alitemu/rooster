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

const ENKELVOUD: Record<Teller, string> = { AVOND: 'avonddienst', WEEKEND: 'weekenddienst', FEESTDAG: 'feestdagdienst' };
const MEERVOUD: Record<Teller, string> = { AVOND: 'avonddiensten', WEEKEND: 'weekenddiensten', FEESTDAG: 'feestdagdiensten' };

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

/**
 * Where someone has more than the top or fewer than the bottom of the range, and by how many: "1 avonddienst
 * te veel", "2 weekenddiensten tekort" (2.2.1, the planner's wish: "buiten het bereik: avond" did not say how
 * far). That difference is what lib/carryOver.ts carries to the next period once this roster is published.
 */
export function buitenBereik(target: Record<Teller, MemberTarget>, aantallen: Record<Teller, number>): string[] {
  const uit: string[] = [];
  for (const t of TELLERS) {
    const n = aantallen[t] ?? 0;
    const woord = (k: number) => `${k} ${k === 1 ? ENKELVOUD[t] : MEERVOUD[t]}`;
    if (n > target[t].max) uit.push(`${woord(n - target[t].max)} te veel`);
    // A fellow's weekend has nothing expected: fewer is no shortfall.
    else if (!target[t].fellow && n < target[t].min) uit.push(`${woord(target[t].min - n)} tekort`);
  }
  return uit;
}
