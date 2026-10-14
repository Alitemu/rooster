import { describe, it, expect } from 'vitest';
import { priorRowsInWindow } from './priorAssignmentUpload';

/**
 * The rule: only rows inside the carry-over window go on to the import,
 * each read the way the roster download wrote it - and every row left out
 * for another reason is named, never dropped without a word.
 * (POST .../import-csv checks the window again, route.test.ts there.)
 */

const RANGE: [string, string] = ['2026-12-28', '2027-01-03'];
const HEADER = ['Datum', 'Week', 'Diensttype', 'Codenaam'];

describe('priorRowsInWindow', () => {
  it('keeps the window, counts what lies outside it', () => {
    const result = priorRowsInWindow(
      [HEADER, ['2026-12-27', '52', 'Avond', 'A'], ['46384', '53', 'Avond', 'B'], ['2027-01-03', '53', 'Weekend', 'C'], ['2027-01-04', '1', 'Avond', 'D']],
      RANGE
    );
    expect(result.rows).toEqual([
      { datum: '2026-12-28', teller: 'AVOND', codenaam: 'B' },
      { datum: '2027-01-03', teller: 'WEEKEND', codenaam: 'C' },
    ]);
    expect(result.outOfRange).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it('reads every way the diensttype and the codenaam come back', () => {
    const result = priorRowsInWindow(
      [HEADER, ['29-12-2026', '53', 'avonddienst', "'-Anna"], ['30-12-2026', '53', 'FEESTDAG', ' Bert '], ['31-12-2026', '53', 'Avond']],
      RANGE
    );
    expect(result.rows).toEqual([
      { datum: '2026-12-29', teller: 'AVOND', codenaam: '-Anna' },
      { datum: '2026-12-30', teller: 'FEESTDAG', codenaam: 'Bert' },
      { datum: '2026-12-31', teller: 'AVOND', codenaam: '' },
    ]);
  });

  it('names each row it leaves out and why', () => {
    const result = priorRowsInWindow([HEADER, ['morgen', '1', 'Avond', 'A'], ['2026-12-29'], ['2026-12-30', '53', 'Nacht', 'B'], [''], []], RANGE);
    expect(result.rows).toEqual([]);
    expect(result.warnings).toEqual([
      'Rij 2: "morgen" is geen datum, overgeslagen',
      'Rij 3: niet genoeg kolommen, overgeslagen',
      'Rij 4: onbekend diensttype "Nacht", overgeslagen',
    ]);
  });
});
