import { describe, it, expect } from 'vitest';
import { checkPeriodAcceptsInput } from './periodInputGate';

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
