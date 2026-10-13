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
    expect(lines).toEqual(['Het streefbereik laat samen hoogstens 105 avonddiensten toe, terwijl er 175 zijn. Verhoog het bereik onder Venster en streefbereik.']);
  });

  // The planner's screen: 160 empty, a typed band of 5-6 avond and 2-3
  // weekend (one worked out for 30 people) and 8 of 15 members only in for
  // the first quarter. The shortfall is the 160 exactly; it used to add
  // "De overige 160 diensten lukten niet" as if those were 160 more.
  it('does not count the shifts the streefbereik explains twice, and suggests a band', () => {
    const unfilled = [
      ...Array.from({ length: 120 }, (_, i) => ({ datum: day(i), teller: 'AVOND', reden: null })),
      ...Array.from({ length: 40 }, (_, i) => ({ datum: day(i), teller: 'WEEKEND', reden: null })),
    ];
    const lines = explainUnfilled(
      unfilled,
      { AVOND: { maximaal: 55, diensten: 175, voorgesteld: [19, 20] }, WEEKEND: { maximaal: 30, diensten: 70, voorgesteld: [7, 8] } },
      8
    );
    expect(lines).toEqual([
      '8 mensen doen volgens Geldig vanaf en Geldig tot maar een deel van de periode mee. Hun streefbereik is daarom naar verhouding lager. Klopt dat niet, pas het dan aan bij Medewerkers.',
      'Het streefbereik laat samen hoogstens 55 avonddiensten toe, terwijl er 175 zijn. Verhoog het bereik onder Venster en streefbereik, bijvoorbeeld naar 19 tot 20 avonddiensten per persoon.',
      'Het streefbereik laat samen hoogstens 30 weekenddiensten toe, terwijl er 70 zijn. Verhoog het bereik onder Venster en streefbereik, bijvoorbeeld naar 7 tot 8 weekenddiensten per persoon.',
    ]);
    for (const l of lines) expect(l).not.toMatch(/ - |, en |, of /);
  });

  it('names what the streefbereik leaves unexplained, once', () => {
    const unfilled = Array.from({ length: 30 }, (_, i) => ({ datum: day(i), teller: 'AVOND', reden: null }));
    const lines = explainUnfilled(unfilled, { AVOND: { maximaal: 170, diensten: 175, voorgesteld: [6, 6] } }, 1);
    expect(lines).toEqual([
      '1 persoon doet volgens Geldig vanaf en Geldig tot maar een deel van de periode mee. Het streefbereik van die persoon is daarom naar verhouding lager. Klopt dat niet, pas het dan aan bij Medewerkers.',
      'Het streefbereik laat samen hoogstens 170 avonddiensten toe, terwijl er 175 zijn. Verhoog het bereik onder Venster en streefbereik, bijvoorbeeld naar 6 avonddiensten per persoon.',
      'Nog 25 diensten lukten niet binnen het venster en het streefbereik.',
    ]);
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
      'Nog 1 dienst lukte niet binnen het venster en het streefbereik.',
    ]);
    for (const l of lines) expect(l).not.toMatch(/ - |, en |, of /);
  });
});

describe('dateRanges', () => {
  it('joins consecutive days, also over a month and a year end', () => {
    expect(dateRanges(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-05'])).toEqual(['30 december 2026 t/m 1 januari 2027', '5 januari 2027']);
  });
});
