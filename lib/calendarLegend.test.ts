import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dienstLegenda, dienstLetter, beschikbaarVoorbeeld, groepsgrootte } from './calendarLegend';

describe('legenda van de voorkeurenkalender', () => {
  it('legt elke letter uit die een vakje toont, ook F', () => {
    const counters = ['AVOND', 'WEEKEND', 'FEESTDAG'];
    expect(dienstLegenda(counters)).toEqual([
      { counter: 'AVOND', letter: 'A', naam: 'Avonddienst' },
      { counter: 'WEEKEND', letter: 'W', naam: 'Weekenddienst' },
      { counter: 'FEESTDAG', letter: 'F', naam: 'Feestdagdienst' },
    ]);
    for (const c of counters) expect(dienstLegenda(counters).map((x) => x.letter)).toContain(dienstLetter(c));
  });

  it('volgt de soorten die de kalender toont', () => {
    expect(dienstLegenda(['AVOND']).map((x) => x.letter)).toEqual(['A']);
  });

  it('de kalender bouwt de uitleg en de vakjes met dezelfde functies', () => {
    const bron = readFileSync('components/PreferencesCalendar.tsx', 'utf8');
    expect(bron).toContain('dienstLegenda(shiftCounters)');
    expect(bron).toContain('{dienstLetter(counter)}');
    expect(bron).not.toContain('{counter[0]}');
  });
});

/**
 * Audit per role R-10 (1.7.0): the explanation under the calendar said "15 van de 31" in every group,
 * also in one of 30. Now the group's own number, and no number at all while it is not known.
 */
describe('het voorbeeld onder de kalender', () => {
  it('rekent met de eigen groep', () => {
    expect(beschikbaarVoorbeeld(30)).toEqual({ kort: '15/30', tekst: '15 van de 30' });
    expect(beschikbaarVoorbeeld(31)).toEqual({ kort: '15/31', tekst: '15 van de 31' });
    expect(beschikbaarVoorbeeld(12)).toEqual({ kort: '6/12', tekst: '6 van de 12' });
  });

  it('noemt geen getal zolang de groep niet bekend is', () => {
    expect(beschikbaarVoorbeeld(0)).toBeNull();
    expect(beschikbaarVoorbeeld(Number.NaN)).toBeNull();
  });

  it('neemt de grootste groep van alle dagen: wie halverwege begint, telt mee', () => {
    expect(groepsgrootte([{ total_in_pool: 29 }, { total_in_pool: 30 }, { total_in_pool: 28 }])).toBe(30);
    expect(groepsgrootte([])).toBe(0);
  });

  it('de kalender gebruikt het, zonder vast getal', () => {
    const bron = readFileSync('components/PreferencesCalendar.tsx', 'utf8');
    expect(bron).toContain('beschikbaarVoorbeeld(groepsgrootte(coverage.values()))');
    expect(bron).not.toMatch(/15\/31|15 van de 31/);
  });
});
