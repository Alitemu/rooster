import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { shiftChanges, definitiefBericht, voorlopigBericht } from './publication';
import { formatSwapDate } from './swapMailDetails';

/**
 * The rule: the mail that makes a roster definitief tells each person
 * exactly what changed for them since the voorlopige version - nothing
 * left out, nothing invented.
 *
 * Between the two the planner corrects: gives a shift to someone else,
 * fills an empty one, takes one away. Random rosters and random
 * corrections; for every person the voorlopige shifts, minus what the mail
 * says fell away, plus what it says came in, must be exactly the
 * definitieve shifts, and the mail must name every one of those dates.
 */

const TELLERS = ['AVOND', 'WEEKEND', 'FEESTDAG'] as const;
const PEOPLE = ['p0', 'p1', 'p2', 'p3', 'p4'];

interface Shift {
  person_id: string;
  datum: string;
  teller: string;
}

/** A roster: every slot (a date and a counter) held by at most one person. */
const slotArb = fc.record({ dag: fc.integer({ min: 0, max: 60 }), teller: fc.constantFrom(...TELLERS) });
const rosterArb = fc
  .uniqueArray(slotArb, { selector: (s) => `${s.dag}|${s.teller}`, maxLength: 40 })
  .chain((slots) =>
    fc.tuple(
      fc.constant(slots),
      fc.array(fc.option(fc.constantFrom(...PEOPLE), { nil: null }), { minLength: slots.length, maxLength: slots.length }),
      fc.array(fc.option(fc.constantFrom(...PEOPLE), { nil: null }), { minLength: slots.length, maxLength: slots.length })
    )
  )
  .map(([slots, before, after]) => {
    const datum = (d: number) => new Date(Date.UTC(2027, 0, 4 + d)).toISOString().slice(0, 10);
    const toShifts = (holders: Array<string | null>) =>
      slots.flatMap((s, i) => (holders[i] ? [{ person_id: holders[i]!, datum: datum(s.dag), teller: s.teller }] : []));
    return { voorlopig: toShifts(before), definitief: toShifts(after) };
  });

const key = (s: { datum: string; teller: string }) => `${s.datum}|${s.teller}`;
const keysOf = (shifts: Shift[], person: string) => new Set(shifts.filter((s) => s.person_id === person).map(key));

describe('shiftChanges and the definitieve mail', () => {
  it('the voorlopige shifts, minus what fell away, plus what came in, are the definitieve ones', () => {
    fc.assert(
      fc.property(rosterArb, ({ voorlopig, definitief }) => {
        for (const person of PEOPLE) {
          const { erbij, eraf } = shiftChanges(person, voorlopig, definitief);
          const result = keysOf(voorlopig, person);
          for (const s of eraf) {
            expect(result.has(key(s))).toBe(true);
            result.delete(key(s));
          }
          for (const s of erbij) {
            expect(result.has(key(s))).toBe(false);
            result.add(key(s));
          }
          expect(result).toEqual(keysOf(definitief, person));
          for (const s of [...erbij, ...eraf]) expect(s.person_id).toBe(person);
        }
      }),
      { numRuns: 1000 }
    );
  });

  it('the mail names every change, and says nothing changed only when nothing did', () => {
    fc.assert(
      fc.property(rosterArb, ({ voorlopig, definitief }) => {
        for (const person of PEOPLE) {
          const changes = shiftChanges(person, voorlopig, definitief);
          const eigen = definitief.filter((s) => s.person_id === person);
          const { tekst } = definitiefBericht({ naam: 'Voorjaar' }, person, eigen, changes, null);
          const unchanged = changes.erbij.length === 0 && changes.eraf.length === 0;
          expect(tekst.includes('niets veranderd')).toBe(unchanged);
          for (const s of [...changes.erbij, ...changes.eraf, ...eigen]) expect(tekst).toContain(formatSwapDate(s.datum));
          expect(tekst).toContain(eigen.length === 0 ? 'geen diensten' : eigen.length === 1 ? '1 dienst' : `${eigen.length} diensten`);
        }
      }),
      { numRuns: 500 }
    );
  });

  it('a link is in the mail only when there is one, and the text stays Dutch about it', () => {
    const shift = [{ person_id: 'p0', datum: '2027-01-04', teller: 'AVOND' }];
    expect(voorlopigBericht({ naam: 'V' }, 'p0', shift, 'https://rooster.example/l/abc').tekst).toContain('https://rooster.example/l/abc');
    expect(voorlopigBericht({ naam: 'V' }, 'p0', shift, null).tekst).not.toContain('Je rooster in de app');
    expect(definitiefBericht({ naam: 'V' }, 'p0', shift, { erbij: [], eraf: [] }, null).tekst).not.toContain('Je rooster in de app');
  });
});
