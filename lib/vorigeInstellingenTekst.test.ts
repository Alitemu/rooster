import { describe, it, expect } from 'vitest';
import { budgetTekst, verschilMelding, verschillenMetVorige } from '@/lib/vorigeInstellingenTekst';
import type { VorigeInstellingen } from '@/lib/vorigeInstellingen';

/**
 * Rooster instellen takes the previous period's settings over
 * (lib/vorigeInstellingen.test.ts); when the planner changes one, the
 * summary says what the previous period had (audit 1.3.0: Gelijk instead of
 * Naar rato went by with only "Verdeling: Gelijk" in the summary).
 */
const vorige: VorigeInstellingen = {
  periode_naam: '2027-1 (Jan-Jun)',
  distributionMode: 'NAAR_RATO',
  windowWeeksAvond: 2,
  windowWeeksWeekendFeestdag: 2,
  hardPercent: 10,
  softPercent: 100,
  parttimeExempt: true,
};
const zelfde = { ...vorige } as Omit<VorigeInstellingen, 'periode_naam'> & { periode_naam?: string };
delete zelfde.periode_naam;

describe('the summary against the previous period', () => {
  it('says nothing when everything is as before', () => {
    expect(verschillenMetVorige(vorige, zelfde)).toEqual([]);
    expect(verschilMelding(vorige, zelfde)).toBeNull();
  });

  it('names the previous verdeling when it was changed', () => {
    expect(verschilMelding(vorige, { ...zelfde, distributionMode: 'GELIJK' })).toBe(
      'Anders dan in 2027-1 (Jan-Jun). Daar was het: verdeling Naar rato. Klopt dat zo voor deze periode?'
    );
  });

  it('lists every difference in words, the last one after "en" without a comma', () => {
    const m = verschilMelding(vorige, { ...zelfde, windowWeeksAvond: 1, hardPercent: 100, parttimeExempt: false });
    expect(m).toBe(
      'Anders dan in 2027-1 (Jan-Jun). Daar was het: venster avond 2 weken, geblokkeerd hoogstens 10% en deeltijddagen telden niet mee. Klopt dat zo voor deze periode?'
    );
    expect(m).not.toMatch(/, en /);
  });

  it('calls 100% "zonder limiet"', () => {
    expect(budgetTekst(100)).toBe('zonder limiet');
    expect(budgetTekst(25)).toBe('hoogstens 25%');
    expect(verschillenMetVorige(vorige, { ...zelfde, softPercent: 20 })).toEqual(['liever niet zonder limiet']);
  });
});
