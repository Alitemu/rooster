import { describe, it, expect } from 'vitest';
import { dateRanges, explainUnfilled } from './unfilledExplanation';

/**
 * The rule: after generating, the planner is told why shifts stayed empty,
 * by cause, in Dutch words - not one "not enough people" for all of them.
 */

const day = (i: number) => new Date(Date.UTC(2027, 3, 1 + i)).toISOString().slice(0, 10);

describe('explainUnfilled', () => {
  it('says nothing when nothing stayed empty', () => {
    expect(explainUnfilled([], {})).toEqual([]);
  });

  it('names the days nobody is a member, as one range, and where to fix it', () => {
    const unfilled = Array.from({ length: 158 }, (_, i) => ({ datum: day(i), teller: 'AVOND', reden: 'GEEN_LID' as const }));
    const [line] = explainUnfilled(unfilled);
    expect(line).toContain('Voor 158 diensten is op die dag niemand lid van de pool: 1 april 2027 t/m 5 september 2027.');
    expect(line).toContain('Geldig vanaf en Geldig tot bij Medewerkers');
  });

  it('says when the streefbereik itself is too small, per kind of shift', () => {
    const unfilled = Array.from({ length: 70 }, (_, i) => ({ datum: day(i), teller: 'AVOND', reden: null }));
    const lines = explainUnfilled(unfilled, { AVOND: { maximaal: 105, diensten: 175 } });
    expect(lines[0]).toBe('Het streefbereik laat samen hoogstens 105 avonddiensten toe, terwijl er 175 zijn. Verhoog het bereik onder Venster en streefbereik.');
    expect(lines[1]).toBe('De overige 70 diensten lukten niet binnen het venster en het streefbereik.');
  });

  it('counts every empty shift once over the causes, and writes Dutch without " - " or ", en"', () => {
    const unfilled = [
      { datum: day(0), teller: 'AVOND', reden: 'GEEN_LID' as const },
      { datum: day(2), teller: 'AVOND', reden: 'GEEN_LID' as const },
      { datum: day(5), teller: 'WEEKEND', reden: 'IEDEREEN_GEBLOKKEERD' as const },
      { datum: day(6), teller: 'WEEKEND', reden: null },
    ];
    const lines = explainUnfilled(unfilled);
    expect(lines).toEqual([
      'Voor 2 diensten is op die dag niemand lid van de pool: 1 april 2027, 3 april 2027. Controleer Geldig vanaf en Geldig tot bij Medewerkers.',
      'Voor 1 dienst heeft iedereen die dag geblokkeerd.',
      'De overige 1 dienst lukte niet binnen het venster en het streefbereik.',
    ]);
    for (const l of lines) expect(l).not.toMatch(/ - |, en |, of /);
  });
});

describe('dateRanges', () => {
  it('joins consecutive days, also over a month and a year end', () => {
    expect(dateRanges(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-05'])).toEqual(['30 december 2026 t/m 1 januari 2027', '5 januari 2027']);
  });
});
