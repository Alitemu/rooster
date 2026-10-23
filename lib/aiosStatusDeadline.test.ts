import { describe, it, expect } from 'vitest';
import { zetAiosDeadline } from './aiosStatus';
import type { AiosUitnodigPeriode } from './aiosUitnodigen';

/**
 * The rule: the AIOS deadline route takes the deadline in the shape the forms
 * write it, as the achterwacht's routes do. Whatever `new Date()` can read
 * ("2026", "12/01/2026", a date alone) was stored as it came and read
 * differently by everything that works with the text later.
 */

const periode = { id: 'p', status: 'OPEN', deadline: '2099-02-01T17:00', start_datum: '2099-04-01', eind_datum: '2099-06-30', row_version: 1 } as unknown as AiosUitnodigPeriode;
const nu = new Date(2099, 0, 1);

describe('zetAiosDeadline: the shape of the deadline', () => {
  it.each(['2026', '1', '12/01/2099', '2099-02-01', 'Feb 1 2099 17:00', '2099-02-01 17:00 UTC+1', '2099-13-01T17:00', '2099-02-30T17:00', '2099-02-01T25:00', 'morgen'])(
    'refuses %j',
    (tekst) => {
      expect(zetAiosDeadline(periode, tekst, 'actor', nu)).toMatchObject({ ok: false, status: 400, code: 'INVALID_DEADLINE', message: 'Ongeldige deadline' });
    }
  );

  it.each([null, undefined, 5, {}, ''])('says a deadline is needed for %j', (waarde) => {
    expect(zetAiosDeadline(periode, waarde, 'actor', nu)).toMatchObject({ ok: false, status: 400, code: 'MISSING_DEADLINE' });
  });

  it('still refuses a good shape in the past and after the start', () => {
    expect(zetAiosDeadline(periode, '2098-12-31T17:00', 'actor', nu)).toMatchObject({ ok: false, message: 'Deadline mag niet in het verleden liggen' });
    expect(zetAiosDeadline(periode, '2099-04-01T00:00', 'actor', nu)).toMatchObject({ ok: false, message: 'Deadline moet vóór de startdatum liggen' });
  });
});
