import { describe, it, expect } from 'vitest';
import { checkPeriodAcceptsInput, deadlinePassed, isDeadlineTekst } from './aiosInvoer';

describe('isDeadlineTekst and a deadline that cannot be read (0.111.0)', () => {
  it('takes what the forms write and nothing else', () => {
    for (const ok of ['2027-01-15T17:00', '2027-01-15T17:00:00Z', '2027-01-15T17:00:00.000+01:00']) expect(isDeadlineTekst(ok), ok).toBe(true);
    for (const kapot of [1893456000000, null, {}, '', 'morgen', '2027-01-15', '15-01-2027']) expect(isDeadlineTekst(kapot), String(kapot)).toBe(false);
  });

  it('counts a deadline it cannot read as passed', () => {
    expect(deadlinePassed('kapot', new Date('2027-01-10T12:00:00Z'))).toBe(true);
    expect(checkPeriodAcceptsInput({ status: 'OPEN', deadline: 'kapot' }, new Date('2027-01-10T12:00:00Z')).allowed).toBe(false);
  });
});
