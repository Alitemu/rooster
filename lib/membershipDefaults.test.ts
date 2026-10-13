import { describe, it, expect } from 'vitest';
import { newMembershipDefaults, FALLBACK_GELDIG_TOT, type PeriodForDefaults } from './membershipDefaults';

/**
 * The rule: someone added to a pool is, by default, a member for the whole
 * period being rostered - never for less of it than the planner meant.
 */

const TODAY = '2026-10-13';
const period = (over: Partial<PeriodForDefaults>): PeriodForDefaults => ({
  naam: 'Winter',
  pool_id: 'pool-a',
  status: 'OPEN',
  start_datum: '2026-12-28',
  eind_datum: '2027-09-05',
  ...over,
});

describe('newMembershipDefaults', () => {
  it('takes the dates of the one period being rostered', () => {
    expect(newMembershipDefaults([period({})], 'pool-a', TODAY)).toEqual({
      geldig_vanaf: '2026-12-28',
      geldig_tot: '2027-09-05',
      periode: 'Winter',
    });
  });

  it('counts a closed or generated, not yet published period as being rostered', () => {
    for (const status of ['GESLOTEN', 'GEGENEREERD']) {
      expect(newMembershipDefaults([period({ status })], 'pool-a', TODAY).periode, status).toBe('Winter');
    }
  });

  it('looks past published and concept periods, and other pools', () => {
    const periods = [
      period({ naam: 'Vorige', status: 'GEPUBLICEERD', start_datum: '2026-06-29', eind_datum: '2026-12-27' }),
      period({ naam: 'Later', status: 'CONCEPT', start_datum: '2027-09-06', eind_datum: '2028-01-02' }),
      period({ naam: 'Andere pool', pool_id: 'pool-b' }),
      period({}),
    ];
    expect(newMembershipDefaults(periods, 'pool-a', TODAY).periode).toBe('Winter');
  });

  it('falls back to today until the end of 2029 without such a period', () => {
    expect(newMembershipDefaults([], 'pool-a', TODAY)).toEqual({ geldig_vanaf: TODAY, geldig_tot: FALLBACK_GELDIG_TOT, periode: null });
    expect(newMembershipDefaults([period({ status: 'GEPUBLICEERD' })], 'pool-a', TODAY).periode).toBeNull();
  });

  it('falls back when two periods are being rostered at once: which one is not ours to guess', () => {
    const two = [period({}), period({ naam: 'Zomer', status: 'GESLOTEN', start_datum: '2026-06-29', eind_datum: '2026-12-27' })];
    expect(newMembershipDefaults(two, 'pool-a', TODAY)).toEqual({ geldig_vanaf: TODAY, geldig_tot: '2029-12-31', periode: null });
  });
});
