import { describe, it, expect } from 'vitest';
import { veranderdeDagen } from './membershipRooster';

const oud = { geldig_vanaf: '2030-01-01', geldig_tot: '2030-12-31' };

describe('veranderdeDagen', () => {
  it('is the whole membership when it is removed', () => {
    expect(veranderdeDagen(oud, null)).toEqual([['2030-01-01', '2030-12-31']]);
  });

  it('is nothing when the dates stay as they are', () => {
    expect(veranderdeDagen(oud, { ...oud })).toEqual([]);
  });

  it('is the days between the old and the new end, when the end moves (earlier or later)', () => {
    expect(veranderdeDagen(oud, { ...oud, geldig_tot: '2030-06-30' })).toEqual([['2030-07-01', '2030-12-31']]);
    expect(veranderdeDagen(oud, { ...oud, geldig_tot: '2031-02-28' })).toEqual([['2031-01-01', '2031-02-28']]);
  });

  it('is the days between the old and the new start, when the start moves (earlier or later)', () => {
    expect(veranderdeDagen(oud, { ...oud, geldig_vanaf: '2030-03-01' })).toEqual([['2030-01-01', '2030-02-28']]);
    expect(veranderdeDagen(oud, { ...oud, geldig_vanaf: '2029-11-15' })).toEqual([['2029-11-15', '2029-12-31']]);
  });

  it('gives two stretches when both ends move, over the year boundary too', () => {
    expect(veranderdeDagen(oud, { geldig_vanaf: '2030-02-01', geldig_tot: '2031-01-31' })).toEqual([
      ['2030-01-01', '2030-01-31'],
      ['2031-01-01', '2031-01-31'],
    ]);
  });
});
