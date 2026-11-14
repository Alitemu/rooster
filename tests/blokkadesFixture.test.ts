import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The seed's real blockades (tests/fixtures/blokkades-2027-h1.csv, scripts/seed.ts step 11b).
 *
 * The first conversion of the source spreadsheet read a non-breaking space (filler) as a mark,
 * so 14 of the 31 columns came out blocked on 153 of the 154 days. Nobody is blocked for half
 * a year: the demo and every browser check then ran with 17 people really available, and the
 * solver left 33 shifts empty for lack of people (audit 1.2.2). A column blocked on (nearly)
 * every day is that error again.
 */
const csv = fs.readFileSync(path.resolve(__dirname, 'fixtures/blokkades-2027-h1.csv'), 'utf-8').trim().split(/\r?\n/);
const [kop, ...rijen] = csv.map((r) => r.split(';'));

describe('blokkades-2027-h1.csv', () => {
  it('has 31 people over 154 days', () => {
    expect(kop.slice(3)).toHaveLength(31);
    expect(rijen).toHaveLength(154);
  });

  it('blocks nobody on more than three quarters of the days', () => {
    const teVeel = kop.slice(3).flatMap((codenaam, i) => {
      const aantal = rijen.filter((r) => r[i + 3]?.trim() === 'X').length;
      return aantal > rijen.length * 0.75 ? [`${codenaam}: ${aantal}`] : [];
    });
    expect(teVeel).toEqual([]);
  });

  it('holds only X or nothing in a cell', () => {
    const anders = rijen.flatMap((r) => r.slice(3).filter((c) => c.trim() !== '' && c.trim() !== 'X'));
    expect(anders).toEqual([]);
  });
});
