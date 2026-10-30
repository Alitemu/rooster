import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { afwijking, afwijkingWoorden, bereikWoorden, buitenBereik, celWoorden, eerlijkBereik, EERLIJK_SOORTEN, type EerlijkRij } from '@/lib/aiosEerlijk';

/**
 * The fair range per soort (0.903.0): the whole numbers either side of the solver's share, none below none; within
 * it is fair, outside it is said in words.
 */

const rij = (codenaam: string, aantallen: Partial<EerlijkRij['aantallen']>, doelen: Partial<Record<keyof EerlijkRij['aantallen'], number>>): EerlijkRij => ({
  codenaam,
  aantallen: Object.fromEntries(EERLIJK_SOORTEN.map(({ soort }) => [soort, aantallen[soort] ?? 0])) as EerlijkRij['aantallen'],
  eerlijk: Object.fromEntries(
    EERLIJK_SOORTEN.map(({ soort }) => [soort, doelen[soort] === undefined ? null : eerlijkBereik(doelen[soort]!)])
  ) as EerlijkRij['eerlijk'],
});

describe('the fair range of a share', () => {
  it('is the whole numbers either side, one number when the share is whole, none below none', () => {
    expect(eerlijkBereik(4.6)).toEqual({ van: 4, tot: 5 });
    expect(eerlijkBereik(4)).toEqual({ van: 4, tot: 4 });
    expect(eerlijkBereik(0.3)).toEqual({ van: 0, tot: 1 });
    expect(eerlijkBereik(-0.2)).toEqual({ van: 0, tot: 0 });
    expect(eerlijkBereik(-2.2)).toEqual({ van: 0, tot: 0 });
    // As stored: hundredths. 4,001 is 4, not "4 of 5".
    expect(eerlijkBereik(4.001)).toEqual({ van: 4, tot: 4 });
    expect(eerlijkBereik(4.01)).toEqual({ van: 4, tot: 5 });
  });

  it('holds the share and is at most one wide (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100, noNaN: true }), (doel) => {
        const { van, tot } = eerlijkBereik(doel);
        const d = Math.round(doel * 100) / 100;
        expect(Number.isInteger(van) && Number.isInteger(tot)).toBe(true);
        expect(van <= d && d <= tot).toBe(true);
        expect(tot - van).toBeLessThanOrEqual(1);
      })
    );
  });

  it('a count is fair exactly within the range, and the difference is to the nearest end (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: -5, max: 40, noNaN: true }), fc.integer({ min: 0, max: 50 }), (doel, aantal) => {
        const b = eerlijkBereik(doel);
        const af = afwijking(aantal, b);
        expect(af === 0).toBe(b.van <= aantal && aantal <= b.tot);
        if (af < 0) expect(aantal - af).toBe(b.van);
        if (af > 0) expect(aantal - af).toBe(b.tot);
      })
    );
  });
});

describe('in words', () => {
  it('says the range, the difference and the whole cell in Dutch', () => {
    expect(bereikWoorden({ van: 4, tot: 5 })).toBe('4 of 5');
    expect(bereikWoorden({ van: 3, tot: 3 })).toBe('3');
    expect(afwijkingWoorden('nachten', 2, { van: 4, tot: 5 })).toBe('2 nachten minder dan eerlijk');
    expect(afwijkingWoorden('nachten', 6, { van: 4, tot: 5 })).toBe('1 nacht meer dan eerlijk');
    expect(afwijkingWoorden('weekavonden', 9, { van: 6, tot: 7 })).toBe('2 avonddiensten door de week meer dan eerlijk');
    expect(afwijkingWoorden('dagdiensten', 4, { van: 4, tot: 5 })).toBeNull();
    expect(celWoorden('nachten', 5, { van: 4, tot: 5 })).toBe('5 nachten, eerlijk is 4 of 5.');
    expect(celWoorden('uitloopdiensten', 1, { van: 3, tot: 4 })).toBe('1 uitloopdienst, eerlijk is 3 of 4. Dat is 2 uitloopdiensten minder dan eerlijk.');
    expect(celWoorden('feestdagdiensten', 1, null)).toBe('1 feestdagdienst.');
  });
});

describe('who is outside the range', () => {
  it('names each AIOS with every soort they are outside of, in the planner order, and skips a soort without a share', () => {
    const rijen = [
      rij('aios01', { nachten: 5, dagdiensten: 3 }, { nachten: 4.6, dagdiensten: 3.2 }),
      rij('aios02', { nachten: 2, uitloopdiensten: 9, dagdiensten: 1 }, { nachten: 4.6, uitloopdiensten: 5.5, dagdiensten: 3.2 }),
      rij('aios03', { nachten: 7, weekavonden: 12 }, { nachten: 4.6 }),
    ];
    expect(buitenBereik(rijen)).toEqual([
      {
        codenaam: 'aios02',
        verschillen: [
          '2 nachten minder dan eerlijk (eerlijk is 4 of 5)',
          '2 dagdiensten minder dan eerlijk (eerlijk is 3 of 4)',
          '3 uitloopdiensten meer dan eerlijk (eerlijk is 5 of 6)',
        ],
      },
      { codenaam: 'aios03', verschillen: ['2 nachten meer dan eerlijk (eerlijk is 4 of 5)'] },
    ]);
  });

  it('a debt from before is a range of none: any dienst of that soort is more than fair', () => {
    expect(buitenBereik([rij('aios04', { nachten: 1 }, { nachten: -0.2 })])).toEqual([
      { codenaam: 'aios04', verschillen: ['1 nacht meer dan eerlijk (eerlijk is 0)'] },
    ]);
  });

  it('no one outside: an empty list', () => {
    expect(buitenBereik([rij('aios01', { nachten: 4 }, { nachten: 4.6 })])).toEqual([]);
  });
});
