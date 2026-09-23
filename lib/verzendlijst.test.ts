import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { verzendlijstPersonen } from './verzendlijst';

/**
 * The rule: a flow that replaces each codenaam in `personen` by a real
 * name, in list order, never breaks a longer codenaam by replacing a
 * shorter one that sits inside it ("Persoon-1" inside "Persoon-10").
 */

/** What the flow does: replace each codenaam in list order. */
function replaceInOrder(tekst: string, personen: string[], naam: (c: string) => string): string {
  return personen.reduce((t, c) => t.split(c).join(naam(c)), tekst);
}

describe('verzendlijstPersonen', () => {
  it('puts the recipient and the others in, once each', () => {
    expect(verzendlijstPersonen('Persoon-07', ['Persoon-03', 'Persoon-07'])).toEqual(['Persoon-03', 'Persoon-07']);
  });

  it('drops an empty codenaam (a lookup that found nobody)', () => {
    expect(verzendlijstPersonen('Persoon-07', [''])).toEqual(['Persoon-07']);
  });

  it('lists a codenaam before any shorter one it contains', () => {
    expect(verzendlijstPersonen('Persoon-1', ['Persoon-10'])).toEqual(['Persoon-10', 'Persoon-1']);
  });

  it('never lets replacing in list order break a longer codenaam', () => {
    const codenaam = fc.integer({ min: 1, max: 120 }).map((n) => `Persoon-${n}`);
    fc.assert(
      fc.property(codenaam, fc.array(codenaam, { maxLength: 4 }), (ontvanger, anderen) => {
        const personen = verzendlijstPersonen(ontvanger, anderen);
        const tekst = personen.map((c) => `[${c}]`).join(' ');
        // Reversed, so a name never starts like the codenaam it replaces: a
        // shorter codenaam replaced first then leaves visible debris.
        const naam = (c: string) => [...c].reverse().join('');
        const verwacht = personen.map((c) => `[${naam(c)}]`).join(' ');
        expect(replaceInOrder(tekst, personen, naam)).toBe(verwacht);
      })
    );
  });
});
