import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { blokTitel } from './AiosDienstrooster';

/**
 * Audit 1.2.2: every empty block in the AIOS's roster was read out as "Nachtblok zo t/m di: leeg.
 * Wijzigen", with nothing to tell one from the next. The box's name holds its days in that week.
 */
describe('blokTitel', () => {
  it('names the first and the last day of the block in this week', () => {
    const titel = blokTitel('Nachtblok zo t/m di', '2027-03-07', '2027-03-09');
    expect(titel).toMatch(/^Nachtblok zo t\/m di zo 7 mrt\.? t\/m di 9 mrt\.?$/);
  });

  it('one day: that day only', () => {
    expect(blokTitel('Avondblok wo t/m za', '2027-03-03', '2027-03-03')).toMatch(/^Avondblok wo t\/m za wo 3 mrt\.?$/);
  });

  it('the block box uses it, so the label of a button has it too', () => {
    const bron = fs.readFileSync(path.resolve(__dirname, 'AiosDienstrooster.tsx'), 'utf-8');
    expect(bron).toContain('title={blokTitel(naam, dagen[i].datum, dagen[j - 1].datum)}');
    expect(bron).toContain("aria-label={`${title}: ${dienst.aios ? dienst.aios.codenaam : 'leeg'}. Wijzigen`}");
  });
});
