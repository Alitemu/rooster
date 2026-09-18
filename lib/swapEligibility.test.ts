import { describe, it, expect } from 'vitest';
import { checkSwapAllowed } from './swapEligibility';

/**
 * One rule = one test. Two hard rules live here, and both are about what
 * two participants can do to a roster without the planner:
 * - a swap only ever touches a published roster
 * - a swap never rewrites a shift that has already been worked
 */

const FUTURE = '2099-01-10';
const ALSO_FUTURE = '2099-02-20';

describe('checkSwapAllowed', () => {
  it('allows a swap of two future shifts on a published roster', () => {
    expect(
      checkSwapAllowed({ periodStatus: 'GEPUBLICEERD', slotDates: [FUTURE, ALSO_FUTURE] }).allowed
    ).toBe(true);
  });

  for (const status of ['CONCEPT', 'OPEN', 'GESLOTEN', 'GEGENEREERD']) {
    it(`refuses a swap while the period is still ${status}, so participants cannot edit a draft roster`, () => {
      // An approved swap writes bron='MANUAL' on both assignments, and a
      // regenerate deliberately preserves manual ones - so without this,
      // two participants could pin their own change into a roster the
      // planner has not published yet.
      const result = checkSwapAllowed({ periodStatus: status, slotDates: [FUTURE, ALSO_FUTURE] });
      expect(result.allowed).toBe(false);
      expect(result.code).toBe('PERIOD_NOT_PUBLISHED');
    });
  }

  it('refuses a swap when either shift is already in the past', () => {
    const now = new Date('2099-01-15T12:00:00Z');
    const offeredInPast = checkSwapAllowed(
      { periodStatus: 'GEPUBLICEERD', slotDates: [FUTURE, ALSO_FUTURE] },
      now
    );
    expect(offeredInPast.allowed).toBe(false);
    expect(offeredInPast.code).toBe('SHIFT_IN_PAST');

    const requestedInPast = checkSwapAllowed(
      { periodStatus: 'GEPUBLICEERD', slotDates: [ALSO_FUTURE, FUTURE] },
      now
    );
    expect(requestedInPast.allowed).toBe(false);
    expect(requestedInPast.code).toBe('SHIFT_IN_PAST');
  });

  it('still allows a shift dated today - it may not have started yet', () => {
    const now = new Date('2099-01-10T09:00:00Z');
    expect(
      checkSwapAllowed({ periodStatus: 'GEPUBLICEERD', slotDates: [FUTURE, ALSO_FUTURE] }, now).allowed
    ).toBe(true);
  });

  it('refuses when a slot date is missing rather than treating it as valid', () => {
    expect(
      checkSwapAllowed({ periodStatus: 'GEPUBLICEERD', slotDates: [FUTURE, undefined] }).allowed
    ).toBe(false);
  });
});
