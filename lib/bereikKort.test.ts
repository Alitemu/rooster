import { describe, it, expect } from 'vitest';
import { bereikKort, weekendBereikTekst } from './bereikKort';

/** One way to write a range on the planner's screens (2.6.2): "x of x+1", never "x tot y". */
describe('a range in numbers', () => {
  it('writes two neighbours with "of", a wider one with "tot en met", one number on its own', () => {
    expect(bereikKort(4, 5)).toBe('4 of 5');
    expect(bereikKort(0, 1)).toBe('0 of 1');
    expect(bereikKort(2, 4)).toBe('2 tot en met 4');
    expect(bereikKort(3, 3)).toBe('3');
  });

  it('the fellow notice says the others\' weekend band the same way', () => {
    expect(weekendBereikTekst([4, 5])).toBe('4 of 5 weekenddiensten');
    expect(weekendBereikTekst([1, 3])).toBe('1 tot en met 3 weekenddiensten');
    expect(weekendBereikTekst([1, 1])).toBe('1 weekenddienst');
    for (const b of [[4, 5], [1, 3], [0, 1]] as Array<[number, number]>) expect(weekendBereikTekst(b)).not.toMatch(/\d tot \d/);
  });
});
