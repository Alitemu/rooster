import { describe, it, expect } from 'vitest';
import { leesSaldoBestand } from './saldoBestand';
import { SALDO_KOP } from './importSjablonen';

/** The beginsaldo sjabloon as the wizard and the section "Import en correcties" both read it. */
describe('leesSaldoBestand', () => {
  it('reads the rows of the sjabloon, a blank cell as 0, a minus as fewer shifts', () => {
    expect(leesSaldoBestand([[...SALDO_KOP], ['staf01', '-1', ''], ['staf02', '', '2'], ['', '5', '5']])).toEqual({
      rows: [
        { codenaam: 'staf01', AVOND_delta: -1, WEEKEND_delta: 0 },
        { codenaam: 'staf02', AVOND_delta: 0, WEEKEND_delta: 2 },
      ],
      warnings: [],
    });
  });

  it('refuses a file that is not the sjabloon, before a row is read', () => {
    const gelezen = leesSaldoBestand([['codenaam', 'AVOND_delta', 'WEEKEND_delta'], ['staf01', '-1', '0']]);
    expect(gelezen).toHaveProperty('fout');
    expect((gelezen as { fout: string }).fout).toMatch(/niet de kolommen van het sjabloon/);
  });

  it('says which row has a number that is not whole, and which codenaam comes twice', () => {
    const gelezen = leesSaldoBestand([[...SALDO_KOP], ['staf01', '1,5', '0'], ['staf01', '1', 'x']]);
    expect(gelezen).toEqual({
      rows: [
        { codenaam: 'staf01', AVOND_delta: 0, WEEKEND_delta: 0 },
        { codenaam: 'staf01', AVOND_delta: 1, WEEKEND_delta: 0 },
      ],
      warnings: [
        'Rij 2 (staf01): avondwaarde "1,5" is geen geheel getal, als 0 verwerkt',
        'Rij 3: codenaam "staf01" komt meerdere keren voor. Beide rijen worden bij elkaar opgeteld.',
        'Rij 3 (staf01): weekendwaarde "x" is geen geheel getal, als 0 verwerkt',
      ],
    });
  });
});
