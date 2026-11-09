import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The blocked-days boxes above the participant's calendar: one per kind of
 * shift the period has. A period from June to December has no feestdag, and
 * its box read "Feestdagdiensten geblokkeerd 0 van 0 toegestaan 0%" (audit
 * 1.3.0). A kind counts when the calendar has at least one day of it.
 */
const bron = fs.readFileSync(path.resolve(__dirname, 'PreferencesCalendar.tsx'), 'utf-8');

describe('blocked-days boxes', () => {
  it('leaves out a kind of shift with no day in the period', () => {
    expect(bron).toMatch(/const zichtbareTellers = shiftCounters\.filter\(\(c\) => counterTotals\.get\(c\)!\.total > 0\);/);
    expect(bron).toMatch(/\{zichtbareTellers\.map\(\(counter\) => \{\s*const totals = counterTotals\.get\(counter\)!;/);
  });
});
