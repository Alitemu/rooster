import { describe, it, expect } from 'vitest';
import { herinnerdOpTekst, isRecentHerinnerd } from './herinnerdOp';

/**
 * The rule: within 24 hours of the last reminder the screen asks first;
 * the moment reads as the planner would say it.
 */

// Local times, so the test holds in any time zone.
const now = new Date(2026, 9, 7, 16, 0);
const iso = (...args: [number, number, number, number, number]) => new Date(...args).toISOString();

describe('isRecentHerinnerd', () => {
  it('is true within 24 hours and false after', () => {
    expect(isRecentHerinnerd(iso(2026, 9, 7, 15, 40), now)).toBe(true);
    expect(isRecentHerinnerd(iso(2026, 9, 6, 16, 1), now)).toBe(true);
    expect(isRecentHerinnerd(iso(2026, 9, 6, 15, 59), now)).toBe(false);
  });

  it('is false without a reminder', () => {
    expect(isRecentHerinnerd(null, now)).toBe(false);
  });
});

describe('herinnerdOpTekst', () => {
  it('says today, yesterday or the date', () => {
    expect(herinnerdOpTekst(iso(2026, 9, 7, 9, 5), now)).toBe('vandaag 09:05');
    expect(herinnerdOpTekst(iso(2026, 9, 6, 23, 30), now)).toBe('gisteren 23:30');
    expect(herinnerdOpTekst(iso(2026, 9, 5, 15, 40), now)).toBe('5 okt 15:40');
  });

  it('adds the year across a year boundary', () => {
    expect(herinnerdOpTekst(iso(2025, 11, 20, 8, 0), new Date(2026, 0, 3, 12, 0))).toBe('20 dec 2025 08:00');
  });
});
