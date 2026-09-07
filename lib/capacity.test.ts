import { describe, it, expect } from 'vitest';
import {
  checkTotalCapacity,
  checkDistinctPeople,
  checkCapacity,
  periodsToCatchUp,
  getMinimumParticipantsNeeded,
  getMaxWindowWeeksForParticipants,
} from './capacity';

/**
 * CLAUDE.md names these two formulas explicitly as the live, pre-generation
 * capacity gate - a period must not be offered as generatable when either
 * fails. Each hard rule gets a test at its exact pass/fail boundary, not
 * just an example in the middle of the passing range, per the project's
 * "prove it can't be broken" convention.
 */

describe('checkTotalCapacity', () => {
  it('passes when pool capacity exactly meets total slots, fails one slot short', () => {
    // maxPerPerson = floor(10/2) = 5, poolCapacity = 4*5 = 20
    const atBoundary = checkTotalCapacity(10, 2, 4, 20);
    expect(atBoundary.passed).toBe(true);
    expect(atBoundary.poolCapacity).toBe(20);

    const oneShort = checkTotalCapacity(10, 2, 4, 21);
    expect(oneShort.passed).toBe(false);
  });

  it('floors maxPerPerson rather than rounding, so a partial window buys nobody an extra shift', () => {
    // floor(9/2) = 4, not 4.5 rounded up to 5 - a person can't work a
    // fractional shift for a leftover half-window.
    const result = checkTotalCapacity(9, 2, 1, 5);
    expect(result.maxPerPerson).toBe(4);
    expect(result.passed).toBe(false); // capacity=4 < 5 needed
  });
});

describe('checkDistinctPeople', () => {
  it('passes when active participants exactly meet the 7*windowWeeks requirement, fails one short', () => {
    const atBoundary = checkDistinctPeople(2, 14);
    expect(atBoundary.passed).toBe(true);
    expect(atBoundary.required).toBe(14);

    const oneShort = checkDistinctPeople(2, 13);
    expect(oneShort.passed).toBe(false);
  });
});

describe('checkCapacity', () => {
  it('only passes overall when both checks pass - one failing sub-check must fail the whole thing', () => {
    // Total capacity: floor(4/1)=4 per person * 20 people = 80 >= 10 slots - passes.
    // Distinct people: requires 7*1=7, only 20 available - also passes.
    // (Sanity: both pass when both individually pass.)
    const bothPass = checkCapacity(4, 1, 20, 10);
    expect(bothPass.overallPassed).toBe(true);

    // Now shrink participants so distinct-people fails while total
    // capacity still (trivially) passes - overall must still fail.
    const distinctFailsOnly = checkCapacity(4, 1, 5, 4);
    expect(distinctFailsOnly.totalCapacity.passed).toBe(true);
    expect(distinctFailsOnly.distinctPeople.passed).toBe(false);
    expect(distinctFailsOnly.overallPassed).toBe(false);
  });
});

describe('periodsToCatchUp', () => {
  it('is already caught up at balance >= 0, regardless of fair share', () => {
    expect(periodsToCatchUp(0, 8)).toBe(0);
    expect(periodsToCatchUp(3, 8)).toBe(0);
  });

  it('cannot catch up when fair share is zero or negative - must not divide by it', () => {
    expect(periodsToCatchUp(-2, 0)).toBeNull();
    expect(periodsToCatchUp(-2, -1)).toBeNull();
  });

  it('rounds up to a whole period, never a fraction of one', () => {
    // -5 balance, 8 per period: 5/8 = 0.625 -> must round up to 1 period,
    // not report a fractional 0.625 periods.
    expect(periodsToCatchUp(-5, 8)).toBe(1);
    // Exact multiple: -16 balance, 8 per period = exactly 2, no rounding needed.
    expect(periodsToCatchUp(-16, 8)).toBe(2);
  });
});

describe('getMinimumParticipantsNeeded / getMaxWindowWeeksForParticipants', () => {
  it('are inverse to each other at the pass/fail boundary', () => {
    const windowWeeks = 3;
    const minNeeded = getMinimumParticipantsNeeded(windowWeeks);
    expect(minNeeded).toBe(21);

    // Exactly enough participants must support this window...
    expect(getMaxWindowWeeksForParticipants(minNeeded)).toBeGreaterThanOrEqual(windowWeeks);
    // ...one participant short must not.
    expect(getMaxWindowWeeksForParticipants(minNeeded - 1)).toBeLessThan(windowWeeks);
  });
});
