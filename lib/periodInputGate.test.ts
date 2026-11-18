import { describe, it, expect } from 'vitest';
import { checkPeriodAcceptsInput, deadlinePassed, isDeadlineText } from './periodInputGate';

describe('checkPeriodAcceptsInput', () => {
  it('allows input while OPEN and before the deadline', () => {
    const result = checkPeriodAcceptsInput(
      { status: 'OPEN', deadline: '2027-01-15T17:00:00Z' },
      new Date('2027-01-10T12:00:00Z')
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks input once the deadline has passed, even while still OPEN', () => {
    // The status-based check alone would let this through - a planner who
    // hasn't closed the period yet must not leave input open past the
    // deadline the participant was actually told about.
    const result = checkPeriodAcceptsInput(
      { status: 'OPEN', deadline: '2027-01-15T17:00:00Z' },
      new Date('2027-01-16T00:00:00Z')
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('DEADLINE_PASSED');
  });

  it('blocks input once the period has moved past OPEN, even before the deadline', () => {
    // The planner closed early - status must still win, deadline or not.
    const result = checkPeriodAcceptsInput(
      { status: 'GESLOTEN', deadline: '2027-01-15T17:00:00Z' },
      new Date('2027-01-10T12:00:00Z')
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('PERIOD_NOT_OPEN');
  });

  it('treats the exact deadline instant as still allowed (only strictly after blocks)', () => {
    const deadline = '2027-01-15T17:00:00.000Z';
    const result = checkPeriodAcceptsInput({ status: 'OPEN', deadline }, new Date(deadline));
    expect(result.allowed).toBe(true);
  });
});

describe('isDeadlineText and a deadline that cannot be read', () => {
  it('takes what the forms write and nothing else', () => {
    for (const ok of ['2028-02-29T17:00', '2027-01-15T17:00', '2027-01-15T17:00:00', '2027-01-15T17:00:00Z', '2027-01-15T17:00:00.000+01:00']) {
      expect(isDeadlineText(ok), ok).toBe(true);
    }
    for (const kapot of [1893456000000, null, undefined, {}, '', 'morgen', '2027-01-15', '15-01-2027', '2027-13-45T17:00', '2027-02-30T17:00', '2027-02-29T17:00', '2027-04-31T17:00']) {
      expect(isDeadlineText(kapot), String(kapot)).toBe(false);
    }
  });

  it('counts a deadline it cannot read as passed, so the period does not take input for ever', () => {
    expect(deadlinePassed('1893456000000', new Date('2027-01-10T12:00:00Z'))).toBe(true);
    expect(deadlinePassed('kapot', new Date('2027-01-10T12:00:00Z'))).toBe(true);
    expect(checkPeriodAcceptsInput({ status: 'OPEN', deadline: 'kapot' }, new Date('2027-01-10T12:00:00Z')).allowed).toBe(false);
  });
});
