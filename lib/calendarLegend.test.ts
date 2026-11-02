import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dienstLegenda, dienstLetter } from './calendarLegend';

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
