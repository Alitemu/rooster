import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { streefbereikUitRuleset } from './wizardControles';

/**
 * Audit 4 (1.6.1), measured with axe on the calendar a participant fills in:
 * - N-03: the 9px labels in grey 500 on the grey of a day cell reach 4.34 to 1, under the 4.5 of WCAG AA.
 *   Grey 600 reaches it on white and on both greys the calendar uses.
 *   (The other half of N-03 stays: axe also reports that a day button shows "A+" while its name reads
 *   "maandag 4 januari, Avonddiensten: voorkeur". Putting "A+" in the name makes a screen reader say it, and
 *   drawing the sign with CSS takes it out of the text that tests/e2e/preferences-calendar.e2e.ts holds
 *   apart per state, on screen and in print. The name in words is the better of the two.)
 * - N-06: the period page's header read "Avond 3-4 · Weekend 1-2", the raw range.
 */
const bron = (file: string) => fs.readFileSync(path.resolve(__dirname, file), 'utf8');

describe('small text in the calendars', () => {
  it.each(['PreferencesCalendar.tsx', 'AssignmentCalendar.tsx'])('%s has no 9px text in grey 500', (file) => {
    const klassen = [...bron(file).matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2]);
    const teLicht = klassen.filter((k) => /text-\[9px\]/.test(k) && /text-neutral-(400|500)\b/.test(k));
    expect(teLicht).toEqual([]);
  });

  it('the cell of a day outside Geldig vanaf en tot is not in grey 500 on grey either', () => {
    expect(bron('PreferencesCalendar.tsx')).not.toMatch(/bg-neutral-100 text-neutral-500/);
  });
});

describe('streefbereikUitRuleset', () => {
  it('says a frozen ruleset in words', () => {
    expect(streefbereikUitRuleset({ bandAvond: [3, 4], bandWeekend: [1, 2], bandFeestdag: [0, 1] })).toBe(
      '3 of 4 avonddiensten, 1 of 2 weekenddiensten en hoogstens 1 feestdagdienst'
    );
    expect(streefbereikUitRuleset({ bandAvond: [12, 12], bandWeekend: [2, 5], bandFeestdag: [0, 0] })).toBe(
      '12 avonddiensten, 2 tot en met 5 weekenddiensten en geen feestdagdiensten'
    );
  });

  it('gives nothing rather than a question mark when a band is missing or odd', () => {
    expect(streefbereikUitRuleset({ bandAvond: [3, 4], bandWeekend: [1, 2] })).toBeNull();
    expect(streefbereikUitRuleset({ bandAvond: [3], bandWeekend: [1, 2], bandFeestdag: [0, 1] })).toBeNull();
    expect(streefbereikUitRuleset({ bandAvond: ['3', '4'], bandWeekend: [1, 2], bandFeestdag: [0, 1] })).toBeNull();
    expect(streefbereikUitRuleset(null)).toBeNull();
  });

  it('is what the period page shows, with no raw range next to it', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../app/planner/period/[id]/page.tsx'), 'utf8');
    expect(page).toContain('streefbereikUitRuleset(cfg)');
    expect(page).not.toMatch(/cfg\.band(Avond|Weekend|Feestdag)\?\.\[/);
  });
});
