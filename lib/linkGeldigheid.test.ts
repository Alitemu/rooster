import { describe, it, expect } from 'vitest';
import { linkVerlopen } from './linkGeldigheid';

describe('linkVerlopen', () => {
  it('is still valid on the last day of the period, expired from the day after', () => {
    expect(linkVerlopen('2030-03-15', '2030-03-14')).toBe(false);
    expect(linkVerlopen('2030-03-15', '2030-03-15')).toBe(false);
    expect(linkVerlopen('2030-03-15', '2030-03-16')).toBe(true);
  });

  it('holds over the year boundary', () => {
    expect(linkVerlopen('2030-12-31', '2030-12-31')).toBe(false);
    expect(linkVerlopen('2030-12-31', '2031-01-01')).toBe(true);
  });

  it('never expires a link that has no period', () => {
    expect(linkVerlopen(null, '2099-01-01')).toBe(false);
    expect(linkVerlopen(undefined, '2099-01-01')).toBe(false);
  });
});
