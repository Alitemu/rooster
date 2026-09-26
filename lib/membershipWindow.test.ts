import { describe, it, expect } from 'vitest';
import { blockOutsideMembership, coversDate } from './membershipWindow';

/**
 * The rule: nobody is put on a day before their Geldig vanaf or after their
 * Geldig tot. Both ends count as taking part.
 */

describe('coversDate', () => {
  const w = [{ geldig_vanaf: '2027-03-01', geldig_tot: '2027-03-28' }];

  it('includes both ends and nothing outside them', () => {
    expect(coversDate(w, '2027-03-01')).toBe(true);
    expect(coversDate(w, '2027-03-28')).toBe(true);
    expect(coversDate(w, '2027-02-28')).toBe(false);
    expect(coversDate(w, '2027-03-29')).toBe(false);
  });

  it('follows someone who left and came back', () => {
    const tweeKeer = [...w, { geldig_vanaf: '2027-04-12', geldig_tot: '2030-12-31' }];
    expect(coversDate(tweeKeer, '2027-04-05')).toBe(false);
    expect(coversDate(tweeKeer, '2027-04-12')).toBe(true);
  });

  it('covers nothing without a membership', () => {
    expect(coversDate(undefined, '2027-03-10')).toBe(false);
  });
});

describe('blockOutsideMembership (what the solver gets)', () => {
  const slots = [
    { id: 'voor', datum: '2027-03-15' },
    { id: 'laatste', datum: '2027-03-28' },
    { id: 'na', datum: '2027-04-06' },
  ];
  const windows = new Map([
    ['vertrekt', [{ geldig_vanaf: '2020-01-01', geldig_tot: '2027-03-28' }]],
    ['blijft', [{ geldig_vanaf: '2020-01-01', geldig_tot: '2030-12-31' }]],
  ]);

  it('blocks every day after Geldig tot hard, even one marked as preferred', () => {
    const result = blockOutsideMembership(
      { vertrekt: [{ slot_id: 'na', blocking_level: 'VOORKEUR' }], blijft: [] },
      slots,
      windows
    );
    expect(result.vertrekt).toEqual([{ slot_id: 'na', blocking_level: 'ABSOLUUT' }]);
    expect(result.blijft).toEqual([]);
  });

  it('leaves days inside the membership exactly as marked', () => {
    const prefs = { vertrekt: [{ slot_id: 'voor', blocking_level: 'LIEVER_NIET' }], blijft: [] };
    const result = blockOutsideMembership(prefs, slots, windows);
    expect(result.vertrekt).toContainEqual({ slot_id: 'voor', blocking_level: 'LIEVER_NIET' });
    expect(result.vertrekt.find((p) => p.slot_id === 'laatste')).toBeUndefined();
  });
});
