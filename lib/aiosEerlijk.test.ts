import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { afwijking, afwijkingWoorden, bereikWoorden, celWoorden, eerlijkBereik, eerlijkVak, EERLIJK_SOORTEN, metVak, verschillen, type EerlijkRij } from '@/lib/aiosEerlijk';

/**
 * The fair range per soort (0.903.0): the whole numbers either side of the solver's share, none below none; within
 * it is fair, outside it is said in words.
 */

const rij = (aantallen: Partial<EerlijkRij['aantallen']>, doelen: Partial<Record<keyof EerlijkRij['aantallen'], number>>): EerlijkRij => ({
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

describe('the last column: what is outside the range (2.4.0)', () => {
  it('names every soort outside it in the planner order, in short words, and skips a soort without a share', () => {
    const r = rij(
      { nachten: 2, dagdiensten: 1, weekendavonden: 4, weekavonden: 9, uitloopdiensten: 9, feestdagdiensten: 0 },
      { nachten: 4.6, dagdiensten: 3.2, weekendavonden: 2.4, weekavonden: 5.5, uitloopdiensten: 5.5, feestdagdiensten: 1 }
    );
    expect(verschillen(r)).toEqual([
      '2 nachten tekort',
      '2 dagdiensten tekort',
      '1 weekendavond te veel',
      '3 weekavonden te veel',
      '3 uitloopdiensten te veel',
      '1 feestdagdienst tekort',
    ]);
    expect(verschillen(rij({ nachten: 7, weekavonden: 12 }, { nachten: 4.6 }))).toEqual(['2 nachten te veel']);
  });

  it('on either end of the range is goed: an empty list', () => {
    expect(verschillen(rij({ nachten: 4 }, { nachten: 4.6 }))).toEqual([]);
    expect(verschillen(rij({ nachten: 5 }, { nachten: 4.6 }))).toEqual([]);
    expect(verschillen(rij({ nachten: 3 }, { nachten: 4.6 }))).toEqual(['1 nacht tekort']);
    expect(verschillen(rij({ nachten: 6 }, { nachten: 4.6 }))).toEqual(['1 nacht te veel']);
  });

  it('a debt from before is a range of none: any dienst of that soort is too many', () => {
    expect(verschillen(rij({ nachten: 1 }, { nachten: -0.2 }))).toEqual(['1 nacht te veel']);
  });

  it('says exactly the soorten the arrows mark, by how many (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 20 }), { minLength: 6, maxLength: 6 }), fc.array(fc.double({ min: -3, max: 15, noNaN: true }), { minLength: 6, maxLength: 6 }), (n, d) => {
        const r = rij(
          Object.fromEntries(EERLIJK_SOORTEN.map(({ soort }, i) => [soort, n[i]])),
          Object.fromEntries(EERLIJK_SOORTEN.map(({ soort }, i) => [soort, d[i]]))
        );
        const verwacht = EERLIJK_SOORTEN.flatMap(({ soort }) => {
          const af = afwijking(r.aantallen[soort], r.eerlijk[soort]!);
          return af === 0 ? [] : [`${Math.abs(af)} ${af > 0 ? 'te veel' : 'tekort'}`];
        });
        expect(verschillen(r).map((t) => t.replace(/^(\d+) .*? (te veel|tekort)$/, '$1 $2'))).toEqual(verwacht);
      })
    );
  });
});

describe('the dashed box (2.4.0)', () => {
  it('is half a dienst wider on either side, never left of none, none without a range', () => {
    expect(eerlijkVak({ van: 4, tot: 5 })).toEqual({ van: 3.5, tot: 5.5 });
    expect(eerlijkVak({ van: 3, tot: 3 })).toEqual({ van: 2.5, tot: 3.5 });
    expect(eerlijkVak({ van: 0, tot: 1 })).toEqual({ van: 0, tot: 1.5 });
    expect(eerlijkVak({ van: 0, tot: 0 })).toEqual({ van: 0, tot: 0.5 });
    expect(eerlijkVak(null)).toBeNull();
  });

  it('is over every soort but the feestdagen, as at the achterwacht', () => {
    expect(EERLIJK_SOORTEN.map(({ soort }) => soort).filter(metVak)).toEqual(['nachten', 'dagdiensten', 'weekendavonden', 'weekavonden', 'uitloopdiensten']);
    expect(metVak('feestdagdiensten')).toBe(false);
  });

  it('holds both ends of the range and no count outside it (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: -5, max: 40, noNaN: true }), fc.integer({ min: 0, max: 50 }), (doel, aantal) => {
        const b = eerlijkBereik(doel);
        const v = eerlijkVak(b)!;
        expect(v.van).toBeGreaterThanOrEqual(0);
        expect(v.van <= b.van && b.tot <= v.tot).toBe(true);
        // A bar ends inside the box exactly when it is fair: the arrows and the box never disagree.
        expect(v.van <= aantal && aantal <= v.tot).toBe(afwijking(aantal, b) === 0);
      })
    );
  });
});
