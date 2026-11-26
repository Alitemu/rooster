import { describe, it, expect } from 'vitest';
import { EERDERE_KOP, SALDO_KOP, kopFout } from './importSjablonen';

/**
 * The first row of an uploaded workbook has to be the sjabloon's: that is
 * what keeps a column in the wrong place from importing as something else.
 */

describe('kopFout', () => {
  it('accepts the sjabloon\'s own header, in any case and with spaces around it', () => {
    expect(kopFout([[...SALDO_KOP], ['A', '1', '2']], SALDO_KOP)).toBeNull();
    expect(kopFout([[' codenaam ', 'AVONDDIENSTEN (SALDO)', 'weekenddiensten (saldo)']], SALDO_KOP)).toBeNull();
    expect(kopFout([[...EERDERE_KOP]], EERDERE_KOP)).toBeNull();
  });

  it('accepts extra columns after the sjabloon\'s', () => {
    expect(kopFout([[...EERDERE_KOP, 'Opmerking']], EERDERE_KOP)).toBeNull();
  });

  it.each([
    ['an empty file', []],
    ['an empty first row', [[]]],
    ['the old CSV layout', [['codenaam', 'AVOND_delta', 'WEEKEND_delta']]],
    ['a column missing', [['Codenaam', 'Avonddiensten (saldo)']]],
    ['the columns in another order', [['Avonddiensten (saldo)', 'Codenaam', 'Weekenddiensten (saldo)']]],
    ['the other sjabloon', [[...EERDERE_KOP]]],
  ])('refuses %s, in Dutch, naming the columns of the sjabloon', (_naam, rows) => {
    const fout = kopFout(rows as string[][], SALDO_KOP);
    expect(fout).toContain('niet de kolommen van het sjabloon');
    expect(fout).toContain(SALDO_KOP.join(', '));
    expect(fout).toContain('Download het sjabloon');
  });
});
