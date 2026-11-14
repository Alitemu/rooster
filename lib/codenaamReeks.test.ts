import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { codenaamReeks, MAX_REEKS } from './codenaamReeks';

/**
 * The rule: a reeks is every number from the first to the last, once each,
 * in order, with the letters in front kept and the width of the first
 * number; anything that is not one reeks says why in Dutch.
 */

describe('codenaamReeks', () => {
  it('counts from the first to the last, keeping the width of the first number', () => {
    expect(codenaamReeks('aios01', 'aios03')).toEqual({ ok: true, codenamen: ['aios01', 'aios02', 'aios03'] });
    expect(codenaamReeks('aios08', 'aios11')).toEqual({ ok: true, codenamen: ['aios08', 'aios09', 'aios10', 'aios11'] });
    expect(codenaamReeks('staf9', 'staf11')).toEqual({ ok: true, codenamen: ['staf9', 'staf10', 'staf11'] });
    expect(codenaamReeks(' aios05 ', 'aios05')).toEqual({ ok: true, codenamen: ['aios05'] });
    expect(codenaamReeks('Persoon-01', 'Persoon-02')).toEqual({ ok: true, codenamen: ['Persoon-01', 'Persoon-02'] });
  });

  it('holds every number once, in order, for any range', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: MAX_REEKS - 1 }), fc.integer({ min: 1, max: 4 }), (begin, extra, breedte) => {
        const van = `aios${String(begin).padStart(breedte, '0')}`;
        const tot = `aios${begin + extra}`;
        const r = codenaamReeks(van, tot);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.codenamen).toHaveLength(extra + 1);
        expect(r.codenamen.map((c) => Number(c.slice(4)))).toEqual(Array.from({ length: extra + 1 }, (_, i) => begin + i));
        expect(new Set(r.codenamen).size).toBe(r.codenamen.length);
        expect(r.codenamen[0]).toBe(van);
      })
    );
  });

  it('says what is wrong with something that is not one reeks', () => {
    expect(codenaamReeks('aios', 'aios30')).toMatchObject({ ok: false });
    expect(codenaamReeks('aios01', 'staf03')).toEqual({ ok: false, message: 'Het begin van de twee codenamen verschilt ("aios" en "staf"). Een reeks heeft één begin, bijvoorbeeld aios01 tot en met aios30.' });
    expect(codenaamReeks('aios10', 'aios02')).toEqual({ ok: false, message: 'Het tweede nummer is lager dan het eerste. Draai ze om.' });
    expect(codenaamReeks('aios1', `aios${MAX_REEKS + 1}`)).toEqual({ ok: false, message: `Een reeks is hooguit ${MAX_REEKS} codenamen.` });
    expect(codenaamReeks('aios1', `aios${MAX_REEKS}`).ok).toBe(true);
  });
});
